# A module-level global lent to a call can be reassigned while the callee holds it

**Severity:** S1. Safe code reads freed memory. A `&G` argument of a module-level runtime binding stays borrowed for the whole call. If the binding is reassigned during that call, the callee reads the released old value. The reassignment can come from the callee itself (directly or through a function it calls) or, during an await inside the callee, from another task. No diagnostic is raised, and the output is wrong.

**Status:** FIXED (Generation A) on `feat/global-lend-to-call-is-an-error`, by decision 47 (`plans/VALUES_BY_DEFAULT.md` §4) and decision 18 rule 3's amendment. Found 2026-10-15 while fixing `issues/fixed/2026-10-15-a-module-level-global-lent-to-a-borrowing-future-can-be-reassigned-during-the-await.md`. That fix covers the borrowing-future form only (E0909 at the call that makes the future). This doc covers the call-scoped form.

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

## Decision (maintainer, 2026-10-15)

Rust's `static` / `static mut` model, with an explicit marker, as the first
step of decision 47 ("a binding is immutable unless its name is wrapped in
`mut(...)`"):

- A module-level or `thread_local` runtime binding is immutable unless it is
  declared `mut(G) := v`, `(mut(G) : T) = v` or `thread_local(mut(G))`.
- A write to an unmarked one (a reassignment, a field or element write of a
  value, a `&mut` lend of a value place, a `&mut self` call on one) is E0917.
- An unmarked global may be lent to any call. Lending a `mut(G)` global, or a
  place under it, to a call is E0916.
- A `ref` handle the global holds is mutated through its methods without
  `mut`. Rule A: a lend into the storage behind the handle (`&G(i)`) is E0916
  if a `&mut self` method is called on the handle anywhere. Rule B: a lend of
  `&G.f` is E0916 if `G.f` is assigned through the handle anywhere.

Rejected after a census: the strict rule "every lend of a global to a call is
an error". It found 1,447 sites (src 1,345, std 15, tests 87); 94% were
`ref`-handle receivers, and 49 were the `&self` methods of the `Mutex`/atomic
globals its own message named as the fix. Whole-program inference of "never
written" was rejected too: its verdict would depend on module load order.

## The fix

- `src/evaluator/exprs/initialization_assignment.yo` and
  `src/evaluator/exprs/assignment.yo` accept the `mut(name)` declaration
  forms at module level and strip the marker the way `thread_local(name)` is
  stripped; `register_mut_global` (`src/expr_info.yo`) carries it.
- `global_require_mut` (`src/evaluator/utils.yo`) is E0917, called at a
  reassignment, at a field or element write of a value, and at a `&mut` lend
  of a value place (`_judge_global_lend`, `src/evaluator/calls/function.yo`).
- `_judge_global_lend` is E0916 for a lend of a `mut(G)` global at every call
  form (named functions, methods and receivers, closures, function values,
  operator operands, macro expansions such as `for(&G, ...)` and `${G}`), and
  feeds rules A and B (`global_note_handle_*`, `src/evaluator/utils.yo`).
- Generation A: enforced outside std, the compiler source beside it, fetched
  dependencies and macro expansions (`is_global_mut_rule_exempt`), because the
  v0.2.62 seed cannot parse `mut(`. `YO_AUDIT_GLOBAL_LEND=1` prints the census
  for Generation B. `yo fix <path> --migrate mutable-globals` marks every
  written global.
- Both repros above, with `G` declared `mut(G)` as their writes require, are
  E0916 at `w2(&G)` and `w(&G, io)` (`tests/global_lend.test.yo`).

## Rule A today

Rule A guards the ABI after #1368's direct projection calls; it does not
reproduce a use-after-free today. Probed under ASan
(`--sanitize address --allocator system`) on the v0.2.62 seed and on the
branch:

- `peek(&G(usize(0)))` where `peek` calls a helper that pushes 64 elements
  onto `G`;
- the same, with the helper also replacing `G(usize(0))`;
- `for(&G, s => { grow(); println(&s); })`.

All ran clean. The emitted C copies the element out through `index(...)`
with an increment and a decrement of its count around the call
(`set_expr_as_needs_to_call_dup_for_borrowed_projection`), so the callee
never holds a pointer into the buffer. A function returning `&T`, whose `&T`
parameters are passed by pointer, cannot be called directly until #1368.
