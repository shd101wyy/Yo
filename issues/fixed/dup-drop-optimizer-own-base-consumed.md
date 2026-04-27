# Dup/Drop Optimizer: Own-consumed Base Variable Skips Essential Dup

## Summary

When a derived variable `b := a` is created via dup, and the base variable `a`
is later consumed by an `own()` parameter call, the dup/drop optimizer
incorrectly cancels `dup(a)→b` with `drop(b)` at scope end. This leaves `a`
with rc=1 instead of rc=2, causing COW to mutate in-place and corrupt `b`'s
view of the data.

## Reproduction

```rust
{ String } :: import "std/imm/string";

main :: (fn() -> unit)({
  a := String.from("hello");
  b := a;                         // dup(a) → b, rc=2
  c := a.concat(String.from(" world"));  // own(self) consumes a
  // Bug: optimizer canceled dup(a) with drop(b), so rc was 1
  // COW path fired → mutated "hello" buffer in-place
  assert((b == String.from("hello")), "b should be unchanged");
});
```

## Root Cause

The dup/drop optimizer in `begin.ts` tracks consumed **derived** variables via
`consumedDerivedCountByBase`, but didn't check if the **base** variable itself
was consumed. When:

1. `b := a` → dup(a), b.isOwningTheSameRcValueAs = a
2. `a.concat(own)` → consumes `a` (the base)
3. `b` is in `variablesNeedingDrop` → optimizer finds base `a`
4. `consumedDerivedCountByBase[a] == 0` (no derived consumed)
5. `runtimeDupCount == 1` → optimizer cancels dup+drop

The optimizer didn't realize `a` (the base) was consumed, making the dup for `b`
essential.

## Fix

In `src/evaluator/exprs/begin.ts`, added a check for whether the base variable
itself is consumed:

```typescript
let baseConsumed = false;
if (baseVariable !== variable && topFrame) {
  for (const v of topFrame.variables) {
    if (v.id === baseId && v.consumedAtToken) {
      baseConsumed = true;
      break;
    }
  }
}

if (consumedDups > 0 || baseConsumed) {
  // Keep all dups and drops
  variablesActuallyNeedingDrop.push(variable);
}
```

## Affected Files

- `src/evaluator/exprs/begin.ts` — dup/drop optimizer section

## Related Issues

- Prior Bug 1: `consumedDerivedCountByBase` tracking (consumed derived variable)
- This is the complementary case: consumed base variable with live derived copies
