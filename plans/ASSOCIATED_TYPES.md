# Associated Types in Traits — Design & Implementation Plan

## Motivation

Currently, traits with associated types in Yo use a **function wrapper** pattern:

```rust
Iterator :: (fn(comptime(Item) : Type) -> comptime(Trait)) {
  return trait(
    Item := Item,
    next : (fn(self : *(Self)) -> Option(Self.Item))
  );
};
```

This means `Iterator` is a _function_ that returns a trait, not a trait itself. `Iterator(i32)` calls the function, producing a new TraitType with `Item := i32`. Every call produces a distinct TraitType with a unique ID.

Rust's approach is cleaner — `Iterator` is a single trait with one identity. Its `Item` is an **associated type** declared inside the trait:

```rust
pub trait Iterator {
    type Item;
    fn next(&mut self) -> Option<Self::Item>;
}
```

This plan redesigns Yo's traits to follow the Rust model.

---

## Proposed Syntax

### Trait definition

```rust
Iterator :: trait(
  Item : Type,
  next : (fn(self : *(Self)) -> Option(Self.Item))
);
```

- `Iterator` is a TraitType directly, not a function.
- `Item : Type` declares an unassigned associated type (already supported by `evaluateTraitType` — produces an `unassignedSomeType` field).
- `next : (fn(...))` declares a method (unchanged).

### impl — providing associated types

Use `:` to provide values for all fields (associated types and methods together):

```rust
// Concrete impl
impl(Counter, Iterator(
  Item : i32,
  next : (fn(self : *(Self)) -> Option(Self.Item))(body)
));

// Generic impl
impl(forall(T : Type), MyIter(T), Iterator(
  Item : T,
  next : (fn(self : *(Self)) -> Option(Self.Item))(body)
));
```

The `:` syntax is consistent with existing trait value creation — `tryToImplementTraitWithArgumentsByTraitType` already handles labeled arguments with `:`.

### Where clause — constraining associated types

Use `:=` to constrain associated types in where clauses and trait specialization contexts:

```rust
IntoIterator :: trait(
  Item : Type,
  IntoIter : Type,
  into_iter : (fn(self : Self) -> Self.IntoIter),
  where(Self.IntoIter <: Iterator(Item := Self.Item))
);
```

**Why `:=` instead of `:`?**

- `:` inside a trait type call creates a **TraitValue** (requires ALL fields — associated types + methods). This is for impl.
- `:=` inside a trait type call creates a **specialized TraitType** (binds only associated types). This is for where clauses and type constraints.
- Different syntax for different semantics: providing vs constraining.
- `:=` matches Yo's "constant binding" semantics and mirrors how associated values are stored in trait definitions (`Item := Item`).

**Alternative considered**: `=` (Rust uses `Iterator<Item = T>`). Rejected because `=` in Yo is the mutable assignment operator. `:=` is the constant binding operator, which is closer to the intended semantics.

---

## How It Works (Evaluator Analysis)

### Phase 1: Direct trait types — what already works

The `evaluateTraitType` function in `src/evaluator/types/trait.ts` already handles:

1. `Item : Type` → creates field with `unassignedSomeType` placeholder
2. Binds the SomeType in the scoped env so `Self.Item` resolves within the trait body
3. `next : (fn(self : *(Self)) -> Option(Self.Item))` → function type with SomeType for Item

When `Iterator :: trait(...)`, `Iterator` is a TypeValue containing a TraitType (not a function).

### Phase 1: Calling a direct TraitType

When you write `Iterator(Item : T, next : fn_body)`:

1. `Iterator` evaluates to TypeValue(TraitType)
2. The function call dispatcher (`src/evaluator/calls/function.ts:1980`) detects TraitType callee
3. Routes to `tryToImplementTraitWithArgumentsByTraitType` (`src/evaluator/calls/trait-type.ts`)
4. For each labeled argument:
   - `Item : T` → finds `Item` field (no `assignedValue`), evaluates `T` to TypeValue(SomeType_T), stores it
   - `next : fn_body` → finds `next` field, re-evaluates type expr with `Self.Item` now bound, evaluates fn_body
5. Creates TraitValue with all fields filled

**No evaluator changes needed for this path.**

### Phase 1: Generic impl registration

`impl(forall(T), MyIter(T), Iterator(Item : T, next : fn_body))`:

