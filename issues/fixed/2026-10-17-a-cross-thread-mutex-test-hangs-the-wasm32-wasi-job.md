# A cross-thread async-mutex test hangs develop's wasm32-wasi job

**Severity:** S2. develop's battery has no verdict: `test-wasm32_wasi` runs into its 120-minute job timeout and is reported as cancelled, so `Merge gate (all checks)` fails. That blocks every release cut, and no compiler or std behaviour is wrong.

**Status: FIXED** (`fix(develop)`, this PR).

## Symptom

develop run 38987303081 on `5425cd7bf` (#1380). The wasm32-wasi job ran `tests/async/mutex.test.yo` and printed its four tests up to "Test tasks contend through Arc handles, and lock borrows through them across awaits" at 00:59:39 UTC. Nothing followed until the job was cancelled at 02:42:26. The job normally takes 64–67 minutes in total (develop runs on `982b4a685`, `1a4cf8df6`, `a60a046e0` and `ed733408c`).

## Cause

#1380 added "Test a task on another thread's loop contends for the same mutex" to `tests/async/mutex.test.yo`. The test spawns a `Thread` whose task parks on the held lock from its own event loop, then waits for `waiter_count() > 0` before unlocking.

The wasm job runs the whole suite with `--target wasm32-wasip1`. Standalone WASI has no pthreads, so the worker cannot run on a loop of its own. It never registers as a waiter, and the main task's `while(waiter_count() == 0)` loop never exits.

Every other test file that spawns OS threads opts out of WASI with `pragma(Pragma.SkipWasm32Wasi)`, for example `tests/arc.test.yo`, `tests/arena.test.yo` and `tests/async/exit_release.test.yo`. `tests/async/mutex.test.yo` had no thread test before #1380, so it carries no such pragma.

## Fix

- The test moves unchanged to `tests/async/mutex_threads.test.yo`, which carries `pragma(Pragma.SkipWasm32Wasi)` and `pragma(Pragma.SkipWasm32Emscripten)`.
- `tests/async/mutex.test.yo` drops its `Thread` import. Its other tests still run on wasm, as they did before #1380.

**Test.** The fix is the test's placement, and the failing run is the before-evidence: develop run 38987303081 hung on this exact test. After the fix, the test runs natively from its new file, and the wasm job skips the file.

## Follow-up (not done here)

A test that hangs at runtime costs the wasm job its whole 120-minute budget, because the runner's deadline covers only the compile. A per-file runtime deadline for the wasm runner would turn a hang like this into a quick, named failure.
