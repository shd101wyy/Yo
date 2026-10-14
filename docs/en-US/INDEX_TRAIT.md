# Index Trait

The `Index` trait provides a unified interface for accessing elements of a collection by index. Any type that implements `Index` can use the familiar `value(index)` call syntax, making custom collections behave just like built-in arrays and slices.

## Overview

```yo
// Built-in arrays and custom types use the same syntax:
(arr : [i32 ; 3]) = [i32(10), i32(20), i32(30)];
v := arr(usize(1)); // 20
(list : ArrayList(i32)) = ArrayList(i32).new();
list.push(i32(42));
v := list(usize(0)); // 42
```

## The Index Trait

The `Index` trait and its write half `IndexMut` are defined in the prelude and are available to all Yo programs:

```yo
Index :: (fn(comptime(Idx) : Type) -> comptime(Trait))(
  trait(
    Output : Type,
    index : (fn(self : &Self, idx : Idx) -> &Self.Output)
  )
);
IndexMut :: (fn(comptime(Idx) : Type) -> comptime(Trait))(
  trait(
    Output : Type,
    index_mut : (fn(self : &mut Self, idx : Idx) -> &mut Self.Output)
  )
);
```

- **`Idx`**: The index type (e.g., `usize`, or a custom key type), taken by value.
- **`Output`**: An associated type specifying the element type. `Index` and `IndexMut` of the same index type agree on it.
- **`index`**: A read projection: it borrows the container shared and yields the element's place.
- **`index_mut`**: A mutable projection: it borrows the container exclusively and yields the element's place for writing.

```yo
// Read: calls index, then reads the place
v := collection(idx);
// Write via call-syntax assignment: calls index_mut, writes the place
collection(idx) = val;
// Address-of: calls index_mut, returns the place's address
p := addr_of(collection(idx));
```

## Reads and writes: `Index` and `IndexMut`

Values by default (V2b, decision 34) splits element access in two, as Rust does.

- **Which method a subscript calls.** `x(i)` read as a value calls `index`. Every write calls `index_mut`: `x(i) = v`, a field of the element (`x(i).f = v`), a nested element (`grid(i)(j) = v`), a `self : &mut Self` method on the element (`x(i).push(v)`), a `&mut` argument (`f(&mut x(i))`), `addr_of(x(i))`, and a `&mut` local borrow of it. A read-modify-write such as `x(i) = (x(i) + 1)` is a read and then a write. Yo has no compound assignment operator.
- **Read-only elements.** A type that implements `Index` without `IndexMut` has read-only elements, and a write through `x(i)` is a compile error naming the missing `IndexMut`.
- **A writable receiver.** `index_mut` takes `self : &mut Self`, so writing `x(i)` through a read-only borrow of `x` (a `x : &T` parameter) is E0908.
- **One `Output`.** `Index` and `IndexMut` of the same index type must agree on `Output`.

### Projections

`index` and `index_mut` are **projections** (decision 24): functions whose result is a borrow, `-> &T` or `-> &mut T`. A projection yields one place. Its result expression is that place written with the borrow sigil of its result type:

```yo ignore
Trio :: struct(a : i32, b : i32, c : i32);
impl(
  Trio,
  Index(usize)(
    Output : i32,
    index : (fn(self : &Self, idx : usize) -> &Self.Output)(
      cond(
        (idx == usize(0)) => &self.a,
        (idx == usize(1)) => &self.b,
        true => &self.c
      )
    )
  )
);
impl(
  Trio,
  IndexMut(usize)(
    Output : i32,
    index_mut : (fn(self : &mut Self, idx : usize) -> &mut Self.Output)(
      cond(
        (idx == usize(0)) => &mut self.a,
        (idx == usize(1)) => &mut self.b,
        true => &mut self.c
      )
    )
  )
);
t := Trio(a : i32(1), b : i32(2), c : i32(3));
t(usize(1)) = i32(20); // index_mut
assert(t(usize(1)) == i32(20), "index");
```

The rules a projection follows:

