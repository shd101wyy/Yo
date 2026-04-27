# Acyclic cycle detection misses cycles through value-type structs

**Status:** FIXED

## Summary

`canTypeFormRcCycle` in `src/types/utils.ts` did not traverse through value-type struct fields when checking for RC cycles. This caused types like:

```rust
WrapA :: (fn(comptime(T) : Type) -> comptime(Type))(struct(inner: T));
Node :: atomic object(data: i32, child: Option(WrapA(Self)));
```

to incorrectly auto-derive `Acyclic`, despite having a clear cycle: `Node` → `Option(WrapA(Node))` → `WrapA(Node)` → `struct(inner: Node)` → `Node`.

## Root Cause

In `typeCanFormCyclicRcReference`, when encountering a struct type:

```typescript
if (isStructType(type) && type.isReferenceSemantics) {
  return canTypeFormRcCycle(type, new Set(visitedTypes), env);
}
```

Only RC objects (`isReferenceSemantics = true`) were recursed into. Value-type structs fell through to `return false`, completely skipping their fields. But value-type structs can contain RC pointers as inline fields — an `atomic object` reference stored inside a `struct` is still an RC pointer that participates in cycle formation.

## Fix

Added traversal through value-type struct fields, matching the existing pattern for enums, tuples, and unions:

```typescript
if (isStructType(type) && !type.isReferenceSemantics) {
  for (const field of type.fields) {
    if (
      typeCanFormCyclicRcReference(
        field.type,
        originalRefStruct,
        visitedTypes,
        env
      )
    ) {
      return true;
    }
  }
}
```

## Impact

Any `atomic object` with self-references through value-type struct intermediaries (generic wrapper types, newtypes, etc.) now correctly does NOT auto-derive `Acyclic`.

Non-cyclic types like `WrapA(i32)` are unaffected — they still correctly derive `Acyclic`.
