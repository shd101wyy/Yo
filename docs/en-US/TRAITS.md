# Traits

Traits and `impl`: defining and implementing a trait, static methods,
associated types, coherence, calling an ambiguous method, `Impl(Trait)` types,
the subscript traits `Index`/`IndexMut`, and `Deref`. Trait objects (`Dyn`) are
in [TRAIT_OBJECTS.md](./TRAIT_OBJECTS.md); deriving impls is in
[DERIVE_TRAITS.md](./DERIVE_TRAITS.md).

## Defining and implementing traits

Traits define collections of functions and types that can be implemented for types. They work similarly to traits in Rust. Note that `impl` takes the receiver type as the first argument, followed by the trait implementation.

A trait is defined as a function that returns a `Trait` type containing field definitions.

```yo
// Define a trait (like a trait in Rust)
Summary :: trait(
  summarize : (fn(self : &mut Self) -> String)
);

Display :: trait(
  display : (fn(self : &mut Self) -> String),
  where(Self <: Summary) // Constraint
);

NewsArticle :: struct(
  headline : String,
  location : String,
  author : String,
  content : String
);

// Implement the Summary trait for NewsArticle
impl(
  NewsArticle,
  Summary(
    summarize : (
      self ->
        `${self.headline}, by ${self.author} (${self.location})`
    )
  )
);

// Implement the Display trait for NewsArticle
impl(
  NewsArticle,
  Display(
    display : (
      self ->
        `Headline: ${self.headline}\n`
    )
  )
);

// Pass in function
notify :: (fn(item : &mut NewsArticle) -> unit)({
  println(`Breaking news! ${item.summarize()}`);
});

// Generic function with trait constraint
notify2 :: (fn(generic(T : Type), item : &mut T, where(T <: Display)) -> unit)({
  println(`Breaking news! ${item.summarize()}`);
  println(`Breaking news! ${item.display()}`);
});
```

### Bounds

`<:` is the bound operator: `T <: Trait` reads "`T` implements `Trait`". Several bounds on one type are a tuple, `T <: (Clone, Hash)`, and a function trait is grouped, `F <: (Fn(x : i32) -> i32)`. The form is the same in every `where(...)`: a function's, a type constructor's, a trait's, an impl's and a derive's. In a trait, `where(Self <: Shape)` declares a supertrait and `where(Self.Item <: Clone)` bounds an associated type; an impl's `where(...)` bounds the impl's own `generic(...)` binders.

A name's `:` gives it a type or a kind, never a trait. A binder's kind is `Type`, `?Sized`, `Type.Struct`, `Origin`, `Trait` or a type constructor's kind, and its bounds go in `where(...)`: Rust's `T: Clone + Hash` is `generic(T : Type), where(T <: (Clone, Hash))`. A value's type names one type, so a trait reaches it through `Impl(...)` or `Dyn(...)`:

| To | Write |
| --- | --- |
| require that a type implements a trait | `where(T <: Trait)` |
| ask whether it does (a compile-time `bool`) | `Type.impls(T, Trait)` |
| call the impl a type has for a trait | `(T <: Trait).m(a)` |
| take a value of one implementing type | `x : Impl(Trait)` |
| erase a value's type to the trait | `dyn(&x)`, a `&Dyn(Trait)`; `dyn(Box.new(x))`, a `Box(Dyn(Trait))` |

Yo has no subtyping. A bound never lets a `T` stand where a `Dyn(Trait)` is expected: `dyn(&x)` writes the conversion. `<:` never relates two types or two traits.

The wrong spellings are errors where they are written. A bound in a kind slot is E0624: `where(T : Trait)`, `generic(T : Trait)`, `generic(T : (A, B))`, `generic(T <: Trait)`, `trait(Item : Trait, ...)`, and a right side that is not a trait (`T <: Circle`, with `Circle` a struct). `yo fix` rewrites `where(T : Trait)` to `<:`, and moves a bound out of a binder's kind slot in two passes: the bound into the signature's `where(...)`, then the kind `Type`. A trait as a value's type is E0625: `a : Trait`, `a : &Trait`, `-> Trait`, `(x : Trait) = v`, `struct(v : Trait)`. A trait constructor names its argument, `where(T <: Eq(T))`; `where(T <: Eq)` is E0603.

