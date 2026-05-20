# Index Trait

The `Index` trait provides a unified interface for accessing elements of a collection by index. Any type that implements `Index` can use the familiar `value(index)` call syntax, making custom collections behave just like built-in arrays and slices.

## Overview

```rust
// Built-in arrays and custom types use the same syntax:
(arr : [i32; 3]) = [i32(10), i32(20), i32(30)];
v := arr(usize(1));  // 20

(list : ArrayList(i32)) = ArrayList(i32).new();
list.push(i32(42));
v := list(usize(0));  // 42
```

## The Index Trait

The `Index` trait is defined in the prelude and is available to all Yo programs:

```rust
Index :: (fn(comptime(Idx) : Type) -> comptime(Trait))(
  trait(
    Output : Type,
    index : (fn(inout(self) : Self, idx : Idx) -> *(Self.Output))
  )
);
```

- **`Idx`**: The index type (e.g., `usize`, or a custom key type).
- **`Output`**: An associated type specifying the element type returned.
- **`index`**: A method that takes `self` by `inout` (so it can return a pointer into the caller's storage) and an index, returning a **pointer** to the element.

The `index` method returns `*(Output)` (a pointer), which is automatically dereferenced when used in value context. This design enables both reading and writing through the same trait:

```rust
// Read: auto-deref happens
v := collection(idx);        // calls index(collection, idx).*

// Write via call-syntax assignment (preferred)
collection(idx) = val;       // calls index(collection, idx), writes through pointer

// Address-of: returns pointer directly
p := &(collection(idx));     // calls index(collection, idx), no deref
```

## Implementing Index

### Basic Implementation

```rust
MyArray :: struct(data0: i32, data1: i32, data2: i32);

impl(MyArray, Index(usize)(
  Output : i32,
  index : (fn(inout(self) : Self, idx : usize) -> *(Self.Output))(
    cond(
      (idx == usize(0)) => &(self.data0),
      (idx == usize(1)) => &(self.data1),
      (idx == usize(2)) => &(self.data2),
      true => panic("MyArray: index out of bounds")
    )
  )
));

// Usage:
(arr : MyArray) = MyArray(i32(10), i32(20), i32(30));
assert((arr(usize(0)) == i32(10)), "should be 10");
assert((arr(usize(1)) == i32(20)), "should be 20");
```

### Generic Implementation

For generic types like `ArrayList(T)`, use `forall` in the impl:

```rust
impl(forall(T : Type), ArrayList(T), Index(usize)(
  Output : T,
  index : (fn(inout(self) : Self, idx : usize) -> *(Self.Output))({
    assert((idx < self._length), "ArrayList: index out of bounds");
    match(self._ptr,
      .Some(_ptr) => (_ptr &+ idx),
      .None => panic("ArrayList: index on empty list")
    )
  })
));
```

## Address-of Optimization

When you write `&(collection(idx))`, the compiler detects this pattern and avoids the dereference step. Instead of generating:

```c
// Without optimization (hypothetical):
T temp = *Index_index(&collection, idx);
T* result = &temp;  // ← dangling pointer!
```

It generates:

```c
// With optimization:
T* result = Index_index(&collection, idx);  // ← direct pointer
```

This is critical for correctness — the pointer remains valid and points directly into the collection's storage. You can use it for mutation:

```rust
(list : ArrayList(i32)) = ArrayList(i32).new();
list.push(i32(100));

// Mutate via call-syntax assignment
list(usize(0)) = i32(999);
assert((list(usize(0)) == i32(999)), "should be 999");
```

## Range Slicing

Arrays and slices support range-based slicing with `..` (exclusive end) and `..=` (inclusive end):

```rust
(arr : [i32; 5]) = [i32(10), i32(20), i32(30), i32(40), i32(50)];

// Exclusive range: elements at indices 1, 2, 3
s := arr(usize(1)..usize(4));
assert((s.len() == usize(3)), "length is 3");
assert((s(usize(0)) == i32(20)), "first element is 20");

// Inclusive range: elements at indices 1, 2, 3
s2 := arr(usize(1)..=usize(3));
assert((s2.len() == usize(3)), "length is 3");
assert((s2(usize(0)) == i32(20)), "first element is 20");

// Slicing a slice
sub := s(usize(0)..usize(2));
assert((sub.len() == usize(2)), "sub-slice length is 2");
```

The `..` and `..=` operators produce `Range(usize)` and `RangeInclusive(usize)` types, which are defined in the prelude:

```rust
Range :: (fn(comptime(T) : Type) -> comptime(Type))(
  struct(start: T, end: T)
);

RangeInclusive :: (fn(comptime(T) : Type) -> comptime(Type))(
  struct(start: T, end: T)
);
```

Range slicing creates a **slice view** — it does not copy data. The slice shares memory with the original array or slice.

## Built-in vs. Trait-based Indexing

Built-in array and slice types (`[T; N]` and `[T]`) use built-in indexing that generates direct C array access (`arr.data[idx]`). This is more efficient than going through the Index trait and avoids recursion issues.

Custom types and standard library collections (like `ArrayList`) use the Index trait. The dispatch order is:

1. Built-in array/slice indexing (if the callee is `[T; N]` or `[T]`)
2. Range slicing with `..` or `..=` (if the argument is a range expression)
3. Index trait dispatch (looks up `Index(typeof(arg))` impl on the callee type)
4. Regular function call

## Inline with Operators

Index expressions work seamlessly with operators. The result is auto-dereferenced before being passed to operators:

```rust
(arr : [i32; 3]) = [i32(10), i32(20), i32(30)];

// Comparison
assert((arr(usize(0)) == i32(10)), "works with ==");
assert((arr(usize(0)) < arr(usize(1))), "works with <");

// Arithmetic
sum := (arr(usize(0)) + arr(usize(1)));
assert((sum == i32(30)), "works with +");
```

## Standard Library Implementations

The following standard library types implement the `Index` trait:

### ArrayList(T) — `Index(usize)`

```rust
(list : ArrayList(i32)) = ArrayList(i32).new();
list.push(i32(42));
v := list(usize(0));             // 42
&(list(usize(0))).* = i32(99);  // mutate in place
```

### HashMap(K, V) — `Index(K)`

```rust
(map : HashMap(i32, i32)) = HashMap(i32, i32).new();
map.set(i32(1), i32(100));
v := map(i32(1));               // 100
&(map(i32(1))).* = i32(999);   // mutate in place
// map(i32(99))                 // panics: key not found
```

Requires `K <: (Eq(K), Hash)`.

### BTreeMap(K, V) — `Index(K)`

```rust
(map : BTreeMap(i32, i32)) = BTreeMap(i32, i32).new();
map.set(i32(5), i32(500));
v := map(i32(5));               // 500
&(map(i32(5))).* = i32(77);   // mutate in place
// map(i32(99))                 // panics: key not found
```

Requires `K <: Ord(K)`.

### Deque(T) — `Index(usize)`

```rust
(d : Deque(i32)) = Deque(i32).new();
d.push_back(i32(10));
d.push_back(i32(20));
v := d(usize(0));               // 10
&(d(usize(0))).* = i32(555);  // mutate in place
```

O(1) random access, correctly handles ring buffer wrapping.

### String — `Index(usize)`

```rust
(s : String) = `Hello`;
b := s(usize(0));  // u8(72) — byte-level access ('H')
```

Returns `u8` — byte-level indexing into the internal UTF-8 buffer. For character-level access, use the `chars()` iterator.

## Error Handling

Out-of-bounds access through the Index trait causes a **panic** at runtime. This is consistent with Rust's behavior. For checked access that returns `Option(T)`, use the `get` method on `ArrayList`:

```rust
(list : ArrayList(i32)) = ArrayList(i32).new();
list.push(i32(42));

// Panics on OOB:
// v := list(usize(99));  // ← panic!

// Safe access:
match(list.get(usize(99)),
  .Some(v) => println(`got: ${v}`),
  .None => println(`not found`)
);
```
