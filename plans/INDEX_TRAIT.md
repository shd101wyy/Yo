# Index Trait

## Problem

Yo currently uses two different mechanisms for element access:

- **Native Array/Slice**: `arr(0)` works via built-in function call dispatch in the evaluator and codegen. Supports `&(arr(0))` for pointer access and `arr(0:5)` / `arr(:)` for slicing (to be replaced by `arr(0..5)` / `arr(..)`).
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
- Unify slicing syntax to use `..` and `..=` (replacing `:`), handled via built-in functions.
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

| Yo Syntax    | Desugars To                                                | Result Type |
| ------------ | ---------------------------------------------------------- | ----------- |
| `arr(i)`     | `(typeof(arr) <: Index(typeof(i))).index(&(arr), i).*`     | `Output`    |
| `&(arr(i))`  | `(typeof(arr) <: Index(typeof(i))).index(&(arr), i)`       | `*(Output)` |
| `arr(i) = v` | `(typeof(arr) <: Index(typeof(i))).index(&(arr), i).* = v` | `unit`      |

Note: Parentheses around `&(arr)` are required — `&arr, i` would be parsed as `&(arr, i)` in Yo.

### Range Syntax

Use `..` and `..=` for ranges (like Rust), **not** `:`:

| Syntax       | Meaning                             |
| ------------ | ----------------------------------- |
| `arr(0..5)`  | Slice from index 0 to 5 (exclusive) |
| `arr(0..=4)` | Slice from index 0 to 4 (inclusive) |
| `arr(..)`    | Full slice (all elements)           |

Range-based slicing uses built-in functions handled in the evaluator (for comptime values) and C codegen, not through the Index trait. See "Range-Based Slicing" section below.

#### Lexer Considerations

The lexer (`src/lexer.ts`, lines 27-57) has a special rule: dot `.` only combines with other dots to form multi-character operators. So:

- `..` → already lexed as a single `TokenType.Operator` token with value `".."` ✅
- `...` → already lexed as `TokenType.Operator` with value `"..."` (used for spread)
- `..=` → currently lexed as **two tokens**: `..` (Operator) + `=` (Operator), because the dot loop stops at non-dot characters

**Action needed**: Either:

1. Modify the lexer to recognize `..=` as a single operator token (add a special case after the dot loop to check if next char is `=`), or
2. Handle `..=` in the parser by combining the `..` and `=` tokens when they appear consecutively

Option 1 is cleaner. After the dot accumulation loop, check if the result is `".."` and the next char is `=`, then consume the `=` to produce `"..="`.

Range types (`Range(T)`, `RangeInclusive(T)`, `RangeFull`) are defined in `std/prelude.yo`.

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

Range-based slicing (`arr(0..5)`, `arr(..)`) is handled via **built-in functions** in the evaluator (for comptime constant folding) and C codegen, not through the Index trait.

The `..` and `..=` operators are parsed by the lexer/parser. When `arr(0..5)` is encountered:

- The evaluator recognizes the `..` expression as a range argument
- For comptime-known arrays, it performs bounds checking and creates a `SliceValue`
- For runtime, it emits the corresponding C code

This avoids the pointer-to-temporary problem that would arise from `Index(Range(usize))` returning `*(Slice(T))` — a Slice is a new value, not a field of the container.

Types to define in `std/prelude.yo`:

```rust
Range :: (fn(comptime(T) : Type) -> comptime(Type))(
  struct(start : T, end : T)
);

RangeInclusive :: (fn(comptime(T) : Type) -> comptime(Type))(
  struct(start : T, end : T)
);

RangeFull :: struct();
```

The `..` operator creates `Range(T)`, `..=` creates `RangeInclusive(T)`, and `..` with no arguments creates `RangeFull`.

## Call Dispatch Changes

Currently, function call dispatch in `src/evaluator/calls/function.ts` handles:

1. Function values → call the function
2. Array/Slice types → built-in array indexing
3. Type values → constructor call

The new dispatch order becomes:

1. Function values → call the function
2. Type values → constructor call
3. **Type implements `Index(typeof(arg))`** → dispatch to `(typeof(value) <: Index(typeof(arg))).index(&(value), arg)`
4. **`..` / `..=` range argument** → built-in slicing (evaluator + codegen)

