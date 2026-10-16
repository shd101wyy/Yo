# A join wait entry still queued at thread exit is never released

**Severity:** S3 — a program that ends right after a `timeout` whose operand finished first leaks the 64-byte join wait at exit (a LeakSanitizer report under `yo test`'s leak verdict); nothing accumulates while the program runs.

**Status:** FIXED 2026-10-16 on `feat/vbd-v3-a4-future-operands` (VBD V3 A4), which found it while running the new `timeout` tests with the leak verdict on.

## Symptom

Seed v0.2.63, `yo compile repro.yo --sanitize address --allocator system`:

```yo
{ assert } :: import("std/assert");
{ timeout } :: import("std/async");
{ Duration } :: import("std/time/duration");
main :: (fn(io : Io) -> unit)({
  g := io.async((io : Io) => i32(2));
  r := io.await(timeout(io.spawn(g, io), Duration.from_millis(i64(200)), io), io);
  assert(r.is_ok(), "in time");
});
export(main);
```

```text
SUMMARY: AddressSanitizer: 64 byte(s) leaked in 1 allocation(s).
    #2 __yo_async_park_start
    #3 __yo_join_wait_new
```

(The handle form is seed v0.2.63's `timeout`; the future form `timeout(g, …)` leaks the same way.)

## Root cause

`timeout` waits on the operand and its deadline task through one join wait. The operand finishes first, so `timeout` aborts the deadline task, whose abort hook wakes its waiters: the wait's entry (`__yo_join_wait_fire`, which owns a reference to the wait) is queued. `timeout` resolves inline, `main` returns, and the queued entry never runs.

The thread-exit drain (`__yo_async_thread_exit_release`, `src/codegen/async/runtime_core.yo`) treats every queued node as a task: it aborts the payload and resumes it only if the abort marked it Aborted. The payload of a join wait entry is the wait, which already completed, so the abort left it alone and the entry's reference was never released.

## Fix

The drain fires a join wait entry instead: the wake is a no-op on a completed park, and the fire releases the entry's reference.

## Verification

`tests/async/sm_protocol.test.yo` "a join wait entry still queued when the program ends is released" reports the leak before the fix (leak verdict on) and passes after. The patched runtime was first checked by hand-editing the emitted C of the reproducer.
