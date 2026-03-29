# Type Synthesizer Review — Known Issues and Improvement Opportunities

A review of `src/evaluator/types/synthesizer.ts`, `src/types/compatibility.ts`, and related files. Issues are ordered by severity.

---

## Issue 1: Asymmetric SomeType–SomeType binding when both are unbound

**File:** `src/evaluator/types/synthesizer.ts`, line 242

**Problem:**

When `synthesizeTypes` encounters two unbound SomeTypes (e.g., forall `T` vs forall `U`), it binds both to `given.type`. The code has a comment:

```typescript
const value = createTypeValue(
  given.type // NOTE: Using expected.type here causes some errors in tests
);
```

This is asymmetric — `synthesizeTypes(A, B)` and `synthesizeTypes(B, A)` may produce different results. The comment suggests this was a pragmatic fix to avoid test failures, but the real cause was never investigated.

**Risk:** Could produce wrong type bindings if the call order is ever reversed (e.g., during trait matching where expected/given conventions differ). Difficult to reproduce since it only triggers when both sides are completely unconstrained SomeTypes.

**Proposed fix:** Investigate why `expected.type` causes test failures. The correct behavior should be either symmetric (both bound to a fresh unification variable) or explicitly documented with the directional semantics.

---

## Issue 2: `occursCheck` missing coverage for TypeApplication, Trait, Module, and Union types

**File:** `src/evaluator/types/synthesizer.ts`, lines 59–133

**Problem:**

The `occursCheck` function prevents infinite types by checking whether a SomeType ID appears inside a given type. It handles: Struct, Enum, Tuple, Array/Slice, Ptr (skipped), Iso, Arc, Function, Future, FnTrait. But it does **not** check inside:

- `TypeApplicationType` (e.g., `F(T)` — SomeType could appear in `args`)
- `TraitType` (fields could contain the SomeType)
- `ModuleType` (fields could contain the SomeType)
- `UnionType` (variants could contain the SomeType)

The function falls through to `return false` for these, meaning `occursCheck` would allow binding `T = SomeTrait(T)` or `T = F(T)` without error.

**Risk:** Currently low because these patterns are rare and TypeApplication is resolved before most synthesis. But as the type system grows more complex (especially with HKT), this could lead to infinite type construction that hangs the compiler.

**Proposed fix:** Add `occursCheck` branches for TypeApplication (check `args`), TraitType (check `fields`), ModuleType (check `fields`), and UnionType (check `variants`).

---

## Issue 3: Name-based SomeType fallback in synthesis

**File:** `src/evaluator/types/synthesizer.ts`, line 373–375

**Problem:**

When checking if a SomeType is already bound in the environment, the code falls back to name-based matching:

```typescript
if (
  isSomeType(type) &&
  (type.id === expected.type.id ||
    // QUESTION: Is this condition below needed?
    type.name === expected.type.name)
)
```

The `type.name === expected.type.name` fallback means two completely unrelated SomeTypes that happen to share the same name (e.g., two different `T` from different forall scopes) could be treated as the same. This is dangerous when multiple generic functions are nested.

**Risk:** Medium. In practice, frame-level scoping usually prevents this. But if two forall scopes are active simultaneously (e.g., during trait method specialization where both the trait and the impl have a `T`), the name-based fallback could pick the wrong binding.

**Proposed fix:** Remove the name-based fallback or add a frame-level check alongside it. The `id`-based check should be sufficient since SomeTypes have unique IDs.

---

## Issue 4: `visitedPairs` not passed for function type compatibility

**File:** `src/types/compatibility.ts`, line 608

**Problem:**

When comparing function types for compatibility, `visitedPairs` is not passed through:

```typescript
if (isFunctionType(expected.type) && isFunctionType(given.type)) {
  return areFunctionTypesCompatible(
    { type: expected.type, env: expected.env },
    { type: given.type, env: given.env },
    requireExactMatch
    // TODO: pass visitedPairs?
  );
}
```

This means cycle detection doesn't work for recursive function types. If a type contains a function type that references the parent type (e.g., a callback that takes `Self`), the cycle detection set won't prevent infinite recursion.

**Risk:** Low-medium. Most recursive types use pointers or `Option`, so the function type path is rarely the cycle source. But it could theoretically cause stack overflow on pathological recursive types.

**Proposed fix:** Add `visitedPairs` parameter to `areFunctionTypesCompatible` and pass it through.

---

## Issue 5: Silent `false` return for unbound SomeTypes in compatibility check

**File:** `src/types/compatibility.ts`, lines 922–923 and 948–950

**Problem:**

