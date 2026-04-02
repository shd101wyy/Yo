# Index Trait

## Problem

Yo currently uses two different mechanisms for element access:

- **Native Array/Slice**: `arr(0)` works via built-in function call dispatch in the evaluator and codegen. Supports `&(arr(0))` for pointer access and `arr(0:5)` for slicing.
- **ArrayList and user types**: Must use explicit methods like `.get(index)`, `.get_ptr(index)`, `.set(index, value)`, `.get_unchecked(index)`.

This inconsistency means:

1. User types cannot use the natural `value(index)` call syntax.
2. Generic code cannot abstract over "indexable" types.
3. ArrayList requires five separate access methods (`get`, `get_ptr`, `get_unchecked`, `set`, `set_unchecked`) instead of one unified mechanism.

## Goals

- Define an `Index` trait so any type can support `value(index)` syntax.
- `arr(0)` returns the element value (auto-deref from pointer).
- `&(arr(0))` returns a pointer to the element.
- `arr(0) = value` works through the returned pointer (no separate `IndexMut`).
- Unify slicing (`arr(0:5)`, `arr(:)`) under `Index(Range(usize))`.
- Fully migrate native Array and Slice types from built-in handling to the Index trait.
- Eliminate redundant ArrayList methods (`get_ptr`, `get_unchecked`, `set_unchecked`).

## Design

### Trait Definition

```rust
Index :: (fn(comptime(Idx) : Type) -> comptime(Trait))(
  trait(
    Output : Type,
    index : (fn(self: *(Self), idx: Idx) -> *(Self.Output))
  )
);
export Index;
```

Key design decisions:

- **`index` returns `*(Output)`** (pointer), not the value directly. This matches Rust's `&Output` return and Yo's existing `arrayElementRef` mechanism.
- **`Idx` is a type parameter on the trait**, allowing multiple implementations for the same type (e.g., `Index(usize)` for element access, `Index(Range(usize))` for slicing).
- **No `IndexMut`** — since `*(T)` in Yo is always mutable, assignment through the returned pointer works directly: `arr(0).* = value` or simply `arr(0) = value` (with auto-deref assignment support).
- **Associated type `Output`** — the result type varies by index type (e.g., `T` for `usize` indexing, `Slice(T)` for range slicing).

### Desugaring Rules

| Yo Syntax    | Desugars To                                                                 | Result Type |
| ------------ | --------------------------------------------------------------------------- | ----------- |
| `arr(i)`     | `Index(typeof(i)).index(&arr, i).*`                                         | `Output`    |
| `&(arr(i))`  | `Index(typeof(i)).index(&arr, i)`                                           | `*(Output)` |
| `arr(i) = v` | `Index(typeof(i)).index(&arr, i).* = v`                                     | `unit`      |
| `arr(0:5)`   | `Index(Range(usize)).index(&arr, Range(usize)(start: 0, end: 5)).*`         | `Slice(T)`  |
| `arr(:)`     | `Index(Range(usize)).index(&arr, Range(usize)(start: 0, end: arr.len())).*` | `Slice(T)`  |

### ArrayList Implementation

```rust
impl(forall(T : Type), ArrayList(T), Index(usize)(
  Output : T,
  index : (fn(self: *(Self), idx: usize) -> *(Self.Output))({
    assert((idx < self.*.len()), "ArrayList index out of bounds");
    (self.*._ptr.unwrap() &+ idx)
  })
));
```

After this, ArrayList supports:

```rust
(list : ArrayList(i32)) = ArrayList(i32).init();
list.append(i32(10));
list.append(i32(20));

(first : i32) = list(0);          // 10, via Index
(ptr : *(i32)) = &(list(0));      // pointer to first element
list(0) = i32(42);                 // mutation via pointer
```

Methods that can be eliminated from ArrayList:

- `get_ptr` → replaced by `&(list(i))`
- `get_unchecked` → replaced by `list(i)` (bounds checking is in the Index impl; an `UncheckedIndex(usize)` trait or marker could be added later if needed)
- `set` → replaced by `list(i) = value`
- `set_unchecked` → replaced by `list(i) = value`
- `get` → can be kept for `Option(T)` safe access, or replaced by a `try_index` method

