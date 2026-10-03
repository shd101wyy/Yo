# A second `io.spawn` of a running task overwrites its effect bundle

**Severity:** S2 — a task spawned twice with two bundles continues under the SECOND caller's handlers, so the first spawn's handlers are silently replaced mid-task; no error, no documented rule.

**Status: OPEN.** Found 2026-10-03 by `plans/ASYNC_IO_API_AUDIT.md` (finding F3, probe 4). **Measured on:** develop `bcb57bfe7` built by the v0.2.49 seed, `--optimize 2`.

## Symptom

`issues/repros/a-second-io-spawn-of-a-running-task-overwrites-its-effect-bundle.yo`: a task yields twice and then calls `ctx.tell(...)`, whose handler returns `1` in the first bundle and `2` in the second.

```rust
h1 := io.spawn(task, { io, tell : tell_a });
h2 := io.spawn(task, { io, tell : tell_b });
// r1=2 r2=2   (expected r1=1 r2=1: the task was started with tell_a)
```

## Cause

`_generate_io_spawn` (`src/codegen/exprs/generation.yo` 362–433) injects the bundle (`__yo_future_set_bundle`, a `memcpy` of `bundle_size` bytes into the future, `src/codegen/exprs/await.yo` 256–284) at line 390, BEFORE the cold-start check at 392–397. A second spawn skips the start, takes another reference, returns a second handle — and has already overwritten the bundle slot the running task reads its handlers from. `io.await` gets this right: its injection sits inside the `state == 0` block (`await.yo` 418–422).

The same `memcpy` is a copy with no dup. Today's bundles hold `Io` and handler function pointers, so nothing is miscounted, but a bundle with a reference-counted field would be held without a count. That is a missing rule rather than a live defect; it is tracked by the same plan item.

## Expected

The bundle is injected once, at the cold start; a second spawn of a running (or finished) future returns a second handle to the same task with the original bundle. Documented in `docs/*/ASYNC_AWAIT.md`.

## Fix direction

Move the injection under the cold-start branch in `_generate_io_spawn`, matching `generate_await`. Regression test: the repro (`r1=1 r2=1`). Add the bundle-field rule (`Io`, handler types, value types) as an evaluator check or dup the fields. Plan: `plans/ASYNC_IO_API_AUDIT.md` A3.
