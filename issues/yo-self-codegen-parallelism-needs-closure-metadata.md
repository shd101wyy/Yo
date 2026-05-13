# yo-self codegen `parallelism.ts` full port needs closure metadata

## Symptom

Only the metadata-independent `generateYoThreadSetMaximumThreads` helper from
`src/codegen/exprs/parallelism.ts` can be faithfully ported today.

The remaining TypeScript helpers (`generateThreadSpawnCall`,
`generateWorkerSpawnCall`, and `generateSpawnWrapper`) depend on typed/evaluated
codegen metadata that the current self-hosted codegen does not expose yet:

- `expr.$.runtimeArgExprsInOrder`
- closure argument `.$.type`
- `SomeType.resolvedConcreteType`
- `context.implClosureCallMap`
- `expr.$.variableName`
- `expr.$.env.modulePath`
- RC dup/drop helpers for the concrete capture type

The current `yo-self/codegen/exprs.yo` dispatcher mostly receives bare `AstExpr`
nodes and `CodegenContext` does not yet model the complete TypeScript
`CodeGenContext` closure maps.

## Correct fix

Do not hand-roll thread/worker-spawn lowering in `driver.yo` or in the monolithic
`exprs.yo`. Preserve 1-to-1 porting by first adding typed expression metadata,
closure call maps, and capture-type context parity, then port the rest of
`src/codegen/exprs/parallelism.ts` directly.