- **The place is reached from a borrow parameter.** The place is rooted at one of the projection's own `&`/`&mut` parameters, through field steps and element accesses. A local, a temporary, a by-value parameter or a module-level binding is rejected, because its storage ends with the call. A `-> &mut T` projection's place is rooted at a `&mut` parameter.
- **The sigil matches the result.** A `-> &T` projection writes `&place`, and a `-> &mut T` one writes `&mut place`.
- **Raw-pointer places.** In a `pragma(Pragma.AllowUnsafe)` file the place may be a raw-pointer dereference (`&(p &+ i).*`), and the result may be the raw pointer `*T` itself. This is the form std's buffers use.
- **ABI.** A projection's `&T` parameters are passed by pointer (a `&T` parameter is passed by value elsewhere), so the place it returns is the caller's.
- **Calling a projection directly.** A projection is also an ordinary function or method, called by name: `t.index(i)`, `Trio.index(&t, i)`, `first(&t)`. Calling one through a function value is an error. The call's result is the place itself, never a copy:
  - as an operand it is read through (`t.index(i) + 1`);
  - as a receiver it is lent (`n.name(0).len()`, `n.name_mut(0).push_str("!")`), and a subscript on it indexes the place (`g.index_mut(0)(2) = v`);
  - as the argument of a `&T` or `&mut T` parameter it is lent as written (`f(t.index(i))`);
  - `r := t.index(i)` binds a local borrow, `&` or `&mut` as the result is, live until its last use. `(v : T) = t.index(i)` copies the value out instead;
  - a `&mut` projection's call is the left of `=` (`t.index_mut(i) = v`). Decision 43 will spell this write `t.index_mut(i).* = v`.
