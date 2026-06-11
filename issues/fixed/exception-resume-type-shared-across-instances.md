# Exception `ResumeType` SomeType Shared Across Instances

**Status:** FIXED (2026-06-11). Implemented the issue's "fresh SomeType
instance per struct-field call" proposal at the struct-construction site:
`instantiateOwnForallSomeTypes` in `src/evaluator/calls/type.ts` clones the
SomeTypes named by a field function type's OWN `forallParameters`
(`throw : ctl(forall(ResumeType : Type), …) -> ResumeType`) per
construction, so resolving a handler's return type cannot leak into other
constructions — the declared field type stays pristine. Enclosing-context
SomeTypes keep their identity (cross-argument unification unaffected).
Regression tests: tests/exception_resume_type_per_instance.test.yo
(two instances resuming i32 and String in one scope, type-check + runtime).
Note: the forall parameter is stripped from `parameters` during function
type evaluation — it lives in `forallParameters` (that's why a
parameters-based detection finds nothing).

**Discovered:** During yo-self test suite fixes (Phase 6m).

## Symptom

When two or more `given(exn) := Exception(throw: handler)` bindings are evaluated in the same module, the second handler fails with a type mismatch like:

```
Incompatible return type: Expected: ResumeType, Got: Output
```

even though the handler body is correct.

## Root cause

`Exception` is defined as:

```rust
Exception :: struct(
  throw : fn(forall(ResumeType : Type), error : AnyError) -> ResumeType
)
```

The `forall(ResumeType : Type)` parameter introduces a `SomeType` object. In the current evaluator, this `SomeType` is **shared** across all `Exception` instances evaluated in the same module — it is not freshly instantiated per struct-field call.

When the first `given(exn1) := Exception(throw: handler1)` is evaluated and `handler1` returns a value of type `ExitStatus`, the evaluator records:

```
ResumeType.resolvedConcreteType = ExitStatus
```

When the second `given(exn2) := Exception(throw: handler2)` is evaluated, the same `SomeType` object already has `resolvedConcreteType = ExitStatus`. If `handler2` returns `Output`, the compatibility check fails:

```
Output ≠ ExitStatus
```

The key code path is in `src/evaluator/values/anonymous-function.ts` around lines 1117-1138: the `resolveConcreteType` step is skipped when `resolvedConcreteType` is already set — it relies on `ResumeType` being fresh per call, but it's not.

## Affected code

- `src/evaluator/values/anonymous-function.ts` — `SomeType` resolution during function call evaluation
- `std/error.yo` — `Exception` struct definition with the shared `forall(ResumeType : Type)` parameter

## Workaround

Ensure all `Exception` handlers in a module return the same type, OR avoid multiple `given(exn)` bindings with different return types in the same module.

In `yo-self/pkg-config/pkg_config.yo`, the workaround was to remove the local `given(...)` handlers and propagate exceptions through the outer `exn` parameter directly.

## Proper fix

The evaluator should create a **fresh `SomeType` instance per struct-field function call** for struct fields whose type contains `forall` parameters. This ensures `ResumeType.resolvedConcreteType` is independent across different `Exception` instances.

Alternatively, reset `resolvedConcreteType` to `undefined` before each `throw` field evaluation during `Exception(throw: ...)` struct construction.

## Files to fix

- `src/evaluator/values/anonymous-function.ts`
- Possibly `src/evaluator/calls/function-type.ts` (where struct field SomTypes are created)
