# A module-level global lent to a borrowing future can be reassigned during the await

**Severity:** S1. Safe code read freed memory: a borrowing future that was lent a module-level runtime binding read the binding's old, already released payload after another task on the same thread reassigned the binding during the await. The checker accepted the program, and the output was wrong with no diagnostic.

**Status:** FIXED 2026-10-15. Found in review of the §3.13 A2 future-lend rules.

## Symptom

On develop at `4d942f533` (a tree-built compiler) and on seed v0.2.62:

```yo
{ sleep } :: import("std/sys/timer");
{ println } :: import("std/fmt");
Gauge :: struct(b : Box(i64));
peek :: (fn(g : &Gauge, io : Io) -> Impl(Future(i64, Io)))(
  io.async({ &g }(io : Io) => {
    io.await(sleep(u64(5)), io);
    g.b.*
  })
);
G := Gauge(b : box(i64(7)));
replace_g :: (fn() -> unit)({
  G = Gauge(b : box(i64(9)));
});
main :: (fn(io : Io) -> unit)({
  h := io.spawn(
    io.async((io : Io) => {
      v := io.await(peek(&G, io), io);
      println(`borrowed payload read after the await: ${v.to_string()} (wrote 7)`);
      return(v);
    }),
    io
  );
  io.await(sleep(u64(1)), io);
  replace_g();
  k1 := box(i64(111111));
  k2 := box(i64(222222));
  k3 := box(i64(333333));
  _r := h.await(io);
  println(`${k1.*.to_string()} ${k2.*.to_string()} ${k3.*.to_string()}`);
});
export(main);
```

`yo compile m5.yo -o m5 && ./m5` printed:

```
borrowed payload read after the await: 111111 (wrote 7)
111111 222222 333333
```

The future read `k1`'s payload: `replace_g` released the `Box` that the future still pointed at, and `box(i64(111111))` reused the freed allocation.

The same hole accepted a borrowing method on a global receiver (`io.await(G.peek_self(io), io)`), a field or fixed-size-array element of a global (`&mut G.n`, `&A(usize(0))`), a `thread_local` binding, and a call through a function value (`fp(&mut G, io)`).

## Root cause

Decision 38 D's future-lend check (`_check_future_call_lends` in `src/evaluator/calls/function.yo`, the E0909 cell rule) assumes that the lender's frame is frozen while the future lives. A local's frame is suspended with the task that awaits, so nothing else can touch it. That premise fails for a module-level runtime binding, and for a `thread_local` one: any task on the same thread can reach it by name and reassign or write it during the await. D1 (the mutable-static rule) only keeps other threads out.

The other two routes to such a borrow were already closed:

- An `io.async` capture list rejects a module-level root (`{ &G }`, decision 18 rule 3, in `src/evaluator/values/anonymous_function.yo`).
- A local borrow of a global (`r := &G`) is E0911 across any call (`local_borrow_note_call`).

Only a call that lends the global as an argument or a receiver went unchecked.

## Fix

`_note_future_producing_call` runs a third check, `_check_future_call_global_lends`, beside the cell and argument-conflict checks. Every place the call lends to the future, the receiver included, is walked to its root binding (`_lent_place_of`, `_lent_root_variable`). If the root is a module-level runtime binding (`is_module_level && !is_compile_time_only`, which also covers a `thread_local`), the lend is E0909. A `::` constant has no runtime storage and is still lent freely. The help suggests lending a local copy, or reading the global by name inside the future, where every use re-reads it.

This fix does not cover a global lent to a plain call. A synchronous function that awaits a future over its `&` parameter (`w :: (fn(g : &Gauge, io : Io) -> i64)(io.await(peek(g, io), io))`, called as `w(&G, io)`) holds the call-scoped borrow across that await. A callee that reassigns the global by name has the same hole. Both are filed as `issues/fixed/2026-10-15-a-module-level-global-lent-to-a-call-can-be-reassigned-while-the-callee-holds-it.md`.

## Verification

`tests/async_await.test.yo`, "a borrowing future cannot hold a place rooted in a module-level or thread_local binding", covers nine rejected shapes: `&` and `&mut` arguments, a `&mut self` receiver, a `&self` receiver whose call omits a defaulted parameter, a field, a fixed-size-array element, a `thread_local`, and a call through a function value. On develop before the fix, the checker accepts every one of them. The same test also has three positive cases: a `::` constant lent to the future, a local copy lent and written in place, and a global read by name inside a spawned future that sees the other task's write. The tree-built compiler now rejects the repro above with E0909.