### Static trait methods

A trait method with no `self` parameter is a static method. Call it on an implementing type (`Point.make(...)`), or on a type parameter the trait constrains (`T.make(...)`). Constructor-style traits are written this way; `FromJson`'s `from_json(v)` is one.

```yo
{ println } :: import("std/fmt");

// A trait method without `self` is a static (constructor-style) method.
Make :: trait(make : (fn(n : i32) -> Self));

Point :: struct(x : i32, y : i32);
impl(Point, Make(make : (n -> Point(x : n, y : n))));

Meters :: struct(v : i32);
impl(Meters, Make(make : (n -> Meters(v : (n * i32(1000))))));

// Called on the type, or on a type parameter in a generic body.
build :: (fn(comptime(T) : Type, n : i32, where(T <: Make)) -> T)(T.make(n));

main :: (fn() -> unit)({
  p := Point.make(i32(3));
  m := build(Meters, i32(2));
  println(`${p.x} ${p.y} ${m.v}`); // 3 3 2000
});
export(main);
```

### Associated types in a trait's `where` clause

A trait declares an associated type before the members that name it (`Item : Type` first, then `next : (fn(...) -> Option(Self.Item))`). Its `where` clause may use its own projections to constrain a DIFFERENT type, as `IntoIterator` does with `where(Self.IntoIter <: Iterator(Item := Self.Item))`. It may not bind an associated type of `Self` itself to one of `Self`'s own projections:

```yo
Source :: trait(Item : Type, pull : (fn(self : &mut Self) -> Option(Self.Item)));

// error: Expected type for associated type constraint "Item", got: (Self.Item)
Peekable :: trait(
  Item : Type,
  peek : (fn(self : Self) -> Option(Self.Item)),
  where(Self <: Source(Item := Self.Item))
);
```

Both of these are accepted:

```yo
Source :: trait(Item : Type, pull : (fn(self : &mut Self) -> Option(Self.Item)));

// Constrain `Self` without binding its associated type...
Rewindable :: trait(
  rewind : (fn(self : &mut Self) -> unit),
  where(Self <: Source)
);

// ...or constrain a different associated type through `Self.Item`.
Pullable :: trait(
  Item : Type,
  Iter : Type,
  source : (fn(self : Self) -> Self.Iter),
  where(Self.Iter <: Source(Item := Self.Item))
);
```

### Coherence: one impl per type and trait

A type implements a trait at most once, in the whole program
(`plans/reference/TRAIT_COHERENCE.md`). Each of these is error E0612:

- a second `impl(P, Summary(...))`, in the same module or another one;
- an impl of a trait that an imported module or the prelude already implements for that type,
  such as `impl(i32, Display(...))`;
- a blanket impl (`impl(generic(T : Type), where(T <: Bound), T, Summary(...))`) together with a
  concrete impl of `Summary` for a type that satisfies `Bound`, in either order.

Yo has no specialization, so a more specific impl does not override a general one; before this
rule the first impl registered won silently and the other was dead code. Two instantiations of a
generic trait are different traits (`Eq(String)` and `Eq(str)`), and blanket impls whose bounds
do not overlap are fine.

### Trait Method Disambiguation

When a type implements multiple traits that define methods with the same name, `where` clause constraints determine which trait's method is used:

