# A module-level global lent to a call can be reassigned while the callee holds it

**Severity:** S1. Safe code reads freed memory. A `&G` argument of a module-level runtime binding stays borrowed for the whole call. If the binding is reassigned during that call, the callee reads the released old value. The reassignment can come from the callee itself (directly or through a function it calls) or, during an await inside the callee, from another task. No diagnostic is raised, and the output is wrong.

**Status:** OPEN. Found 2026-10-15 while fixing `issues/fixed/2026-10-15-a-module-level-global-lent-to-a-borrowing-future-can-be-reassigned-during-the-await.md`. That fix covers the borrowing-future form only (E0909 at the call that makes the future). This doc covers the call-scoped form.

## Symptom

Both programs were compiled with a tree-built compiler at `1e8cece84` (develop `4c3391592` plus the future-lend fix).

The callee reassigns the global through another function:

```yo
{ println } :: import("std/fmt");
Gauge :: struct(b : Box(i64));
G := Gauge(b : box(i64(7)));
replace_g :: (fn() -> unit)({
  G = Gauge(b : box(i64(9)));
});
w2 :: (fn(g : &Gauge) -> i64)({
  replace_g();
  k1 := box(i64(111111));
  println(k1.*.to_string());
  g.b.*
});
main :: (fn() -> unit)({
  v := w2(&G);
  println(`w2 read: ${v.to_string()} (wrote 7)`);
});
export(main);
```

```
111111
w2 read: 111111 (wrote 7)
```

Another task reassigns the global while the callee awaits:

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
w :: (fn(g : &Gauge, io : Io) -> i64)(io.await(peek(g, io), io));
main :: (fn(io : Io) -> unit)({
  h := io.spawn(
    io.async((io : Io) => {
      io.await(sleep(u64(1)), io);
      println("replace");
      G = Gauge(b : box(i64(9)));
      k1 := box(i64(111111));
      println(k1.*.to_string());
    }),
    io
  );
  println("w start");
  v := w(&G, io);
  println(`w read: ${v.to_string()} (wrote 7)`);
  _r := h.await(io);
});
export(main);
```

```
w start
replace
111111
w read: 0 (wrote 7)
```

## Root cause

A `&` argument whose root is a module-level binding has no run-time mark, and the checker does not reject the lend when the callee can reach the binding by name:

- `plans/VALUES_BY_DEFAULT.md` (the "Module-level places" bullet of the closure-lend exclusivity rule) puts the places a callee may write in the overlap set of a lend of a module-level root, approximated by Stage 1's write summaries. The first repro shows that this approximation misses a write made through a function the callee calls (`replace_g`).
- `require_valid_ref_argument_places` (`src/types/flowability.yo`) rejects only a `&mut` argument into a module-level *container*.
- Decision 18 rule 3 rejects a *local* borrow of a module-level root whose live range contains any call or `await` (E0911, `local_borrow_note_call`). The same reasoning applies to the call's own argument borrow, but nothing applies it there.
- In the second repro, the callee's `io.await` suspends, other tasks run, and one of them reassigns `G`. D1 only stops other threads.

## Recommendation

Apply rule 3 to the argument lend itself:

1. Reject a `&`/`&mut` argument rooted in a module-level runtime binding (or a `thread_local`) when the callee's transitive write summary includes that binding, or when the callee can suspend.
2. Otherwise, require the caller to lend a local copy.

Rejecting every such lend whose callee is not a leaf would be simpler but stricter. Measure how many std and compiler call sites each variant would reject before choosing.