1. `forall(T)` creates SomeType_T
2. `Iterator(Item : T, next : ...)` creates TraitValue with fields containing SomeType_T
3. `extractTraitTypeArgsFromImplExpr` — since `Iterator` is an atom (not a nested function call), returns `{}` (no `traitTypeArgExprs`)
4. `getBaseTraitKey(traitType)` — since `traitType.functionValue` is undefined, uses `typeName || id`
5. `extractTraitTypeArgsFromImplExpr` extracts labeled arguments for non-function fields from direct trait calls (e.g., `Iter(Item: T, ...)` → `traitTypeArgExprs = [T]`, `traitFunctionParamNames = ["Item"]`)
6. GenericImpl stored with correct `traitTypeArgExprs`

### Phase 1: Associated type resolution (Self.Item)

`findAssociatedTypeFromGenericImpls` in `src/evaluator/values/impl.ts:986`:

1. Tries the `traitTypeArgExprs` re-evaluation path → skipped (undefined)
2. Falls through to the **fallback path** (line ~1083):
   - Gets `fieldValue = impl.traitValue.fields[0]` → TypeValue(SomeType_T)
   - `isSomeType(fieldValue.value)` → true
   - Loops through `forallParameters`, finds `param.someType === SomeType_T`
   - Gets substitution from match: `T → i32`
   - Returns TypeValue(i32)

**No evaluator changes needed!** The fallback path already handles SomeType resolution for non-parameterized traits.

### Phase 2: Constrained trait types (`:=` syntax)

When you write `Iterator(Item := i32)`:

1. `Iterator` evaluates to TypeValue(TraitType)
2. Calling TraitType with `:=` arguments → new code path needed
3. Instead of creating a TraitValue (which requires ALL fields), creates a **specialized TraitType**:
   - Copy the base TraitType
   - Bind the specified associated types (replace `unassignedSomeType` with concrete value)
   - Leave method fields untouched
   - Return TypeValue(specializedTraitType)

The specialized TraitType has the same `functionValue` (undefined) and same `typeName`, but with some associated type fields bound. This is used in where clauses for constrained matching.

### Phase 2: Trait matching with constraints

`typeImplementsTrait(concreteType, specializedTraitType)`:

1. Check base trait match (same trait identity)
2. For each bound associated type field in the specialized trait:
   - Resolve the concrete type's associated type value
   - Check equality with the constraint

---

## Implementation Plan

### Phase 1: Verify direct trait types work ✅ Done

**Goal**: Confirm that `trait(Item : Type, ...)` defined directly (not via function) works for impl, method dispatch, and `for` macro.

**Changes made**:

- Modified `extractTraitTypeArgsFromImplExpr` in `src/evaluator/values/impl.ts` to handle direct trait types by extracting labeled arguments for non-function fields (associated types). This allows `traitTypeArgExprs` re-evaluation to work for both function-based and direct trait types.

**Test in `src/tests/fixme.yo`**:

```rust
// Define trait directly (no function wrapper)
Iter :: trait(
  Item : Type,
  next : (fn(self : *(Self)) -> Option(Self.Item))
);

// Simple concrete case
Counter :: struct(_current : i32, _max : i32);

impl(Counter, Iter(
  Item : i32,
  next : (fn(self : *(Self)) -> Option(Self.Item))(cond(
    (self._current >= self._max) => .None,
    true => {
      val := self._current;
      self._current = (self._current + i32(1));
      .Some(val)
    }
  ))
));

// Generic case
MyIter :: (fn(comptime(T) : Type) -> comptime(Type))(
  struct(_data : *(T), _index : usize, _len : usize)
);

impl(forall(T : Type), MyIter(T), Iter(
  Item : T,
  next : (fn(self : *(Self)) -> Option(Self.Item))(cond(
    (self._index >= self._len) => .None,
    true => {
      val := (self._data &+ self._index).*;
      self._index = (self._index + usize(1));
      .Some(val)
    }
  ))
));

// Test: concrete impl with for macro
// Test: generic impl with for macro
// Test: Self.Item resolution → Counter.Item == i32
```

**Expected**: Works with zero evaluator changes. If it fails, diagnose and fix.

### Phase 2: `:=` syntax for trait specialization ✅ Done

**Goal**: Support `Trait(AssocType := ConcreteType)` to create a specialized TraitType for where clause constraints.

**Changes made**:

1. **`src/types/definitions.ts`**: Added `associatedTypeConstraints` field to `TraitType` interface to store associated type constraints for specialized traits.

2. **`src/evaluator/context.ts`**: Added `TraitSpecializationResult` interface and `"trait-specialization"` result kind.

