Type reflection

```rust,f#
// Type reflection

TypeField :: struct(
  comptime(type) : Type,
  comptime(label) : comptime_string,
  comptime(is_comptime) : bool
);

TypeInfo :: enum(
  Module(
    comptime(fields) : ComptimeList(TypeField),
    comptime(receiver_type) : enum(
      None,
      Some(comptime(type) : Type)
    )
  ),
  I32(
    comptime(id) : comptime_string,
    comptime(module) : Self.Module
  ),
  Bool(
    comptime(id) : comptime_string,
    comptime(module) : Self.Module
  )
);


I32Info :: TypeInfo.I32(
  id: "i32",
  module: TypeInfo.Module(
    fields : ComptimeList(TypeField)(),
    receiver_type : .None
  )
);
```

```rust,f#
swap ::
  (fn(forall(R1 : Region, comptime(R2) : Region),
    a : &!(i32, using(R1)),
    b : &!(i32, using(R2))
  ) -> unit)
{
  temp := a.*;
  a.* := b.*;
  b.* := temp;
};

// pre/post conditions
swap2 ::
  (fn(forall(R1 : Region, comptime(R2) : Region),
    a : &!(i32, using(R1)),
    b : &!(i32, using(R2))
  ) -> (unit `with` {
    pre : {
      // pseudo example
      R3 :: R1;
      R1 < R3
    },
    post : {
      // pseudo example
      R4 :: R2;
      R2 < R4
    }
  }))
{
  pre(a.* != b.*);
  swap(a, b);
  post(a.* == b.*);
};

main :: (fn() -> unit) { // each `begin` will implicitly create a new region
  // given(reg) :: region();
  mut(x) := 1;
  mut(y) := 2;

  r1 :: region("Hi");
  r2 :: region("Hello");
  x_ref := &!(x, using(r1));
  y_ref := &!(y, using(r2));
  swap(x_ref, y_ref);

  x = 3; // error, cannot use `x` while it's borrowed

  flag :: (r1 > r2); // true, r1 lives longer than r2


  // explicitly end the lifetime earlier
  r1.end();

  x = 4; // now we can use `x`, but all references associated with `r1` are invalid now.
};

// Function purity and region constraints
// 1. Allow implicit temporary borrowing for "pure" functions
length :: (ref: &(i32)) -> usize `pure` // or `no_escape`

// 2. For functions that might store references, require explicit regions
store_in_container :: (
  ref: &(i32, using(R1)),
  container: &mut(Container, using(R2))
) -> unit `where` R1 >= R2  // ref must outlive container

// 3. Usage becomes natural
test1 :: (fn() -> unit) {
  mut(x) := 42;
  r1 :: region("data");
  x_mut := &!(x, using(r1));

  // This works - length is pure/no_escape
  len := length(x_mut); // implicit temporary immutable borrow

  // This requires explicit region management
  mut(container) := Container::new();
  r2 :: region("container");
  container_ref := &!(container, using(r2));

  // This would fail unless R1 >= R2
  store_in_container(x_mut, container_ref);

  x_mut.* = 12; // How to detect this line as error?
  // Problem: x_mut might be stored in container, creating aliasing
  // Solution approaches:
  // A) Conservative: any non-pure function "consumes" the reference
  // B) Flow-sensitive: track which references might be stored where
  // C) Explicit: require `move` or `borrow` annotations
};

test2 :: (fn() -> unit) {
  mut(x) := 42;
  r1 :: region("data");

  // This requires explicit region management
  mut(container) := Container::new();
  r2 :: region("container");
  container_ref := &!(container, using(r2));

  // This would fail unless R1 >= R2
  store_in_container(&!(x, using(r1)), container_ref);

  &!(x, using(r1)).* = 12;
};

// Rust's approach to this problem:
// 1. Tracks borrowing at the VALUE level, not reference level
// 2. Once `x` is borrowed (passed to non-pure function), ALL access to `x` is restricted
// 3. Doesn't matter if you create new references - the underlying value is borrowed
//
// In Rust terms:
// store_in_container(&x, &mut container); // `x` is now borrowed
// x = 12; // Error: cannot assign to `x` because it is borrowed
//
// So test2 SHOULD be an error because:
// - store_in_container(&!(x, using(r1)), container_ref) borrows `x`
// - &!(x, using(r1)).* = 12 tries to mutate the borrowed value `x`
// - Even though it's a "new" reference, it's the same underlying value

test3 :: (fn() -> unit) {
  mut(x) := 42;
  r1 :: region("data");

  // Case: pure function should allow continued use
  len := length(&!(x, using(r1))); // pure function, temporary borrow
  &!(x, using(r1)).* = 12; // Should be OK - no lasting borrow

  // Case: after region ends, should be OK
  {
    r2 :: region("temp");
    store_in_container(&!(x, using(r2)), some_container);
  } // r2 ends here, so any stored references are invalid

  &!(x, using(r1)).* = 13; // Should be OK - r2 references are gone
};

// How does Rust know a function borrows a value?
// It's based on SIGNATURE ANALYSIS and CONSERVATIVE ASSUMPTIONS:

// Example function signatures:
pure_read :: (ref: &(i32)) -> i32 `pure`
// Rust equivalent: fn pure_read(r: &i32) -> i32
// Analysis: Takes &T, returns non-reference -> temporary borrow only

might_store :: (ref: &(i32), container: &mut(Vec<&i32>)) -> unit
// Rust equivalent: fn might_store(r: &i32, container: &mut Vec<&i32>)
// Analysis: Takes &T and &mut Container<&T> -> ASSUMES it stores the reference

definitely_stores :: (ref: &(i32), container: &mut(Vec<&i32>)) -> unit {
  container.push(ref); // Actually stores it
}

does_nothing :: (ref: &(i32), container: &mut(Vec<&i32>)) -> unit {
  // Does nothing, but Rust still assumes it might store
}

// The borrow checker works by:
// 1. Looking at function signatures, not implementations
// 2. Making conservative assumptions about what functions MIGHT do
// 3. Tracking borrows at the VALUE level (x), not reference level (&x)
//
// So when you call: store_in_container(&!(x, using(r1)), container_ref)
// Rust thinks: "This function MIGHT store a reference to x in container"
// Therefore: "x is borrowed until container might be done with it"
```

