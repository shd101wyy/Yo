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
- Unify slicing syntax to use `..` and `..=` (replacing `:`), handled via built-in range detection.
- Remove `arr(:)` and `arr(0:5)` colon syntax — use `arr(0..arr.len())` and `arr(0..5)` instead.
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

**Not supported** (don't fit Yo's syntax well):

- `arr(..)` — standalone range / full slice
- `arr(1..)` — range from
- `arr(..3)` — range to

For full slicing, use explicit bounds: `arr(0..arr.len())`.

The old `arr(:)` and `arr(0:5)` colon syntax is removed.

#### Operator Trait Definitions

`..` and `..=` are defined inside traits (like `Add` defines `(+)`).
All operator traits (Add, Sub, etc.) use `Output` as an **associated type**, not a function parameter — same pattern as Index.

```rust
// Trait for the `..` range operator
RangeOp :: trait(
  (..) : (fn(start: Self, end: Self) -> Range(Self))
);

// Trait for the `..=` inclusive range operator
RangeInclusiveOp :: trait(
  (..=) : (fn(start: Self, end: Self) -> RangeInclusive(Self))
);

// Implement for usize
impl(usize, RangeOp(
  (..) : (fn(start: Self, end: Self) -> Range(Self))(
    Range(usize)(start: start, end: end)
  )
));

impl(usize, RangeInclusiveOp(
  (..=) : (fn(start: Self, end: Self) -> RangeInclusive(Self))(
    RangeInclusive(usize)(start: start, end: end)
  )
));
```

#### Lexer Considerations

The lexer (`src/lexer.ts`, lines 27-57) has a special rule: dot `.` only combines with other dots to form multi-character operators. So:

- `..` → already lexed as a single `TokenType.Operator` token with value `".."` ✅
- `...` → already lexed as `TokenType.Operator` with value `"..."` (used for spread)
- `..=` → currently lexed as **two tokens**: `..` (Operator) + `=` (Operator), because the dot loop stops at non-dot characters

**Action needed**: Modify the lexer to recognize `..=` as a single operator token. After the dot accumulation loop, check if the result is `".."` and the next char is `=`, then consume the `=` to produce `"..="`.

Range types (`Range(T)`, `RangeInclusive(T)`) and their operator traits (`RangeOp`, `RangeInclusiveOp`) are defined in `std/prelude.yo`.

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

Range-based slicing (`arr(0..5)`, `arr(0..=4)`) is handled via **built-in functions** in the evaluator (for comptime constant folding) and C codegen, not through the Index trait.

When `arr(0..5)` is evaluated:

- `0..5` evaluates to a `Range(usize)` value via the `RangeOp` trait
- The evaluator recognizes that the argument to `arr(...)` is a Range value
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
```

The `..` operator creates `Range(T)` via `RangeOp` trait, `..=` creates `RangeInclusive(T)` via `RangeInclusiveOp` trait.

## Call Dispatch Changes

Currently, function call dispatch in `src/evaluator/calls/function.ts` handles:

1. Function values → call the function
2. Array/Slice types → built-in array indexing
3. Type values → constructor call

The new dispatch order becomes:

1. Function values → call the function
2. Type values → constructor call
3. **Type implements `Index(typeof(arg))`** → dispatch to `(typeof(value) <: Index(typeof(arg))).index(&(value), arg)`
4. **Argument is a `Range` or `RangeInclusive` value** → built-in slicing (evaluator + codegen)

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

### Phase 1: Define Index trait, Range types, and range operators ✅

- `Index` trait is already in `std/prelude.yo`.
- Add `Range(T)`, `RangeInclusive(T)` types to `std/prelude.yo`.
- Add `RangeOp` and `RangeInclusiveOp` traits to `std/prelude.yo`.
- Implement `RangeOp` and `RangeInclusiveOp` for `usize`.
- Modify lexer to tokenize `..=` as a single operator token.
- No changes to existing behavior yet.

### Phase 2: Add Index dispatch to evaluator ✅

- Modify call dispatch in `function.ts` to check for Index trait when calling a non-function value.
- Desugar `value(arg)` to `(typeof(value) <: Index(typeof(arg))).index(&(value), arg).*`.
- Handle auto-deref of the returned pointer.
- Handle `&(value(arg))` to skip deref and return `*(Output)` directly.
- Fixed overload resolution bug: `UnknownValue` from Index dispatch was treated as comptime, causing `ComptimeEq` to be preferred over `Eq`. Added `isRuntimeOnly` flag to `UnknownValue` type.

### Phase 3: Implement Index for ArrayList ✅

- Add `impl(forall(T : Type), ArrayList(T), Index(usize)(...))`.
- Wrote tests: `list(0)`, `&(list(0))`.

### Phase 4: Range slicing and colon syntax migration ✅

- Replaced old `:` colon slicing syntax (`arr(:)`, `arr(0:5)`) with `..` and `..=` range syntax.
- Added built-in range slicing (`arr(0..5)`, `arr(0..=4)`) for Array and Slice in evaluator + codegen.
- Migrated all tests and std library code from `:` to `..`/`..=` syntax.
- Native Array/Slice still uses built-in indexing (not Index trait) to avoid recursion issues.

### Phase 5: Remove built-in array indexing ✅

Resolved via compiler builtins approach: Array/Slice Index impls use `__yo_array_index` / `__yo_slice_index` builtins that directly access elements, bypassing Index dispatch recursion. The legacy `tryToCallArrayWithArguments` function was deleted and all array/slice indexing is now unified through the Index trait.

### Phase 6: Clean up ArrayList ✅

- Removed `get_ptr`, `get_unchecked`, `set_unchecked`, `set` from ArrayList.
- Migrated all std library code to use Index trait: `list(idx)`, `&(list(idx))`, `&(list(idx)).* = val`.
- Kept `get` as an `Option(T)` safe-access method.

## Open Questions

1. **Bounds checking**: `Index.index` panics on out-of-bounds (like Rust). `get` remains as a separate method returning `Option(T)` for safe access.

2. **Compile-time constant folding**: Currently, `arr(0)` on a comptime-known array returns the element at compile time. After migration to Index trait, can we preserve this optimization? **Recommendation**: The evaluator can special-case Index calls on known arrays/values as an optimization pass.

3. **Negative indexing**: Should `arr(-1)` be supported (Python-style last element)? **Recommendation**: No, use `arr((arr.len() - usize(1)))` explicitly. Negative indexing introduces ambiguity with `usize`.

4. **String indexing**: Should `String` and `str` implement `Index(usize)` returning `u8` or `rune`? **Recommendation**: `str` implements `Index(usize)` returning `u8` (byte access). `String` implements `Index(usize)` returning `u8`. For Unicode code point access, use an iterator or explicit `.char_at(i)` method.

5. **HashMap/BTreeMap**: These types would benefit from Index trait too. `map(key)` returning `*(Value)`. Panics if key not found. **Recommendation**: Implement in a follow-up after the core Index infrastructure is in place.

## Trait Location

`Index` is already defined in `std/prelude.yo`. `Range(T)`, `RangeInclusive(T)`, `RangeOp`, and `RangeInclusiveOp` should also go in `std/prelude.yo` since they are fundamental types/traits used by built-in array/slice operations.

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
- `..` and `..=` are defined via traits (`RangeOp`, `RangeInclusiveOp`), like `Add` defines `(+)`.
- No `RangeFull` (`..`), `RangeFrom` (`1..`), or `RangeTo` (`..3`) — use explicit bounds instead.
