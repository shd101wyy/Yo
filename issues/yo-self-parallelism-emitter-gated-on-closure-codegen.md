# yo-self: parallelism spawn emitter gated on the closure-codegen subsystem

## Status

OPEN (2026-06-18). The parallelism **runtime** (`generate_parallelism_runtime`,
the `__yo_thread_*` / `__yo_worker_*` C boilerplate) is ported and wired
(`yo-self/codegen/parallelism/runtime.yo`, gated on `context.uses_parallelism` in
`functions/generation.yo`). The parallelism **expression emitter**
(`src/codegen/exprs/parallelism.ts`: `generateThreadSpawnCall`,
`generateWorkerSpawnCall`, `generateSpawnWrapper`,
`generateYoThreadSetMaximumThreads`) is NOT yet ported because it depends on the
deferred closure-codegen subsystem.

## The dependency

`generateThreadSpawnCall` / `generateWorkerSpawnCall` resolve the spawned
closure's concrete capture struct + closure function via
`context.implClosureCallMap.get(concreteTypeId)`, which yields
`{ functionCName, callType, consumedCaptures }`. That map is populated by
`registerImplClosureCallMappings` in `src/codegen/exprs/closures.ts`.

In yo-self, `closures.yo`'s header documents that
`generateClosureConstruction`, `allocateClosureCapture`, and
`registerImplClosureCallMappings` are the **deferred Phase-3 closure-codegen
subsystem** (see `issues/yo-self-closure-codegen-gate.md`). yo-self has no
`impl_closure_call_map` on the codegen context.

`async.yo`'s sync-effect path side-steps the map by reading
`closure_function_value` + `capture_type` from the closure arg's **ExprInfo**, so
the closure function C name and capture struct C name ARE derivable that way. But
the spawn emitter additionally needs `consumedCaptures` (the `own(self)`-consumed
capture field names) to NULL them before the wrapper's drop, preventing a
double-free. `consumedCaptures` is tracked ONLY in `implClosureCallMap`; it is not
carried on yo-self ExprInfo. Porting the spawn emitter without it would silently
omit the RC-cleanup NULLing — an unfaithful correctness shortcut — so it is
blocked on either:

1. Porting `registerImplClosureCallMappings` + an `impl_closure_call_map` on the
   codegen context (the faithful path, unblocks `generateClosureConstruction`
   too), or
2. Threading `consumed_captures` onto ExprInfo at eval time and reading it here
   (a narrower bridge, mirrors how async.yo reads `closure_function_value`).

## Faithful-port note

Do NOT emit a partial spawn emitter that drops the capture struct without first
NULLing consumed fields — that reintroduces the double-free the TS
`generateSpawnWrapper` exists to prevent. Port the closure-call mapping first.

## Concrete repro + current failure (2026-06-19)

`/tmp/th.yo`:
```rust
{ println } :: import("std/fmt");
{ Thread } :: import("std/thread");
main :: (fn(io : Io) -> unit)({
  value := i32(42);
  thread := Thread.spawn((io) => { println(`thread sees ${value}`); });
  thread.join();
  println(`main done`);
});
export(main);
```
- TS reference → `thread sees 42` / `main done`.
- yo-self-bin → CRASHES at codegen, rc=134:
  `get_type_string: no C type name found for Io (type not collected before lowering)`.

So before/alongside the spawn emitter there is a **type-collection gap**: the
`Thread.spawn` closure's `io : Io` param type is never collected into
`context.types` (the spawn emitter doesn't exist, so the closure arg falls through
to a generic path that lowers `Io` without it being registered). The full fix is:
(1) port `generateThreadSpawnCall` / `generateWorkerSpawnCall` /
`generateSpawnWrapper` (`exprs/parallelism.ts`) into a new `yo-self/codegen/exprs/
parallelism.yo`, resolving the closure fn + capture struct the way `async.yo` does
(closure_function_value + capture_type from ExprInfo), and wiring the two
`__yo_thread_spawn` / `__yo_worker_spawn` extern names in `other_fn_call.yo`'s
`is_extern == "yo"` dispatch (mirrors other-fn-call.ts:906-916); (2) ensure the
spawn closure's param/capture types are collected (the `Io` crash); (3)
`consumedCaptures` for the own(self) NULLing remains the narrower deferred piece —
a fixture WITHOUT own(self) consumption (like the repro above) is faithful without
it and can land first. The parallelism RUNTIME (`runtime.yo`) is already in place,
so once the emitter lands a fixture is differential-testable end to end.