---

Runtime memory safety check inspired by [Inko language](https://docs.inko-lang.org/manual/latest/getting-started/memory-management/)

```rust
Point :: struct
  x : i32,
  y : i32
;
// Allocated on heap, Linear
// can use both & and &!

Point :: value struct
  x : i32,
  y : i32
;
// Allocated on stack, Free
// cannot use & or &! references on Free
// but can use * or *! pointers

// => move semantics closure.
// &=> capture by reference closure.
// *=> capture by pointer closure.

// QUESTION: What about `value struct` contains a `struct` field? Can we use &/&! on that field?
// Disallow `value` type to contain non-value types?
```

---

Optional Region created using `borrow` for reference types.
So we still keep our current way of second-class reference.
However, if we use `borrow`, then we attach a `region` to the reference.
The `region` is optional.

```rust
x := 1;

ref := &(x); // not allowed due to second-class reference
mut_ref := &!(x); // not allowed due to second-class reference

borrow &(x), (x_ref)=> {
  // x cannot be used while borrowed.
  // x_ref has type &(i32, r1), where r1 is generated when we borrow.
  // x_ref is Free type.
  x_ref2 := x_ref; // allowed, because x_ref has region information.

  // You can cast &(i32, r1) to &(i32).
};

borrow &!(x), (x_ref)=> {
  // x cannot be used while borrowed.
  // x_ref has type &!(i32, r2), where r2 is generated when we borrow.
  // x_ref is Linear type!!! Mutable reference type with region is Linear!
  x_ref2 := x_ref; // x_ref is moved to x_ref2, so x_ref is no longer valid.

  // You can cast &!(i32, r2) to &!(i32) or &(i32), but not &(i32, r2).
}
```

The point is we only need `region` when we want to store references in the data structure.

Let me simplify this:

```rust
x := 1;

// region keeps track of the borrowed path collections like we did.

r1 :: region();
x_ref := &(x, r1); // borrow x at region r1.
                   // x_ref: &(i32, r1) // Free type.
x_ref2 := x_ref; // allowed, because x_ref has region information.

x_ref3 := &(x, r1); // not allowed, because `x` is already borrowed.
r1.end(); // end the region.

r2 :: region();
x_ref := &!(x, r2); // borrow x at region r2.
                    // x_ref: &!(i32, r2) // Linear type.
x_ref2 := x_ref; // x_ref is moved to x_ref2, so x_ref is no longer valid.

x_ref3 := &(x, r2); // not allowed, because `x` is already borrowed.
r2.end(); // end the region.
```

Let's simplify futher by automaticaly inserting `region`.
`region` keeps track of the borrowed path collections like we did.
Reference types that without `region` information are considered as 2nd-class references.

```rust
// ==> r1
x := 1;

{ // ==> r2
  x_ref := &(x);   // allowed, x_ref : &(i32, r2) // Free type.
  x2_ref := x_ref; // allowed, x2_ref : &(i32, r2) // Free type.
  x3_ref := &(x);  // allowed, x3_ref : &(i32, r2) // Free type.
  x4_ref := &!(x); // not allowed, because `x` is already borrowed in r2.

  (x5_ref : &(i32)) = x_ref; // not allowed, because &(i32) is 2nd-class reference.

  // r2 ends, invalidates all
}

{ // ==> r3
  x_ref := &!(x);  // allowed, x_ref : &!(i32, r3) // Linear type.
  x2_ref := x_ref; // allowed, x2_ref : &!(i32, r3) // Linear type.
  x3_ref := &!(x); // not allowed, because `x` is already borrowed in r3.
  x4_ref := &(x);  // not allowed, because `x` is already borrowed in r3.

  (x5_ref : &!(i32)) = x_ref; // not allowed, because &!(i32) is 2nd-class reference.

  // r3 ends, invalidates all
}

x_ref := &(x); // allowed, x_ref : &(i32, r1) // Free type.
x2_ref := x_ref; // allowed, x2_ref : &(i32, r1) // Free type.
x3_ref := &(x); // allowed, x3_ref : &(i32, r1) // Free type.
x4_ref := &!(x); // not allowed, because `x` is already borrowed in r1.
// r1 ends, invalidates all
```

1. Function boundaries

```rust
process :: (fn(forall(SomeRegion: Region), data: &(i32, SomeRegion)) -> unit) { ... }
process2 :: (fn(data: &(i32)) -> unit) { ... }

{ // r2
  x_ref := &(x);  // &(i32, r2)

  process(x_ref); // &(i32, r2) is valid here

  process2(x_ref); // &(i32, r2) gets casted to &(i32) here, which is allowed.
}
```

2. Return Values: Can functions return region-tagged references?

```rust
get_ref :: (fn(forall(SomeRegion: Region)) -> &(i32, SomeRegion)) { ... } // This is not allowed
```

3. Data Structure Storage: This is where explicit regions might still be needed:

```rust
Container :: (fn(using(ExplicitRegion: Region))-> comptime(Type))
  struct(
    data_ref: &(i32, ExplicitRegion) // Still need explicit regions here?
  );
```

4. Cross-Block Dependencies: What happens here?

```rust
// r1
x := 12;
mut(container) := Container::new();
{ // r2
  x_ref := &(x); // &(i32, r2)
  container.store(x_ref); // Error, because containser has type Container(using(r1))
}
```

```rust
// r1
x := 12;
{ // r2
  mut(container) := Container::new(); // Container(using(r2))
  x_ref := &(x); // &(i32, r2)
  container.store(x_ref); // Now it works!
}
```

---

- 2nd-class reference, same as swift in/inout, &(i32) without region.
- 1st-class reference, &(i32, r1) with region.

We say a 1st-class reference is used when it is passed to a function or stored in a data structure.

```rust
Point :: struct
  x : i32,
  y : i32
;

extern "Yo"
  use_ref : (fn(forall(r : Region), ref : &(Point, r)) -> unit),
  use_mut_ref : (fn(forall(r : Region), mut_ref : &!(Point, r)) -> unit),

  use_in_ref : (fn(in_ref : &(Point)) -> unit),
  use_inout_mut_ref : (fn(inout_mut_ref : &!(Point)) -> unit),

  use_i32_ref : (fn(forall(r : Region), ref : &(i32, r)) -> unit),
  use_i32_mut_ref : (fn(forall(r : Region), mut_ref : &!(i32, r)) -> unit),

  use_i32_in_ref : (fn(in_ref : &(i32)) -> unit),
  use_i32_inout_mut_ref : (fn(inout_mut_ref : &!(i32)) -> unit)
;


// r1 :: region();
p := Point(3, 4);

{ // r2 :: region();
  p_ref := &(p); // p_ref : &(Point, r2), Free, path `p` not used
  p_ref2 := &!(p); // p_ref2 : &!(Point, r2), Linear, path `p` not used

  use_in_ref(p_ref); // Allowed, p_ref is Free type
                     // path `p` is still not used,
                     // because we only passed it to function accepts &(i32),
                     // but not &(i32, r2).
  use_inout_mut_ref(p_ref2); // Allowed, p_ref2 is Linear type, but not consumed
                             // because we only passed it to function accepts &!(i32),
                             // but not &!(i32, r2).

  use_ref(p_ref); // Allowed, p_ref is Free type, but not consumed.
                  // path `p` is now used, as it is passed to a function that accepts &(i32, r2).
  use_mut_ref(p_ref2); // Not allowed, because path `p` is used as immutable reference.
};

{
  // r3 :: region();
  px_ref = &(p.x); // px_ref : &(i32, r3), Free, path `p.x` not used
  py_ref = &!(p.y); // py_ref : &!(i32, r3), Linear, path `p.y` not used

  use_i32_in_ref(px_ref); // Allowed, px_ref is Free type
                          // path `p.x` is still not used,
                          // because we only passed it to function accepts &(i32),
                          // but not &(i32, r3).
  use_i32_inout_mut_ref(py_ref); // Allowed, py_ref is Linear type
                                 // path `p.y` is still not used,
                                 // because we only passed it to function accepts &!(i32),

  use_i32_ref(px_ref); // Allowed, px_ref is Free type, but not consumed.
                  // path `p.x` is now used, as it is passed to a function that accepts &(i32, r3).
  use_i32_mut_ref(py_ref); // Allowed, py_ref is Linear type, and it's consumed.
                           // path `p.y` is now used, as it is passed to a function that accepts &!(i32, r3).
};
```

```rust
// Ref type
List :: struct
  data : i32,
  tail : Option(Ref(List))
;

p := Ref(Point(3, 4));

p.mut_ref();
p.ref();
p.try_mut_ref();
p.try_ref();
```

```rust
// "ref" only works with "struct" and "enum" types.
List :: ref struct // reference counted
  data : i32,
  tail : Option(List)
;

Point :: struct // not reference counted
  x : i32,
  y : i32
;

Shape :: ref enum // reference counted
  Rectangle(w: i32, h: i32),
  Circle(r: i32)
;

mut(p1) := Point(3, 4);
p2 := p1; // p2 and p1 are independent copies.
p1.x = 6;
p2 == Point(3, 4); // true
p1 == Point(6, 4); // true

// Or
Point :: struct
  x : i32,
  y : i32
;
p1 := Point(3, 4); // allocated on stack
p2 := new Point(5, 6); // allocated on heap
// p2 : ^(Point); // Reference counted.
p3 := p2; // p2 and p3 are the same reference.
p2.x = 7;
p2 == Point(7, 6); // true
// ^ I feel this approach is too complicated.
// It introduces new pointer type ^(T), which is reference counted.
```

```rust
Box :: (fn(comptime(V) : Type) -> comptime(Type))
  ref struct
    (*) : V
;
box :: (fn(forall(V : Type), value : V) -> Box(V))

x := Box(i32)(42);
x := box(42); // sugar
x.* = 43;
```

Let's keep it simple for now:

- Remove the `region` concept.
- Add `ref` keyword to `struct` and `enum` for reference counted types.
- ~~Remove `&` and `&!` for reference types. Use them to create pointer values instead for `*` and `*!`.~~
- Remove the borrow checker which is currently based on second-class references.
- Remove the Linear/Free type system and the move semantics.
- Simply the `match` to support destructuring.
- Add `Io` monad for simple effect system.
- Update closure syntax. So we have:
  - `fn(...) -> ... { ... }` normal function.
  - `fn(...) => ... { ... }` closure which is esssentially a struct containing context pointer and call function pointer.
- Make dynamic dispatch support only `ref` types.

  ```rust
  Bark :: module
    Self : Type,
    bark : (fn(self: Self) -> String);
  ;
  dog := ref struct();
  cat := ref struct();

  given(DogBark) :: Bark
    Self : dog,
    bark :
      (self) -> "Woof!"
  ;
  given(CatBark) :: Bark
    Self : cat,
    bark :
      (self) -> "Meow!"
  ;
  (animals : Array(Dyn(Bark))) = [dyn(dog), dyn(cat)];
  ```

Use ^(x) to move a value. By moving we consume the variable. This could be useful for ending the variable lifetime early, especially like in a `cond`/`match` expression.

---

```rust
impl(bool, Comptime, {});
impl(bool, LogicalNot, {
  (!) :: (fn(value : bool) -> bool) {
    return __yo_op_not(a);
  };
  export (!);
});
```

No this is bad ^^ It requires we re-define the function signature every time.
