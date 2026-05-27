# Option(FnType) — "No C type name found" during codegen

**Status:** fixed (2026-05-27, commit `ecf5fd12`)

## Symptom

Building `yo-self-bin` from `yo-self/main.yo` fails with:

```
error: No C type name found for enum Option(EvaluateExprRawFn)
  (.Some selected) (id=enum_yo1c2129e9_id_66866)
```

## Root cause

`Option(EvaluateExprRawFn)` is an enum with a `.Some` variant whose field holds
`EvaluateExprRawFn` (a function-type alias). The generic `Option(T)` type's
concrete instantiation carries a resolved `SomeType` for `T` inside the variant
field.

Three codegen passes skip any type where `typeContainsSomeType(type)` returns
true, but the exception for fn-typed fields was only implemented for **struct**
types (`structSomeTypeIsOnlyInFunctionFields`). Enum types like `Option(T)` with
fn-typed variant fields were wrongly skipped in:

1. **Type collection** (`collection.ts:collectType`) — the type never got a cName
2. **Forward declaration pass** (`generation.ts:forward-decl loop`) — no typedef emitted
3. **Sorted type declaration pass** (`generation.ts:sortedTypes loop`) — no struct generated
4. **Nullable-pointer optimization pass** (`generation.ts:4th pass`) — skipped

## Fix

Added `enumSomeTypeIsOnlyInFunctionFields(…)` helper to both `collection.ts` and
`generation.ts`. The helper checks that all SomeType content in an enum lives in
function-typed variant fields (which become `void*` fn-ptrs in C).

Extended all four filter sites to apply the enum exception alongside the
existing struct exception.

Also added `TypeTag.Function → "void*"` case in `getTypeString()` so function
types in enum fields get a concrete C representation.

## Files changed

- `src/codegen/types/collection.ts`
- `src/codegen/types/generation.ts`
- `src/codegen/utils/index.ts`
