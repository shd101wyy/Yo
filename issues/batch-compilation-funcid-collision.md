# Batch Compilation FuncId Collision

## Problem

When batch compiling multiple tests into a single binary, different nominal types
with the same display name (e.g., `Counter :: object(count : i32)` defined in
separate test scopes) produced the same function specialization `funcId`.

The evaluator correctly created separate specializations (the cache check using
`areTypesCompatible` with `requireExactMatch: true` returns `false` for types with
different IDs). However, both specializations received the same `funcId` string,
because `valueToSignatureString` only included the type ID for anonymous types
(those without `typeName`).

The codegen (`collection.ts`) uses `context.functions[functionValue.funcId]` as a
deduplication key. With identical funcIds, only the first specialization was
collected, causing the second to use the wrong C struct types — leading to
incompatible pointer type errors.

## Root Cause

In `src/evaluator/calls/helper.ts`, `valueToSignatureString` had:

```typescript
if (!type.typeName && type.id) {
  // Only anonymous types
  return `${valueToString(value)}_id${type.id}`;
}
```

Named types like `Counter` (which have `typeName = "Counter"`) got only their
display name in the signature, regardless of their unique type ID.

## Fix

Always include the type ID in the signature for all TypeValues:

```typescript
if (type.id) {
  // All types with IDs
  return `${valueToString(value)}_id${type.id}`;
}
```

This ensures different nominal types produce different funcIds, even when they
share the same display name. The same logical type (e.g., `Option(i32)`) always
has the same ID (from comptime function caching), so no duplicate specializations
are created.

## Impact

- Fixed incompatible pointer types in batch-compiled tests (especially on WASM
  where Clang 16+ promoted this from warning to hard error)
- Removed the `-Wno-incompatible-pointer-types` workaround flag from all compiler
  flag sets
- C function names are slightly longer (include type IDs) but functionally correct

## Files Changed

- `src/evaluator/calls/helper.ts`: `valueToSignatureString` and runtime parameter
  signature — always include type ID
- `src/codegen/index.ts`: Removed `-Wno-incompatible-pointer-types` flag
- `src/test-runner.ts`: Removed `-Wno-incompatible-pointer-types` flag
