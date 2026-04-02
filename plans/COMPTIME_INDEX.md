# ComptimeIndex, ComptimeRangeOp, ComptimeRangeInclusiveOp

## Problem

The runtime `Index`, `RangeOp`, and `RangeInclusiveOp` traits exist but have no compile-time counterparts. Other operator traits already have Comptime variants (e.g., `Add`/`ComptimeAdd`, `Eq`/`ComptimeEq`). We need to add `ComptimeIndex`, `ComptimeRangeOp`, and `ComptimeRangeInclusiveOp` following the same pattern.

Additionally, built-in Array and Slice types do not implement the `Index` trait — they use a separate built-in dispatch path (`tryToCallArrayWithArguments`). This was originally deferred (Phase 5 of INDEX_TRAIT.md) because an Index impl body using `self.*(idx)` would cause infinite recursion through the Index dispatch. We solve this by introducing compiler builtins.

## Design

### ComptimeIndex

Mirrors `Index` exactly, but with `comptime` qualifiers on parameters and return type. Pointers in Yo can be comptime, so the signature keeps `*(Self)` and `*(Self.Output)`:

```rust
// Runtime Index (existing):
Index :: (fn(comptime(Idx) : Type) -> comptime(Trait))(
  trait(
    Output : Type,
    index : (fn(self: *(Self), idx: Idx) -> *(Self.Output))
  )
);

// Comptime counterpart:
ComptimeIndex :: (fn(comptime(Idx) : Type, where(Idx <: Comptime)) -> comptime(Trait))(
  trait(
    Output : Type,
    index : (fn(comptime(self): *(Self), comptime(idx): Idx) -> comptime(*(Self.Output))),
    where(Self <: Comptime)
  )
);
```

Key differences from `Index`:

- Parameters are `comptime(self)` and `comptime(idx)` instead of `self` and `idx`
- Return type is `comptime(*(Self.Output))` instead of `*(Self.Output)`
- `where(Idx <: Comptime)` on the trait function, `where(Self <: Comptime)` inside the trait body
- `Output` remains an associated type (`Output : Type`), not a default-parameter — same as `Index`

### ComptimeRangeOp ✅ (already defined and working)

```rust
ComptimeRangeOp :: trait(
  (..) : (fn(comptime(start): Self, comptime(end): Self) -> comptime(Range(Self))),
  where(Self <: Comptime)
);
```

### ComptimeRangeInclusiveOp ✅ (already defined and working)

```rust
ComptimeRangeInclusiveOp :: trait(
  (..=) : (fn(comptime(start): Self, comptime(end): Self) -> comptime(RangeInclusive(Self))),
  where(Self <: Comptime)
);
```

### Array/Slice Index via Builtins (Full Unification)

The infinite recursion problem: `impl(Array(T,N), Index(usize)(...))` body calls `self.*(idx)` → call dispatch → Index dispatch → same impl → recursion.

**Solution**: Introduce compiler builtins that directly access array/slice elements, bypassing Index dispatch. This unifies ALL indexing (element, range, range-inclusive) under the Index trait.

Note: `Slice(T)` in Yo is NOT a DST — it's a regular struct (pointer + length). So `*(Slice(T))` is a normal pointer, and Index returning `*(Slice(T))` which auto-derefs to `Slice(T)` works naturally.

```rust
// === Element access builtins ===
// __yo_array_index : (fn(self: *(Array(T, N)), idx: usize) -> *(T))
// __yo_slice_index : (fn(self: *(Slice(T)), idx: usize) -> *(T))

// === Range slicing builtins ===
// __yo_array_index_range : (fn(self: *(Array(T, N)), range: Range(usize)) -> *(Slice(T)))
// __yo_array_index_range_inclusive : (fn(self: *(Array(T, N)), range: RangeInclusive(usize)) -> *(Slice(T)))
// __yo_slice_index_range : (fn(self: *(Slice(T)), range: Range(usize)) -> *(Slice(T)))
// __yo_slice_index_range_inclusive : (fn(self: *(Slice(T)), range: RangeInclusive(usize)) -> *(Slice(T)))

// === Index impls for Array ===
impl(forall(T : Type, comptime(N) : usize), Array(T, N), Index(usize)(
  Output : T,
  index : (fn(self: *(Self), idx: usize) -> *(Self.Output))(
    __yo_array_index(self, idx)
  )
));

impl(forall(T : Type, comptime(N) : usize), Array(T, N), Index(Range(usize))(
  Output : Slice(T),
  index : (fn(self: *(Self), idx: Range(usize)) -> *(Self.Output))(
    __yo_array_index_range(self, idx)
  )
));

impl(forall(T : Type, comptime(N) : usize), Array(T, N), Index(RangeInclusive(usize))(
  Output : Slice(T),
  index : (fn(self: *(Self), idx: RangeInclusive(usize)) -> *(Self.Output))(
    __yo_array_index_range_inclusive(self, idx)
  )
));

// === Index impls for Slice ===
impl(forall(T : Type), Slice(T), Index(usize)(
  Output : T,
  index : (fn(self: *(Self), idx: usize) -> *(Self.Output))(
    __yo_slice_index(self, idx)
  )
));

impl(forall(T : Type), Slice(T), Index(Range(usize))(
  Output : Slice(T),
  index : (fn(self: *(Self), idx: Range(usize)) -> *(Self.Output))(
    __yo_slice_index_range(self, idx)
  )
));

impl(forall(T : Type), Slice(T), Index(RangeInclusive(usize))(
  Output : Slice(T),
  index : (fn(self: *(Self), idx: RangeInclusive(usize)) -> *(Self.Output))(
    __yo_slice_index_range_inclusive(self, idx)
  )
));

// === ComptimeIndex for Array ===
impl(forall(T : Type, comptime(N) : usize), where(T <: Comptime), Array(T, N), ComptimeIndex(usize)(
  Output : T,
  index : (fn(comptime(self): *(Self), comptime(idx): usize) -> comptime(*(Self.Output)))(
    __yo_array_index(self, idx)
  )
));
```

