# An early `return` in an `io.async` body drops a task-slot local it already moved

**Severity:** S1: memory unsafety in generated code. A heap-use-after-free or
double free: the moved value's new owner frees it, and the task frees it again
at the early return.

> Found 2026-10-29 by V2c's replay onto develop `c39c574be`.
> `tests/async_await.test.yo` failed 6 tests under ASan: "Test early return from cond branch in async",
> "Test code after while-with-await loop", and four related tests.
> #1655 made `RefCell.with_mut` take an owning `FnOnce` body, and under
> decision 17 the body's implicit capture of an `Rc` moves it. Pre-existing:
> a develop `c39c574be` build shows the same use-after-free with a move-only
> `Box`, whether it is moved into a call or into a closure's capture.

## Reproducer

```yo
{ println } :: import("std/fmt");
{ yield } :: import("std/async");
{ RefCell } :: import("std/sync/refcell");
take :: (fn(b : Box(i32), r : &Rc(RefCell(i32))) -> unit)({
  r.with_mut(cur => {
    cur = b.*;
  });
});
main :: (fn(io : Io) -> unit)({
  result := rc(RefCell(i32).new(0));
  task := io.async({ result : Rc.clone(result) }(io : Io) => {
    s := box(i32(100));
    cond(
      result.with(cur => (cur == i32(0))) => {
        io.await(yield(io), io);
        take(s, &result);
        return;
      },
      true => ()
    );
  });
  io.await(task, io);
  println(`ok ${result.with(cur => cur)}`);
});
export(main);
```

`yo compile repro.yo --sanitize address --allocator system` reports
`heap-use-after-free`. The same happens when `take(s, &result)` is replaced by
`result.with_mut(cur => { cur = s.*; })`, where the owning closure captures
`s`.

## Root cause

There are two halves:

1. The early-completion path of an inlined state machine (`return` in
   `src/codegen/exprs/atom.yo`) emits every pending drop that names a task slot
   (`sm->var_s`) unconditionally. A move out of a named local's slot keeps the
   value in place and sets the slot's move flag (`_sm_consuming_read`), but
   only the abort dispose reads the flag. The early-completion path released
   the moved value again.
2. A closure built inside the machine that implicitly captures a slot by
   MOVE (a move-only value, or a counted handle under decision 17) read
   `sm->var_s` into its capture struct (`generate_closure_construction`'s
   `_resolve_sm_atom` fallback, `src/codegen/exprs/closures.yo`) and never
   set the move flag. The same applied to an owned capture-list field
   (`sm->__capture.x`). The machine's drops then released what the closure
   owned.

## Fix

- The early-completion path empties a slot whose move flag is set before its
  drop, as the abort dispose does.
- The closure-capture fallback (`_sm_moved_capture_read`) sets the slot's move
  flag, or empties a slot that has no flag, after the line holding the
  literal. It does so when the variable's move is this closure literal
  (`consumed_at_token`).

Tests: `tests/async/sm_ownership.test.yo`, "an early return after moving a
task-slot local into a call drops it once" and "… into a closure's capture
drops it once" (both with a `Box`, so they fail on develop without decision
17). `tests/async_await.test.yo`'s six tests pass again.