3. **`src/evaluator/calls/trait-type.ts`**: Added `tryToSpecializeTraitType` function that handles `:=` arguments, validates they're associated type fields, evaluates constraint types, and creates a specialized TraitType copy with `associatedTypeConstraints`.

4. **`src/evaluator/calls/function.ts`**: Added dispatch for `:=` trait calls to `tryToSpecializeTraitType`. Added handling for `"trait-specialization"` result kind that returns TypeValue(specializedTraitType).

5. **`src/evaluator/trait-checking.ts`**: Added `checkAssociatedTypeConstraints` helper function that resolves associated types and checks compatibility with constraints. Called from `typeImplementsTrait`.

6. **`src/evaluator/types/trait.ts`**: Modified `parseTraitWhereClauseConstraints` to collect LHS resolution failures as pending traits (not just RHS failures), allowing `where(Self.IntoIterType <: Iter(Item := Self.Item))` to work.

7. **`src/evaluator/values/impl.ts`**: Modified `extractTraitTypeArgsFromImplExpr` to handle direct trait types (see Phase 1 changes).

### Phase 3: IntoIterator trait + where clause enforcement ✅ Done

**Goal**: Define IntoIterator using the new associated type syntax with where clause constraint. Enforce where clause constraints during concrete impl registration.

**Changes made**:

1. **`src/evaluator/types/trait.ts`**: Modified `applySingleTraitConstraintForTrait` to persist where clause constraints directly on SomeType's `requiredTraits`/`negativeTraits` arrays (in addition to env frame storage). This is needed because env frames are popped after trait evaluation, but constraints must remain accessible during impl registration.

2. **`src/evaluator/calls/trait-type.ts`**: Added where clause constraint checking in `tryToImplementTraitWithArgumentsByTraitType`. After all fields are bound:

   - Iterates trait fields with `unassignedSomeType` that have `requiredTraits`
   - Skips fields whose bound type still contains SomeTypes (generic impl — deferred to instantiation)
   - Resolves SomeTypes in `associatedTypeConstraints` to their concrete bound values by matching against other trait fields
   - Calls `typeImplementsTrait` to verify the constraint

3. **`src/evaluator/trait-checking.ts`**: Fixed `checkAssociatedTypeConstraints` to look inside TraitValues for associated types. When checking a TraitValue whose type matches the constraint's trait id, looks at the TraitValue's fields by label to find the associated type value. Previously only checked direct fields on the target type, missing associated types stored inside nested TraitValues.

**Test in `src/tests/fixme.yo`**:

```rust
IntoIter :: trait(
  Item : Type,
  IntoIterType : Type,
  into_iter : (fn(self : Self) -> Self.IntoIterType),
  where(Self.IntoIterType <: Iter(Item := Self.Item))
);

// Concrete impl — Counter's IntoIterType is Counter (which implements Iter with Item=i32) ✅
impl(Counter, IntoIter(
  Item : i32,
  IntoIterType : Counter,
  into_iter : (fn(self : Self) -> Self.IntoIterType)(Counter(_current: i32(10), _max: i32(13)))
));

// Bad impl — BadIter's Iter has Item=bool, but IntoIter claims Item=i32 ❌ Correctly rejected
// impl(BadStruct, IntoIter(Item : i32, IntoIterType : BadIter, ...));
// Error: "Where clause constraint not satisfied: BadIter does not implement Iter(Item := i32)"

// Generic impl — Wrapper(T)'s IntoIterType is MyIter(T) (which has SomeType T) → deferred ✅
impl(forall(T : Type), Wrapper(T), IntoIter(
  Item : T,
  IntoIterType : MyIter(T),
  into_iter : (fn(self : Self) -> Self.IntoIterType)(MyIter(T)(...))
));
```

### Phase 4: Migrate prelude.yo and std library ✅ Done

Migrated all Iterator and IntoIterator definitions + impls from the function-wrapper pattern to direct trait syntax.

**Changes made**:

