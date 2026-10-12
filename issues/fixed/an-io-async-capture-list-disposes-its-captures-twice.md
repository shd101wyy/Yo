# An `io.async` capture list disposes its captures twice

**Severity:** S1: a double dispose of every capture in an `io.async` body's
capture list (the second dispose runs on a value whose resources were already
released), on every path: a completed, aborted or early-returning body alike.

**Status:** fixed with V3 async A1 (`plans/VALUES_BY_DEFAULT.md` §3.13).

> Found 2026-10-12 while landing A1. A1 makes a captured future movable out of
> an `io.async` body only through a by-value capture list
> (`io.async({ f }(io : Io) => io.await(f, io))`), so it also lifted the
> "no capture list on an `io.async` body" rule for by-value entries. The
> first run of that shape counted two disposes.

## Reproducer

```yo ignore
{ println } :: import("std/fmt");
_D :: struct(n : i32);
(g_d : i32) = i32(0);
impl(_D, Dispose(dispose : (fn(self : &Self) -> unit)({ g_d = (g_d + i32(1)); })));
main :: (fn(io : Io) -> unit)({
  d := _D(n : i32(3));
  r := io.await(io.async({ d }(io : Io) => d.n), io);
  println(`r=${r} disposed=${g_d} (want 1)`);
});
export(main);
```

Printed `disposed=2`.

## Root cause

Two owners for one capture. A closure with a capture list typed `FnOnce`
owns its captures (decision 37): the evaluator schedules a drop of every
capture the body did not move at the body's end, tagged
`is_fnonce_capture_drop`, and codegen keeps those drops. A state machine also
owns its capture struct: its dispose drops every capture field
(`issues/fixed/io-async-closure-captures-never-released.md`). An `io.async`
body got both.

The body's drops cannot be the owner of a state machine's captures: the body
can be abandoned between awaits (an abort) or never run (a cold future that is
dropped), and then no body-end drop runs.

## Fix

The state machine is the single owner (`InlineSmLowering.owns_fnonce_captures`,
set when the capture struct is an `FnOnce` capture list):
- the body's tagged capture drops are not emitted (`is_deferred_drop_for_closure_capture`
  takes `sm_owns_captures`; the tail and early-completion drop loops skip them);
- each droppable capture field gets a move flag
  (`__yo_mv___capture_<label>`, `sm_capture_move_flag_name`): a consuming read
  of `sm->__capture.<label>` sets it, as it does for a named local's slot;
- the dispose drops each capture whose flag is clear.

A sync future (a body with no await) runs its closure function to the end in
one resume, so that body keeps decision 37's drops and the dispose drops the
captures only while the future is cold (`state == 0`).

Regression: `tests/async_await.test.yo`, "Test an io.async capture list
disposes each capture once on every path": kept and moved captures, in a sync
body and a state machine, moved then aborted, aborted before the move, a cold
future dropped unrun, and an early return. Each disposes once, and the same
shapes are clean under `--sanitize address --allocator system`.
