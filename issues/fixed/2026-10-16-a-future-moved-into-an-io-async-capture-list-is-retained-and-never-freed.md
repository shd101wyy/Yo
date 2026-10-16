# A future moved into an io.async capture list is retained and never freed

**Severity:** S1 — every future captured by name in an `io.async` capture list (`io.async({ f }(io : Io) => …)`) leaked its state machine, and a task spawned from it and then aborted never dropped its locals (a `Drop` value held across the abort was never dropped).

**Status:** FIXED 2026-10-16 on `feat/vbd-v3-a4-future-operands` (VBD V3 A4), which found it: `std/async`'s `timeout` and `select` now take futures and capture them (`io.async({ fut, ms, io }(e : E) => …)`), and `tests/async/sm_protocol.test.yo`'s "cancelling a task blocked on a channel releases it" stopped seeing its aborted tasks' locals dropped.

## Symptom

Seed v0.2.63 and develop at `0684c9c40`, `yo compile repro.yo --sanitize address --allocator system`:

```yo
{ println } :: import("std/fmt");
{ sleep } :: import("std/sys/timer");
mk :: (fn(io : Io) -> Impl(Future(i32, Io)))(
  io.async((io : Io) => {
    io.await(sleep(u64(1)), io);
    i32(1)
  })
);
main :: (fn(io : Io) -> unit)({
  f := mk(io);
  outer := io.async({ f }(io : Io) => io.await(f, io));
  r := io.await(outer, io);
  println(`r=${r}`);
});
export(main);
```

```text
r=1
Direct leak of 88 byte(s) in 1 object(s) allocated from:
```

The same through a parameter (`wrap :: (fn(f : Impl(Future(i32, Io)), io : Io) -> …)(io.async({ f }(io : Io) => io.await(f, io)))`) leaks the same 88 bytes. When the body spawns the captured future and aborts the task (`h := io.spawn(f, io); h.abort(); io.await(h.join(io), io)`), the task's state machine is never freed, so a `Drop` local it holds across the abort is never dropped.

An implicit capture of a future is rejected (E0913), so the capture list was the only way to hand a future to an `io.async` body, and it always leaked.

## Root cause

A future is move-only (§3.13 A1), so `generate_captured_variable_dup_expressions` (`src/evaluator/utils/closure.yo`) MOVES it into the capture struct: no dup, and the variable is consumed, so its scope-end drop is skipped. The capture struct's dispose releases it.

`_build_async_capture_struct_literal` (`src/codegen/exprs/async.yo`) builds the struct from the variables' names. When no field matched a deferred dup, it retained every RC-bearing field itself, the moved future included:

```c
__yo_cap cap = { .__yo_v_f = __yo_v_f };
if (cap.__yo_v_f != NULL) { __yo_incr_rc((void*)cap.__yo_v_f); }   // nothing releases this
```

That retain had no balancing drop: the variable it copies from is consumed.

## Fix

The fallback retain skips move-only fields (`type_is_move_only`). A move-only capture is always moved (`capture_of_caller_owned_sink_param` answers false for a move-only type), so its field owns the value the variable gave up.

## Verification

`tests/async/sm_protocol.test.yo` "a future moved into a capture list is freed with the task that runs it": an aborted task spawned from a captured future drops its `Thing` local (the count stayed unchanged before the fix), and an awaited captured future drops it once. With the leak verdict on, the file reports no leak.
