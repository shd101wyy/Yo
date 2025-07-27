```rust,f#
swap :: 
  (fn(forall(compt(R1) : Region, compt(R2) : Region),
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
  (fn(forall(compt(R1) : Region, compt(R2) : Region),
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