### Native Array Implementation

```rust
impl(forall(T : Type, comptime(N) : usize), Array(T, N), Index(usize)(
  Output : T,
  index : (fn(self: *(Self), idx: usize) -> *(Self.Output))(
    &(self.*.data(idx))
  )
));
```

### Native Slice Implementation

```rust
impl(forall(T : Type), Slice(T), Index(usize)(
  Output : T,
  index : (fn(self: *(Self), idx: usize) -> *(Self.Output))(
    (self.*.ptr() &+ idx)
  )
));
```

### Range-Based Slicing

First, define a Range type (if not already present):

```rust
Range :: (fn(comptime(T) : Type) -> comptime(Type))(
  struct(start : T, end : T)
);
```

Then implement `Index(Range(usize))` for slicing:

```rust
impl(forall(T : Type, comptime(N) : usize), Array(T, N), Index(Range(usize))(
  Output : Slice(T),
  index : (fn(self: *(Self), idx: Range(usize)) -> *(Self.Output))({
    // bounds check and create slice
    assert(((idx.start <= idx.end) && (idx.end <= usize(N))), "slice out of bounds");
    // return pointer to a stack-local Slice value
    // (codegen needs special handling here — see below)
  })
));
```

**Open question**: Returning `*(Slice(T))` for range indexing is tricky — the Slice is a new value, not a field of the container. Options:

1. Return `Slice(T)` directly for range indexing (different return convention for range Index).
2. Store the slice in a hidden local and return pointer to it.
3. Make `Index(Range(usize))` a separate `SliceIndex` trait that returns `Slice(T)` by value.

**Recommended**: Option 3 — define a separate `SliceIndex` trait for range-based slicing that returns by value. The `arr(0:5)` syntax dispatches to `SliceIndex` instead of `Index`. This avoids the pointer-to-temporary problem.

```rust
SliceIndex :: (fn(comptime(Idx) : Type) -> comptime(Trait))(
  trait(
    Output : Type,
    slice : (fn(self: *(Self), idx: Idx) -> Self.Output)
  )
);
```

## Call Dispatch Changes

Currently, function call dispatch in `src/evaluator/calls/function.ts` handles:

1. Function values → call the function
2. Array/Slice types → built-in array indexing
3. Type values → constructor call

The new dispatch order becomes:

1. Function values → call the function
2. Type values → constructor call
3. **Type implements `Index(typeof(arg))`** → dispatch to `Index.index`
4. **Colon argument + type implements `SliceIndex`** → dispatch to `SliceIndex.slice`

The built-in array/slice handling in `tryToCallArrayWithArguments` is removed and replaced by the trait dispatch.

### Evaluator Changes

**`src/evaluator/calls/function.ts`**:

- Remove the `isArrayType || isSliceType` branch that dispatches to `tryToCallArrayWithArguments`.
- Add a new branch: check if the value's type has an `Index` impl matching the argument type.
- If found, generate a call to `Index.index(&value, arg)` and auto-dereference the result.
- Track the `arrayElementRef` equivalent so `&(value(arg))` still works.

**`src/evaluator/builtins/ptr-fns.ts`** (`evaluateAddressCall`):

- When `&(value(arg))` is used and the inner call resolved via Index trait, skip the auto-deref step — return the `*(Output)` pointer directly.

**`src/evaluator/calls/array.ts`**:

- Eventually remove or repurpose. The logic moves into the Index trait implementations.
- Compile-time array element access (constant folding) may remain as an optimization.

### Codegen Changes

**`src/codegen/exprs/other-fn-call.ts`**:

- Remove the array/slice-specific codegen branches.
- Index trait calls generate normal trait method calls.
- The codegen for `arr.data[index]` moves into the Index impl body (which becomes a trait method call generating `&self->data[index]`).

**For native Array**, the Index impl body generates:

```c
// Index(usize).index for Array(T, N)
T* index(Array_T_N* self, size_t idx) {
    return &self->data[idx];
}
```

**For ArrayList**, the Index impl body generates:

```c
// Index(usize).index for ArrayList(T)
T* index(ArrayList_T* self, size_t idx) {
    assert(idx < self->_length);
    return self->_ptr + idx;
}
```

