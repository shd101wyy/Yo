# Data Types

The types a Yo program builds its data from: primitives, structs, tuples,
arrays and ranges, enums and ADTs, unions, newtypes, member visibility and the
standard collections. Bindings and literals are in [SYNTAX.md](./SYNTAX.md);
ownership of these values is in
[OWNERSHIP_AND_BORROWING.md](./OWNERSHIP_AND_BORROWING.md).

## Types

A type can have the following **Kind**:

- Type
  - i32
  - bool
  - ...

### Type

#### Primitive Types

- `unit` (unit type)
- `bool` (true or false)
- `u8` (8-bit unsigned integer)
- `u16` (16-bit unsigned integer)
- `u32` (32-bit unsigned integer)
- `u64` (64-bit unsigned integer)
- `i8` (8-bit signed integer)
- `i16` (16-bit signed integer)
- `i32` (32-bit signed integer)
- `i64` (64-bit signed integer)
- `f32` (32-bit floating point)
- `f64` (64-bit floating point)
- `usize` (pointer size. It's `u32` on 32-bit system, `u64` on 64-bit system)
- `isize` (signed pointer size. It's `i32` on 32-bit system, `i64` on 64-bit system)

#### Compile-time known types:

- `comptime_int` (compile-time known integer type)
- `comptime_float` (compile-time known float type)
- `comptime_str` (compile-time known string type)
- `ComptimeList` (compile-time known list type)
- `Expr` (compile-time known expression type, used for macros and compile-time evaluation)

#### C compatible types:

- `char` (C char type)
- `short` (C short type)
- `ushort` (C unsigned short type)
- `int` (C int type)
- `uint` (C unsigned int type)
- `long` (C long type)
- `ulong` (C unsigned long type)
- `longlong` (C long long type)
- `ulonglong` (C unsigned long long type)
- `longdouble` (C long double type)
- `void` (C void type, mainly used for pointers like `*(void)`)

#### Type universes:

- `Type` (the type of all types)

#### Composite types:

- Structs defined with `struct(...)`
- Enums/ADTs defined with `enum(...)`
- Unions defined with `union(...)`
- Shared cells: `Rc(T)` (non-atomic reference counting) and `Arc(T)` (atomic reference counting), and `Box(T)`, the uniquely owned cell
- Fixed-size arrays: `Array(T, N)` or `[T; N]`
- Strings: the unsized `str`, `&str` (a fat reference), and `String`, the owned buffer; a string literal is a `&(str, static)`
- Newtypes defined with `newtype(...)`
- Tuples: `Tuple(T1, T2, ...)` or `(T1; T2; ...)`

#### Pointer types:

- `*(T)` (pointer to T)

#### Static/Dynamic dispatch types:

- `Impl(Trait)` (static dispatch type that implements Trait)
- `Dyn(Trait)` (dynamic dispatch: an unsized trait object, used behind a pointer such as `Box(Dyn(Trait))`, `Rc(Dyn(Trait))` or `&Dyn(Trait)`; see [TRAIT_OBJECTS.md](./TRAIT_OBJECTS.md))

#### Unsized types

A type with no size of its own lives only behind a pointer: `&T`, `&mut T`, `*T`, or an owning handle such as `Box(T)`. There are three:

- `[T]` (`Slice(T)`), a run of `T`s whose length is carried by the pointer. `unsize(&a)` turns a `&Array(T, N)` into a `&[T]` (`&mut a` and `*Array(T, N)` likewise), and `&xs(a..b)` is a view of part of a container whose `Index(Range(usize))` impl has `Output : [T]`, with no copy. `size_of_val(s)` and `align_of_val(s)` measure through the pointer.
- `Dyn(Trait, ...)`, a trait object, whose pointer carries the vtable ([TRAIT_OBJECTS.md](./TRAIT_OBJECTS.md)).
- A struct whose last field is unsized.

A pointer to an unsized type is two words, the address and the length or vtable. Using an unsized type by value (a local, a by-value parameter or result, a field other than a struct's last, an element, `size_of(T)`) is E0619, and so is assigning to an unsized place. `unsize` and `dyn` change a pointer's type, never a value's, so `unsize(a)` of a value is E0620. A `generic(T : Type)` binder carries the implicit bound `where(T <: Sized)`; a generic whose body uses `T` only behind a pointer declares `generic(T : ?Sized)` and accepts unsized types too, and its body is checked where it is defined:

```yo
Show :: trait(show : (fn(self : &Self) -> i32));
show :: (fn(generic(T : ?Sized), x : &T, where(T <: Show)) -> i32)(x.show());
```

A trait's associated type takes the same kind: with `Target : ?Sized` an impl may bind it to `[T]` or `str` as well as to a sized type, and the trait uses `Self.Target` only behind a pointer (a by-value `Self.Target` is E0619 at the trait). With `Target : Type` it is sized, and a value `str` written for it means `&(str, static)`.

```yo
Peek :: trait(Target : ?Sized, peek : (fn(self : &Self) -> &Self.Target));
Row :: struct(a : Array(i32, 3));
impl(Row, Peek(Target : [i32], peek : (fn(self : &Self) -> &Self.Target)(&self.a.*)));
```

On `[T]` the standard library provides `len`, `is_empty`, `contains`, `==` and hashing; a `[T]` has no subscript and no iterator.

#### Value Types and Shared Cells

**Value Types** (stack-allocated, copied on assignment):

- Primitive types: `i32`, `bool`, `f32`, etc.
- Structs defined with `struct(...)`
- Enums/ADTs defined with `enum(...)`
- Unions defined with `union(...)`
- Fixed-size arrays: `Array(T, N)` or `[T; N]`
- Tuples: `Tuple(T1, T2, ...)` or `(T1; T2; ...)`

**Shared cells** (heap-allocated, reference-counted):

- `Rc(T)` and `Arc(T)`: a handle is a new owner, spelled `Rc.clone(h)`; the payload is read-only through the handle
- Freed at the last handle; a reference cycle leaks unless a `Weak` breaks it
- `Rc` stays on the thread that created it; `Arc` is the atomic form that threads share

```yo
// Value type - stack-allocated; `Copy`, so `q := p` copies
Point :: struct(x : i32, y : i32);
derive(Point, Copy, Clone);
p := Point(x : 3, y : 4);
q := p;
// Shared cell - heap-allocated, reference-counted
s1 := Rc.new(String.from("Hello"));
s2 := Rc.clone(s1); // s2 and s1 point to the same cell (reference counted)
```

## Struct

```yo
Point :: struct(x : i32, y : i32);

my_point := Point(
  x : i32(10),
  y : i32(20)
);
```

Compiles to C

```c
struct Point {
  int x;
  int y;
};
```

## Tuple

A tuple is defined as a sequence of elements of different types, separated by commas and enclosed in parentheses.

```yo
my_unit := (); // my_unit: unit.
my_i32_tuple := 12; // my_i32_tuple: i32
// Needs extra comma to make it a tuple
my_i32_tuple := (12,); // my_i32_tuple: (i32;). Free type
// NOTE the separator: tuple VALUES use commas, tuple TYPES use SEMICOLONS.
(
  i32_tuple : (
    i32;
    i32;
    i32
  )
) = (1, 2, 3);

mixed_tuple := (1, true, "Hello"); // mixed_tuple: (i32; bool; str)
(a, b, c) := mixed_tuple; // a: i32, b: bool, c: str
a := mixed_tuple.0;
b := mixed_tuple.1;
c := mixed_tuple.2;

// NOTE: a 1-element tuple TYPE still needs the separator, or it is just the
// element type itself.
MyTuple :: i32;
// is equivalent to
MyTuple :: i32;
// to make it a 1-element tuple type:
MyTuple :: (
  i32;
);
```

## Array & Ranges

```yo
i32_array := [i32 ; _](1, 2, 3); // i32_array: [i32; 3]
// In C: int i32_array[3] = {1, 2, 3};
i32_array.len(); // 3, compile-time known
(i32_array2 : [i32 ; _]) = [1, 2, 3]; // i32_array2: [i32; 3]
```

There is no heap-backed slice type in Yo. Views that could dangle when
the underlying buffer is freed are excluded by construction:

- **Range operations COPY.** On `ArrayList(T)` and `String`, `xs(a..b)`
  and `xs(a..=b)` lower to `slice_copy` / `slice_copy_inclusive` and
  produce an independent owned value, not a window into the source.
- **`str` is the only built-in view**, and it refers exclusively to
  static string data — `s(a..b)` on a `str` is a zero-copy window of
  static bytes, which can never dangle.
- **Element access hands out values, never interior pointers** —
  `xs.get(i)` returns the element (a copy for `Copy` types, written back with
  `xs(i) = v`; `xs.get_cloned(i)` for the rest, a second handle for an `Rc` element, which
  survives container growth). See [OWNERSHIP_AND_BORROWING.md](./OWNERSHIP_AND_BORROWING.md#element-access-and-iteration).

### Range with `..`

```yo
mut(list) := ArrayList(i32).new();
list.push(i32(1));
list.push(i32(2));
list.push(i32(3));
list.push(i32(4));

// Copy of elements 1..3 (end-exclusive) — an independent ArrayList(i32)
part := list(usize(1) .. usize(3)); // [2, 3]
// End-inclusive variant
part2 := list(usize(1) ..= usize(3)); // [2, 3, 4]
// Mutating the copy does not affect the source
part(usize(0)) = i32(99);
assert(list(usize(1)) == i32(2));
```

### Array Methods

Arrays in Yo come with useful methods:

#### Array.fill

Create an array filled with a value:

```yo
// `fill` requires a COMPILE-TIME value argument (it is defined under
// `where(T <: Comptime)` and takes a `comptime(val)`), but its RESULT is a
// runtime value — bind it with `:=` (`::` is rejected: "Got runtime value").
zeros := Array(i32, 10).fill(0); // [0,0,0,0,0,0,0,0,0,0]
ones := Array(i32, 5).fill(1); // [1,1,1,1,1]
```

#### Array.len

Get the length of an array:

```yo
arr :: [1, 2, 3, 4, 5];
len := arr.len(); // 5 (a runtime value; the length is in the TYPE, reachable
//    at compile time via Type.get_info([i32; 5]) -> .Array(_, n))
// Works with generic arrays
generic_len :: (fn(comptime(T) : Type, comptime(n) : usize, arr : [T ; n]) -> usize)(arr.len()); // Returns n
```

### Array Length Inference

Yo can infer array lengths using `_`:

```yo
// Infer length from initializer
arr1 :: Array(i32, _)(1, 2, 3); // Array(i32, 3)
arr2 :: [i32 ; _](10, 20, 30, 40); // Array(i32, 4)
// Literal syntax with inferred length
arr3 :: [1, 2, 3]; // Array(i32, 3)
// Empty array
empty :: Array(i32, _)(); // Array(i32, 0)
// Nested arrays with inference
nested :: Array(Array(i32, _), _)(
  Array(i32, _)(1, 2, 3),
  Array(i32, _)(4, 5, 6)
); // Array(Array(i32, 3), 2)
```

**Restriction**: Cannot use `_` in variable bindings without initialization:

```yo
// Error: Cannot infer length
arr : Array(i32, _); // Not allowed!
arr = [1, 2, 3];

// Correct: Use concrete length or initialize immediately
arr := Array(i32, _)(1, 2, 3); // OK
```

### Array Assignment and Copying

Arrays are value types and are copied on assignment:

```yo
// Create arrays
arr1 := [i32(1), i32(2), i32(3)];
arr2 := arr1; // arr2 is a copy of arr1
// Modify arr2
arr2(usize(0)) = i32(10);

assert(arr1(usize(0)) == i32(1), "arr1 unchanged");
assert(arr2(usize(0)) == i32(10), "arr2 modified");
```

For more array examples, see `tests/array.test.yo`.

## Algebraic Data Types (ADT)

ADT is basically another type of Record with a hidden field `tag` that indicates the variant type.

Therefore, when a value of a variant is decided, we can access the field of the value just like accessing the field of a record.

There is also some optimization on the ADT. For example, if the ADT has only one variant, the `tag` field will be omitted.

In addition, if there is only one variant with one field, the field type will be used directly instead of wrapping it in a record. This is like the [newtype](https://wiki.haskell.org/Newtype) in Haskell.

```yo
Option :: (fn(comptime(T) : Type) -> comptime(Type))(
  enum(
    Some(value : T),
    None
  )
);

(none : Option(i32)) = .None;
(some : Option(i32)) = .Some(i32(42));

IpAddr :: enum(
  V4(a : u8, b : u8, c : u8, d : u8),
  V6(v : String)
);

home := IpAddr.V4(u8(127), u8(0), u8(0), u8(1));
loopback := IpAddr.V6(String.from("::1"));

// Use record as variant
Message :: enum(
  Quit,
  Move(x : i32, y : i32),
  Write(v : String),
  ChangeColor(r : i32, g : i32, b : i32)
);

m := Message.Write(String.from("hello"));
m = Message.Move(i32(3), i32(4));
m = Message.ChangeColor(i32(1), i32(2), i32(3));
```

## Enums without fields

It's the same as the ADT, but all variants have no fields.

```yo
State :: enum(
  Working,
  Failed
);
Week :: enum(
  Monday,
  // 0
  Tuesday,
  // 1
  Wednesday // 2
);

day := Week.Wednesday;
printf("%d", day); // 2
```

## Union

```yo
MyNumber :: union(
  i : i32,
  j : f32
);
(my_number : MyNumber) = MyNumber(i : 10);
my_number.j = 1.2;
```

Compiles to C

```c
union MyNumber {
  int i;
  float j;
};
```

## Newtype

The `newtype` keyword defines a struct with a single field along with methods, constants, and trait implementations in one declaration. It provides zero-cost abstraction - at runtime, it's identical to the wrapped type, but at compile time it's a distinct type. This is similar to Haskell's `newtype`.

**Key properties:**

- Zero runtime overhead (no wrapper allocation)
- Type safety through distinct types
- Methods and constants defined inline
- Trait implementations included in definition
- Access wrapped value via the field name

**Syntax:**

```yo
newtype(
  // Only one field
  field_name : FieldType
);
```

**Example:** (see `std/string/rune.yo`):

```yo
rune :: newtype(
  char : u32
);
impl(
  rune,
  // Constructor with validation
  from_u32 : (fn(value : u32) -> Option(Self))(
    cond(
      ((value <= u32(0x10FFFF)) && ((value < 0xD800) || (value > 0xDFFF))) => .Some(Self(char : value)),
      true => .None
    )
  ),
  to_u32 : (fn(self : Self) -> u32)(self.char),
  is_ascii : (fn(self : Self) -> bool)(self.char <= u32(0x7F)),
  // Constants
  NUL : Self(char : 0x00),
  TAB : Self(char : 0x09),
  NEWLINE : Self(char : 0x0A),
  SPACE : Self(char : 0x20)
);
```

**Use cases:**

- Type-safe IDs (UserId, OrderId, etc.)
- Unicode characters (rune wrapping u32)
- Units of measurement (Meters, Seconds, Dollars)
- Validated types (Email, PhoneNumber, PositiveInt)
- Semantic distinction (Username vs Password)

**Memory layout:**

```yo
UserId :: newtype(value : i32);
// size_of(UserId) == size_of(i32)
// In C: just an i32, no struct wrapper at runtime
```

## Private members

A struct field or impl method whose name starts with `_` is **private**, and the compiler enforces it. Such a member can be read, written, called, constructed or destructured only from the module that declares the type (or the impl) and from that module's **same-directory siblings**. Everything else is public. There is no keyword: the underscore convention *is* the visibility rule.

```yo
// counter.yo
{ String } :: import("std/string");

Counter :: struct(_count : i32, label : String);
impl(
  Counter,
  new : (fn(label : String) -> Counter)(Counter(_count : i32(0), label : label)),
  _bump : (fn(self : Self, by : i32) -> Counter)(
    Counter(_count : (self._count + by), label : self.label.clone())
  ),
  add : (fn(self : Self, by : i32) -> Counter)(self._bump(by)),
  count : (fn(self : Self) -> i32)(self._count)
);
export(Counter);
```

A module in a different directory imports it:

```yo
// app/main.yo
{ Counter } :: import("../counter.yo");
c := Counter.new(String.from("clicks")).add(i32(2));
c.count(); // OK — public method
c.label; // OK — public field
c._count; // error[E0405]: Field "_count" of Counter is private to its declaring module
c._bump(i32(1)); // error[E0405]: Method "_bump" of Counter is private to its declaring module
Counter(_count : i32(9), label : c.label); // error[E0405]: Cannot construct Counter outside its declaring module: field "_count" is private
{ _count } := c; // error[E0405]: Cannot destructure field "_count" of Counter outside its declaring module: it is private
{ label } := c; // OK — naming only public fields
```

The rules that follow from this:

- A type with any private field needs a constructor function (`Counter.new`) for outside callers, and outside code reads such a type only through its methods. The `{ ... }` spread is rejected too, so a private field never leaks through it.
- To test private members, put the test file **next to the module** (`counter.test.yo` beside `counter.yo`): a sibling may reach them, exactly like Rust's in-file `#[cfg(test)] mod tests`, while tests in another directory exercise the public surface. `yo test <dir>` runs sibling tests; a normal build treats `test(...)` as a no-op.
- The sibling rule makes a directory a unit: `std/sync/cond.yo` may call the `_raw_handle_ptr` method that `std/sync/mutex.yo` declares, while `std/thread.yo` may not.
- The static form `Counter._bump(c, i32(1))` is checked exactly like the instance call, and methods provided by a generic `impl(generic(T), ...)` count as declared where that impl is written.
- Names starting with `___` are reserved for compiler-synthesized members and are never private, and positional labels `_0`, `_1`, … (tuple-shaped structs) are not private either.
- Module-level bindings are unaffected: `export(...)` remains the only control over what a module publishes, whatever the binding is called. Trait *signatures* are not members of a type and are not checked either.

Run `yo explain E0405` for the diagnostic.

## Collections

Please check `std/collections` for the full list of collection types and their APIs.

Yo provides efficient, uniquely owned collection types in the standard library.

### Mutating a collection: mutators take `&mut self`

Every method that changes a collection takes `self : &mut Self`: the
mutators of `ArrayList`, `HashMap`, `HashSet`, `Deque`, `BTreeMap`,
`PriorityQueue`, `OrderedMap`, `HeaderMap` and `StringBuilder`
(`push`, `pop`, `insert`, `remove`, `clear`, `sort`, `retain`, `write_str`, …,
including `StringBuilder.to_string`, which detaches the buffer). Read-only
methods (`len`, `get`, `contains`, `iter`, …) take `self : Self`.

The collections are values: a copy is an explicit `.clone()`, and a write through a clone lands in the clone alone. The rules that follow:

- **A helper that fills a list takes it `&mut`:** `fill :: (fn(out :
  &mut ArrayList(i32)) -> unit)(...)`. A plain `out : ArrayList(i32)` parameter is
  the callee's copy.
- **An element of a collection is written through its place:**
  `rows(i).push(x)`, `m(k).push(x)`, or `for(&mut xs, x => x.push(...))`. A
  `match` binding (`.Some(l) => l.push(x)`) or a value `for` binding is a copy.
- **A list stored in a map or an `Option` field is taken out, changed and stored
  back:** `l := match(m.remove(k), .Some(v) => v, .None => ArrayList(T).new());
  l.push(x); m.insert(k, l);`, or `self.f.take()` followed by
  `self.f = .Some(l)`.
- **A list two owners hold on purpose is an `Rc`:** `Rc(ArrayList(T))`, written
  through `b.*.push(x)`. A closure or an `io.async` body captures by value, so a
  closure that records into a list shares it this way (or returns the list).

### ArrayList

Dynamic array with automatic resizing.

```yo
{ ArrayList } :: import("std/collections/array-list");

// Create a new ArrayList
mut(list) := ArrayList(i32).new();

// Push elements
list.push(i32(42));
list.push(i32(100));
list.push(i32(200));

printf("Length: %zu\n", list.len());
printf("Capacity: %zu\n", list.capacity());

// Get elements by index
first := list.get(usize(0));
match(
  first,
  .Some(value) => printf("First element: %d\n", value),
  .None => printf("No first element\n")
);

// Set an element
list(usize(1)) = i32(150);

// Pop an element
popped := list.pop();
match(
  popped,
  .Some(value) => printf("Popped: %d\n", value),
  .None => printf("List is empty\n")
);

// Create with initial capacity
list2 := ArrayList(i32).with_capacity(usize(10));

// Clear and shrink
list.clear();
list.shrink_to_fit();
```

### HashMap

Hash map with key-value pairs.

```yo
{ HashMap } :: import("std/collections/hash-map");

// Create a new HashMap
mut(map) := HashMap(i32, i32).new();

// Insert key-value pairs
result := map.insert(i32(1), i32(100));
match(
  result,
  .Ok(opt) => match(
    opt,
    .None => printf("Inserted new key\n"),
    .Some(old_val) => printf("Updated, old value: %d\n", old_val)
  ),
  .Error(_) => printf("Insert failed\n")
);

// Get a value
value_opt := map.get(i32(1));
match(
  value_opt,
  .Some(v) => printf("Value: %d\n", v),
  .None => printf("Key not found\n")
);

// Check if key exists
cond(
  map.contains_key(i32(1)) => printf("Contains key 1\n"),
  true => printf("Does not contain key 1\n")
);

// Remove a key
removed := map.remove(i32(1));
match(
  removed,
  .Some(v) => printf("Removed value: %d\n", v),
  .None => printf("Key not found\n")
);

// Check length and empty
printf("Length: %zu\n", map.len());
cond(
  map.is_empty() => printf("Map is empty\n"),
  true => printf("Map is not empty\n")
);

// Clear the map
map.clear();
```

### HashSet

Hash set for unique values.

```yo
{ HashSet } :: import("std/collections/hash-set");

// Create a new HashSet
mut(set) := HashSet(i32).new();

// Insert elements
result := set.insert(i32(42));
match(
  result,
  .Ok(was_new) => cond(
    was_new => printf("Inserted new element\n"),
    true => printf("Element already exists\n")
  ),
  .Error(_) => printf("Insert failed\n")
);

// Check if has
cond(
  set.contains(i32(42)) => printf("Contains 42\n"),
  true => printf("Does not contain 42\n")
);

// Remove element
removed := set.remove(i32(42));
cond(
  removed => printf("Removed element\n"),
  true => printf("Element not found\n")
);

// Set operations
set1 := HashSet(i32).new();
set2 := HashSet(i32).new();

set1.insert(i32(1));
set1.insert(i32(2));
set1.insert(i32(3));

set2.insert(i32(2));
set2.insert(i32(3));
set2.insert(i32(4));

// Union
union_result := set1.union(set2);
match(
  union_result,
  .Ok(union_set) => printf("Union size: %zu\n", union_set.len()),
  .Error(_) => printf("Union failed\n")
);

// Intersection
inter_result := set1.intersection(set2);
match(
  inter_result,
  .Ok(inter_set) => printf("Intersection size: %zu\n", inter_set.len()),
  .Error(_) => printf("Intersection failed\n")
);

// Subset check
is_sub := set1.is_subset(set2);
cond(
  is_sub => printf("set1 is subset of set2\n"),
  true => printf("set1 is not subset of set2\n")
);
```

### Names that differ from Rust

The standard library keeps Rust's method names (`push`, `pop`, `len`, `insert`, `contains_key`, `checked_add`, `Rc`, `Arc`, `Duration`). These types and spellings differ on purpose:

| Rust | Yo | Why |
| --- | --- | --- |
| `Vec<T>`, `vec![..]` | `ArrayList(T)`, `ArrayList(T).from([..])` | In mathematics a vector has a fixed size; this type grows. No std name says `Vec`. |
| `VecDeque`, `BinaryHeap` | `Deque`, `PriorityQueue` | The name of the abstract type, not of one implementation. |
| `char` | `rune` | `char` is C's 8-bit type, which FFI needs. |
| `Path`, `PathBuf` | one owned `Path` | There is no unsized path view. |
| `PartialEq`/`Eq`, `PartialOrd`/`Ord` | `Eq(T)`, `Ord(T)` | Floats carry a total `cmp`, so there is no split. |
| `Neg`, `Rem`, `Shl`, `Shr`, `Not` | `Negate`, `Mod`, `BitLeftShift`, `BitRightShift`, `LogicalNot` / `BitNot` | Yo's own names. `Not` is two operators: `!` is `LogicalNot` and yields `bool`, `~` is `BitNot`. |
| `collect::<Vec<_>>()`, `parse::<i32>()`, `into()` | `it.collect(ArrayList(i32))`, `s.parse(i32)`, `x.into(i64)` | The type is an argument: Yo does not infer from the result type. |
| `lock()`, `borrow()` / `borrow_mut()`, `Cell` | `m.with_lock(v => ..)`, `c.with(v => ..)` / `c.with_mut(v => ..)` on `RefCell` | Access is scoped to a closure; there are no guards and no lock poisoning. |
| `io::Result<T>`, `thread::spawn`, `JoinHandle<T>` | `exn : Exception` and `io : Io`, `Thread(T).spawn((io : Io) => ..)`, `t.join()` | I/O and threads are effects. |
| `sync::Weak`, `atomic::Ordering` | `ArcWeak`, `MemoryOrder` | One flat prelude namespace: `Weak` and `Ordering` are taken. |
| `Duration` over `u64` / `u128` | `Duration` over `i64`, `as_millis() -> i64` | There are no 128-bit integers, and a negative span is representable. |
| `serde_json::from_str`, `to_string` | `parse`, `stringify` (`json`, `toml`) | One verb pair for every text format. |
| `x.sqrt()` | `import("std/math");` | The import registers the float methods; the module exports no names. |

A Rust name that does not resolve (E0401) prints the Yo spelling and its import as help.
