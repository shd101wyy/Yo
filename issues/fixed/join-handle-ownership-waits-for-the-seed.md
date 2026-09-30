# The owning JoinHandle waits for a seed that can lower it

**Severity:** S1 — until the flip, a statement-level (fire-and-forget) `io.spawn` leaks its state machine again, and a JoinHandle must be awaited at most once

**Status:** FIXED 2026-10-01 — both steps landed. Step 1 in #996 (released in v0.2.46); step 2 once `SEED_VERSION` reached v0.2.47.
**Found:** 2026-09-29. develop `c52ce152c` (#991) and `34c51c895` could not be built by the
v0.2.45 seed: every CI battery failed at "Build stage 1 once (seed `yo build`)" (runs
36480349988, 36486077485), and so did every PR based on develop, #992 included.

## What broke (measured from the CI log)

#991 made `JoinHandle(T)` an owning `ref` struct with a `Dispose` that calls a new runtime
function, `__yo_join_handle_release_raw`. The seed compiles the compiler's own source
(`src/build_runner.yo` spawns tasks at six sites) with the TREE std (`--std-path ./std` is
load-bearing), but lowers `io.spawn` / `JoinHandle.await` with its OWN codegen, which hard-codes
the value struct:

```
error: initialization of non-aggregate type '__yo_t_…*' with a designated initializer list
       sm->var_h_… = (__yo_t_…*){ .__future = (void*)__spawn_future_… };
error: member reference type '__yo_t_…*' is a pointer; did you mean to use '->'?
error: call to undeclared function '__yo_join_handle_release_raw'
```

No std spelling satisfies both compilers, and a release cannot be cut from a develop the seed
cannot build (the release workflow builds with the seed too).

## Step 1 (landed with this doc)

- std's `JoinHandle` is the value struct again, with no Dispose (`std/prelude.yo`).
- The codegen lowers by the handle's TYPE (`_generate_io_spawn` in
  `src/codegen/exprs/generation.yo`, `generate_join_handle_await` in
  `src/codegen/exprs/await.yo`): a `ref` handle gets #991's owning lowering (`__yo_new_…`,
  `->__future`, released by Dispose), a value handle the pre-#991 one (a bound spawn takes a
  reference, `JoinHandle.await` releases it after reading the result).
- `__yo_join_handle_release_raw` stays in the runtime (`runtime_core.yo`) for step 2.

Consequence until step 2: the leak in `issues/fixed/statement-level-io-spawn-leaks-the-state-machine.md`
is back (the evaluator names every value, so a discarded spawn still takes a reference nothing
releases), a handle awaited twice reads freed memory, and a dropped un-awaited bound handle leaks
its task. The detach test is parked as `issues/repros/statement-level-spawn-detaches-the-task.yo`.

## Step 2 (after a release carries step 1)

1. Bump `SEED_VERSION` to that release.
2. Make std's `JoinHandle` the `ref` struct again with #991's Dispose
   (`__yo_join_handle_release_raw`).
3. Delete the value branch of both lowerings.
4. Move the parked repro back into `tests/async/sm_protocol.test.yo` ("a statement-level spawn
   detaches the task, which frees itself") and close this doc and the leak doc.


## Step 2 (landed 2026-10-01)

`SEED_VERSION` is v0.2.47, whose codegen lowers both forms. std's `JoinHandle` is the `ref`
struct again, with #991's `Dispose` calling `__yo_join_handle_release_raw`. The value branches of
`_generate_io_spawn` (`src/codegen/exprs/generation.yo`) and `generate_join_handle_await`
(`src/codegen/exprs/await.yo`) are deleted, along with the imports only they used. The detach test
is back in `tests/async/sm_protocol.test.yo`, and its parked repro is removed.