- **The result's roots.** The place lies in the call's borrowed arguments, the receiver included (a `&mut` projection's place lies in its `&mut` arguments). While a binding of the result is live, a `&` result freezes them (no write or move), and a `&mut` result allows no access to them except through the binding (E0911). The binding never leaves the function (E0912), and a projection call whose borrowed argument is a temporary cannot be bound.
- **Read projections are read-only.** Writing a `&` projection's place, calling a `self : &mut Self` method on it, or lending it to a `&mut` parameter is E0908. A `&mut` projection's call needs a writable receiver, as any `&mut self` method does.
- **A projection may yield another projection's result** (`&g.index(i).a`, `&mut g.index_mut(i).b`) when that call's borrowed arguments are rooted at its own borrow parameters. A `-> &mut T` projection yields only a `&mut` projection's place.

## Implementing Index

### Basic Implementation

```yo
MyArray :: struct(data0 : i32, data1 : i32, data2 : i32);

impl(
  MyArray,
  Index(usize)(
    Output : i32,
    index : (fn(self : &Self, idx : usize) -> &Self.Output)(
      cond(
        (idx == usize(0)) => &self.data0,
        (idx == usize(1)) => &self.data1,
        (idx == usize(2)) => &self.data2,
        true => panic("MyArray: index out of bounds")
      )
    )
  )
);
// Without this impl, `arr(i)` reads but `arr(i) = v` is a compile error.
impl(
  MyArray,
  IndexMut(usize)(
    Output : i32,
    index_mut : (fn(self : &mut Self, idx : usize) -> &mut Self.Output)(
      cond(
        (idx == usize(0)) => &mut self.data0,
        (idx == usize(1)) => &mut self.data1,
        (idx == usize(2)) => &mut self.data2,
        true => panic("MyArray: index out of bounds")
      )
    )
  )
);

// Usage:
(arr : MyArray) = MyArray(i32(10), i32(20), i32(30));
assert(arr(usize(0)) == i32(10), "should be 10");
assert(arr(usize(1)) == i32(20), "should be 20");
```

### Generic Implementation

For generic types like `ArrayList(T)`, use `generic` in the impl. std's buffers yield a raw pointer into the buffer (a `pragma(Pragma.AllowUnsafe)` file), and the `IndexMut` impl repeats the body with `self : &mut Self` and `-> &mut Self.Output`:

```yo
impl(
  generic(T : Type),
  ArrayList(T),
  Index(usize)(
    Output : T,
    index : (fn(self : &Self, idx : usize) -> &Self.Output)({
      assert(idx < self._length, "ArrayList: index out of bounds");
      match(
        self._ptr,
        .Some(_ptr) => _ptr.add(idx),
        .None => panic("ArrayList: index on empty list")
      )
    })
  )
);
```

## Address-of Optimization

When you write `addr_of(collection(idx))`, the compiler detects this pattern and avoids the dereference step. Instead of generating:

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

```yo
(list : ArrayList(i32)) = ArrayList(i32).new();
list.push(i32(100));

// Mutate via call-syntax assignment
list(usize(0)) = i32(999);
assert(list(usize(0)) == i32(999), "should be 999");
```

## Range Slicing

Arrays and slices support range-based slicing with `..` (exclusive end) and `..=` (inclusive end):

```yo
(arr : [i32 ; 5]) = [i32(10), i32(20), i32(30), i32(40), i32(50)];

// Exclusive range: elements at indices 1, 2, 3
s := arr(usize(1) .. usize(4));
assert(s.len() == usize(3), "length is 3");
assert(s(usize(0)) == i32(20), "first element is 20");

// Inclusive range: elements at indices 1, 2, 3
s2 := arr(usize(1) ..= usize(3));
assert(s2.len() == usize(3), "length is 3");
assert(s2(usize(0)) == i32(20), "first element is 20");

// Slicing a slice
sub := s(usize(0) .. usize(2));
assert(sub.len() == usize(2), "sub-slice length is 2");
```

The `..` and `..=` operators produce `Range(usize)` and `RangeInclusive(usize)` types, which are defined in the prelude:

```yo
Range :: (fn(comptime(T) : Type) -> comptime(Type))(
  struct(start : T, end : T)
);

RangeInclusive :: (fn(comptime(T) : Type) -> comptime(Type))(
  struct(start : T, end : T)
);
```

Range slicing creates a **slice view** — it does not copy data. The slice shares memory with the original array or slice.

## Built-in vs. Trait-based Indexing

Built-in array and slice types (`[T; N]` and `[T]`) use built-in indexing that generates direct C array access (`arr.data[idx]`). This is more efficient than going through the Index trait and avoids recursion issues.

Custom types and standard library collections (like `ArrayList`) use the Index trait. The dispatch order is:

1. Built-in array/slice indexing (if the callee is `[T; N]` or `[T]`)
2. Range slicing with `..` or `..=` (if the argument is a range expression)
3. Index trait dispatch (looks up `Index(type_of(arg))` impl on the callee type)
4. Regular function call

## Inline with Operators

Index expressions work seamlessly with operators. The result is auto-dereferenced before being passed to operators:

```yo
(arr : [i32 ; 3]) = [i32(10), i32(20), i32(30)];

// Comparison
assert(arr(usize(0)) == i32(10), "works with ==");
assert(arr(usize(0)) < arr(usize(1)), "works with <");

// Arithmetic
sum := (arr(usize(0)) + arr(usize(1)));
assert(sum == i32(30), "works with +");
```

## Standard Library Implementations

The following standard library types implement the `Index` trait:

### ArrayList(T) — `Index(usize)`

```yo
(list : ArrayList(i32)) = ArrayList(i32).new();
list.push(i32(42));
v := list(usize(0)); // 42
addr_of(list(usize(0))).* = i32(99); // mutate in place
```

### HashMap(K, V) — `Index(K)`

```yo
(map : HashMap(i32, i32)) = HashMap(i32, i32).new();
map.insert(i32(1), i32(100));
v := map(i32(1)); // 100
addr_of(map(i32(1))).* = i32(999); // mutate in place
// map(i32(99))                 // panics: key not found
```

Requires `K <: (Eq(K), Hash)`.

### BTreeMap(K, V) — `Index(K)`

```yo
(map : BTreeMap(i32, i32)) = BTreeMap(i32, i32).new();
map.insert(i32(5), i32(500));
v := map(i32(5)); // 500
addr_of(map(i32(5))).* = i32(77); // mutate in place
// map(i32(99))                 // panics: key not found
```

Requires `K <: Ord(K)`.

### Deque(T) — `Index(usize)`

```yo
(d : Deque(i32)) = Deque(i32).new();
d.push_back(i32(10));
d.push_back(i32(20));
v := d(usize(0)); // 10
addr_of(d(usize(0))).* = i32(555); // mutate in place
```

O(1) random access, correctly handles ring buffer wrapping.

### String — `Index(usize)`, read-only

`String` implements `Index(usize)` with `Output : u8` and no `IndexMut`: `s(i)` reads the byte at offset `i` and panics past the end, like `byte_at(i)`.

```yo
(s : String) = `Hello`;
b := s(usize(0)); // u8(72) — the byte ('H'); panics past the end
c := s.get_byte(usize(9)); // .None — the checked form
```

`s(i) = b` is a compile error naming the missing `IndexMut`: a write would change every string sharing the buffer, and it could leave invalid UTF-8 behind. Rust's `String` has no writable byte index either. For character-level access, use the `chars()` iterator. The range sugar `s(a..b)` builds a new string; it and every other string index (`substring`, `index_of`, …) are byte offsets — see [STRINGS.md](./STRINGS.md) for the full contract.

## Error Handling

Out-of-bounds access through the Index trait causes a **panic** at runtime. This is consistent with Rust's behavior. For checked access that returns `Option(T)`, use the `get` method on `ArrayList`:

```yo
(list : ArrayList(i32)) = ArrayList(i32).new();
list.push(i32(42));

// Panics on OOB:
// v := list(usize(99));  // ← panic!
// Safe access:
match(
  list.get(usize(99)),
  .Some(v) => println(`got: ${v}`),
  .None => println(`not found`)
);
```
