# Async State Machine: Temp Future Variable Duplication

**Status: FIXED** (Phase 1b — temp future variable aliasing)

## Summary

When an async body contains `io.await(yield())` or `io.await(someExpr())`, the state machine struct may contain **both**:

1. A captured temp variable field (`var_temp_XXXX`) from suspension analysis
2. A separate `await_future_N` field from the await point analysis

Both point to the same future object. Only `await_future_N` is actually used by the resume function logic; the `var_temp_XXXX` field is captured by the variable walker but never referenced during code generation.

## Fix applied

Instead of removing temp vars from the SM variable map (which breaks deferred drop code generation), we **alias** them to their corresponding `await_future_N` field:

1. `computeCrossBoundaryVariables()` identifies temp vars by matching `awaitPoint.expr.args[0].$.variableName` to captured variables
2. Aliased vars stay in `stateMachineVariables` (so atom.ts and drop codegen can find them) but NO struct field is generated
3. `atom.ts` checks `stateMachineFieldAliases` and redirects lookups to `sm->await_future_N`
4. Deferred drops for aliased vars become no-ops (await_future_N is already NULLed by the resume function)
5. The dispose function skips drops for aliased vars (lifecycle managed by resume function)

Key files modified:

- `src/codegen/async/state-machine.ts` — `computeCrossBoundaryVariables()` returns `CrossBoundaryResult` with alias map
- `src/codegen/functions/context.ts` — added `stateMachineFieldAliases` field
- `src/codegen/exprs/async.ts` — passes aliases through struct definition, dispose, and resume codegen
- `src/codegen/exprs/atom.ts` — checks aliases before generating SM field access