## Migration Path

### Phase 1: Define Index and SliceIndex traits

- Add `Index` trait to `std/prelude.yo` (or a new `std/ops/index.yo`).
- Add `SliceIndex` trait for range-based slicing.
- Add `Range(T)` type if not already present.
- No changes to existing behavior yet.

### Phase 2: Implement Index for ArrayList

- Add `impl(ArrayList(T), Index(usize)(...))`.
- Add `impl(ArrayList(T), SliceIndex(Range(usize))(...))` if ArrayList supports slicing.
- Write tests: `list(0)`, `&(list(0))`, `list(0) = value`.
- Keep existing methods (`get`, `set`, etc.) as deprecated aliases.

### Phase 3: Add Index dispatch to evaluator

- Modify call dispatch in `function.ts` to check for Index trait when calling a non-function value.
- Handle auto-deref of the returned pointer.
- Handle `&(value(arg))` to skip deref.
- Handle `value(arg) = expr` to assign through pointer.

### Phase 4: Implement Index for native Array and Slice

- Add `impl(Array(T, N), Index(usize)(...))`.
- Add `impl(Slice(T), Index(usize)(...))`.
- Add `impl(Array(T, N), SliceIndex(Range(usize))(...))`.
- Add `impl(Slice(T), SliceIndex(Range(usize))(...))`.

### Phase 5: Remove built-in array indexing

- Remove `tryToCallArrayWithArguments` from evaluator.
- Remove array/slice-specific codegen branches.
- Verify all existing tests still pass.

### Phase 6: Clean up ArrayList

- Remove `get_ptr`, `get_unchecked`, `set_unchecked`, `set` from ArrayList.
- Update all std library code that uses these methods.
- Keep `get` as an `Option(T)` safe-access method (does not go through Index).

## Open Questions

1. **Bounds checking**: Should `Index.index` panic on out-of-bounds, or should there be a separate safe `get` method returning `Option(T)`? **Recommendation**: Index panics (like Rust), `get` remains for safe access.

2. **Compile-time constant folding**: Currently, `arr(0)` on a comptime-known array returns the element at compile time. After migration to Index trait, can we preserve this optimization? **Recommendation**: The evaluator can special-case Index calls on known arrays/values as an optimization pass.

3. **Negative indexing**: Should `arr(-1)` be supported (Python-style last element)? **Recommendation**: No, use `arr((arr.len() - usize(1)))` explicitly. Negative indexing introduces ambiguity with `usize`.

4. **String indexing**: Should `String` and `str` implement `Index(usize)` returning `u8` or `rune`? **Recommendation**: `str` implements `Index(usize)` returning `u8` (byte access). `String` implements `Index(usize)` returning `u8`. For Unicode code point access, use an iterator or explicit `.char_at(i)` method.

5. **HashMap/BTreeMap**: These types would benefit from Index trait too. `map(key)` returning `*(Value)`. Panics if key not found. **Recommendation**: Implement in a follow-up after the core Index infrastructure is in place.

## Trait Location

`Index` and `SliceIndex` should be defined in `std/prelude.yo` since they are fundamental traits used by built-in types (Array, Slice). Alternatively, they could be in a new `std/ops/index.yo` module that the prelude re-exports.

**Recommendation**: Define in `std/prelude.yo` alongside other fundamental traits (`Eq`, `Iterator`, etc.).

## Prior Art

### Rust

- `Index<Idx>` trait with associated type `Output`, returns `&Output`.
- `IndexMut<Idx>` extends `Index`, returns `&mut Output`.
- `container[i]` desugars to `*container.index(i)`.
- Multiple `Idx` types: `usize`, `Range<usize>`, `RangeFrom`, `RangeTo`, `RangeFull`.

### Differences from Rust

- Yo uses `arr(i)` instead of `arr[i]` — function call syntax, not bracket syntax.
- No `IndexMut` — Yo's `*(T)` pointers are always mutable.
- Slicing uses a separate `SliceIndex` trait to avoid pointer-to-temporary issues.
- The `arr(start:end)` colon syntax maps to `SliceIndex(Range(usize))` dispatch.