The built-in array/slice handling in `tryToCallArrayWithArguments` is removed and replaced by Index trait dispatch (for single-index access) and built-in range handling (for slicing).

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

### Phase 1: Define Index trait and Range types

- `Index` trait is already in `std/prelude.yo`.
- Add `Range(T)`, `RangeInclusive(T)`, `RangeFull` types to `std/prelude.yo`.
- Add `..` and `..=` operator parsing to the lexer/parser.
- No changes to existing behavior yet.

### Phase 2: Add Index dispatch to evaluator

- Modify call dispatch in `function.ts` to check for Index trait when calling a non-function value.
- Desugar `value(arg)` to `(typeof(value) <: Index(typeof(arg))).index(&(value), arg).*`.
- Handle auto-deref of the returned pointer.
- Handle `&(value(arg))` to skip deref and return `*(Output)` directly.
- Handle `value(arg) = expr` to assign through the returned pointer.

### Phase 3: Implement Index for ArrayList

- Add `impl(forall(T : Type), ArrayList(T), Index(usize)(...))`.
- Write tests: `list(0)`, `&(list(0))`, `list(0) = value`.
- Keep existing methods (`get`, `set`, etc.) as deprecated aliases.

### Phase 4: Implement Index for native Array and Slice

- Add `impl(forall(T : Type, comptime(N) : usize), Array(T, N), Index(usize)(...))`.
- Add `impl(forall(T : Type), Slice(T), Index(usize)(...))`.
- Add built-in range slicing (`arr(0..5)`, `arr(..)`) for Array and Slice in evaluator + codegen.

### Phase 5: Remove built-in array indexing

- Remove `tryToCallArrayWithArguments` from evaluator (single-index path).
- Remove array/slice-specific single-index codegen branches.
- Keep/adapt range slicing as built-in handling.
- Verify all existing tests still pass.

### Phase 6: Clean up ArrayList

- Remove `get_ptr`, `get_unchecked`, `set_unchecked`, `set` from ArrayList.
- Update all std library code that uses these methods.
- Keep `get` as an `Option(T)` safe-access method (does not go through Index).

## Open Questions

1. **Bounds checking**: `Index.index` panics on out-of-bounds (like Rust). `get` remains as a separate method returning `Option(T)` for safe access.

2. **Compile-time constant folding**: Currently, `arr(0)` on a comptime-known array returns the element at compile time. After migration to Index trait, can we preserve this optimization? **Recommendation**: The evaluator can special-case Index calls on known arrays/values as an optimization pass.

3. **Negative indexing**: Should `arr(-1)` be supported (Python-style last element)? **Recommendation**: No, use `arr((arr.len() - usize(1)))` explicitly. Negative indexing introduces ambiguity with `usize`.

4. **String indexing**: Should `String` and `str` implement `Index(usize)` returning `u8` or `rune`? **Recommendation**: `str` implements `Index(usize)` returning `u8` (byte access). `String` implements `Index(usize)` returning `u8`. For Unicode code point access, use an iterator or explicit `.char_at(i)` method.

5. **HashMap/BTreeMap**: These types would benefit from Index trait too. `map(key)` returning `*(Value)`. Panics if key not found. **Recommendation**: Implement in a follow-up after the core Index infrastructure is in place.

## Trait Location

`Index` is already defined in `std/prelude.yo`. `Range(T)`, `RangeInclusive(T)`, and `RangeFull` should also go in `std/prelude.yo` since they are fundamental types used by built-in array/slice operations.

## Prior Art

### Rust

- `Index<Idx>` trait with associated type `Output`, returns `&Output`.
- `IndexMut<Idx>` extends `Index`, returns `&mut Output`.
- `container[i]` desugars to `*container.index(i)`.
- Multiple `Idx` types: `usize`, `Range<usize>`, `RangeFrom`, `RangeTo`, `RangeFull`.

### Differences from Rust

- Yo uses `arr(i)` instead of `arr[i]` — function call syntax, not bracket syntax.
- No `IndexMut` — Yo's `*(T)` pointers are always mutable.
- Range-based slicing (`arr(0..5)`) is handled via built-in functions, not through Index trait, to avoid pointer-to-temporary issues.
- The `..` and `..=` operators replace the current `:` slicing syntax.
