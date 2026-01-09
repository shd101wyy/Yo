# Language Design

**Yo** is a multi-paradigm, general-purpose, compiled programming language.
Yo aims to be **Simple** and **Fast** (around 0% - 15% slower than C).

**Yo** aims to be a simple to learn programming language for C and JavaScript (TypeScript) programmers 😉.

**Yo** (will &) tend to support advanced type system features such as generalized algebraic data types (GADT), dependent types, refinement types [In Design](./IN_DESIGN.md).

Our goal is to be a practical language that is easy to use and easy to learn.

<!-- @import "[TOC]" {cmd="toc" depthFrom=2 depthTo=6 orderedList=false} -->

<!-- code_chunk_output -->

- [Philosophy](#philosophy)
- [Inspiration](#inspiration)
- [Hello World](#hello-world)
- [CLI Usage](#cli-usage)
- [Syntax](#syntax)
- [Types](#types)
  - [Type](#type)
    - [Primitive Types](#primitive-types)
    - [Value Types vs Object Types](#value-types-vs-object-types)
  - [Variable Declaration](#variable-declaration)
    - [No variable shadowing](#no-variable-shadowing)
  - [Type inference](#type-inference)
    - [Uninitialized variable](#uninitialized-variable)
- [Function Declaration](#function-declaration)
  - [Named arguments](#named-arguments)
  - [Default parameter values](#default-parameter-values)
  - [Generic function](#generic-function)
  - [Type constraints](#type-constraints)
  - [Type Methods](#type-methods)
  - [recur](#recur)
  - [Object Types and Memory Management](#object-types-and-memory-management)
    - [Object Type](#object-type)
    - [Compile-Time Reference Counting Optimization](#compile-time-reference-counting-optimization)
- [Pointers](#pointers)
  - [Pointer Operations](#pointer-operations)
  - [Pointer Arithmetic Operations](#pointer-arithmetic-operations)
  - [Pointer Operators Reference](#pointer-operators-reference)
  - [The consume Function](#the-consume-function)
  - [Nullable Pointers](#nullable-pointers)
  - [RAII (Resource Acquisition Is Initialization)](#raii-resource-acquisition-is-initialization)
- [Tuple](#tuple)
- [Array & Slice](#array--slice)
  - [Range with `:`](#range-with-)
  - [Array Methods](#array-methods)
    - [Array.fill](#arrayfill)
    - [Array.len](#arraylen)
  - [Array Length Inference](#array-length-inference)
  - [Array Assignment and Copying](#array-assignment-and-copying)
- [Control Flow](#control-flow)
  - [if/else](#ifelse)
  - [cond](#cond)
  - [while](#while)
- [Algebraic Data Types (ADT)](#algebraic-data-types-adt)
- [C struct](#c-struct)
- [Newtype](#newtype)
- [C union](#c-union)
- [C enum](#c-enum)
- [Modules](#modules)
- [Pattern Matching](#pattern-matching)
- [String](#string)
  - [C String literal as u8 slice or C string pointer](#c-string-literal-as-u8-slice-or-c-string-pointer)
  - [String (Immutable String)](#string-immutable-string)
- [Collections](#collections)
  - [ArrayList](#arraylist)
  - [HashMap](#hashmap)
  - [HashSet](#hashset)
  - [LinkedList](#linkedlist)
- [Closure](#closure)
  - [Basic Closure Syntax](#basic-closure-syntax)
  - [Closure Capture Semantics](#closure-capture-semantics)
  - [Closure Type Restrictions](#closure-type-restrictions)
  - [Closures with Object Types](#closures-with-object-types)
- [Box and Boxing](#box-and-boxing)
  - [Box Type](#box-type)
  - [Usage Examples](#usage-examples)
  - [Box with Assignments](#box-with-assignments)
  - [Box and Reference Counting](#box-and-reference-counting)
  - [When to Use Box](#when-to-use-box)
- [Impl Types](#impl-types)
  - [Basic Usage](#basic-usage)
  - [Impl as Return Type](#impl-as-return-type)
  - [Impl with Multiple Modules](#impl-with-multiple-modules)
  - [Impl vs Dyn](#impl-vs-dyn)
- [Error handling](#error-handling)
  - [Error Propagation with match](#error-propagation-with-match)
- [Closure](#closure-1)
- [Async/Await](#asyncawait)
- [Parallelism](#parallelism)
- [Isolated Types](#isolated-types)
- [Async IO](#async-io)
- [Module importing and exporting](#module-importing-and-exporting)
- [Dynamic Dispatch](#dynamic-dispatch)
  - [`Dyn` and `dyn`](#dyn-and-dyn)
  - [Examples](#examples)
- [Naming Convention](#naming-convention)
- [Testing](#testing)
  - [Basic Test Syntax](#basic-test-syntax)
  - [Running Tests](#running-tests)
  - [Assertions](#assertions)
    - [Runtime Assertions](#runtime-assertions)
    - [Compile-Time Assertions](#compile-time-assertions)
  - [Testing Expected Errors](#testing-expected-errors)
  - [Test Organization](#test-organization)
  - [Testing with Object Types](#testing-with-object-types)
  - [Test Files](#test-files)
- [Meta-programming](#meta-programming)
  - [Macro functions](#macro-functions)
- [Compile-Time Evaluation](#compile-time-evaluation)
  - [Compile-Time Variables](#compile-time-variables)
  - [Compile-Time Arithmetic](#compile-time-arithmetic)
  - [Compile-Time Arrays](#compile-time-arrays)
  - [Compile-Time Assertions](#compile-time-assertions-1)
  - [Compile-Time Expected Errors](#compile-time-expected-errors)
  - [Compile-Time vs Runtime](#compile-time-vs-runtime)
  - [Benefits of Compile-Time Evaluation](#benefits-of-compile-time-evaluation)
- [In Design](#in-design)
- [References](#references)

<!-- /code_chunk_output -->

## Philosophy

**Key Design Principles:**

- **Simple syntax inspired by Lisp** (no keywords, minimal)
- **First-class types** (types are values)
- **Compile-time evaluation** (powerful `compt` system)
- **Reference counting with ownership analysis** (eliminate unnecessary RC)
- **Pointer-based memory model** (no references/borrowing complexity)

**A few NO design choices:**

- **No operator precedence** (explicit parentheses or newline-based associativity)
- **No variable shadowing** (similar to Zig)
- **No stop-the-world GC** (optional thread-local cycle collector for object types)

## Inspiration

The **Yo** language is inspired by the following programming languages and absorbs some of their good ideas:

- Lisp
  - [Scheme](https://www.scheme.com/)
  - [Clojure](https://clojure.org/)
- [C](https://www.c-language.org/)/[C++](https://isocpp.org/)
- [Rust](https://www.rust-lang.org/)
- [Haskell](https://www.haskell.org/), [OCaml](https://ocaml.org/), [PureScript](https://www.purescript.org/)
- [JavaScript](https://developer.mozilla.org/en-US/docs/Web/JavaScript), [TypeScript](https://www.typescriptlang.org/)
- [Jai](https://github.com/Ivo-Balbaert/The_Way_to_Jai), [Zig](https://ziglang.org/), [Odin](https://odin-lang.org/)
- [Nim](https://nim-lang.org/)
- [Austral](https://austral-lang.org/)
- [Elixir](https://elixir-lang.org/)
- [Io](https://iolanguage.org/)
- [ATS](https://www.ats-lang.org/)
- [Effekt](https://effekt-lang.org/), [Koka](https://koka-lang.github.io/)
- [Go](https://go.dev/)
- [Ada](https://www.adacore.com/)
- [hylo](https://www.hylo-lang.org/)
- [Lobster](https://aardappel.github.io/lobster/README_FIRST.html)
- [pony](https://www.ponylang.io/)
- [Swift](https://swift.org/)
- [Vale](https://vale.dev/)

## Hello World

```rust
open import "std/libc/stdio";

main :: (fn()-> unit) {
  printf("Hello World!\n");
};

export main;
```

## CLI Usage

```bash
yo --help
yo --version
yo init # Create a new project in the current directory

# Compilation
yo compile hello.yo -o hello
yo compile hello.yo --c-compiler clang -o hello
yo compile hello.yo --target wasm -o hello.wasm

# Package management (In Design)
yo install # Install dependencies defined in `yo.json` and `yo.lock`
yo install package-name # Install a specific package
yo install package-name@version # Install a specific version of a package
yo install --global package-name # Install a package globally
yo uninstall package-name # Uninstall a package

# package-name could be
#   github:shd101wyy/some-package@master

# Run scripts (In Design)
yo run test

# Format code (In Design)
yo format
```

## Syntax

```rust
// Comment is using `//` or `/* */`
/*
  Nested comments are supported
  /*
    Like this
  */
*/

// Yo syntax is inspired by Lisp, so there are no keywords
// It uses atoms and function calls only
x // an atom (identifier)
func(x, y) // a function call with two arguments x and y.
           // Please note there is no space between function name and parentheses

// or without parentheses:
func x, y  // same as above

// or use S expression style:
(func x, y) // same as above, but with parentheses surrounding the whole expression

// Yo is case sensitive, so `X` and `x` are different identifiers

// In Yo, everything is a function:
x := true;
y :: 14;

// can be written as:
(:=)(x, true);
(::)(y, 14);
// although normally we won't write like this ^

// There is no arithmetic precedence in Yo
// Except for the "." which is not treated as an operator, but it has the highest precedence.
// "." has its own parsing rules, for example a.b + c.d is parsed as (. a b) + (. c d)

// Every infix operator takes two arguments on its left and right
// so the expression below is invalid
//
//   3 + 4 - 5;
//
// needs to be written as
//
3 + (4 - 5);
//
// or
(3 + 4) - 5;
// or you can use ; to separate the expressions
3 + 4; - 5; // but apparently this is not what we meant :)
// same for
//
//   3 + 4 + 5;
//
// needs to be written as
(3 + 4) + 5;

// Operators in Yo are combination of the following characters:
// = + - * / < > @ $ ~ & % | ! ? ^ . : \\ #
// They can be used as infix operators with two arguments
// But they will be translated as dot method call:
(3 + 4) * 5; // is the same as
3.(+)(4).(*)(5);

// But there is a trick with newlines and operator positioning
// to control associativity without parentheses!

// RIGHT ASSOCIATIVITY: Put operator at the end of line
3 + // Newline after the operator enforces right associativity!
  4 + 5
;
// This is equivalent to
3 + (4 + 5);

// LEFT ASSOCIATIVITY: Put operator at the start of line
  1
+ 2
+ 3
;
// This is equivalent to
(1 + 2) + 3;

{
  // Content within {...} with separator `;` is a begin block
  // which is used to group expressions together
  (); // () is a unit value
  12
};
// is the same as
begin(
  (),
  12
);
```

## Types

A type can have the following **Kind**:

- Type
  - i32
  - bool
  - ...

### Type

#### Primitive Types

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
- `()` (unit type, same as the `void` in C)
- `rune` (Unicode code point, 32-bit, similar to Go's rune. See `std/string/rune.yo`)
- `char` (C char type, 8-bit)

#### Value Types vs Object Types

**Value Types** (stack-allocated, copied on assignment):

- Primitive types: `i32`, `bool`, `f32`, etc.
- Structs defined with `struct(...)`
- Enums/ADTs defined with `enum(...)`
- Unions defined with `union(...)`
- Fixed-size arrays: `Array(T, N)`
- Tuples: `Tuple(T1, T2, ...)`

**Object Types** (heap-allocated, reference-counted):

- Types defined with `object(...)`
- Automatic cycle detection and collection
- Thread-affinity for performance (objects stay on the thread that created them)

```rust
// Value type - stack-allocated, copied
Point :: struct(x : i32, y : i32);
p1 := Point(3, 4);
p2 := p1;  // p2 is a copy of p1

// Object type - heap-allocated, reference-counted
String :: object(
  _bytes: ArrayList(u8),
  // methods...
);
s1 := String.from("Hello");
s2 := s1;  // s2 and s1 point to the same object (reference counted)
```

### Variable Declaration

Variables in Yo are declared with `:=` (runtime) or `::` (compile-time).

```rust
               // "compt" here means compile-time known
x := 5;        // x: i32, runtime variable
y :: 5;        // y: compt_int, compile-time variable

// with explicit type declaration
(x : i32) = 5; // x: i32, runtime variable
(compt(y) : compt_int) = 5; // y: compt_int, compile-time variable
// or
compt(y) := 5;

// All variables are mutable by default
x := 1;
x = 2;  // OK: reassignment is allowed

// (:) function is used to denote a type
// (=) function is used to update a variable with a new value, or initialize a variable with a value
// (:=) function is used to denote a runtime variable with type inferred
// (::) function is used to denote a comptime variable with type inferred

x : i32;        // Define a runtime variable
compt(x) : i32; // Define a compile-time variable
// All variables are mutable by default. There is no immutable variable, for simplicity.

// Initialize variables
(compt(x) : compt_int) = 12;
(y : i32) = 14;
(z : i32) = 16;

// can be written as:
(=)((:)(compt(x), compt_int), 12);
(=)((:)(y, i32), 14);
(=)((:)(z, i32), 16);

// They are equivalent to the following:
x :: 12;
y := 14;
z := 16;
```

All variables are mutable by default.

> Yo used to have a `mut` keyword to denote mutable variables, but it was removed for simplicity.

#### No variable shadowing

Yo disallows variable shadowing to avoid confusion

```rust
x := 1;
x := 2; // Error: x is already declared
```

```rust
x := 1;
{
  x := 2; // Error: x is already declared
};
```

Variables can be shadowed in different block scopes:

```rust
{
  x := 1;
}
{
  x := 2; // Allowed: different scope
}
```

### Type inference

```rust
// String is an object type with automatic reference counting
(my_string: String) = String.from("Hello, world"); // Heap-allocated
my_string_2 := my_string; // Both point to the same object (RC incremented)

// Primitive types are copied
my_int := 1; // Stack-allocated
my_int_2 := my_int; // my_int_2 is a copy

// Fixed-size arrays are value types
(my_int_array: Array(i32, 3)) = [1, 2, 3]; // Stack-allocated
my_int_array := [1, 2, 3]; // Array(i32, 3)

// ArrayList is an object type
(my_array_list: ArrayList(i32)) = ArrayList(i32).new(); // Heap-allocated, RC

// Enum/ADT can be value or object type depending on definition
Person :: struct(name: String, age: i32); // Value type (but contains object field)
p := Person(name: String.from("Alice"), age: 30);
_(name, age) := p; // name: String, age: i32
```

#### Uninitialized variable

```rust
x : i32; // x: i32, uninitialized

// Compiler prevents using uninitialized variable.
println(x); // Compiler Error: x is uninitialized.

x = 1; // x: i32, initialized
```

## Function Declaration

Functions are declared using the `::` operator for compile-time definitions or `:=` for runtime values.

```rust
// Function declaration with explicit type
// function type is written as fn(args...) -> return_type
add :: (fn(x : i32, y : i32) -> i32)
  (x + y)  // Function body
;
// calling a function type with function body creates a function value

// Or define type first, then implementation
compt(add) : (fn(x : i32, y : i32) -> i32);
add = _(x + y); // `_` here infers the function type from `add`

// or define the function body with anonymous function
add = ((a, b) -> (a + b));  // Type inferred from usage. Can have different parameter names

// With explicit return type
multiply :: (fn(x : i32, y : i32) -> i32) {
  return (x * y);  // Explicit return
};

// Last expression is the return value
divide :: (fn(x : i32, y : i32) -> i32)
  (x / y)
;

// Function can take `compt` parameter and can return `compt` value, like Type:
Point :: (fn(compt(T) : Type) -> compt(Type)) {
  return struct(
    x : T,
    y : T
  );
};
I32Point :: Point(i32);
BoolPoint :: Point(bool);

p1 := I32Point(3, 4);
p2 := BoolPoint(true, false);
```

### Named arguments

Named arguments in Yo must be provided in the same order as they are defined in the function signature:

```rust
add :: (fn(x : i32, y : i32) -> i32)
  (x + y)
;

add(3, 4);        // OK: Positional arguments
add(x: 3, y: 4);  // OK: Named arguments in correct order
add(3, y: 4);     // OK: Mixed (positional then named)
add(y: 4, x: 3);  // Error: Named arguments must be in order (x before y)
```

### Default parameter values

Default parameter values can be defined using `?=` syntax:

```rust
create_user :: (fn(
    name: String,
    (age: i32) ?= 18,
  ) -> User)
  User(name: name, age: age)
;

create_user(name: "Alice");  // Uses defaults: age=18
create_user(name: "Bob", age: 30);  // Explicit age
```

> Note: Default parameters must use compile-time known values.

### Generic function

You can use `forall` to define generic functions:

```rust
identity :: (fn(forall(T : Type), arg : T) -> T)
  arg
;

x := identity(12);     // Type inferred: x: i32
y := identity(true);   // Type inferred: y: bool
```

### Type constraints

You can use `where` clause to add type constraints on generic parameters:

```rust
add :: (fn(forall(T : Type), x: T, y: T, where(T <: Add(T))) -> T)
  (x + y)
;
```

`where` clause can specify multiple constraints:

```rust
compare_and_add :: (fn(
    forall(T : Type),
    x: T,
    y: T,
    z: T,
    where(T <: (Add(T), Eq(T)))
  ) -> T)
  cond(
    (x == y) => (x + z),
    true => (y + z)
  )
;
```

### Type Methods

Yo supports **type methods** - methods defined within the type's module.

**Method calls only work for:**

1. Methods defined in the type's own module
2. Methods from implemented modules

```rust
// Define a type with methods in its module
Point :: struct(
  x : i32,
  y : i32,

  // Type methods are defined in the struct's module
  distance_from_origin :: (fn(self: Self) -> f64)(
    f64(
      sqrt(
        (self.x * self.x) +
        (self.y * self.y)))
  ),

  move_by :: (fn(self: *(Self), dx : i32, dy : i32) -> unit)({
    self.x = (self.x + dx);
    self.y = (self.y + dy);
  })
);

p := Point(3, 4);
d := p.distance_from_origin();  // Type method call - OK

p2 := Point(0, 0);
p2.move_by(5, 10);  // Automatically takes pointer for `*(Self)` parameter
// p2 is now Point(5, 10)
```

**Automatic pointer conversion:**

When a method expects `*(Self)` but you have `Self`, Yo automatically takes the pointer for you (Rust-style):

```rust
Point :: struct(x: i32, y: i32,
  set_x :: ((self: *(Self), new_x: i32) -> unit) {
    self.x = new_x;
  }
);

mut(p) := Point(3, 4);
p.set_x(10);  // Automatically converts to &(p).set_x(10)
```

### recur

Use `recur` to call the function recursively.  
This is useful for anonymous functions.  
If `recur` is the last expression, tail-call optimization will be applied.

- With tail-call optimization

  ```rust
  fn(x: u32, acc: u32 = 1)->
    if x == 1, then:
      acc
    else:
      recur(x - 1, acc * x)
  ```

- Without tail-call optimization

  ```rust
  fn(x: u32)->
    if x == 1, then:
      1
    else:
      x * recur(x - 1)
  ```

### Object Types and Memory Management

Yo uses **object types** with [Compile-time Reference Counting with Ownership and Lifetime Analysis](./COMPILE_TIME_RC_WITH_OWNERSHIP_ANALYSIS.md) for safe and efficient memory management.

#### Object Type

Object types are heap-allocated types with automatic reference counting:

```rust
// Define an object type
String :: object(
  _bytes: ArrayList(u8),

  // Methods
  from :: (fn(slice : [u8]) -> Self)({
    // Implementation...
  }),

  length :: (fn(self : Self) -> usize)({
    // Implementation...
  }),

  dispose :: (fn(self : Self) -> unit) {
    // The `dispose` function is called when the reference count reaches zero
  }
);

// Usage
s1 := String.from("Hello");  // RC = 1
s2 := s1;                    // RC = 2 (both point to same object)
s3 := s2;                    // RC = 3
// When s1, s2, s3 go out of scope, RC decrements
// When RC reaches 0, memory is freed
// In practice, we eliminate many RC operations via ownership analysis
```

#### Compile-Time Reference Counting Optimization

The compiler performs [ownership analysis](./COMPILE_TIME_RC_WITH_OWNERSHIP_ANALYSIS.md) to eliminate unnecessary reference counting operations.

See [COMPILE_TIME_RC_WITH_OWNERSHIP_ANALYSIS.md](./COMPILE_TIME_RC_WITH_OWNERSHIP_ANALYSIS.md) for details.

## Pointers

Yo uses pointers (`*(T)`) for direct memory access, similar to C:

```rust
// Pointer type: *(T)
x := 1;
y := 2;

swap :: (fn(a : *(i32), b : *(i32)) -> unit) {
  tmp := a.*;  // Dereference pointer
  a.* = b.*;
  b.* = tmp;
};

swap(&(x), &(y));  // Pass pointers to x and y
// Now x == 2, y == 1
```

### Pointer Operations

```rust
// Create pointer with & operator
x := 42;
ptr := &(x);  // ptr: *(i32)

// Dereference with .*
value := ptr.*;  // value == 42

// Modify through pointer
ptr.* = 100;  // x is now 100

// Pointer arithmetic (unsafe)
arr := [1, 2, 3, 4, 5];
ptr := &(arr(0));  // Pointer to first element
ptr2 := (ptr &+ 2);  // Point to third element
value := ptr2.*;  // value == 3

// Pointer casting
float_ptr := *(f32)(ptr);  // Cast pointer to *(f32)
```

### Pointer Arithmetic Operations

Yo provides a complete set of pointer arithmetic operators:

```rust
test "Pointer arithmetic", {
  x := 12;
  p := &(x);

  // Addition and subtraction
  q := (p &+ 2);   // Advance pointer by 2 elements
  z := (q &- 2);   // Go back 2 elements

  // Comparison operators
  assert(q &> p);  // q is after p
  assert(p &< q);  // p is before q
  assert(q &>= p); // Greater or equal
  assert(p &<= q); // Less or equal
  assert(z &== p); // Equal (same address)
  assert(p &!= q); // Not equal

  // Pointer difference (distance between pointers)
  diff := (q &/ p);  // Distance: 2 elements
  assert(diff == 2);
};
```

### Pointer Operators Reference

- `&+` : Pointer addition (advance)
- `&-` : Pointer subtraction (go back)
- `&>` : Greater than comparison
- `&<` : Less than comparison
- `&>=` : Greater or equal comparison
- `&<=` : Less or equal comparison
- `&==` : Equality comparison
- `&!=` : Inequality comparison
- `&/` : Pointer difference (distance)

### The consume Function

`consume` tells the compiler that you're initializing memory, not overwriting an existing value. This prevents attempting to drop uninitialized memory:

```rust
// Without consume - Error: tries to drop uninitialized value
ptr.* = some_value;  // Danger!

// With consume - OK: initialization, no drop
consume(ptr.* = some_value);
```

For more pointer examples, see [ptr.test.yo](../tests/ptr.test.yo).

### Nullable Pointers

Yo uses `Option(*(T))` for nullable pointers:

```rust
// malloc returns Option(*(T))
some_ptr := malloc(sizeof(i32));
match(some_ptr,
  .Some(ptr) => {
    ptr.* = 42;
    printf("value: %d\n", ptr.*);
    free(some_ptr);
  },
  .None => printf("Allocation failed\n")
);
```

**Note**: Raw pointers are unsafe. Use object types for safe memory management whenever possible.

### RAII (Resource Acquisition Is Initialization)

Yo automatically manages memory for object types through reference counting. When an object's reference count reaches zero, it is automatically freed.

```rust
test :: (fn() -> unit) {
  x := String.from("World!");  // RC = 1
  // ... use x ...
  // At end of scope, RC is decremented
  // If RC reaches 0, memory is automatically freed
}
```

## Tuple

A tuple is defined as a sequence of elements of different types, separated by commas and enclosed in parentheses.

```rust
my_unit := (); // my_unit: unit.

my_i32_tuple := (12);  // my_i32_tuple: i32
// Needs extra comma to make it a tuple
my_i32_tuple := (12,); // my_i32_tuple: (i32,). Free type

(i32_tuple: (i32, i32, i32)) = (1, 2, 3); // tuple: (i32, i32, i32). Free type

mixed_tuple := (1, true, "Hello"); // mixed_tuple: (i32, bool, *u8[6,'\0']). Free type

(a, b, c) := mixed_tuple; // a: i32, b: bool, c: *u8[6,'\0']. Free type

a := mixed_tuple.0;
b := mixed_tuple.1;
c := mixed_tuple.2;

// NOTE: For a tuple that has only 1 element, we need to add a comma to make it a tuple.
MyTuple := (i32)
// is equivalent to
MyTuple := i32;
// to make it a tuple, we need to add a comma
MyTuple := (i32,);
```

## Array & Slice

```rust
i32_array := [1, 2, 3, 4, 5]; // i32_array: [i32; 5]
                              // In C: int i32_array[5] = {1, 2, 3, 4, 5};
i32_array.len(); // 5, compile-time known

(i32_array2 : [i32; _]) = [1, 2, 3]; // i32_array2: [i32; 3]

// Slices are created using range syntax (:)
// No need for & operator - DST (Dynamically Sized Types) removed
(end : usize) = 3;
slice := i32_array(1:end);  // slice: Slice(i32)
slice.len(); // 2, runtime known

full_slice := i32_array(:);  // full_slice: Slice(i32)

slice(0) = 10;  // Modify through slice
slice(1) = 20;
// i32_array: [1, 10, 20, 4, 5]

slice_of_slice := slice(0:2);  // Slice from slice
```

### Range with `:`

Slices use the `:` operator for range syntax:

```rust
arr := [1, 2, 3, 4, 5];

// Slice from index 1 to 3 (exclusive)
slice1 := arr(1:3);  // [2, 3]

// Slice from start to index
slice2 := arr(:3);  // [1, 2, 3]

// Slice from index to end
slice3 := arr(2:);  // [3, 4, 5]

// Full slice
slice4 := arr(:);  // [1, 2, 3, 4, 5]
```

### Array Methods

Arrays in Yo come with useful methods:

#### Array.fill

Create an array filled with a value:

```rust
// Fill at runtime
zeros := Array(i32, 10).fill(0);  // [0,0,0,0,0,0,0,0,0,0]

// Fill at compile-time
ones :: Array(i32, 5).fill(1);    // [1,1,1,1,1]
```

#### Array.len

Get the length of an array:

```rust
arr := [1, 2, 3, 4, 5];
len := arr.len();  // 5 (compile-time for arrays, runtime for slices)

// Works with generic arrays
generic_len :: (fn(compt(T) : Type, compt(n) : usize, arr : [T; n]) -> usize)
  arr.len()  // Returns n
;
```

### Array Length Inference

Yo can infer array lengths using `_`:

```rust
// Infer length from initializer
arr1 := Array(i32, _)(1, 2, 3);         // Array(i32, 3)
arr2 := [i32; _](10, 20, 30, 40);       // Array(i32, 4)

// Literal syntax with inferred length
arr3 := [1, 2, 3];                      // Array(i32, 3)

// Empty array
empty := Array(i32, _)();               // Array(i32, 0)

// Nested arrays with inference
nested := Array(Array(i32, _), _)(
  Array(i32, _)(1, 2, 3),
  Array(i32, _)(4, 5, 6)
);                                       // Array(Array(i32, 3), 2)
```

**Restriction**: Cannot use `_` in variable bindings without initialization:

```rust
// Error: Cannot infer length
arr : Array(i32, _);  // Not allowed!
arr = [1, 2, 3];

// Correct: Use concrete length or initialize immediately
arr := Array(i32, _)(1, 2, 3);  // OK
```

### Array Assignment and Copying

Arrays are value types and are copied on assignment:

```rust
// Create arrays
arr1 := [1, 2, 3];
arr2 := arr1;       // arr2 is a copy of arr1

// Modify arr2
arr2(0) = 10;

assert(arr1(0) == 1);   // arr1 unchanged
assert(arr2(0) == 10);  // arr2 modified

// Assignment returns old value
arr3 := [5, 6, 7];
old := (arr3 = [8, 9, 10]);

assert(arr3(0) == 8);   // arr3 has new value
assert(old(0) == 5);    // old has previous value
```

For more array examples, see [array.test.yo](../tests/array.test.yo).

## Control Flow

### if/else

`if(condition, then, else)`

The `if` in Yo is actually a macro function (see `std/prelude.yo`):

```rust
// Definition in prelude.yo
if :: (fn(
        quote(condition): Expr,
        quote(then): Expr,
        (quote(else): Expr) ?= quote(())
      ) -> unquote(Expr))
  quote(
    cond(
      unquote(condition) => unquote(then),
      true => unquote(else)
    )
  )
;

// Usage
main :: (fn() -> unit) {
  // If no return type, it is unit
  number := 3;

  if number < 5, then: {
    println("condition was true");
  },
  else: {
    println("condition was false");
  };

  if(number < 5, println("condition was true"), println("condition was false"));
};
```

### cond

```rust
use_cond :: (fn(x: i32) -> unit)
  cond(
    (x == 1) => println("x is 1"),
    (x == 2) => println("x is 2"),
    true => println("x is not 1 or 2")
  )
;
```

> Note: The last condition must be compile-time known value `true` to act as the default case.

### while

`while(condition, do: body)` or
`while(condition, steps, do: body)`

```rust
factorial :: (fn(n: i32) -> i32) {
  result := 1;
  i := 1;
  while(i <= n, {
    result = (result * i);
    i = (i + 1);
  });
  result
};

factorial2 :: (fn(n: i32) -> i32) {
  result := 1;
  i := 1;
  while((i <= n), (i = (i + 1)), {
    result = (result * i);
  });
  result
};
```

## Algebraic Data Types (ADT)

ADT is basically another type of Record with a hidden field `tag` that indicates the variant type.

Therefore, when a value of a variant is decided, we can access the field of the value just like accessing the field of a record.

There is also some optimization on the ADT. For example, if the ADT has only one variant, the `tag` field will be omitted.

In addition, if there is only one variant with one field, the field type will be used directly instead of wrapping it in a record. This is like the [newtype](https://wiki.haskell.org/Newtype) in Haskell.

```rust
Option :: (fn(compt(T) : Type) -> compt(Type))
  enum(
    Some(value : T),
    None
  )
;

(none: Option(i32)) = .None;
(some: Option(i32)) = .Some(42);

IpAddr :: enum(
  V4(a : u8, b : u8, c : u8, d : u8),
  V6(v : String)
);

home := IpAddr.V4(127, 0, 0, 1);
loopback := IpAddr.V6(String.from("::1"));

// Use record as variant
Message :: enum(
  Quit,
  Move(x : i32, y : i32),
  Write(v : String),
  ChangeColor(r : i32, g : i32, b : i32)
);

m := Message.Write(String.from("hello"));
m := Message.Move(x: 3, y: 4);
m := Message.ChangeColor(r: 1, g: 2, b: 3);
```

## C struct

```rust
Point :: struct(x: i32, y: i32);

my_point := Point {
  x: 10.as(i32),
  y: 20.as(i32)
};

```

Compiles to C

```c
struct Point {
  int x;
  int y;
};
```

## Newtype

The `newtype` keyword defines a struct with a single field along with methods, constants, and module implementations in one declaration. It provides zero-cost abstraction - at runtime, it's identical to the wrapped type, but at compile time it's a distinct type. This is similar to Haskell's `newtype`.

**Key properties:**

- Zero runtime overhead (no wrapper allocation)
- Type safety through distinct types
- Methods and constants defined inline
- Module implementations included in definition
- Access wrapped value via the field name

**Syntax:**

```rust
newtype(
  field_name : FieldType,

  // Methods
  method_name :: ((fn(...) -> ReturnType) body),

  // Constants
  CONSTANT_NAME :: Value,

  // Module implementations
  ModuleName :: impl(Self, Module(...))
)
```

**Example:** (see `std/string/rune.yo`):

```rust
rune :: newtype(
  c : u32,

  // Constructor with validation
  from_u32 :: ((fn(value: u32) -> Option(Self))
    cond(
      ((value <= 0x10FFFF.as(u32)) && (((value < 0xD800) || (value > 0xDFFF)))) => .Some(Self(c: value)),
      true => .None
    )
  ),

  to_u32 :: ((fn(self: Self) -> u32) self.c),

  is_ascii :: ((fn(self: Self) -> bool) (self.c <= 0x7F)),

  // Constants
  NUL        :: Self(c: 0x00),
  TAB        :: Self(c: 0x09),
  NEWLINE    :: Self(c: 0x0A),
  SPACE      :: Self(c: 0x20)
);
```

**Use cases:**

- Type-safe IDs (UserId, OrderId, etc.)
- Unicode characters (rune wrapping u32)
- Units of measurement (Meters, Seconds, Dollars)
- Validated types (Email, PhoneNumber, PositiveInt)
- Semantic distinction (Username vs Password)

**Memory layout:**

```rust
UserId :: newtype(value : i32, /* methods... */);
// sizeof(UserId) == sizeof(i32)
// In C: just an i32, no struct wrapper at runtime
```

## C union

```rust
MyNumber := union(
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

## C enum

It's the same as the ADT, but all variants have no fields.

```rust
State := enum(
  Working,
  Failed
);
Week := enum(
  Monday, // 0
  Tuesday, // 1
  Wednesday // 2
);

day := Week.Wednesday;
printf("%d", day); // 2
```

## Modules

Modules define collections of functions and types that can be implemented for types. They work similarly to traits in Rust. Note that `impl` takes the receiver type as the first argument, followed by the module implementation.

A module is defined as a function that returns a `Module` type containing field definitions.

```rust
// Define a module (like a trait in Rust)
Summary :: module(
  summarize : (fn(self: *(Self)) -> String)
);

Display :: module(
  where(Self <: Summary), // Constraint
  display : (fn(self: *(Self)) -> String)
);

NewsArticle :: struct(
  headline : String,
  location : String,
  author   : String,
  content  : String
);

// Implement the Summary module for NewsArticle
impl(NewsArticle, Summary(
  summarize : ((self) ->
    f(self.headline, ", by ", self.author, " (", self.location, ")")
  )
));

// Implement the Display module for NewsArticle
impl(NewsArticle, Display(
  display : ((self) ->
    f("Headline: ", self.headline, "\n")
  )
));

// Pass in function
notify :: (fn(item: *(NewsArticle)) -> unit) {
  println("Breaking news! ", item.summarize());
};

// Generic function with module constraint
notify2 :: (fn(forall(T : Type), item: *(T), where(T <: Display)) -> unit) {
  println("Breaking news! ", item.summarize());
  println("Breaking news! ", item.display());
};
```

## Pattern Matching

The compiler performs exhaustive checking on pattern matching.

```rust
Coin :: enum(
  Penny,
  Nickel,
  Dime,
  Quarter
);

// Reference:
// - https://doc.rust-lang.org/book/ch06-02-match.html
// - https://github.com/tc39/proposal-pattern-matching
value_in_cents :: (fn(coin: Coin) -> u8)
  match(coin,
    .Penny => {
      printf("Lucky penny!\n");
      1
    },
    .Nickel => 5,
    .Dime => 10,
    .Quarter => 25
  )
;

Shape :: enum(
  Circle(r : i32),
  Rectangle(w : i32 , h: i32)
);

area :: (fn(shape: Shape) -> i32)(
  match(shape,
    .Circle(r) => (i32(3) * (r * r)),
    .Rectangle(w, h) => (w * h)
  )
);
```

## String

### C String literal as u8 slice or C string pointer

```rust
s = "Hello"; // s : [u8]; By default, a string literal converts to u8 slice.
(s2 : *(u8)) = "Hi"; // You can explicitly declare a C string pointer.
```

### String (Immutable String)

UTF-8 encoded string.

```rust
s := String.new();
s2 := String.from("Hello World!");
s3 := (s + s2); // Create a new string.
```

## Collections

Yo provides efficient, reference-counted collection types in the standard library.

### ArrayList

Dynamic array with automatic resizing.

```rust
{ ArrayList } :: import "std/collections/array_list";

// Create a new ArrayList
list := ArrayList(i32).new();

// Push elements
list.push((42).as(i32));
list.push((100).as(i32));
list.push((200).as(i32));

printf("Length: %zu\n", list.length());
printf("Capacity: %zu\n", list.capacity());

// Get elements by index
first := list.get((0).as(usize));
match(first,
  .Some(value) => printf("First element: %d\n", value),
  .None => printf("No first element\n")
);

// Set an element
list.set((1).as(usize), (150).as(i32));

// Pop an element
popped := list.pop();
match(popped,
  .Some(value) => printf("Popped: %d\n", value),
  .None => printf("List is empty\n")
);

// Create with initial capacity
list2 := ArrayList(i32).with_capacity((10).as(usize));

// Clear and shrink
list.clear();
list.shrink_to_fit();
```

### HashMap

Hash map with key-value pairs.

```rust
{ HashMap } :: import "std/collections/hash_map";

// Create a new HashMap
map := HashMap(i32, i32).new();

// Insert key-value pairs
result := map.set(1.as(i32), 100.as(i32));
match(result,
  .Ok(opt) => match(opt,
    .None => printf("Inserted new key\n"),
    .Some(old_val) => printf("Updated, old value: %d\n", old_val)
  ),
  .Error(_) => printf("Insert failed\n")
);

// Get a value
value_opt := map.get(1.as(i32));
match(value_opt,
  .Some(v) => printf("Value: %d\n", v),
  .None => printf("Key not found\n")
);

// Check if key exists
cond(
  (map.has(1.as(i32))) => printf("Contains key 1\n"),
  true => printf("Does not contain key 1\n")
);

// Remove a key
removed := map.remove(1.as(i32));
match(removed,
  .Some(v) => printf("Removed value: %d\n", v),
  .None => printf("Key not found\n")
);

// Check length and empty
printf("Length: %zu\n", map.length());
cond(
  (map.is_empty()) => printf("Map is empty\n"),
  true => printf("Map is not empty\n")
);

// Clear the map
map.clear();
```

### HashSet

Hash set for unique values.

```rust
{ HashSet } :: import "std/collections/hash_set";

// Create a new HashSet
set := HashSet(i32).new();

// Insert elements
result := set.add(42.as(i32));
match(result,
  .Ok(was_new) => cond(
    was_new => printf("Inserted new element\n"),
    true => printf("Element already exists\n")
  ),
  .Error(_) => printf("Insert failed\n")
);

// Check if has
cond(
  (set.has(42.as(i32))) => printf("Contains 42\n"),
  true => printf("Does not contain 42\n")
);

// Remove element
removed := set.remove(42.as(i32));
cond(
  removed => printf("Removed element\n"),
  true => printf("Element not found\n")
);

// Set operations
set1 := HashSet(i32).new();
set2 := HashSet(i32).new();

set1.add(1.as(i32));
set1.add(2.as(i32));
set1.add(3.as(i32));

set2.add(2.as(i32));
set2.add(3.as(i32));
set2.add(4.as(i32));

// Union
union_result := set1.union(set2);
match(union_result,
  .Ok(union_set) => printf("Union size: %zu\n", union_set.length()),
  .Error(_) => printf("Union failed\n")
);

// Intersection
inter_result := set1.intersection(set2);
match(inter_result,
  .Ok(inter_set) => printf("Intersection size: %zu\n", inter_set.length()),
  .Error(_) => printf("Intersection failed\n")
);

// Subset check
is_sub := set1.is_subset(set2);
cond(
  is_sub => printf("set1 is subset of set2\n"),
  true => printf("set1 is not subset of set2\n")
);
```

### LinkedList

Doubly-linked list.

```rust
{ LinkedList } :: import "std/collections/linked_list";

// Create a new LinkedList
list := LinkedList(i32).new();

// Push to front and back
list.push_front(1.as(i32));
list.push_back(2.as(i32));
list.push_front(0.as(i32));

printf("Length: %zu\n", list.len());

// Access front and back
match(list.front(),
  .Some(v) => printf("Front: %d\n", v),
  .None => printf("List is empty\n")
);

match(list.back(),
  .Some(v) => printf("Back: %d\n", v),
  .None => printf("List is empty\n")
);

// Pop from front and back
match(list.pop_front(),
  .Some(v) => printf("Popped front: %d\n", v),
  .None => printf("List is empty\n")
);

match(list.pop_back(),
  .Some(v) => printf("Popped back: %d\n", v),
  .None => printf("List is empty\n")
);

// Get by index
match(list.get((0).as(usize)),
  .Some(v) => printf("At index 0: %d\n", v),
  .None => printf("Index out of bounds\n")
);

// Insert at index
match(list.set((1).as(usize), 20.as(i32)),
  .Ok(_) => printf("Inserted at index 1\n"),
  .Error(err) => match(err,
    .IndexOutOfBounds => printf("Index out of bounds\n"),
    .EmptyList => printf("List is empty\n")
  )
);

// Remove at index
match(list.remove((0).as(usize)),
  .Ok(v) => printf("Removed: %d\n", v),
  .Error(err) => printf("Remove failed\n")
);

// Check if has
cond(
  (list.has(20.as(i32), i32.Eq)) => printf("Contains 20\n"),
  true => printf("Does not contain 20\n")
);

// Reverse the list
list.reverse();

// Clear
list.clear();
assert(list.is_empty(), "List should be empty");
```

## Closure

Yo supports closures (anonymous functions that capture their environment). Closures are automatically reference-counted and can capture variables from their surrounding scope.

### Basic Closure Syntax

There are two ways to create closures:

1. **Using `Impl(Fn(...))`** - Explicit closure type:

```rust
test_closure :: (fn() -> unit) {
  x := 1;

  // Explicit closure type using Impl
  (closure : Impl(Fn(y : i32) -> i32)) = ((y) => {
    x = (x + y);
    return x;
  });

  closure(1); // x is now 2
  closure(1); // x is now 3
  result := closure(2); // x is now 5

  assert(result == 5);
};
```

2. **Using `ClosureType({...})`** - Closure value from type:

```rust
test_closure :: (fn() -> unit) {
  x := 1;

  ClosureType :: Impl(Fn(y : i32) -> i32);
  closure := (ClosureType {
    x = (x + y);
    return x;
  });

  result := closure(2);
  assert(result == 3);
};
```

### Closure Capture Semantics

Closures capture variables from their environment:

- **Value types** (primitives, structs) are captured by value (copied)
- **Object types** (reference-counted) are captured by reference
- Captured variables maintain their mutability

```rust
test_capture :: (fn() -> unit) {
  // Value type - captured by value
  counter := 0;

  // Object type - captured by reference
  data := Box(i32)(42);

  closure := ((increment : i32) => {
    counter = (counter + increment);  // Modifies local copy
    data.* = (data.* + increment);     // Modifies shared object
    return counter;
  });

  closure(5);
  // counter is still 0 (closure has its own copy)
  // data.* is now 47 (shared reference)
};
```

### Closure Type Restrictions

Each closure has a unique type, even if they look identical:

```rust
// This will fail - each closure has a distinct type
test_error :: (fn() -> unit) {
  closure : Impl(Fn(y : i32) -> i32);

  cond(
    some_condition() => {
      a := 1;
      closure = ((y) => (y + a));  // Type 1
    },
    true => {
      b := 1;
      closure = ((y) => (y + b));  // Type 2 - different!
    }
  );
  // Error: no two closures, even if identical, have the same type
};
```

### Closures with Object Types

Closures work seamlessly with object types:

```rust
MyBox :: object(
  (*) : i32,
  dispose :: ((fn(self : Self) -> unit) {
    printf("Disposing: %d\n", self.*);
  })
);

make_incrementer :: (fn(start : MyBox) -> Impl(Fn() -> i32)) {
  return ((unit) => {
    start.* = (start.* + 1);
    return start.*;
  });
};

test :: (fn() -> unit) {
  counter := MyBox(0);
  inc := make_incrementer(counter);

  assert(inc(()) == 1);
  assert(inc(()) == 2);
  assert(counter.* == 2);
};
```

For more examples, see [closure.test.yo](../tests/closure.test.yo).

## Box and Boxing

Yo provides `Box` and `box` for heap-allocating value types with automatic reference counting.

### Box Type

`Box(T)` is a generic object type that wraps any value type:

```rust
// Box is defined in std/prelude.yo
Box :: (fn(compt(V) : Type) -> compt(Type))
  object(
    (*) : V
  )
;

// box function creates a Box
box :: (fn(forall(V : Type), value : V) -> Box(V))
  Box(V)(value)
;
```

### Usage Examples

```rust
// Box a primitive value
i := box(42);              // i: Box(i32)
assert(i.* == 42);         // Dereference with .*

// Box a struct
Point :: struct(x: i32, y: i32);
p := box(Point(3, 4));     // p: Box(Point)
assert(p.*.x == 3);

// Box with explicit type
b := Box(i32)(100);        // Same as box(100)

// Modify boxed value
m := box(10);
m.* = 20;
assert(m.* == 20);
```

### Box with Assignments

```rust
test "Box assignment behavior", {
  x := box(1);
  y := (x = box(2));  // y gets the old value

  assert(x.* == 2);   // x now points to new Box
  assert(y.* == 1);   // y has the old Box
};
```

### Box and Reference Counting

`Box(T)` is an object type, so it uses automatic reference counting:

```rust
test "Box reference counting", {
  original := box(42);
  copy := original;        // RC increment
  another := copy;         // RC increment

  // All three point to the same Box
  assert(original.* == 42);
  original.* = 100;
  assert(copy.* == 100);   // Shared!
  assert(another.* == 100);

  // RC decrements when variables go out of scope
};
```

### When to Use Box

- **Heap allocation**: When you need a value type on the heap
- **Shared mutability**: Multiple references to the same mutable value
- **Dynamic dispatch**: Boxing value types for use with `Dyn`
- **Recursive types**: Breaking cycles in type definitions

```rust
// Dynamic dispatch requires object types
impl(i32, SomeTrait(...));

// Value types must be boxed for Dyn
use_dyn :: (fn(value: Dyn(SomeTrait)) -> unit) { ... };

// Box the i32 for use with Dyn
use_dyn(dyn box(42));
```

## Impl Types

`Impl(ModuleName)` creates a type representing any type that implements the specified module(s). This is similar to `impl Trait` in Rust.

### Basic Usage

```rust
// Define a module (trait)
Id :: module(
  id : (fn(self : Self) -> Self)
);

// Function accepting any type implementing Id
use_id :: (fn(
  forall(T : Type),
  value : T,
  where(T <: Id)
) -> T) {
  return value.id();
};

// Implement Id for i32
impl(i32, Id(
  id : ((self) -> {
    printf("i32: %d\n", self);
    return self;
  })
));

// Use it
result := use_id(42);  // Prints "i32: 42", returns 42
```

### Impl as Return Type

`Impl` can be used in return types for static dispatch:

```rust
RetI32 :: module(
  return_i32 : (fn(self : *(Self)) -> i32)
);

get_value :: (fn(use_bool : bool) -> Impl(RetI32)) {
  cond(
    use_bool => return true,   // bool implements RetI32
    true => return i32(42)      // i32 implements RetI32
  )
};
```

**Important**: Each return path must return a concrete type, not different types that happen to implement the same module.

### Impl with Multiple Modules

```rust
Speak :: module(
  speak : (fn(self : Self) -> unit)
);

Run :: module(
  run : (fn(self : Self) -> unit)
);

// Type must implement both Speak and Run
perform :: (fn(
  forall(T : Type),
  actor : T,
  where(T <: (Speak, Run))
) -> unit) {
  actor.speak();
  actor.run();
};
```

### Impl vs Dyn

- **Impl**: Static dispatch, compile-time polymorphism, no runtime overhead
- **Dyn**: Dynamic dispatch, runtime polymorphism, requires object types

```rust
// Impl - static dispatch (monomorphization)
use_impl :: (fn(forall(T), value: T, where(T <: SomeTrait)) -> unit) {
  value.method();  // Statically dispatched
};

// Dyn - dynamic dispatch (vtable)
use_dyn :: (fn(value: Dyn(SomeTrait)) -> unit) {
  value.method();  // Dynamically dispatched
};
```

For more examples, see [impl.test.yo](../tests/impl.test.yo).

## Error handling

Yo uses the `Result` type for error handling, similar to Rust:

```rust
// Define Result type (from standard library)
Result :: (fn(compt(T): Type, compt(E): Type) -> compt(Type))
  enum(
    Ok(value : T),
    Error(error : E)
  )
;

// Define an error type
DivisionError :: enum(
  DivideByZero,
  Overflow
);

// Function that can fail
safe_div :: (fn(a: i32, b: i32) -> Result(i32, DivisionError))
  if (b == 0),
    then: Result(i32, DivisionError).Error(.DivideByZero),
    else: Result(i32, DivisionError).Ok(a / b)
;

// Pattern matching for error handling
division_result := safe_div(10, 2);
match(division_result,
  .Ok(value) => printf("Result: %d\n", value),
  .Error(error) => match(error,
    .DivideByZero => printf("Error: Cannot divide by zero\n"),
    .Overflow => printf("Error: Overflow\n")
  )
);
```

### Error Propagation with match

```rust
compute :: (fn(x: i32, y: i32) -> Result(i32, DivisionError)) {
  result1 := safe_div(x, 2);
  result2 := match(result1,
    .Ok(v1) => {
      temp := safe_div(v1, y);
      match(temp,
        .Ok(v2) => .Ok(v2),
        .Error(e) => .Error(e)
      )
    },
    .Error(e) => .Error(e)
  );
  return result2;
}
```

**Note**: Yo does not use algebraic effects for error handling. The language uses explicit Result types and pattern matching.

## Closure

Please check [closure.test.yo](../tests/closure.test.yo) for closure examples and usage.

## Async/Await

Yo uses **async/await with state machine transformation** for efficient concurrent programming. This is a stackless coroutine model similar to Rust, JavaScript, C#, and Python.

See [ASYNC_AWAIT.md](./ASYNC_AWAIT.md) for comprehensive documentation.

## Parallelism

Please check [PARALLELISM.md](./PARALLELISM.md) for details on parallel programming in Yo.

## Isolated Types

Please check [ISOLATED.md](./ISOLATED.md) for details on isolated types in Yo.

## Async IO

Please check [ASYNC_IO.md](./ASYNC_IO.md) for details on asynchronous IO in Yo.

## Module importing and exporting

```rust
// module1.yo
test :: (fn() -> unit) {
  println("Hello, world!");
};
export test;

// module2.yo
// Export the type
Option :: (fn(compt(T): Type) -> compt(Type))
  enum(
    Some(value : T),
    None
  )
;
export Option;
```

```rust
open import("./test.yo"); // Import everything from test.yo
Test :: import("./test.yo"); // Import everything from test.yo and put it in the Test namespace
{ test } :: import("./test.yo"); // Import test function from test.yo
{ test : test2 } :: import("./test.yo"); // Import test function from test.yo and rename it to test2

{ Option } :: import("./test.yo"); // Import Option type from test.yo
```

## Dynamic Dispatch

### `Dyn` and `dyn`

Use `Dyn` to define dynamic dispatch types that can hold any object implementing specified modules (traits). Use the `dyn()` function to create a `Dyn` instance from an object.

`Dyn` types in Yo are reference-counted objects (like closures and regular object types). They enable dynamic dispatch through module objects.

**Key features:**

- Reference counted automatically
- No need for `&` operator - they are objects
- Automatic memory management
- Support multiple trait bounds

### Examples

```rust
Speak :: module(
  speak: (fn(self : Self) -> i32)
);

Run :: module(
  run: (fn(self : Self) -> i32)
);

// Must be object type to work with Dyn
Dog :: object();

DogSpeak :: impl(Dog, Speak(
  speak: ((self: Self) -> {
    printf("Woof!\n");
    return 1;
  })
));

DogRun :: impl(Dog, Run(
  run: ((self: Self) -> {
    printf("The dog is running!\n");
    return 2;
  })
));

// Dyn type is reference counted - no & needed
act :: (fn(s: Dyn(Speak, Run)) -> i32)
  (s.speak() + s.run())
;

main :: (fn() -> i32) {
  dog := Dog();
  // dyn() creates a reference-counted trait object
  result := act(dyn(dog));
  return result;
};
```

**Note:** `Dyn` types are internally reference-counted objects, providing automatic memory management without manual pointer handling.

## Naming Convention

2 spaces for indentation.

- `snake_case`
  - `file name`
  - `directory name`
  - `function`
  - `variable`
- `PascaleCase`
  - `module`
  - `type` and its variants
- `UPPER_SNAKE_CASE`
  - `constant`

## Testing

Yo has a built-in testing framework accessible via the `test` keyword.

### Basic Test Syntax

```rust
test "Test description", {
  // Test code here
  x := 1 + 1;
  assert(x == 2);
};
```

### Running Tests

Tests can be run using the Yo CLI:

```bash
# Run all tests in a file
$ ./yo-cli test path/to/file.test.yo

# Run specific test by pattern
$ ./yo-cli test path/to/file.test.yo --test-name-pattern "Test addition"

# Stop on first failure
$ ./yo-cli test path/to/file.test.yo --bail

# Verbose output
$ ./yo-cli test path/to/file.test.yo -v
```

### Assertions

#### Runtime Assertions

```rust
test "Runtime assertions", {
  x := 42;

  // Basic assertion
  assert(x == 42);

  // Assertion with message
  assert(x > 0, "x should be positive");

  // Complex assertions
  arr := [1, 2, 3];
  assert(arr.len() == 3, "Array should have 3 elements");
};
```

#### Compile-Time Assertions

Use `compt_assert` for compile-time verification:

```rust
test "Compile-time assertions", {
  // These are checked during compilation
  compt_assert((2 + 2) == 4);
  compt_assert(Array(i32, 5).fill(0).len() == 5);
  compt_assert(f32(3.14) > f32(3.0));

  // Type-level assertions
  T :: i32;
  compt_assert(Type.to_string(T) == "i32");
};
```

### Testing Expected Errors

Verify that certain code produces compile-time errors:

```rust
test "Expected compile errors", {
  // Expect an error without specific message
  compt_expect_error({
    x :: (1 / 0);  // Division by zero
  });

  // Expect an error with specific message
  compt_expect_error(
    {
      arr : Array(i32, _);
      arr = [1, 2, 3];
    },
    "Cannot infer array length in binding"
  );

  // Test that certain patterns are invalid
  compt_expect_error({
    closure1 := ((x) => (x + 1));
    closure2 := ((x) => (x + 1));
    // Each closure has unique type
    (c : typeof(closure1)) = closure2;  // Error!
  }, "no two closures have the same type");
};
```

### Test Organization

Organize related tests in the same file:

```rust
// arithmetic.test.yo

test "Addition", {
  assert((1 + 1) == 2);
  assert((5 + 3) == 8);
};

test "Subtraction", {
  assert((5 - 3) == 2);
  assert((10 - 10) == 0);
};

test "Multiplication", {
  assert((2 * 3) == 6);
  assert((7 * 0) == 0);
};

test "Division", {
  assert((10 / 2) == 5);
  assert((9 / 3) == 3);
};
```

### Testing with Object Types

Test cleanup and disposal:

```rust
MyBox :: object(
  (*) : i32,
  dispose :: ((fn(self : Self) -> unit) {
    printf("Disposing MyBox with value: %d\n", self.*);
  })
);

test "Object disposal", {
  // Box is automatically disposed at end of scope
  b := MyBox(42);
  assert(b.* == 42);
  b.* = 100;
  assert(b.* == 100);
  // dispose() called automatically here
};
```

### Test Files

Yo test files typically use the `.test.yo` extension:

- `basic.test.yo` - Basic language features
- `array.test.yo` - Array operations
- `closure.test.yo` - Closure functionality
- `async_await.test.yo` - Async/await features
- `collections/*.test.yo` - Collection types

For comprehensive test examples, see the [tests/](../tests/) directory.

## Meta-programming

`quote` is similar to the `quasiquote` in Lisp.  
`unquote` can only be used in `quote`.  
`unquote_splicing` can only be used in `quote` to splice the values into the AST.

```rust
x := quote(2); // compt(x) : Expr

list := quote((1, unquote(x), 3)); // tuple (1, 2, 3)

list2 = quote((1, x, 3)); // tuple (1, x, 3)

quote((0, unquote_splicing(list.get_args()), 4)); // tuple (0, 1, 2, 3, 4)
```

### Macro functions

Macro functions use `quote` and `unquote` for code generation. See `std/prelude.yo` for real examples like the `if` macro.

- `quote(...)` : Quote an expression
- `unquote(...)` : Unquote within a quoted expression
- `gensym(...)` : Generate unique symbol

`unquote` can only be used within `quote`.

Example from `std/prelude.yo`:

```rust
// The `if` macro function
if :: (fn(quote(condition): Expr,
        quote(then): Expr,
        (quote(else): Expr) ?= quote(())
      ) -> unquote(Expr))
  quote
    cond
      unquote(condition) => unquote(then),
      true => unquote(else)
;

// Usage
if(true, {
  println("true");
});

// The `try` macro for Result types
try :: (fn(quote(expr_to_try): Expr) -> unquote(Expr)) {
  temp :: gensym("try");
  quote {
    unquote(temp) := unquote(expr_to_try);
    match(unquote(temp),
      .Ok => unquote(temp).value,
      .Error => {
        return unquote(temp).error;
      }
    )
  }
};

// Custom macro example
unless :: (fn(quote(condition): Expr, quote(do): Expr) -> unquote(Expr))
  quote
    if(not(unquote(condition)), unquote(do))
;
```

## Compile-Time Evaluation

Yo has powerful compile-time evaluation capabilities. You can perform computations, type manipulations, and code generation at compile time.

### Compile-Time Variables

Variables declared with `::` are compile-time constants:

```rust
// Compile-time integer
x :: 42;                    // compt_int
y :: (x + 10);              // compt_int = 52

// Compile-time type
MyInt :: i32;               // compt(Type)
value := MyInt(100);        // Runtime i32

// Compile-time computation
factorial :: (fn(compt(n) : compt_int) -> compt(compt_int))
  cond(
    (n <= 1) => 1,
    true => (n * recur(n - 1))
  )
;
result :: factorial(5);     // Computed at compile time: 120
```

### Compile-Time Arithmetic

All primitive operations can be performed at compile time:

```rust
// Integer operations
a :: 100;
b :: 25;
sum :: (a + b);            // 125
diff :: (a - b);           // 75
prod :: (a * b);           // 2500
quot :: (a / b);           // 4
rem :: (a % b);            // 0

// Comparison operations
eq :: (a == b);            // false
lt :: (b < a);             // true
gte :: (a >= b);           // true

// Floating-point operations
pi :: f32(3.14159);
radius :: f32(5.0);
area :: (pi * (radius * radius));  // ~78.54

// Boolean operations
flag1 :: true;
flag2 :: false;
and_result :: (flag1 && flag2);    // false
or_result :: (flag1 || flag2);     // true
not_result :: not(flag1);          // false
```

### Compile-Time Arrays

Arrays with compile-time known lengths:

```rust
// Inferred length
arr :: [1, 2, 3, 4, 5];    // Array(i32, 5)
len :: arr.len();          // 5 (compile-time)

// Array.fill at compile time
zeros :: Array(i32, 10).fill(0);  // [0,0,0,0,0,0,0,0,0,0]

// Generic array function
create_array :: (fn(compt(T) : Type, compt(n) : usize, value : T) -> [T; n])
  Array(T, n).fill(value)
;

int_array :: create_array(i32, 5, 42);  // [42,42,42,42,42]
```

### Compile-Time Assertions

Use `compt_assert` to verify compile-time conditions:

```rust
test "Compile-time assertions", {
  // These are checked at compile time
  compt_assert((2 + 2) == 4);
  compt_assert(f32(100.5) > f32(50.0));
  compt_assert(Array(i32, 5).fill(0).len() == 5);

  // Compile-time type checks
  T :: i32;
  compt_assert(Type.to_string(T) == "i32");
};
```

### Compile-Time Expected Errors

Test that code produces compile-time errors:

```rust
test "Expected compile errors", {
  // Verify that this code produces an error
  compt_expect_error(
    x :: (1 / 0),  // Division by zero
    "Division by zero"
  );

  compt_expect_error({
    arr : Array(i32, _);  // Cannot infer length in binding
    arr = [1, 2, 3];
  });
};
```

### Compile-Time vs Runtime

Understanding when things happen:

```rust
// Compile-time: declared with :: or compt(...)
COMPT_VALUE :: 42;                // Computed at compile time
ComptType :: i32;                 // Type selected at compile time

// Runtime: declared with :=
runtime_value := 42;              // Computed at runtime
runtime_type := i32(100);         // Value created at runtime

// Mixed: compile-time type, runtime value
(x : i32) = 42;                   // Type known at compile time
                                  // Value computed at runtime

// Compile-time function parameter
array_fn :: (fn(compt(n) : usize) -> Array(i32, n))
  Array(i32, n).fill(0)
;                                 // n must be known at compile time

// Runtime function parameter
increment :: (fn(x : i32) -> i32)
  (x + 1)
;                                 // x is runtime value
```

### Benefits of Compile-Time Evaluation

1. **Zero runtime cost**: Computations done once at compile time
2. **Type safety**: Catch errors before execution
3. **Generic programming**: Type-level abstraction without runtime overhead
4. **Metaprogramming**: Generate code based on compile-time information

For more examples, see [compt.test.yo](../tests/compt.test.yo).

## In Design

Please check [IN_DESIGN.md](./IN_DESIGN.md) for features that are still in design phase.

## References

- [Ocaml Locality](https://blog.janestreet.com/oxidizing-ocaml-locality/)
- [Data race freedom](https://github.com/ocaml-flambda/ocaml-jst/blob/main/jane/doc/proposals/data-race-freedom.md)
- [ICFP'21 Tutorials - Programming with Effect Handlers and FBIP in Koka](https://www.youtube.com/watch?v=6OFhD_mHtKA&ab_channel=ACMSIGPLAN)
- [Simply Easy! An Implementation of a Dependently Typed Lambda Calculus](http://strictlypositive.org/Easy.pdf)
- [Reconstructing TypeScript](https://jaked.org/blog/2021-09-07-Reconstructing-TypeScript-part-0)
- [PureScript Types](https://github.com/purescript/documentation/blob/master/language/Types.md)
- [The Ultimate Conditional Syntax](https://icfp22.sigplan.org/details/mlfamilyworkshop-2022-papers/6/The-Ultimate-Conditional-Syntax)
- [Algebraic Effects for the Rest of Us](https://overreacted.io/algebraic-effects-for-the-rest-of-us/)
- [What Color is Your Function](https://journal.stuffwithstuff.com/2015/02/01/what-color-is-your-function/)
- [Implementing Algebraic Effects in C "Monads for Free in C"](https://www.microsoft.com/en-us/research/wp-content/uploads/2017/06/algeff-in-c-tr.pdf)
- [Efficient Compilation of Algebraic Effect Handlers - Ningning Xie](https://www.youtube.com/watch?v=tWLPrPfb4_U&ab_channel=ETHWSCR)
- [Generalized Evidence Pasing for Effect Handlers](https://www.microsoft.com/en-us/research/uploads/prod/2021/03/multip-tr-v4.pdf)
- [Structured Asynchrony with Algebraic Effects](https://www.microsoft.com/en-us/research/wp-content/uploads/2017/05/asynceffects-msr-tr-2017-21.pdf)
- [Effects as Capabilities: Effect Handlers and Lightweight Effect Polymorphism](https://dl.acm.org/doi/pdf/10.1145/3428194)
- [A Typed Continuatino-Passing Translatino for Lexical Effect Handlers](https://se.cs.uni-tuebingen.de/publications/schuster22typed.pdf)
- [Zero-cost Effect Handlers](https://se.cs.uni-tuebingen.de/publications/schuster19zero.pdf)
- [Why Rust Closures are (Somewhat) Hard](https://stevedonovan.github.io/rustifications/2018/08/18/rust-closures-are-hard.html)
- [Inside Rust's Async Transformation](https://blag.nemo157.com/2018/12/09/inside-rusts-async-transform.html)
- [Coroutines: Suspending State Machines](https://medium.com/google-developer-experts/coroutines-suspending-state-machines-36b189f8aa60)
- [What's the difference between an algebraic effect, a callback function, and a coroutine](https://www.reddit.com/r/ProgrammingLanguages/comments/13v35fk/whats_the_difference_between_an_algebraic_effect/)
- [Revisiting coroutines](https://dl.acm.org/doi/abs/10.1145/1462166.1462167)
- [One-shot Algebraic Effects as Coroutines](http://logic.cs.tsukuba.ac.jp/~sat/pdf/tfp2020.pdf)
- [Implementing Co, a Small Language With Coroutines](https://abhinavsarkar.net/posts/implementing-co-3/)
- [Retrofitting Effect Handlers onto OCaml](https://arxiv.org/pdf/2104.00250.pdf)
- [Do Be Do Be Do](https://arxiv.org/pdf/1611.09259.pdf)
- [Custom Infix Operators in Haskell](<https://bugfactory.io/blog/custom-infix-operators-in-haskell/#:~:text=Precedence%20(aka%20Operator%20Binding)&text=All%20operators%20in%20Haskell%20have,6%20>).)
- [Region-Based Memory Management in Cyclone](https://www.cs.umd.edu/projects/cyclone/papers/cyclone-regions.pdf)
- [Implementation Strategies for Mutable Value Semantics](https://www.jot.fm/issues/issue_2022_02/article2.pdf)
- [Type Classes as Objects and Implicits](https://citeseerx.ist.psu.edu/document?repid=rep1&type=pdf&doi=d30d65ca9ce7891352024a5c71ebe0ae8c41f7ac)
- [Implicit Parameters: Dynamic Scoping with Static Types](https://dl.acm.org/doi/pdf/10.1145/325694.325708)
- [Scrap your type classes](https://www.haskellforall.com/2012/05/scrap-your-type-classes.html)
- [Implicit Parameters in Scala and Haskell](https://trebledj.me/posts/implicit-parameters-in-scala-and-haskell/)
- [High-level effect handlers in C](https://homepages.inf.ed.ac.uk/slindley/papers/libseff-draft-november2023.pdf)
- [Exceptions in C with longjmp and setjmp](https://web.archive.org/web/20091104065428/http://www.di.unipi.it/~nids/docs/longjump_try_trow_catch.html)
- [Continuation Passing for C](https://www.irif.fr/~jch/cpc.pdf)
- [Refinement Types for TypeScript](https://goto.ucsd.edu/~pvekris/docs/pldi16.pdf)
- [Continuations and Delimited Control
  ](https://okmij.org/ftp/continuations/)
- [Custom allocators in Rust](https://nical.github.io/posts/rust-custom-allocators.html)
- [Ownership You Can Count On: A Hybrid Approach to Safe Explicit Memory Management](https://inko-lang.org/papers/ownership.pdf)
