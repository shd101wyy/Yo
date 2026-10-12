# A local borrowed by a closure's capture list in an `io.async` body is not hoisted into the task

**Severity:** S1 — the closure read a dead resume-function frame after a
suspension (garbage where 42 was right), on develop as well.

Found by the adversarial review of the §3.13 A2 change, 2026-10-12. The
defect predates A2; A2 added a second way to reach it.

## Symptom

```yo ignore
outer :: (fn(io : Io) -> Impl(Future(i32, Io)))(
  io.async((io : Io) => {
    x := C(n : i32(20), m : i32(22));
    (f : Impl(Fn() -> i32)) = ({ &x }() => (x.n + x.m));
    io.await(yield(io), io);
    f()
  })
);
```

Develop printed `72529221` at -O0 and `15673881` at -O2; the A2 branch
printed garbage too. A2's shape: the closure is called from an inner
`io.async` after a yield (`v2_min_closure.yo`, `p27_closure_local_in_sm.yo`),
which develop rejected with E0909.

The C kept `x` a local of the resume function and stored `&__yo_v_x` in the
closure, which was hoisted (`sm->var_f_…`); the state machine's `var_x_*`
field was declared with the pointer type and never written.

## Root cause

`compute_cross_boundary_variables` (`src/codegen/async/state_machine.yo`)
hoists the locals live across a suspension, by a linear liveness walk. An
`&x` argument marks `x` live to the end of its scope, but a capture list's
`{ &x }` entry did not: nothing names `x` after the closure is made, so `x`
looked dead at the await while the closure (hoisted) still pointed at it.

## Fix

`_lv_walk` marks the root of every capture-list borrow entry of a closure
literal (an `io.async` body's list too) live to the end of its scope
(`_lv_mark_capture_list_borrows`), as it does for an `&x` argument. `x` is
then a task slot, and the closure's capture points at the slot.

Regression test: `tests/async_await.test.yo`, "borrowed temporaries and
closure-borrowed locals of an awaiting io.async body live in the task".