1. **`std/prelude.yo`**: Replaced `Iterator` and `IntoIterator` function wrappers with direct trait definitions. Updated `ArrayIterPtr` and `SliceIterPtr` impls.
2. **`std/collections/array_list.yo`**: Updated `ArrayListIter` and `ArrayListIterPtr` impls.
3. **`std/collections/linked_list.yo`**: Updated `LinkedListIter` and `LinkedListIterPtr` impls.
4. **`std/collections/deque.yo`**: Updated `DequeIter` and `DequeIterPtr` impls.
5. **`std/collections/hash_map.yo`**: Updated `HashMapIter`, `HashMapIterPtr`, `HashMapKeys`, `HashMapValues` impls.
6. **`std/collections/hash_set.yo`**: Updated `HashSetIter` and `HashSetIterPtr` impls.
7. **`std/collections/btree_map.yo`**: Updated `BTreeMapIter`, `BTreeMapIterPtr`, `BTreeMapKeys`, `BTreeMapValues` impls.
8. **`std/collections/priority_queue.yo`**: Updated `PriorityQueueIter` and `PriorityQueueIterPtr` impls.
9. **`std/string/string.yo`**: Updated `StringChars` (rune) and `StringBytes` (u8) impls.

**Pattern**: `Iterator(T)(next : ...)` → `Iterator(Item : T, next : ...)`

**Not migrated**: Other function-wrapper traits (Add, Sub, Eq, Ord, TryFrom, TryInto, etc.) — see Open Questions.

---

## Key Evaluator Functions (Reference)

| Function                                      | File                                | Line | Role                                                    |
| --------------------------------------------- | ----------------------------------- | ---- | ------------------------------------------------------- |
| `evaluateTraitType`                           | `src/evaluator/types/trait.ts`      | 838  | Creates TraitType from `trait(...)` expression          |
| `tryToImplementTraitWithArgumentsByTraitType` | `src/evaluator/calls/trait-type.ts` | 24   | Creates TraitValue from `TraitType(fields...)` call     |
| `evaluateImplValue`                           | `src/evaluator/values/impl.ts`      | 605  | Processes `impl(...)` statements                        |
| `evaluateImplFieldList`                       | `src/evaluator/values/impl.ts`      | 264  | Evaluates impl field expressions                        |
| `extractTraitTypeArgsFromImplExpr`            | `src/evaluator/values/impl.ts`      | 230  | Extracts trait type arg exprs for generic impls         |
| `findAssociatedTypeFromGenericImpls`          | `src/evaluator/values/impl.ts`      | 986  | Resolves Self.Item through generic impls                |
| `getBaseTraitKey`                             | `src/evaluator/values/impl.ts`      | 523  | Gets registry key for a trait (uses funcId or typeName) |
| `typeImplementsTrait`                         | `src/evaluator/trait-checking.ts`   | 229  | Checks if a type implements a trait                     |
| `tryMatchGenericImpl`                         | `src/evaluator/values/impl.ts`      | 1250 | Matches concrete type against generic impl pattern      |

---

## Syntax Summary

| Context          | Associated type    | Syntax                            | Result                          |
| ---------------- | ------------------ | --------------------------------- | ------------------------------- |
| Trait definition | Declaration        | `Item : Type`                     | Field with `unassignedSomeType` |
| impl body        | Providing value    | `Iterator(Item : T, next : body)` | TraitValue                      |
| Where clause     | Constraining value | `Iterator(Item := T)`             | Specialized TraitType           |

---

## Open Questions

1. **Should other traits migrate?** TryFrom, TryInto, Eq, Ord, Add, etc. all use the function wrapper pattern. Should they all migrate to direct trait types? The ones with associated types (TryFrom's `Error`) would benefit. Traits parameterized by types they operate on (like `Eq(Rhs)`) might be different — `Rhs` is more like a type parameter than an associated type.

2. **Duplicate impl detection**: With a single trait ID, duplicate detection is simpler — checking trait ID match. But need to handle associated type differences (e.g., can you impl `Iterator(Item : i32)` AND `Iterator(Item : str)` for the same type? In Rust, no — each type can impl Iterator only once).

3. **`for` macro compatibility**: The `for` macro just calls `.next()` on the iterator — it doesn't check Iterator trait compliance. So it will work regardless of how Iterator is defined. But should we add type checking to require Iterator impl?

4. **Phase 2 `:=` parsing**: Need to verify that `Iterator(Item := Self.Item)` parses correctly inside `where(... <: ...)` expressions. The `:=` operator and `<:` operator may interact in unexpected ways.

---

## Status

| Phase | Description                                 | Status                         |
| ----- | ------------------------------------------- | ------------------------------ |
| 1     | Direct trait types                          | ✅ Done — verified in fixme.yo |
| 2     | `:=` trait specialization for where clauses | ✅ Done                        |
| 3     | IntoIterator + where clause enforcement     | ✅ Done — tested in fixme.yo   |
| 4     | Migrate prelude.yo and std library          | ✅ Done                        |