```yo
T1 :: trait(get_number : (fn(self : Self) -> i32));
T2 :: trait(get_number : (fn(self : Self) -> i32));

Point :: struct(x : i32, y : i32);
impl(Point, T1(get_number : (self -> self.x)));
impl(Point, T2(get_number : (self -> self.y)));

// Implicit dispatch — where(T <: T1) constrains self.get_number() to T1's method
use_t1 :: (fn(generic(T : Type), self : T, where(T <: T1)) -> i32)({
  return(self.get_number()); // Returns self.x (10)
});

// Explicit dispatch — (T <: T2).method(self) syntax
use_t2 :: (fn(generic(T : Type), self : T, where(T <: T2)) -> i32)({
  return((T <: T2).get_number(self)); // Returns self.y (20)
});

point := Point(10, 20);
use_t1(point); // 10
use_t2(point); // 20
```

## Impl Types

`Impl(TraitName)` creates a type representing any type that implements the specified trait(s). This is similar to `impl Trait` in Rust.

### Basic Usage

```yo
// Define a trait
Id :: trait(
  id : (fn(self : Self) -> Self)
);

// Function accepting any type implementing Id
use_id :: (
  fn(
    generic(T : Type),
    value : T,
    where(T <: Id)
  ) -> T
)({
  return(value.id());
});

// Implement Id for i32
impl(
  i32,
  Id(
    id : (
      self -> {
        printf("i32: %d\n", self);
        return(self);
      }
    )
  )
);

// Use it
result := use_id(42); // Prints "i32: 42", returns 42
```

### Impl as Return Type

`Impl` can be used in return types for static dispatch:

```yo
RetI32 :: trait(
  return_i32 : (fn(self : &mut Self) -> i32)
);

// `Impl(Trait)` is STATIC dispatch: every path must return the SAME concrete
// type, which the compiler infers. Returning `bool` from one arm and `i32` from
// another does not compile.
get_value :: (fn(use_bool : bool) -> Impl(RetI32))({
  cond(
    use_bool => return(i32(1)),
    true => return(i32(42))
  );
});

// To return DIFFERENT concrete types from different arms, erase to `Dyn`:
get_any :: (fn(use_bool : bool) -> Box(Dyn(RetI32)))({
  cond(
    use_bool => return(dyn(Box.new(true))),
    true => return(dyn(Box.new(i32(42))))
  );
});
```

**Important**: Each return path must return a concrete type, not different types that happen to implement the same trait.

### Impl with Multiple Traits

```yo
Speak :: trait(
  speak : (fn(self : Self) -> unit)
);

Run :: trait(
  run : (fn(self : Self) -> unit)
);

// Type must implement both Speak and Run
perform :: (
  fn(
    generic(T : Type),
    actor : T,
    where(T <: (Speak, Run))
  ) -> unit
)({
  actor.speak();
  actor.run();
});
```

## Index Trait

The `Index` trait provides a unified interface for accessing elements of a collection by index. Any type that implements `Index` can use the familiar `value(index)` call syntax, making custom collections behave just like built-in arrays and slices.

### Overview

```yo
// Built-in arrays and custom types use the same syntax:
(arr : [i32 ; 3]) = [i32(10), i32(20), i32(30)];
v := arr(usize(1)); // 20
(mut(list) : ArrayList(i32)) = ArrayList(i32).new();
list.push(i32(42));
v := list(usize(0)); // 42
```

### The Index Trait

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

### Reads and writes: `Index` and `IndexMut`

Element access is split in two, as in Rust.

