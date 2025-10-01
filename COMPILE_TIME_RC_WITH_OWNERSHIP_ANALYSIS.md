# Compile-time Reference Counting with Ownership Analysis

Inspired by the [Lobster programming language](https://aardappel.github.io/lobster/memory_management.html).

We consider each heap allocated ARC value to have a unique owner. Its reference counter starts at 1.

```rust
Point :: ref struct(x : i32, y : i32);

Point(3, 4); // temp_var owns the Point(3, 4)
```

Using `:=` for initialization will not increase the reference count. The variable on the left side of `:=` will borrow the value on the right side, not owning.

```rust
p1 := Point(3, 4); // temp_var owns the Point(3, 4)
// p1 borrows the temp_var
// we will not increment the reference count when := is used
```

When an owned variable goes out of scope, we automatically call `___drop` on it.

```rust
p1 := Point(3, 4); // temp_var owns the Point(3, 4)
// p1 borrows the temp_var
// we will not increment the reference count

// End of scope of temp_var
___drop(temp_var); // <= This is automatically inserted by the compiler

// NOTE: We will not call ___drop(p1) because p1 does not own the value
```

When to call `___dup` to increase the reference count?

1. On the right side of `=` assignment, and LHS is not variable. Or LHS is a variable, but not on the top frame of the environment.

   ```rust
   p1 := Point(3, 4); // temp_var owns the Point(3, 4)
   p2 := Point(5, 6); // temp_var2 owns the Point(5, 6)

   p2 = p1; // Will not call ___dup on p1 because p2 is a variable
           // In this case, it's still borrowing the ownership of temp_var

   // End of scope of temp_var and temp_var2
   __drop(temp_var2); // <= This is automatically inserted by the compiler
   __drop(temp_var); // <= This is automatically inserted by the compiler
   ```

   ```rust
   test :: (fn(data: Data)-> unit) {
     p1 := Point(3, 4); // temp_var owns the Point(3, 4)
     data.point = p1; // Will call ___dup on p1, because LHS is not a variable.

     __drop(temp_var); // <= This is automatically inserted by the compiler
   };
   ```


   ```rust
   p1 := Point(3, 4);
   {
     p2 := Point(4, 5);
     p1 = p2; // Will call ___dup on p2, because p1 is not on the top frame of the environment.
   };
   ```

2. Passing to `struct`, `enum`, `union`, `array`, `dyn`, `closure`, `thread` constructors. Pass to `chan` send function.

   ```rust
   p1 := Point(3, 4); // temp_var owns the Point(3, 4)
   data := Data(p1); // Will call ___dup on p1, because we are passing to a struct constructor
   arr := [p1]; // Will call ___dup on p1, because we are passing to an array constructor
   result := Result(Point).Ok(p1); // Will call ___dup on p1, because we are passing to an enum constructor
   ```

3. Returning a borrowed variable from a block/function.

   ```rust
   get_point :: (fn() -> Point) {
     p1 := Point(3, 4); // `temp_var` owns the Point(3, 4)
     // `p1` borrows the `temp_var`

     return p1; // Will call ___dup on p1, because p1 is not an owned variable.
     // ___drop(temp_var); // <= This is automatically inserted by the compiler
     // ___dup(p1) and ___drop(temp_var) cancelled out because p1 and temp_var are the same reference.
   };

   get_point2 :: (fn(p : Point) -> Point) { // p here is a borrowed variable, not owned.
     return p; // Will call ___dup, because p is not an owned variable.
   };

   {
     p1 := get_point(); // temp_var owns the return value

     // End of scope of temp_var
     ___drop(temp_var); // <= This is automatically inserted by the compiler
   };

   {
     p1 := Point(3, 4); // temp_var owns the Point(3, 4)
     p2 := get_point2(p1); // temp_var2 owns the return value

     // End of scope of temp_var and temp_var2
     ___drop(temp_var2); // <= This is automatically inserted by the compiler
     ___drop(temp_var); // <= This is automatically inserted by the compiler
   };
   ```