When `areTypesCompatible` encounters a SomeType and tries to resolve it from the environment, if the resolution returns the same SomeType (i.e., it's unbound), the function silently returns `false`:

```typescript
const expectedType_ = getValueOfSomeTypeFromEnv(expected.env, expected.type);
if (expected.type === expectedType_) {
  return false; // Silently incompatible
}
```

This means if a forall parameter is never bound (synthesis was skipped or failed silently), the compatibility check treats it as "incompatible" rather than raising an error.

**Risk:** Makes debugging type errors harder. A function call with an unresolved forall parameter will fail with a generic "type mismatch" error rather than "unresolved type parameter T".

**Proposed fix:** Consider adding a diagnostic mode or warning when a SomeType remains unbound at a point where it should have been resolved by synthesis.

---

## Issue 6: `DynType` compatible with any `SomeType` without validation

**File:** `src/types/compatibility.ts`, lines 705–708

**Problem:**

```typescript
if (isSomeType(expected.type)) {
  // QUESTION: Is this correct?
  if (isDynType(given.type)) {
    return true; // DynType is compatible with SomeType
  }
```

`DynType` is unconditionally compatible with any `SomeType`, even if the SomeType has required trait constraints. This means `dyn(value)` can be passed where `T <: SomeTrait` is required, bypassing the constraint check at compile time.

**Risk:** Medium. The `dyn` mechanism is an explicit escape hatch, so some flexibility is expected. But skipping trait constraint validation entirely could mask bugs — a `dyn` value that doesn't actually implement the required trait would crash at runtime.

**Proposed fix:** Check that the `DynType`'s underlying traits are compatible with the SomeType's `requiredTraits` before returning `true`.

---

## Issue 7: PlaceholderToken used for synthesized variable bindings

**File:** `src/evaluator/types/synthesizer.ts`, lines 407–408

**Problem:**

When the synthesizer creates a new variable binding for a resolved SomeType, it uses `PlaceholderToken` for both `token` and `initializedAtToken`:

```typescript
token: PlaceholderToken, // FIXME: What should be `token` here?
initializedAtToken: PlaceholderToken,
```

This means if a later error references this binding (e.g., "variable T was defined at ..."), the error message will point to a placeholder position rather than the actual source location where the type was inferred.

**Risk:** Low — only affects error message quality. Does not cause incorrect behavior.

**Proposed fix:** Pass the token from the function call or argument expression where synthesis occurs. This requires threading a `token` parameter through `synthesizeTypes`.

---

## Issue 8: Effect row spread binding doesn't validate matched params

**File:** `src/evaluator/types/synthesizer.ts`, lines 1078–1095

**Problem:**

When an unsolved effect row spread is bound to remaining unmatched implicit parameters, there's no validation that the remaining params are actually valid effects:

```typescript
// 3. Bind the single unsolved spread to remaining unmatched given params
if (unsolvedSpreads.length === 1) {
  const remaining: FunctionImplicitParameter[] = [];
  for (let j = 0; j < givenImplicit.length; j++) {
    if (!matchedGiven.has(j)) {
      remaining.push(givenImplicit[j]!);
    }
  }
  // Directly creates EffectsRowType from ALL remaining params
  const effectsRow = createEffectsRowType(remaining);
```

Any unmatched given params get swept into the effect row, even if they don't semantically represent effects or if they were supposed to match a concrete expected param that was skipped.

**Risk:** Low. Effect parameters are validated elsewhere in the pipeline. But if a concrete expected param fails to match (e.g., due to a subtle type mismatch), it silently gets absorbed into the effect row rather than producing an error.

**Proposed fix:** After concrete matching, verify that all concrete expected params were matched. If any concrete expected param has no match, throw an error before binding the spread.

---

## Non-Issues (Verified as Correct)

### TypeApplication never reaches codegen ✓

TypeApplication types (`F(A)`) are fully resolved during evaluation/specialization. No references to TypeApplication exist in `src/codegen/`. This is correct by design.

### Pointer occurs-check skip ✓

`occursCheck` intentionally skips pointer types (`*(T)`) because pointer indirection is a valid way to create recursive types (e.g., `Node { next: *(Node) }`). This is correct.

### checkedTypePairs cycle prevention ✓

The `synthesizeTypes` entry point tracks checked type pairs by object identity to prevent infinite recursion on recursive struct/enum types. This works correctly.

---

## Summary

| #   | Issue                                                  | Severity | File             | Line     |
| --- | ------------------------------------------------------ | -------- | ---------------- | -------- |
| 1   | Asymmetric SomeType–SomeType binding                   | Medium   | synthesizer.ts   | 242      |
| 2   | occursCheck missing TypeApplication/Trait/Module/Union | Medium   | synthesizer.ts   | 59–133   |
| 3   | Name-based SomeType fallback                           | Medium   | synthesizer.ts   | 373–375  |
| 4   | visitedPairs not passed for function types             | Low-Med  | compatibility.ts | 608      |
| 5   | Silent false for unbound SomeTypes                     | Low-Med  | compatibility.ts | 922, 949 |
| 6   | DynType bypasses SomeType constraints                  | Medium   | compatibility.ts | 705–708  |
| 7   | PlaceholderToken for synthesized bindings              | Low      | synthesizer.ts   | 407      |
| 8   | Effect row spread swallows unmatched params            | Low      | synthesizer.ts   | 1078     |