The builtins:

- **Evaluator**: Each builtin returns a pointer to the result. At comptime, performs bounds checking and returns the computed value. At runtime, produces an `UnknownValue`.
- **Codegen**:
  - Element: `&(ptr->data[idx])` — direct array access
  - Range: `&(Slice_T){ .data = &(ptr->data[range.start]), .length = range.end - range.start }` — C11 compound literal
  - RangeInclusive: same but `.length = range.end - range.start + 1`
- **Auto-deref**: Index trait returns `*(Output)`, auto-derefed to `Output`:
  - `arr(0)` → `*(T)` → `T` (element value)
  - `arr(0..2)` → `*(Slice(T))` → `Slice(T)` (slice value)
  - `&(arr(0))` → `*(T)` (pointer to element, no deref)

## Implementation

### Phase 1: Define Comptime traits in prelude.yo ✅ (done)

- `ComptimeIndex` defined right after `Index`
- `ComptimeRangeOp` defined right after `RangeOp`
- `ComptimeRangeInclusiveOp` defined right after `RangeInclusiveOp`
- `impl(usize, ComptimeRangeOp(...))` and `impl(usize, ComptimeRangeInclusiveOp(...))` added

### Phase 2: Add builtins for Array/Slice indexing

6 builtins total:

1. `__yo_array_index(self: *(Array(T,N)), idx: usize) -> *(T)`
2. `__yo_slice_index(self: *(Slice(T)), idx: usize) -> *(T)`
3. `__yo_array_index_range(self: *(Array(T,N)), range: Range(usize)) -> *(Slice(T))`
4. `__yo_array_index_range_inclusive(self: *(Array(T,N)), range: RangeInclusive(usize)) -> *(Slice(T))`
5. `__yo_slice_index_range(self: *(Slice(T)), range: Range(usize)) -> *(Slice(T))`
6. `__yo_slice_index_range_inclusive(self: *(Slice(T)), range: RangeInclusive(usize)) -> *(Slice(T))`

Files to modify:

- Evaluator: Add builtin handling (check where other builtins like `__yo_comptime_usize_add` are handled)
- Codegen: Add C emission for each builtin

### Phase 3: Add Index impls for Array and Slice in prelude.yo

- `Array(T, N)`: Index(usize), Index(Range(usize)), Index(RangeInclusive(usize))
- `Slice(T)`: Index(usize), Index(Range(usize)), Index(RangeInclusive(usize))
- `Array(T, N)` + `where(T <: Comptime)`: ComptimeIndex(usize)

### Phase 4: Update evaluator dispatch

1. Update `index-trait.ts` to also find `ComptimeIndex` methods
2. When both Index and ComptimeIndex match, prefer ComptimeIndex for comptime args
3. Incrementally remove element/range handling from `tryToCallArrayWithArguments` — keep it as fallback initially, remove once tests pass

### Phase 5: Update codegen

1. Move array/slice range slicing C emission from `other-fn-call.ts` to builtin codegen handler
2. Ensure `generateIndexTraitCall` handles range slicing through Index uniformly
3. Range output uses C11 compound literal for `*(Slice(T))`: `&(Slice_T){...}`

### Phase 6: Lvalue assignment via Index

Support `arr(i) = val` syntax as sugar for `&(arr(i)).* = val`:

1. Detect Index expression on LHS of `=` (via `isLhsOfAssignment` context flag)
2. Skip auto-deref, write through the pointer returned by Index
3. Codegen: emit `*index_fn(&container, idx) = val`
4. Works for all Index impls (Array, Slice, ArrayList, HashMap, etc.)

### Phase 7: Tests

Add/update tests in `tests/index.test.yo`:

- Array element indexing: `arr(usize(0))` → value
- Array range slicing: `arr(usize(0)..usize(2))` → Slice
- Array range-inclusive: `arr(usize(0)..=usize(2))` → Slice
- Slice element indexing: `sl(usize(0))` → value
- Slice range slicing: same patterns
- Mutation: `&(arr(usize(0))).* = val`
- ComptimeIndex: `comptime_assert((arr(usize(0)) == i32(10)), "...")`
- Comptime range: `r :: (usize(1)..usize(5)); comptime_assert((r.start == usize(1)), "...")`

### Phase 7: Cleanup & Docs

1. Remove redundant code from `tryToCallArrayWithArguments` and codegen
2. Update `plans/INDEX_TRAIT.md` Phase 5 status
3. Update `docs/en-US/INDEX_TRAIT.md` and `docs/zh-CN/INDEX_TRAIT.md`
4. Update copilot instruction/rule files

## Notes

- Pointers in Yo CAN be comptime — `comptime(*(T))` is valid. The ComptimeIndex signature keeps the pointer-based design identical to Index.
- The auto-deref behavior (`*(Output)` → `Output`) should also work at compile time since the evaluator already handles pointer dereferencing for comptime values.
- `ComptimeRangeOp` and `ComptimeRangeInclusiveOp` are simpler — they follow the exact same pattern as `ComptimeAdd`/`ComptimeEq` (comptime params + comptime return, where Self <: Comptime).
- Range slicing (`arr(usize(1)..usize(4))`) remains built-in — it is detected at expression level and handled separately from single-element indexing.
- The `__yo_array_index` / `__yo_slice_index` builtins break the recursion cycle while keeping the Index trait as the unified dispatch mechanism for all indexable types.
