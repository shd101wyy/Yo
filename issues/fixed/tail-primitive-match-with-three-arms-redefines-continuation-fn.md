# A primitive `match` with 3+ arms, one awaiting, as the async body's tail: `redefinition of 'continuation_fn'`

**Status: FIXED (2026-09-29).** Found 2026-09-28 by the async state-machine audit's control-flow shape sweep (`plans/ASYNC_STATE_MACHINE_GENERATION.md` §8). Confirmed with a tree build of develop `af62bdb28` and the v0.2.45 seed, with the inner future both suspending and completing synchronously, at `-O0` and `-O2`. `yo check` is green for every shape here. Expected values come from the same program written synchronously.

## Symptom

`issues/repros/async-shape-b8-tail-prim-match-3-arms-c-error.yo`: clang reports `redefinition of
'continuation_fn'` / `'continuation_sm'`. Two arms work, and so do enum
matches.

## Root cause

`generate_primitive_match_with_await` / `_emit_primitive_fallback_cases`
(`src/codegen/async/state_code_gen.yo`) emit `case K:` / `default:` bodies
without `{ }`. Each non-awaiting arm's completion
(`_emit_non_await_branch_async_completion` → `emit_async_future_completion`)
then declares `void (*continuation_fn)` and `continuation_sm` in the same C
scope.

## Fix

Brace every emitted case body (cheap, and worth doing even before phase 5,
since the completion block is a declaration-bearing snippet that may be
emitted anywhere). Phase 2's `__yo_future_complete` helper removes the local
declarations entirely. Regression: the repro.

## Fix (2026-09-29)

`generate_primitive_match_with_await` (`src/codegen/async/state_code_gen.yo`) emits each case body as its own C block, so the declarations in each non-awaiting arm's completion no longer share a scope. Regression: `tests/async/sm_ownership.test.yo`, "a primitive match with three arms as the body's tail".
