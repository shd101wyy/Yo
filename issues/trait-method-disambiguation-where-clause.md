# Trait Method Disambiguation with Where-Clause Constraints

## Problem

When a type implements multiple traits that define methods with the same name, calling `self.method()` inside a generic function with `where(T <: Trait)` was ambiguous — the evaluator found methods from ALL implemented traits instead of only the constrained one.

```rust
T1 :: trait(get_number : (fn(self : Self) -> i32));
T2 :: trait(get_number : (fn(self : Self) -> i32));

Point :: struct(x : i32, y : i32);
impl(Point, T1(get_number : (self -> self.x)));
impl(Point, T2(get_number : (self -> self.y)));

// ERROR: "Ambiguous call" — found get_number from both T1 and T2
use_t1 :: (fn(forall(T : Type), self : T, where(T <: T1)) -> i32) {
  return self.get_number();
};
```

## Root Cause

Three issues in the evaluator and codegen pipeline:

### 1. Where-clause applied too late (helper.ts)

Where-clause constraints were applied AFTER argument processing. By the time method lookup happened, the SomeType `T` had already been replaced with the concrete type `Point` (which has both T1 and T2 impls), so trait filtering was impossible.

### 2. Parameter typed as concrete type (helper.ts)

When binding a runtime parameter like `self: T`, the evaluator used the concrete argument type (`Point`) instead of the constrained SomeType (`T`). This meant `self.get_number()` looked up methods on `Point` directly, finding both T1 and T2 methods.

### 3. No trait filtering in method lookup (env.ts)

`getReceiverMethodsByNameFromEnv` didn't filter impl'd traits by where-clause constraints when the receiver was a SomeType. Even if the SomeType had constraints, all matching impls were returned.

### 4. No concrete resolution for codegen (env.ts)

The "required traits" code path in `getReceiverMethodsByNameFromEnv` returned `createUnknownValue(...)` (no FunctionValue), which caused codegen to generate vtable-style dispatch instead of static dispatch.

### 5. SomeType ownership check too strict (env-lookup.ts)

After `synthesizeTypes` replaces `T=SomeType(T)` with `T=ConcreteType`, the `thisSomeTypeWasBound` ownership check in `getValueOfSomeTypeFromEnv` failed because it looked for a self-referential binding (`typeVal.value === someType`) that no longer existed.

## Fix

### Fix 1: Early where-clause application (helper.ts ~line 1316-1358)

Apply where-clause constraints BEFORE the argument processing loop. Guard: only fire when ALL where-clause LHS types are already-bound forall params in `calleeEnv`.

### Fix 2: Constrained SomeType binding (helper.ts ~line 520-538)

When binding a runtime parameter whose type is a constrained SomeType, use the SomeType as the binding type (not the concrete arg type). Guard: `!isParamCompileTimeOnly` to avoid breaking comptime params.

### Fix 3: Trait ID filtering (env.ts ~line 1739-1785)

Collect `constrainedTraitIds` from `getWhereClauseConstraintsForSomeType`. In the impl trait iteration, skip traits not in the constraint set.

### Fix 4: Concrete FunctionValue resolution (env.ts ~line 1905-1960)

After finding the abstract method from the trait, resolve the SomeType to its concrete type via `definitionFrameLevel`. Look up the concrete type's impl for the specific trait and extract `traitField.assignedValue.fields[implMethodIndex]` (TraitValue's fields array, not TypeField's assignedValue which is undefined for runtime methods).

### Fix 5: definitionFrameLevel fallback (env-lookup.ts ~line 167-198)

In the `thisSomeTypeWasBound` check, add a fallback: if no self-referential binding exists but the SomeType's `definitionFrameLevel` points to a variable with a matching concrete type, consider it bound. Cross-checks that the concrete type at `definitionFrameLevel` matches what the normal search found.

## Key Data Structure Insight

`TraitValue` has two layers:

- `traitValue.type.fields[i]` = TypeField (abstract method signature, `assignedValue` often undefined for runtime methods)
- `traitValue.fields[i]` = Value | undefined (concrete values — `FunctionValue` for impl methods)

Always use `traitValue.fields[i]` to get concrete method implementations, not `traitValue.type.fields[i].assignedValue`.

## Test Coverage

- `src/tests/fixme.yo`: Drives evaluator + codegen with `use_t1` (implicit) and `use_t2` (explicit dispatch)
- `tests/impl.test.yo`: "Test trait method disambiguation with where-clause constraints" — `use_trait_a`, `use_trait_b`, `use_trait_b_explicit`
