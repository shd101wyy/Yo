# Comptime enum match: wildcard body prevents compile-time resolution

## Bug

When a `match` expression has a compile-time known enum scrutinee, the result value was not resolved to a concrete value if wildcard `_` was present alongside the matching branch.

```rust
MyEnum :: enum(A, B, C);
v :: MyEnum.A;
r :: match(v, .A => true, _ => false);
// r was `<comptime bool>` (UnknownValue) instead of concrete `true`
```

## Root cause

In `src/evaluator/exprs/match.ts`, when the scrutinee is a known `EnumValue`:

1. Non-matching named variants are skipped via `continue` (line ~387)
2. The matching named variant body IS evaluated and pushed to `bodies`
3. The wildcard `_` body is ALSO evaluated (for type checking) and pushed to `bodies`

This results in `nonReturnBodies.length === 2`. The existing check required `nonReturnBodies.length === 1` to extract the matched body's concrete value. Since there were 2 bodies, it fell through to `createUnknownValue(...)`.

## Fix

Added `matchedBodyIndex` tracking. When a body is pushed, if the scrutinee is a known enum value and the variant matches (or is wildcard `_` as fallback), record the index. The result computation uses this index to find the correct matched body, regardless of how many total bodies exist.

The fix correctly handles:

- Enum with matching variant + wildcard: uses the matching variant's body
- Enum with only wildcard: uses the wildcard's body
- Single-body match: fallback to the existing `nonReturnBodies.length === 1` heuristic

## Files changed

- `src/evaluator/exprs/match.ts`

## Impact

This fix enables compile-time enum matching to fully resolve in all contexts, including:

- `TypeKind.is_struct()` and other guard methods that use `match(self, .Variant => true, _ => false)`
- Any comptime function that pattern-matches on an enum value
- Previously worked in `./yo-cli compile` but failed in `./yo-cli test` due to different evaluation contexts
