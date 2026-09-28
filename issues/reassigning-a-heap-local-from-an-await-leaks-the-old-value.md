# `s = io.await(…)` into an existing heap-typed local never drops the old value (leak)

**Status: OPEN.** Found 2026-09-28 by the async state-machine audit's control-flow shape sweep (`plans/ASYNC_STATE_MACHINE_GENERATION.md` §8). Confirmed with a tree build of develop `af62bdb28` and the v0.2.45 seed, with the inner future both suspending and completing synchronously, at `-O0` and `-O2`. `yo check` is green for every shape here. Expected values come from the same program written synchronously.

## Symptom

`issues/repros/async-shape-l1-reassign-heap-local-from-await-leaks-old.yo`: LeakSanitizer reports
the old String once per run. It reproduces at the top of the body, in a
loop, and in an arm. `t := io.await(…); s = t;` is clean.

## Root cause

The await result extraction `_emit_prev_await_result_extraction`
(`src/codegen/async/state_machine.yo`) writes
`sm->var_s = sm->await_future_0->result;` for BOTH `:=` and `=`. For `=`
the previous value must be released (the ordinary assignment emitter
saves it and drops it), and here it is simply overwritten.

## Fix

Emit the reassignment through the ordinary assignment path (old-value
drop), or, in phase 5, lower `s = await(f)` to `t := await(f); s = t` so
the existing assignment emitter handles it. Regression: the repro under
LSan.
