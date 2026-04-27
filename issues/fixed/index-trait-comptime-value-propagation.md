# Index Trait Comptime Value Propagation Bugs

## Summary

Three related regressions introduced when routing Array/Slice indexing through the Index trait dispatch (`tryToCallWithIndexTrait`). All three stem from the `UnknownValue` with `isRuntimeOnly` flag that Index trait dispatch creates.

## Status: Fixed (all three bugs)

## Bug 1: `UnknownValue` leaks into enum/struct constructors

**Symptom:** Generated C code contains `/* skip generating: <comptime u8> */` instead of actual values.

**Root cause:** `tryToCallWithIndexTrait` (index-trait.ts:204-211) always returns `UnknownValue` with `isRuntimeOnly = true` for Index results. `UnknownValue` is truthy, so `memberValues.every((v) => !!v)` in enum constructor (function.ts) passes, creating an `EnumValue` with `UnknownValue` fields. `generateComptimeValue` then fails to emit these as C literals.

**Fix:** In function.ts, add `isRuntimeOnly` checks to both struct and enum constructor member value checks:

- Struct: `memberValues.some((v) => !v || (isUnknownValue(v) && v.isRuntimeOnly))`
- Enum: `memberValues.every((v) => !!v && !(isUnknownValue(v) && v.isRuntimeOnly))`

**Important:** Do NOT convert the value to `undefined` in the Index result handler — that breaks the dup/drop tracking in `setExprAsNeedsToCallDup` (expr.ts:2344), which checks `if (expr.$.value)` to skip dup for comptime values. Converting to `undefined` causes double-dup on RC types.

**Affected tests:** json.test.yo, tcp.test.yo, udp.test.yo, dns.test.yo, addr.test.yo

## Bug 2: Comptime pointer deref assignment blocked

**Symptom:** `p.* = (p.* + i32(1))` in a comptime function body fails with "Expected to return a compile-time value, but got runtime value".

**Root cause:** Assignment.ts line 953 added `!isUnknownValue(evaluatedLhs.$.value)` to exclude Index trait lvalue assignments from being marked comptime. But this also blocked comptime pointer deref assignments where LHS is a regular `UnknownValue` (not `isRuntimeOnly`) during function body analysis.

**Fix:** Narrow the check to only exclude `isRuntimeOnly` UnknownValues:

```typescript
!(isUnknownValue(evaluatedLhs.$.value) && evaluatedLhs.$.value.isRuntimeOnly);
```

**Affected tests:** comptime.test.yo "Test comptime Ptr value" (line 3733)

## Bug 3: `&(arr(0))` returns runtime pointer for comptime arrays

**Symptom:** `p :: &(arr(0))` fails with "Got runtime value" even when `arr` is a comptime array.

**Root cause:** In ptr-fns.ts, `indexTraitPtrType` was checked BEFORE `arrayElementRef`. Since the unified Index dispatch path sets both properties on the result expression, the `indexTraitPtrType` check won (returning `value: undefined` — runtime pointer), preventing the `arrayElementRef` path from creating a comptime `PtrValue`.

**Fix:** Reorder checks in ptr-fns.ts — check `arrayElementRef` first (comptime path), then `indexTraitPtrType` (runtime path).

**Affected tests:** comptime.test.yo "Test comptime Array value" (line 3751)

## Key insight: `isRuntimeOnly` on `UnknownValue`

The distinction between two flavors of `UnknownValue`:

- **Regular** (`isRuntimeOnly = false/undefined`): Created during comptime function body analysis. The value IS comptime — concrete value not yet known (will be resolved at call site).
- **Runtime-only** (`isRuntimeOnly = true`): Created by Index trait dispatch. The value genuinely only exists at runtime.

The fixes use this distinction to preserve comptime semantics while preventing runtime values from leaking into comptime contexts.

## Files changed

- `src/evaluator/calls/function.ts` — Bug 1 fix (struct + enum constructor checks)
- `src/evaluator/exprs/assignment.ts` — Bug 2 fix
- `src/evaluator/builtins/ptr-fns.ts` — Bug 3 fix