- **Which method a subscript calls.** `x(i)` read as a value calls `index`. Every write calls `index_mut`: `x(i) = v`, a field of the element (`x(i).f = v`), a nested element (`grid(i)(j) = v`), a `self : &mut Self` method on the element (`x(i).push(v)`), a `&mut` argument (`f(&mut x(i))`), `addr_of(x(i))`, and a `&mut` local borrow of it. A read-modify-write such as `x(i) = (x(i) + 1)` is a read and then a write. Yo has no compound assignment operator.
- **Read-only elements.** A type that implements `Index` without `IndexMut` has read-only elements, and a write through `x(i)` is a compile error naming the missing `IndexMut`.
- **A writable receiver.** `index_mut` takes `self : &mut Self`, so writing `x(i)` through a read-only borrow of `x` (a `x : &T` parameter) is E0908.
- **One `Output`.** `Index` and `IndexMut` of the same index type must agree on `Output`.
- **`Deref` and `DerefMut` are chosen the same way.** `w.*` on an owner (`Array(T, N)`, a user type over a `[T]`) is the place its `deref` projection yields, and every write through it calls `deref_mut` instead; a type with `Deref` and no `DerefMut` has a read-only `.*` ([Dereference](#dereference)).

#### Projections

`index` and `index_mut` are **projections**: functions whose result is a borrow, `-> &T` or `-> &mut T`. A projection yields one place. Its result expression is that place written with the borrow sigil of its result type:

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
- **The sigil matches the result.** A `-> &T` projection writes `&place`, and a `-> &mut T` one writes `&mut place`. A reference binding is also a result: `x` for a parameter `x : &T` is the reference itself (the result is a reference slot, so the bare read is the reference, exactly as `&x.*` is), with the same root and origin checks. A `&mut` binding may be returned as `&T`; a `&` binding cannot be returned as `&mut T`.
- **Raw-pointer places.** In a `pragma(Pragma.AllowUnsafe)` file the place may be a raw-pointer dereference (`&(p &+ i).*`), and the result may be the raw pointer `*T` itself. This is the form std's buffers use.
- **ABI.** A projection's `&T` parameters are passed by pointer (a `&T` parameter is passed by value elsewhere), so the place it returns is the caller's.
- **Calling a projection directly.** A projection is also an ordinary function or method, called by name: `t.index(i)`, `Trio.index(&t, i)`, `first(&t)`. A function value of a projection type is called the same way: a `fn(s : &T) -> &U` parameter or field, an `Impl(Fn(s : &T) -> &U)` or `Dyn(Fn(s : &T) -> &U)` holding a named projection or a closure whose body yields `&place`, and an effect operation `ctl(...) -> &U`. The call's result is the place itself, never a copy:
  - as an operand it is read through (`t.index(i) + 1`);
  - as a receiver it is lent (`n.name(0).len()`, `n.name_mut(0).push_str("!")`), and a subscript on it indexes the place (`g.index_mut(0)(2) = v`);
  - as the argument of a `&T` or `&mut T` parameter it is lent as written (`f(t.index(i))`);
  - `r := t.index(i)` binds a local borrow, `&` or `&mut` as the result is, live until its last use. `(v : T) = t.index(i)` copies the value out instead;
  - a `&mut` projection's call is the left of `=` (`t.index_mut(i) = v`, or `t.index_mut(i).* = v`).
- **The result's roots.** The place lies in the call's borrowed arguments, the receiver included (a `&mut` projection's place lies in its `&mut` arguments). While a binding of the result is live, a `&` result freezes them (no write or move), and a `&mut` result allows no access to them except through the binding (E0911). The binding never leaves the function (E0912), and a projection call whose borrowed argument is a temporary cannot be bound.
- **Read projections are read-only.** Writing a `&` projection's place, calling a `self : &mut Self` method on it, or lending it to a `&mut` parameter is E0908. A `&mut` projection's call needs a writable receiver, as any `&mut self` method does.
- **A projection may yield another projection's result** (`&g.index(i).a`, `&mut g.index_mut(i).b`) when that call's borrowed arguments are rooted at its own borrow parameters. A `-> &mut T` projection yields only a `&mut` projection's place.

### Implementing Index

#### Basic Implementation

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

#### Generic Implementation

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

### Address-of Optimization

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
(mut(list) : ArrayList(i32)) = ArrayList(i32).new();
list.push(i32(100));

// Mutate via call-syntax assignment
list(usize(0)) = i32(999);
assert(list(usize(0)) == i32(999), "should be 999");
```

### Range Slicing

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

### Built-in vs. Trait-based Indexing

Built-in array and slice types (`[T; N]` and `[T]`) use built-in indexing that generates direct C array access (`arr.data[idx]`). This is more efficient than going through the Index trait and avoids recursion issues.

Custom types and standard library collections (like `ArrayList`) use the Index trait. The dispatch order is:

1. Built-in array/slice indexing (if the callee is `[T; N]` or `[T]`)
2. Range slicing with `..` or `..=` (if the argument is a range expression)
3. Index trait dispatch (looks up `Index(type_of(arg))` impl on the callee type)
4. Regular function call

### Inline with Operators

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

### Standard Library Implementations

The following standard library types implement the `Index` trait:

#### ArrayList(T) — `Index(usize)`

```yo
(mut(list) : ArrayList(i32)) = ArrayList(i32).new();
list.push(i32(42));
v := list(usize(0)); // 42
addr_of(list(usize(0))).* = i32(99); // mutate in place
```

#### HashMap(K, V) — `Index(K)`

```yo
(map : HashMap(i32, i32)) = HashMap(i32, i32).new();
map.insert(i32(1), i32(100));
v := map(i32(1)); // 100
addr_of(map(i32(1))).* = i32(999); // mutate in place
// map(i32(99))                 // panics: key not found
```

Requires `K <: (Eq(K), Hash)`.

#### BTreeMap(K, V) — `Index(K)`

```yo
(map : BTreeMap(i32, i32)) = BTreeMap(i32, i32).new();
map.insert(i32(5), i32(500));
v := map(i32(5)); // 500
addr_of(map(i32(5))).* = i32(77); // mutate in place
// map(i32(99))                 // panics: key not found
```

Requires `K <: Ord(K)`.

#### Deque(T) — `Index(usize)`

```yo
(d : Deque(i32)) = Deque(i32).new();
d.push_back(i32(10));
d.push_back(i32(20));
v := d(usize(0)); // 10
addr_of(d(usize(0))).* = i32(555); // mutate in place
```

O(1) random access, correctly handles ring buffer wrapping.

#### String — `Index(usize)`, read-only

`String` implements `Index(usize)` with `Output : u8` and no `IndexMut`: `s(i)` reads the byte at offset `i` and panics past the end, like `byte_at(i)`.

```yo
(s : String) = `Hello`;
b := s(usize(0)); // u8(72) — the byte ('H'); panics past the end
c := s.get_byte(usize(9)); // .None — the checked form
```

`s(i) = b` is a compile error naming the missing `IndexMut`: a write would change every string sharing the buffer, and it could leave invalid UTF-8 behind. Rust's `String` has no writable byte index either. For character-level access, use the `chars()` iterator. The range sugar `s(a..b)` builds a new string; it and every other string index (`substring`, `index_of`, …) are byte offsets — see [STRINGS.md](./STRINGS.md) for the full contract.

### Error Handling

Out-of-bounds access through the Index trait causes a **panic** at runtime. This is consistent with Rust's behavior. For checked access that returns `Option(T)`, use the `get` method on `ArrayList`:

```yo
(mut(list) : ArrayList(i32)) = ArrayList(i32).new();
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

## Dereference

The prelude's `Deref` trait names the place `w.*` stands for, and
`DerefMut` is its write half:

```yo ignore
Deref :: trait(Target : Type, deref : (fn(self : &Self) -> &Self.Target));
DerefMut :: trait(Target : Type, deref_mut : (fn(self : &mut Self) -> &mut Self.Target));
```

They are chosen as `Index` and `IndexMut` are: a read of `w.*` calls `deref`,
while a write, a `&mut` lend, a `self : &mut Self` receiver and `addr_of` call
`deref_mut`. A type with `Deref` and no `DerefMut` has a read-only `.*`, and
the two impls share one `Target`.

`x.*` is the only dereference: a reference's referent, a raw pointer's
pointee, a handle's payload, an owner's `deref` view. `Deref` and `DerefMut`
define `.*` and nothing else. Three rules name the implicit steps that stay:

- **Reference transparency.** `.` reaches what the receiver's own type names.
  `&T` and `&mut T` are transparent for it — they name no members, and no
  impl can give them any — so a field read, a method call and an index call
  read through any number of them without `.*`, in every receiver form: a
  binding, a field, a call result, a temporary. Every user-defined
  indirection — a `Deref`/`DerefMut` type, a raw pointer, an owner —
  requires the written `.*` (E0623 below). A whole-value read, borrow or
  write of a reference still spells `.*` (E0926) for a named binding, and no
  coercion turns `&&T` into `&T`.
- **Receiver auto-borrow.** A method receiver follows its slot's declared
  mode: `x.m(...)` passes `x` to `self` as the impl declares it — a by-value
  receiver consumes (or copies, `Copy`), a `&Self` slot lends `x` read-only
  for the call, and a `&mut Self` slot lends it exclusively until the call
  returns. A receiver that is itself a reference value needs no borrow: the
  reference is the slot's value. The written form `(&x).m(...)` /
  `(&mut x).m(...)` means the same call. The declared mode is the contract;
  `yo context <type> <method>` prints it.
- **Twin selection by written context.** `x.*` and `x(i)` in a read position
  dispatch `deref` / `index`; the mut twin is selected exactly when the
  written syntax sends a write or an exclusive lend through the place — an
  assignment target, a `&mut` argument or receiver, `addr_of` — and by
  nothing else. The twins share one `Target` / `Output`, and a type with
  only the read twin is read-only (E0908).

`Box`, `Rc` and `Arc` are **handles**: `w.*` is the payload their pointer
names, read natively, and their `deref` is `&self.*.*`. `Rc` and `Arc` have
no `DerefMut`, because their payload is read-only through the handle. A
payload member is written with one star per layer:

```yo
Point :: struct(x : i32, y : i32);
impl(Point, norm1 : (fn(self : &Self) -> i32)(self.x + self.y));
p := Rc.new(Point(x : 3, y : 4));
assert(p.*.x == 3);
assert(p.*.norm1() == 7);
assert(p.*.norm1() == 7);
pp := Rc.new(Rc.new(Point(x : 1, y : 2)));
assert(pp.*.*.y == 2); // one star per handle
assert(pp.*.*.y == 2); // one star per handle
mut(b) := Box.new(Point(x : 3, y : 4));
b.*.x = 5; // a place: only Box has DerefMut
assert(b.*.norm1() == 9);
```

- **A payload member read with `.` alone is error E0623.** Its help spells
  the whole chain (`pp.*.*.y`, `x.*.*.value`), and `yo fix` inserts the
  stars:

  ```yo expect=E0623
  Point :: struct(x : i32, y : i32);
  impl(Point, norm1 : (fn(self : &Self) -> i32)(self.x + self.y));
  main :: (fn() -> unit)({
    p := Rc.new(Point(x : 3, y : 4));
    n := p.norm1();
  });
  export(main);
  ```

  ```text
  error[E0623]: `p` has type `Rc(Point)`, which has no member "norm1"; its payload `Point` has one. `.` does not read through a handle.
  help: write `p.*.norm1(...)`: `p.*` names the payload (`yo fix` applies this)
  ```

  When no type in the chain has the name, the error says so:
  ``No field "z" on Rc(Point). `p` is a Rc(Point); its payload Point has no
  field "z" either.`` (E0406; E0610 for a method).
- **`w.clone()` is the handle's own `clone`**, in and out of a generic body:
  a second handle for `Rc` and `Arc`, a new cell for `Box`. `Rc.clone(w)` is
  the same call, and `w.*.clone()` is the payload's.
- **Callee position.** `h.*.items(i)` indexes the payload's `items`, and
  `h.*.f(x)` calls a payload field that holds a function.
- **A reference to a handle takes two stars.** `x : &Box(Node)`, such as a
  `for(&xs, x => …)` element or a `match(&self.next, .Some(b) => …)`
  binding, reaches the payload as `x.*.*.value`: the first star is the
  reference's, the second the handle's. The idiomatic forms are the `Box(n)`
  pattern (`.Some(Box(n)) => n.total()`) and `x.as_ref().value`.
- **Raw pointers.** `q.*.x` reads a field of the pointee of `q : *P` in
  unsafe code; `q.add(1)` is the pointer's own method.
- **Places.** On a `Box`, a payload member is a place: `b.*.x = v` and a
  `&mut self` call such as `b.*.items.push(v)` write the payload. Through an
  `Rc` the same spellings are E0919 (below): an `Rc` has no `DerefMut`, so
  its payload is read-only through the handle. In a file without
  `pragma(Pragma.AllowUnsafe)`, a write through an `Arc` is likewise
  rejected (`a.*.n = v`, `a.*.bump()` with `self : &mut Self`): mutate an
  `Arc`'s payload through a `Mutex` or an atomic.
- **Outside the prelude, `Deref` needs an unsized `Target`.** A `Deref` or
  `DerefMut` impl outside the prelude is accepted when its `Target` is
  `[T]`, `str`, a `Dyn(...)` or a tail-unsized struct. A sized `Target` and
  an open type variable are error E0622: a wrapper over a sized payload
  exposes it through its own fields and methods.
- **The whole payload as a reference: `as_ref`.** `Rc`, `Box` and `Arc`
  have `as_ref : (fn(self : &Self) -> &T)`, Rust's name: `h.as_ref()` lends
  the payload where a `&T` is wanted, such as an argument to a `&T`
  parameter (`takes_point(p.as_ref())`), and `Rc.as_ref(h)` is the same call
  through the type. Pass the result straight to a call or bind it first
  (`q := p.as_ref(); q.clone()` is the payload's `clone`).

**Owners.** Every other `Deref` type is an owner of unsized content, whose
`.*` is the place its `deref` projection yields. `Array(T, N)` is one in the
prelude and `ArrayList(T)` one in std, both with `Target : [T]` and
`DerefMut`, so `&list.*` lends a list's elements as a `&[T]`. A user type
over a `[T]` is one too:

```yo
{ assert } :: import("std/assert");
Ring :: struct(items : Array(i32, 3));
impl(Ring, len : (fn(self : &Self) -> usize)(usize(30)));
impl(Ring, Deref(Target : [i32], deref : (fn(self : &Self) -> &Self.Target)(&self.items.*)));
impl(Ring, DerefMut(Target : [i32], deref_mut : (fn(self : &mut Self) -> &mut Self.Target)(&mut self.items.*)));
count :: (fn(xs : &[i32]) -> usize)(xs.len());
main :: (fn() -> unit)({
  mut(r) := Ring(items : Array(i32, 3)(1, 2, 3));
  v := &r.*; // r.deref(): a view rooted at r
  assert(count(v) == usize(3));
  assert(r.len() == usize(30)); // Ring's len
  assert(r.len() == usize(30)); // Ring's len
  assert(r.*.len() == usize(3)); // the view's
  assert(!r.*.is_empty()); // a member only the view has
  w := &mut r.*; // r.deref_mut(): exclusive while w lives
  assert(count(w) == usize(3));
});
export(main);
```

- `&w.*` is `w.deref()`, `&mut w.*` is `w.deref_mut()`, and anywhere else
  `w.*` is that call's place. The view borrows the owner, so while it is
  live the owner cannot be written, moved or lent `&mut` (E0911).
- `r.len()` above is `Ring`'s and `r.*.len()` the view's. `r.is_empty()` is
  E0623: only the view has `is_empty`, and `r.*` names the view.
- **Nothing else dereferences.** A `&Ring` does not fill a `&[i32]`
  parameter: `count(&r)` is E0601, whose help names `count(&r.*)`. An
  operator operand is never dereferenced (`h.* + 1`). Indexing and iteration
  are not either: `h(i)` on `h : Rc(ArrayList(T))` is E0606, whose help
  names `h.*(i)`, and `for(&h, …)` is E0623, whose help names
  `for(&h.*, …)`.
