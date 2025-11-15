# Language Design

**Yo** is a multi-paradigm, general-purpose, compiled programming language.
Yo aims to be **Simple** and **Fast** (around 0% - 20% slower than C).

**Yo** aims to be a simple to learn programming language for C and JavaScript (TypeScript) programmers 😉.

**Yo** (will &) tend to support advanced type system features such as generalized algebraic data types (GADT), dependent types, refinement types `In Design`.

Our goal is to be a practical language that is easy to use and easy to learn.

<!-- @import "[TOC]" {cmd="toc" depthFrom=2 depthTo=6 orderedList=false} -->

<!-- code_chunk_output -->

- [Philosophy](#philosophy)
- [Inspiration](#inspiration)
- [Hello World](#hello-world)
- [CLI Usage](#cli-usage)
- [Types](#types)
  - [Type](#type)
    - [Primitive Types](#primitive-types)
    - [Value Types vs Object Types](#value-types-vs-object-types)
  - [Variable Declaration](#variable-declaration)
    - [Variable shadowing in blocks](#variable-shadowing-in-blocks)
  - [Type inference](#type-inference)
    - [Uninitialized variable](#uninitialized-variable)
  - [Object Types and Memory Management](#object-types-and-memory-management)
    - [Object Type](#object-type)
    - [Garbage Collection](#garbage-collection)
- [Pointers](#pointers)
  - [Pointer Operations](#pointer-operations)
  - [Nullable Pointers](#nullable-pointers)
  - [GC Finalization with `dispose`](#gc-finalization-with-dispose)
- [Function Declaration](#function-declaration)
  - [Named arguments](#named-arguments)
  - [Implicit Parameters](#implicit-parameters)
  - [Type Methods (Similar to Rust)](#type-methods-similar-to-rust)
  - [`recur` `In Design`](#recur-in-design)
  - [Variadic functions `In Design`](#variadic-functions-in-design)
- [Duck Typing `In Design`](#duck-typing-in-design)
- [Tuple](#tuple)
- [Array & Slice](#array--slice)
  - [Range with `:`](#range-with-)
- [Closure](#closure)
- [Generic](#generic)
  - [Type parameters](#type-parameters)
  - [Type constraints](#type-constraints)
- [Control Flow](#control-flow)
  - [if/else](#ifelse)
  - [cond](#cond)
  - [while](#while)
    - [Iterator (for...in)](#iterator-forin)
- [Type synonyms](#type-synonyms)
- [Algebraic Data Types (ADT)](#algebraic-data-types-adt)
  - [Type parameters for specific variant](#type-parameters-for-specific-variant)
- [C struct](#c-struct)
- [Newtype](#newtype)
- [C union](#c-union)
- [C enum](#c-enum)
- [Advanced Types `In Design`](#advanced-types-in-design)
  - [Dependent types `In Design`](#dependent-types-in-design)
  - [Refinement types `In Design`](#refinement-types-in-design)
  - [Higher Kinded Types](#higher-kinded-types)
  - [Generalized Algebraic Data Types (GADTs) `In Design`](#generalized-algebraic-data-types-gadts-in-design)
- [Modules](#modules)
  - [`impl` a type](#impl-a-type)
  - [Associated types](#associated-types)
  - [Without module](#without-module)
  - [Optional module](#optional-module)
  - [Named impl `In Design`](#named-impl-in-design)
  - [Higher Kinded Types example](#higher-kinded-types-example)
- [Pattern Matching](#pattern-matching)
  - [Using Range in `case`](#using-range-in-case)
- [Guard](#guard)
- [String](#string)
  - [C String](#c-string)
  - [String (Immutable String)](#string-immutable-string)
- [Collections](#collections)
  - [ArrayList](#arraylist)
  - [HashMap](#hashmap)
  - [HashSet](#hashset)
  - [LinkedList](#linkedlist)
- [Error handling](#error-handling)
  - [Error Propagation with match](#error-propagation-with-match)
- [Type casting](#type-casting)
  - [Type casting in destructuring](#type-casting-in-destructuring)
- [Async/Await](#asyncawait)
  - [Quick Overview](#quick-overview)
  - [Key Features](#key-features)
- [Modules](#modules-1)
- [Dynamic Dispatch `In Design`](#dynamic-dispatch-in-design)
  - [`dyn` keyword](#dyn-keyword)
  - [Examples](#examples)
- [Attributes](#attributes)
- [C Interoperability](#c-interoperability)
  - [To C](#to-c)
  - [From C](#from-c)
- [Naming Convention](#naming-convention)
- [Compilation `In Design`](#compilation-in-design)
- [Meta-programming `In Design`](#meta-programming-in-design)
  - [Underscore](#underscore)
  - [Macro](#macro)
- [References](#references)

<!-- /code_chunk_output -->

## Philosophy

It's just a combination of "Lisp" and "C"!  
Yo has no keywords! Everything is a function, even `cond`, `while`, `match`, etc.  
Extended with a little bit of functional programming.

**Key Design Principles:**

- **No operator precedence** (explicit parentheses or newline-based associativity)
- **First-class types** (types are values)
- **Block-based variable shadowing** (similar to JavaScript)
- **Precise garbage collection** (concurrent, generational, <5ms pause times)
- **Object types with GC** for automatic heap memory management
- **Value types with RAII** for deterministic resource cleanup
- **Hybrid type system** (stack-allocated values + GC-managed heap objects)

## Inspiration

The **Yo** language is heavily inspired by:

- [TypeScript](https://www.typescriptlang.org/)
  - Syntax and semantics
  - Module system
- [Koka](https://koka-lang.github.io/)
  - Dot notation (Uniform Function Call Syntax)
  - Perceus and reuse analysis
  - Type system design
- [Rust](https://www.rust-lang.org/)
  - Pattern matching
  - Compile-time memory safety analysis
- [Haskell](https://www.haskell.org/)
  - Type and typeclass
- [OCaml](https://ocaml.org/)
  - Module system (Modular implicits)
- [Go](https://go.dev/)
  - Modules and method call
  - Simplicity
- [Python](https://python.org/)
  - Keyword arguments
- [C++](https://isocpp.org/)
  - ~~RAII~~
- [Scheme (Lisp)](https://www.scheme.com/)
  - Minimal syntax
  - [Meta-programming (Macros)](https://docs.racket-lang.org/reference/quasiquote.html)
- [Jai](https://github.com/Ivo-Balbaert/The_Way_to_Jai), [Zig](https://ziglang.org/), [Odin](https://odin-lang.org/)
  - Syntax
  - Compile time execution
- [Elixir](https://elixir-lang.org/)
  - [Meta-programming (Macros)](https://hexdocs.pm/elixir/quote-and-unquote.html)
- [Nim](https://nim-lang.org/)
  - Pragmatic design
- [Io](https://iolanguage.org/)
  - Minimal syntax and semantic

Other languages that are worth mentioning that have influenced **Yo**:

- [Effekt](https://effekt-lang.org/)
- [PureScript](https://www.purescript.org/)
- [Clojure](https://clojure.org/)
- [Ante](https://antelang.org/)
- [ATS](https://www.ats-lang.org/)
- [Lean](https://leanprover.github.io/)
- [Swift](https://swift.org/)
- [Go](https://go.dev/)
- [Ada](https://www.adacore.com/)
- [Lobster](https://aardappel.github.io/lobster/README_FIRST.html)
- [dyon](https://github.com/PistonDevelopers/dyon)
- [Vale](https://vale.dev/)
- [hylo](https://www.hylo-lang.org/)

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

## Types

A type can have the following **Kind**:

- Type
  - i32
  - boolean
  - ...

### Type

#### Primitive Types

- `boolean` (true or false)
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

- Primitive types: `i32`, `boolean`, `f32`, etc.
- Structs defined with `struct(...)`
- Fixed-size arrays: `Array(T, N)`
- Tuples: `Tuple(T1, T2, ...)`

**Object Types** (heap-allocated, garbage collected):

- Types defined with `object(...)`
- Use [Precise Garbage Collection](./GC_DESIGN.md) with shadow stack and tri-color marking
- Automatic memory management with <5ms pause times
- Work-stealing friendly (no thread affinity constraints)

```rust
// Value type - stack-allocated, copied
Point :: struct(x: i32, y: i32);
p1 := Point(3, 4);
p2 := p1;  // p2 is a copy of p1

// Object type - heap-allocated, garbage collected
String :: object(
  _bytes: ArrayList(u8),
  // methods...
);
s1 := String.from("Hello");
s2 := s1;  // s2 and s1 point to the same object (GC-managed)
```

### Variable Declaration

Variables in Yo are declared with `:=` (runtime) or `::` (compile-time).

```rust
               // compt here means compile-time known
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
```

**Note**: Yo removed the `mut()` keyword for simplicity. All variables are mutable by default.

#### Variable shadowing in blocks

Yo supports block-based variable shadowing (similar to JavaScript):

```rust
x := 1;
x := 2; // Error: x is already declared in the same scope
{
  x := 2; // Allowed: x is shadowed in this block scope
}
// x is still 1 here
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
// String is an object type with garbage collection
(my_string: String) = String.from("Hello, world"); // Heap-allocated, GC-managed
my_string_2 := my_string; // Both point to the same object (GC tracks reachability)

// Primitive types are copied
my_int := 1; // Stack-allocated
my_int_2 := my_int; // my_int_2 is a copy

// Fixed-size arrays are value types
(my_int_array: Array(i32, 3)) = [1, 2, 3]; // Stack-allocated
my_int_array := [1, 2, 3]; // Array(i32, 3)

// ArrayList is an object type
(my_array_list: ArrayList(i32)) = ArrayList(i32).new(); // Heap-allocated, GC-managed

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

### Object Types and Memory Management

Yo uses **object types** with [**Precise Garbage Collection**](./GC_DESIGN.md) for automatic memory management.

#### Object Type

Object types are heap-allocated types managed by the garbage collector:

```rust
// Define an object type
String :: object(
  _bytes: ArrayList(u8),

  // Methods
  from :: ((fn(slice: [u8]) -> Self) {
    // Implementation...
  }),

  length :: ((fn(self: Self) -> usize) {
    // Implementation...
  }),

  dispose :: ((fn(self: Self) -> unit) {
    // Optional finalizer called by GC when object is collected
    printf("Finalizing string\n");
  })
);

// Usage
s1 := String.from("Hello");  // Allocated on GC heap
s2 := s1;                    // Both point to same object (GC tracks reachability)
s3 := s2;                    // All three variables reference the same object
// When s1, s2, s3 go out of scope and object becomes unreachable, GC will collect it
```

#### Garbage Collection

Yo uses a precise, concurrent, generational mark-sweep GC with shadow stack:

**Key features:**

- **Precise GC**: Shadow stack tracks all GC pointers accurately
- **Concurrent marking**: Most GC work happens in parallel with program execution
- **Generational collection**: Young generation for fast frequent collections
- **Low latency**: <5ms pause times (99.9th percentile)
- **Work-stealing friendly**: No thread affinity constraints

See [GC_DESIGN.md](./GC_DESIGN.md) for complete implementation details.

## Pointers

Yo uses pointers (`*(T)`) for direct memory access, similar to C:

```rust
// Pointer type: *(T)
x := 1;
y := 2;

swap :: (fn(a: *(i32), b: *(i32)) -> unit) {
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
ptr2 := (ptr + (2).as(usize));  // Point to third element
value := ptr2.*;  // value == 3
```

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

### GC Finalization with `dispose`

Object types can define a `dispose` method that is called by the garbage collector when the object is freed. This is **not** deterministic and should **not** be used for managing critical resources:

```rust
MyBox :: object(
  value: i32,
  dispose :: ((fn(self: Self) -> unit) {
    printf("Finalizing MyBox with value: %d\n", self.value);
  })
);

test :: (fn() -> unit) {
  box := MyBox(42);
  // Use box...
}  // box becomes unreachable, GC will eventually call dispose (timing not guaranteed)
```

**Use `dispose` for**: Logging, debugging, or non-critical cleanup only.

**Important**: `dispose` is non-deterministic and called by the GC when the object is freed. The timing is unpredictable, so it should NOT be used for managing critical resources like file handles, sockets, or locks.

## Function Declaration

Functions are declared using the `::` operator for compile-time definitions or `:=` for runtime values.

```rust
// Function declaration with explicit type
add :: (fn(x: i32, y: i32) -> i32)
  (x + y)  // Function body
;

// Or define type first, then implementation
compt(add) : (fn(x: i32, y: i32) -> i32);
add = (x, y) -> (x + y);

// Anonymous function
add = ((x, y) -> (x + y));  // Type inferred from usage

// With explicit return type
multiply :: (fn(x: i32, y: i32) -> i32) {
  return (x * y);  // Explicit return
};

// Last expression is the return value
divide :: (fn(x: i32, y: i32) -> i32)
  (x / y)
;

// Default parameter values (using ?=)
create_user :: (fn(
    name: String,
    (age: i32) ?= 18,
    (role: String) ?= String.from("user")
  ) -> User)
  User(name: name, age: age, role: role)
;

create_user(name: "Alice");  // Uses defaults: age=18, role="user"
create_user(name: "Bob", age: 30);  // Explicit age, default role

// Named arguments
add :: (fn(x: i32, y: i32) -> i32) (x + y);
add(3, 4);        // Positional: 7
add(3, y: 4);     // Mixed: 7
add(x: 3, y: 4);  // All named: 7
// The named arguments have to be ordered for now.

// Generic function with forall
identity :: (fn(forall(T: Type), arg: T) -> T)
  arg
;

x := identity(12);     // Type inferred: x: i32
y := identity(true);   // Type inferred: y: boolean

// Type constraints
add :: (fn(forall(T: Type), x: T, y: T, using(AddT) : (T <: Add(T))) -> T)
  AddT.(+)(x, y)
;

// Recursion with recur
factorial :: (fn(x: i32) -> i32)
  if (x <= 1),
    then: 1,
    else: (x * recur(x - 1))  // recur calls the current function
;

// Tail recursion
factorial_tail :: (fn(x: i32, acc: i32) -> i32)
  if (x <= 1),
    then: acc,
    else: recur((x - 1), (x * acc))
;
```

### Named arguments

Named arguments in Yo must be provided in the same order as they are defined in the function signature:

```rust
add :: (fn(x: i32, y: i32) -> i32)
  (x + y)
;

add(3, 4);        // OK: Positional arguments
add(x: 3, y: 4);  // OK: Named arguments in correct order
add(3, y: 4);     // OK: Mixed (positional then named)
add(y: 4, x: 3);  // Error: Named arguments must be in order (x before y)
```

### Implicit Parameters

Implicit parameters (contextual parameters) allow passing parameters without explicitly providing them at each call site. They can be defined using the `using` keyword.

```rust
// id.yo
Id :: module(
  id: (fn(self : Self) -> Self)
);

I32Add :: impl(i32, Id(
  id : ((self) -> self)
));

{ Id, I32Add } // Export Id

// main.yo
{ Id, I32Add } :: import "./id.yo";

I32.id(12); // 12
use_id :: (fn(forall(T : Type), x : T, using(TId) : (T <: Id)) -> T) {
  return TId.id(x);
};
use_id(34); // 34, implicitly use I32Add
use_id(56, I32Add); // 56, explicitly use I32Add
```

### Type Methods (Similar to Rust)

Yo supports **type methods** - methods defined within the type's module. Unlike general Uniform Function Call Syntax (UFCS), you cannot call arbitrary free functions using method syntax.

**Method calls only work for:**

1. Methods defined in the type's own module
2. Methods from implemented modules

```rust
// Define a type with methods in its module
Point :: struct(x: i32, y: i32,
  // Type methods are defined in the struct's module
  distance_from_origin :: ((self: Self) -> f64) {
    sqrt(((self.x * self.x) + (self.y * self.y)).as(f64))
  },

  move_by :: ((self: *(Self), dx: i32, dy: i32) -> unit) {
    self.*.x = (self.*.x + dx);
    self.*.y = (self.*.y + dy);
  }
);

p := Point(3, 4);
d := p.distance_from_origin();  // Type method call - OK

mut(p2) := Point(0, 0);
p2.move_by(5, 10);  // Automatically takes pointer for `*(Self)` parameter
// p2 is now Point(5, 10)
```

**Automatic pointer conversion:**

When a method expects `*(Self)` but you have `Self`, Yo automatically takes the pointer for you (Rust-style):

```rust
Point :: struct(x: i32, y: i32,
  set_x :: ((self: *(Self), new_x: i32) -> unit) {
    self.*.x = new_x;
  }
);

mut(p) := Point(3, 4);
p.set_x(10);  // Automatically converts to &(p).set_x(10)
```

**Important:** Free functions cannot be called with method syntax:

```rust
// This is a free function, NOT a type method
add_one :: (fn(x: i32) -> i32)
  (x + 1)
;

x := 12;
// x.add_one();  // Error: add_one is not a method of i32
add_one(x);     // OK: call as regular function
```

### `recur` `In Design`

Use the `recur` to call the function recursively.  
This is useful for anonymous function.  
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

### Variadic functions `In Design`

```rust
// c11 style variadic function
add_va_c11 :: ((count : c_int, ...) -> c_int) {
  args := va_start(count); // args : c_va_list Free
  mut(result) := 0;
  mut(i) := 0;
  while i < count, i = (i + 1), {
    result = (result + va_arg(args, i32));
  };
  va_end(args);
  return result;
};

// c23 style variadic function
add_va_c23 :: ((...) -> c_int) {
  args := va_start(); // no need to pass count
  c_int count = va_arg(args, c_int);
  mut(result) := 0;
  mut(i) := 0;
  while i < count, i = (i + 1), {
    result = (result + va_arg(args, i32));
  };
  va_end(args);
  return result;
};

// C variadic function
add_va_c :: ((...(args) : VarList) -> c_int) {
  // ...(arg_name) will automatically initialize "VarList" as "arg_name" for you
  // args has type "VarList" which is Linear
  c_int count = args.length(); // Get the count of variadic arguments
  mut(result) := 0;
  mut(i) := 0;
  while i < count, i = (i + 1), {
    result = (result + args.arg(i32)); // Pop the variadic argument and set it to i32
  };
  return result;
};

// Yo variadic function
add_va_yo :: (fn(forall(count: usize), ...(args) : Array(c_int, count)) -> c_int) {
  mut(result) := 0;
  mut(i) := 0;
  while i < count, i = (i + 1), {
    result = (result + args(i));
  };
  return result;
};

```

## Duck Typing `In Design`

```rust
// This function can take any type that has a `length: i32` property.
print_length :: (fn(x: *(struct(length: i32))) -> unit) {
  println(x.*.length);
};

main :: (fn() -> unit) {
  s := String.from("Hello, world");
  print_length(&(s));
  // ^ This works as the compiler converts it to below from the background:
  print_length(&(struct(length: s.length)))
};
```

## Tuple

Tuple is defined as a sequence of elements of different types, separated by commas and enclosed in parentheses.

```rust
my_unit := (); // my_unit: (). Free type

my_i32_tuple := (12);  // my_i32_tuple: i32
// Needs extra comma to make it a tuple
my_i32_tuple := (12,); // my_i32_tuple: (i32,). Free type

(i32_tuple: (i32, i32, i32)) = (1, 2, 3); // tuple: (i32, i32, i32). Free type

mixed_tuple := (1, true, "Hello"); // mixed_tuple: (i32, boolean, *u8[6,'\0']). Free type

(a, b, c) := mixed_tuple; // a: i32, b: boolean, c: *u8[6,'\0']. Free type

a := mixed_tuple.0;
b := mixed_tuple.1;
c := mixed_tuple.2;

// NOTE: for tuple that has only 1 element, we need to add a comma to make it a tuple.
MyTuple := (i32)
// is equivalent to
MyTuple := i32;
// to make it a tuple, we need to add a comma
MyTuple := (i32,);
```

## Array & Slice

```rust
i32_array := [1, 2, 3, 4, 5]; // i32_array: Array(i32, 5)
                              // In C: int i32_array[5] = {1, 2, 3, 4, 5};
i32_array.length; // 5, compile-time known

(i32_array2 : Array(i32, _)) = [1, 2, 3]; // i32_array2: Array(i32, 3)

// Slices are created using range syntax (:)
// No need for & operator - DST (Dynamically Sized Types) removed
(end : usize) = 3;
slice := i32_array(1:end);  // slice: Slice(i32)
slice.length; // 2, runtime known

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

## Closure

Closures in Yo are reference-counted objects, just like any other object type. They automatically capture variables from their environment.

**Key features:**

- Reference counted (like object types)
- Automatic memory management
- Can capture and mutate variables
- Closure syntax: `((fn(...) => ReturnType) body)`

```rust
// Example 1: Simple closure capturing a variable
main :: (fn() -> unit) {
  x := 1;
  closure := ((fn(y: i32) => i32) {
    x = (x + y);
    return x;
  });

  closure(1); // 2
  closure(1); // 3
  result := closure(2); // 5
  printf("Final result: %d\n", result);
};

// Example 2: Closure with object type capture
MyBox :: object(
  (*): i32,

  dispose :: (fn(self: Self) -> unit) {
    printf("Disposing MyBox with value: %d\n", self.*);
  }
);

main2 :: (fn() -> unit) {
  x := MyBox(1);
  closure := ((fn(v: i32) => i32) {
    x.* = (x.* + v);
    return x.*;
  });

  closure(2);  // x.* is now 3
  closure(3);  // x.* is now 6
  result := closure(4);  // x.* is now 10
  printf("Final result: %d, %d\n", result, x.*);
};
```

**Note:** Closures are automatically reference counted and can be passed around like any other object type.

## Generic

### Type parameters

Type is first-class citizen in Yo. Use `forall` inside `fn(...)` to declare type parameters.

```rust
id :: (fn(forall(T: Type), x: T) -> T)
  x
;
```

### Type constraints

Type constraints are achieved using the `<:` operator.

```rust
// Type constraints
three_are_equal :: (fn(forall((T: Type) <: Eq), x: T, y: T, z: T) -> boolean)
  ((x == y) && (y == z))
;
// (T: Type) <: Eq is equivalent to (T: Type) <: Eq(T)

show_compare :: (fn(forall((T: Type) <: (Show & Ord)), x: T, y: T) -> String)
  match(compare(x, y),
    .LT => "Less than",
    .EQ => "Equal",
    .GT => "Greater than"
  )
;

// Instance dependencies with forall
// Note: forall is used at the top level, not inside impl
(forall((A: Type) <: Show, size: compt(usize)))
ArrayShow :: impl(Array(A, size), Show(
  show: ((self) -> {
    // ...
  })
));

(forall((A: Type) <: Show, (B: Type) <: Show))
TupleShow :: impl((A, B), Show(
  show: ((self) -> {
    // ...
  })
));
```

```rust
// show.yo
Show :: (fn(compt(Self): Type) -> compt(Module))
  module
    show: (fn(self: *(Self)) -> String)
;

I32Show :: impl(i32, Show(
  show: ((self) -> {
    // ...
  })
));

StringShow :: impl(String, Show(
  show: ((self) -> {
    // ...
  })
));

{ Show } // export Show


// main.yo
{ Show } := import "./show.yo";

show :: (fn(forall((T: Type) <: Show, size: compt(usize)), x: Array(T, size)) -> String) {
  // ...
};
{ show } // export show


{ Show } := import "./show.yo";
less_than :: (fn(forall((T: Type) <: (Ord & Show)), x: T, y: T) -> boolean) {
  println(x.show());
  return (x < y);
};
```

## Control Flow

### if/else

`if(condition, then, else)`

The `if` in Yo is actually a macro function (see `std/prelude.yo`):

```rust
// Definition in prelude.yo
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

### while

`while(condition, do: body)` or
`while(condition, iteration, do: body)`

```rust
factorial :: (fn(n: i32) -> i32) {
  mut(result) := 1;
  mut(i) := 1;
  while((i <= n), do: {
    result = (result * i);
    i += 1;
  };
  result
};

factorial2 :: (fn(n: i32) -> i32) {
  result := 1;
  i := 1;
  while((i <= n), do: {
    result = (result * i);
    i = (i + 1);
  });
  result
};
```

#### Iterator (for...in)

```rust
arr := ArrayList.from([1, 2, 3, 4, 5]);
for arr.iter(), (value)-> { // NOTE: arr.iter() returns a record that contains `&` reference to `arr`
  // value here has type &i32
  println(value);

  // NOTE: Use of `arr` is prohibited here.
};

mut(mut_arr) = ArrayList.from([1, 2, 3, 4, 5]);
for mut_arr.iter_mut(), (value)-> {
  // value here has type &mut i32
  *value += 1;
};
```

`let...of...` requires the `impl Iterator` or `impl IntoIterator` module.

```rust
Iterator :: (fn(compt(Self): Type) -> compt(Module))
  module
    Item: Type,
    next: (fn(self: *(Self)) -> Option(Item))
;

IntoIterator :: (fn(compt(Self): Type) -> compt(Module))
  module
    Item: Type,
    IntoIter: Type,
    // IntoIter must implement Iterator with the same Item type
    using(IteratorConstraint): (IntoIter <: Iterator, Iterator.Item == Item),

    // IntoIterator will consume the value, while Iterator will not.
    into_iter: (fn(self: Self) -> IntoIter)
;
```

## Type synonyms

```rust
// Record
(User: Linear) = {
  active: boolean;
  username: String;
  email: String;
  age: i32;
};

(user: User) := {
  active: true,
  username: String.from("johndoe"),
  email: String.from("test@gmail.com"),
  age: 13
};
```

Extending the records

```rust
/*
type Lang<l> = { language: String | l}; // Intersection types
type Language = Lang<(year: i32)>;
// Language is equal to
type Language = { language: String; year: i32 };
*/
Lang :: (fn(compt(T): Type) -> Type)
  ({ language: String } & T) // Intersection types
;
Language :: Lang({ year: i32 });
// Language is equal to
Language :: { language: String, year: i32 };
```

Destructure the record:

```rust
User :: struct(name: String, age: i32);

(user: User) := User {
  name: String.from("johndoe"),
  age: 12.as(i32)
};

{
  User {age} := user; // Compiler Error: `user` is consumed while `name` is not moved out.
};

{
  User {name, age} := user;
  // name: String, linear type
  // age: i32. Free type
}

{
  // Rename the field with `:`
  // Specify the type with `as`
  User{name: username, age} := user;
  println(username); // johndoe
  // username: String, linear type.
  // age: i32. Free type.
}
```

## Algebraic Data Types (ADT)

ADT is basically another type of Record with a hidden field `tag` that indicates the variant type.

Therefore, when a value of a variant is decided, we can access the field of the value just like accessing the field of a record.

There is also some optimization on the ADT. For example, if the ADT has only one variant, the `tag` field will be omitted.

In addition, if there is only one variant with one field, the field type will be used directly instead of wrapping it in a record. This is like the [newtype](https://wiki.haskell.org/Newtype) in Haskell.

```rust
Option :: (fn(compt(T): Type) -> compt(Type))
  enum(
    Some(value : T),
    None
  )
;

(none: Option(i32)) = .None;
(some: Option(i32)) = .Some(42);

IpAddr :: enum(
  V4((a : u8, b : u8, c : u8, d : u8)),
  V6(String)
);

home := IpAddr.V4(127, 0, 0, 1);
loopback := IpAddr.V6(String.from("::1"));

// Use record as variant
Message :: enum(
  Quit,
  Move(x: i32, y: i32),
  Write(v : String),
  ChangeColor(r: i32, g: i32, b: i32)
);

m := Message.Write(String.from("hello"));
m := Message.Move(x: 3, y: 4);
m := Message.ChangeColor(r: 1, g: 2, b: 3);
```

### Type parameters for specific variant

```rust
MixedData :: enum(
  NoForall(a : i32, b : String),
  WithForall(forall(T: Type),
            (a : T)-> MixedData,
            using(TToString) : (T <: Show))
);


mixed := MixedData.WithForall(12); // mixed: MixedData.WithForall(i32)
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

**Example:**
```rust
// Simple newtype with methods and constants
UserId :: newtype(
  value : i32,
  
  // Methods
  from_i32 :: ((fn(v: i32) -> Self) Self(value: v)),
  
  to_i32 :: ((fn(self: Self) -> i32) self.value),
  
  // Constants
  ADMIN :: Self(value: 0.as(i32)),
  
  // Module implementations
  Eq :: impl(Self, Eq(Self)(
    (==) : ((fn(a: Self, b: Self) -> boolean)
      (a.value == b.value)
    ),
    
    (!=) : ((fn(a: Self, b: Self) -> boolean)
      (a.value != b.value)
    )
  )),
  
  Ord :: impl(Self, Ord(Self)(
    (<) : ((fn(a: Self, b: Self) -> boolean)
      (a.value < b.value)
    )
  ))
);

// Create newtype values
user_id := UserId(value: 42.as(i32));
admin_id := UserId.ADMIN;

// Call methods
id_value := user_id.to_i32();  // 42

// Use module implementations
cond(
  (user_id == admin_id) => println("Admin user"),
  true => println("Regular user")
);
```

**More complex example** (see `std/string/rune.yo`):
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

  is_ascii :: ((fn(self: Self) -> boolean) (self.c <= 0x7F)),

  // Constants
  NUL        :: Self(c: 0x00),
  TAB        :: Self(c: 0x09),
  NEWLINE    :: Self(c: 0x0A),
  SPACE      :: Self(c: 0x20),

  // Module implementations
  Eq :: impl(Self, Eq(Self)(
    (==) : ((fn(a: Self, b: Self) -> boolean) (a.c == b.c)),
    (!=) : ((fn(a: Self, b: Self) -> boolean) (a.c != b.c))
  ))
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
  Wednesay // 2
);

day := Week.Wednessay;
printf("%d", day); // 2
```

## Advanced Types `In Design`

### Dependent types `In Design`

Dependent types are types which depend on values.

```rust
Vector :: (fn(compt(N): compt(i32)) -> Type)
  Array(i32, N)
;

add_vectors :: (fn(forall(N: compt(i32)), a: Vector(N), b: Vector(N)) -> Vector(N))
  a.map((fn(x, i) -> (x + b(i))))
;

v1 := [1, 2, 3]; // v1: Array(i32, 3), which is Vector(3)
v2 := [4, 5, 6]; // v2: Array(i32, 3), which is Vector(3)
result := add_vectors(v1, v2); // [5, 7, 9]

// The code below will not compile
v3 := [1, 2]; // v3: Array(i32, 2), which is Vector(2)
v4 := [4, 5, 6]; // v4: Array(i32, 3), which is Vector(3)
// error := add_vectors(v3, v4); // Compiler Error: Vector(2) and Vector(3) are different types.
```

### Refinement types `In Design`

Refinement types consists of all values of a given type which satisfy a given predicate.

```rust
PositiveNumber :: (compt(i32) |: (@ > 0));
NonEmptyString :: (compt(String) |: (@.length() > 0));

divide :: (fn(x: PositiveNumber, y: PositiveNumber) -> PositiveNumber)
  (x / y)
;

x := 10; // Valid: x: PositiveNumber
// y := -10; // Compiler Error: -10 is not a PositiveNumber

result := divide(10, 2); // Valid
```

```rust
NaturalNumber :: (i32 |: (@ >= 0));
PositiveNumber :: (i32 |: (@ > 0));
Equal :: (fn(compt(n): i32) -> Type)
  (i32 |: (@ == n))
;
Index :: (fn(compt(T): Type, compt(a): Array(T, _)) -> Type)
  (NaturalNumber |: (@ < a.length()))
;
NotEmptyArray :: (fn(compt(T): Type) -> Type)
  (Array(T, _) |: (@.length() > 0))
;

get :: (fn(forall(T: Type, a: Array(T, _)), index: Index(T, a), array: a) -> T)
  array(index)
;

set :: (fn(forall(T: Type, a: Array(T, _)), index: Index(T, a), array: a, value: T) -> a)
  { array(index) = value; array }
;

head :: (fn(forall(T: Type), array: NotEmptyArray(T)) -> T)
  array(0)
;
```

### Higher Kinded Types

Higher Kinded Types are types that take other types as parameters.

```rust
T1 :: (fn(compt(F): (Type -> Type), compt(A): Type) -> Type)
  F(A)
;

Option :: (fn(compt(T): Type) -> Type)
  T1(Maybe, T)
;
```

### Generalized Algebraic Data Types (GADTs) `In Design`

```rust
MyExpr :: (fn(compt(T): Type) -> Type)
  enum(
    IntExpr(i : i32), // MyExpr(i32)
    BoolExpr(b : boolean), // MyExpr(boolean)
    EqExpr(a : MyExpr(i32), b : MyExpr(i32)) // MyExpr(boolean)
  )
;

eval :: (fn(forall(T: Type), expr: MyExpr(T)) -> T)
  match(expr,
    .IntExpr(i) => i,
    .BoolExpr(b) => b,
    .EqExpr(left, right) => (eval(left) == eval(right))
  )
;

expr1 := MyExpr.EqExpr(MyExpr.IntExpr(1), MyExpr.IntExpr(2)); // expr1: MyExpr(boolean)
eval(expr1); // false
```

## Modules

Modules define collections of functions and types that can be implemented for types. They work similarly to Traits in Rust. Note that `impl` takes the receiver type as the first argument, followed by the module implementation.

A module is defined as a function that returns a `Module` type containing field definitions.

```rust
// Define a module (like a trait in Rust)
Summary :: (fn(compt(Self): Type) -> compt(Module))
  module
    summarize: (fn(self: *(Self)) -> String)
;

Display :: (fn(compt(Self): Type) -> compt(Module))
  module
    display: (fn(self: *(Self)) -> String)
;

NewsArticle :: struct(
  headline: String,
  location: String,
  author: String,
  content: String
);

// Implement the Summary module for NewsArticle
NewsArticleSummary :: impl(NewsArticle, Summary(
  summarize: ((self) -> {
    String.from("${self.headline}, by ${self.author} (${self.location})")
  })
));

// Pass in function
notify :: (fn(item: *(NewsArticle)) -> unit) {
  println("Breaking news! ", item.summarize());
};

// Generic function with module constraint
notify2 :: (fn(forall((T: Type) <: Display), item: *(T)) -> unit) {
  println("Breaking news! ", item.summarize());
  println("Breaking news! ", item.display());
};
```

```rust
// Module for compile-time integer
LuckyNumber :: (fn(compt(T): compt_int) -> compt(Module))
  module
    say_it: (fn(self: *(T)) -> unit)
;

LuckyNumber7 :: impl(7, LuckyNumber(
  say_it: ((self) -> {
    println("Lucky number 7")
  })
));

7.say_it(); // Lucky number 7
```

### `impl` a type

NOTE: `impl` a type more than once is allowed. This is how rust behaves.  
QUESTION: Should we allow `impl` a primitive type?  
ANSWER: Yes we allow

```rust
// my_type.yo
MyType :: (fn(compt(T): Type) -> compt(Type))
  struct(value: T)
;

(forall(T: Type))
MyTypeNew :: impl(MyType(T), module(
  // `this` here means `MyType(T)`.
  new: ((fn(value: T) -> this)
    MyType(value: value)
  )
));

// main.yo
{ MyType } := import("./my_type");
v := MyType(i32).new(1); // MyType { value: 1 }
```

### Associated types

aka [Functional Dependencies](https://book.purescript.org/chapter6.html#functional-dependencies)

```rust
Contains :: (fn(compt(Self): Type) -> compt(Module))
  module
    A: Type,
    B: Type,

    contains: (fn(self: *(Self), a: A, b: B) -> boolean)
    // Note: A and B are associated types defined in this module
    // They will be specified when implementing this module for a type
;

Container :: (i32, i32);

ContainerContains :: impl(Container, Contains(
  A: i32,
  B: i32,

  contains: ((self, a, b) -> {
    ((self.0 == a) && (self.1 == b))
  })
));

my_tuple := Container(10, 20);
my_tuple.contains(10, 20); // true

// Access associated type from the impl
MyI32 :: ContainerContains.A; // i32
```

### Without module

Use `!(Module)` to exclude a module constraint.

```rust
Summary :: (fn(compt(Self): Type, using(ShowImpl): (Self <: Show), using(NotEq): (Self <: !(Eq))) -> compt(Module))
  module
    summarize: (fn(self: *(Self)) -> String)
;
// This module can only be implemented for types that implement Show but not Eq.
```

### Optional module

Use `?(Module)` to make a module constraint optional.

```rust
Summary :: (fn(compt(Self): Type, using(ShowImpl): (Self <: ?(Show))) -> compt(Module))
  module
    summarize: (fn(self: *(Self)) -> String)
;
// This module can be implemented for types whether or not they implement Show.
```

### Named impl `In Design`

This is useful for resolving conflicts when implementing multiple modules for the same type.

```rust
// id.yo
Id :: (fn(compt(Self): Type) -> compt(Module))
  module
    id: (fn(self: *(Self)) -> Self)
;
export Id;

// id1.yo
{ Id } :: import "./id.yo";
MyIdImplementation :: impl(i32, Id(
  id: ((self) -> self.*)
));
export MyIdImplementation;

// id2.yo
{ Id } :: import "./id.yo";
AnotherIdImpl :: impl(i32, Id(
  id: ((self) -> (self.* + 1))
));
export AnotherIdImpl;

// use_id.yo
{ MyIdImplementation } := import("./id1.yo");
MyIdImplementation.id(&(12)); // 13
```

### Higher Kinded Types example

```rust
// Functor module
Functor :: (fn(compt(Wrapper): (Type -> Type)) -> compt(Module))
  module
    map: (fn(forall(A: Type, B: Type),
            fa: Wrapper(A),
            f: (fn(a: A) -> B)
          ) -> Wrapper(B))
;

MaybeFunctor :: impl(Maybe, Functor(
  map: ((fa, f) ->
    match(fa,
      .Just(value) => .Just(f(value)),
      .Nothing => .Nothing
    )
  )
));

(forall(T: Type))
EitherFunctor :: impl(Either(T), Functor(
  map: ((fa, f) ->
    match(fa,
      .Left(value) => .Left(value),
      .Right(value) => .Right(f(value))
    )
  )
));

some_maybe := Maybe.Just(1);
result := some_maybe.map((x) -> (x + 1)); // Just(2)
```

## Pattern Matching

The compiler implements an exhaustive check on the pattern matching.

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

List :: (fn(compt(T): Type) -> Type)
  enum(
    Nil,
    Cons(head : T, tail : Box(List(T)))
  )
;

list_length :: (fn(forall(T: Type), list: *(List(T))) -> i32)
  match(list.*,
    .Nil => 0,
    .Cons(_, tail) => (1 + list_length(&(tail)))
  )
;
```

### Using Range in `case`

```rust
check_int :: (fn(x: i32) -> unit)
  match(x,
    (1..=6) => printf("1 to 6:\n"),
    (7..10) => printf("7 to 10\n"),
    _ => printf("Other\n")
  )
;
```

## Guard

QUESTION: Should we use `|-` operator instead to represent the `assert` meaning?

1. Using `|:` which means `given` for guard

   ```rust
   check_int :: (fn(x: i32) -> unit)
     match(x,
       ((1..6) |: ((x % 2) == 0)) => {
         printf("1 to 6 and even\n");
       },
       ((1..6) |: ((x % 2) != 0))-> {
         println("1 to 6 and odd");
       },
       (7..10) -> println("7 to 10");
       _ -> println("Other");
   ```

2. `iflet(let, do)`

   ```rust
   maybe_some := Some(10);
   iflet (.Some(value) = maybe_some), {
     println(value);
   };
   ```

3. `whilelet(let, do)`

   ```rust
   mut(list) = Some(10);
   whilelet (.Some(value) = list), {
     println(value);
     list = None;
   };
   ```

## String

### C String

0 terminated string.

```rust
s = "Hello".to_cstring(); // s: *u8
// (const char) *const s1 = "Hello";
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

## Type casting

Use `as` function to cast a value to another type.

```rust
(x: i32) := 1;
(y: f32) := x.as(f32);
```

### Type casting in destructuring

```rust
arr := [1, 2, 3];
[as(x, f32), y, z] = arr;

obj := {x: 1, y: 2, z: 3};
{as(x: new_name, f32), mut(y), z} := obj;
y = 3; // Allowed
```

## Async/Await

Yo uses **async/await with state machine transformation** for efficient concurrent programming. This is a stackless coroutine model similar to Rust, JavaScript, C#, and Python.

See [ASYNC_AWAIT.md](./ASYNC_AWAIT.md) for comprehensive documentation.

### Quick Overview

```rust
// Define async function - MUST return Future(T)
fetch_data :: (fn(url: String) -> Future(Data)) async {
  response := await http_get(url);
  data := await response.read();
  return data;
};

// Call async function in async context
main :: (fn() -> unit) {
  async {
    data := await fetch_data("http://example.com");
    printf("Got data!\n");
  };
};

// Async blocks for inline async tasks
compute :: (fn() -> Future(i32)) {
  return async {
    x := await get_value();
    y := await process(x);
    return (x + y);
  };
};
```

### Key Features

- **Stackless coroutines**: State machine transformation at compile time
- **Eager spawning**: Tasks start running immediately when created (JavaScript-style)
- **Thread affinity**: Tasks stay on assigned worker thread (no work stealing)
- **Memory efficient**: ~200 bytes per task vs 16KB+ for stackful coroutines
- **BRC compatible**: Respects biased reference counting thread affinity
- **Worker thread pool**: Fixed number of OS threads executing async tasks

**Syntax Rules:**

1. Async functions **must** return `Future(T)` type
2. `await` can **only** be used inside `async { ... }` blocks
3. Async blocks return `Future(T)` where T is the block's result type
4. Tasks start executing **immediately** when created (eager spawning)

## Modules

QUESTION: Should we allow to `export` a linear type value?

~~NOTE: Why not use javascript like import:~~

- To support condtional import in the future.
- To allow import happening in the middle of the code, like inside a function.
- for consistency with the destructuring. Like for javascript, it uses `import {x as y} from "module.ts"` but destructuring uses `let {x: y} = obj`.

```rust
// module1.yo
{ copy } := import "https://github.com/yo-lang/yo/std/fs.yo";

test :: (fn() -> unit) {
  println("Hello, world!");
};

export test, copy; // Export multiple values

// module2.yo
// Export the type
Option :: (fn(compt(T): Type) -> compt(Type))
  enum(
    Some(value : T),
    None
  )
;
export Option;

// module3.yo
// Export the module (interface).
Id :: (fn(compt(Self): Type) -> compt(Module))
  module
    id: (fn(self: Self) -> Self)
;

// Implement the interface for i32
I32Id :: impl(i32, Id(
  id: ((x) -> x)
));

export Id, I32Id;
```

```rust
open import("./test.yo"); // Import everything from test.yo
Test :: import("./test.yo"); // Import everything from test.yo and put it in the Test namespace
{ test } :: import("./test.yo"); // Import test function from test.yo
{ test: test2 } :: import("./test.yo"); // Import test function from test.yo and rename it to test2

{ Option } :: import("./test.yo"); // Import Option type from test.yo

{ Id } :: import("./test.yo"); // Import `Id` module from test.yo
```

`yo.json` and `yo.lock`

```json
{
  "name": "my-project",
  "version": "0.1.0",
  "dependencies": {
    "std": ""
  }
}
```

## Dynamic Dispatch `In Design`

### `dyn` keyword

`Dyn` types in Yo are reference-counted objects (like closures and regular object types). They enable dynamic dispatch through trait objects.

**Key features:**

- Reference counted automatically
- No need for `&` operator - they are objects
- Automatic memory management
- Support multiple trait bounds

### Examples

```rust
Speak :: module(
  speak: (fn(self: Self) -> i32)
);

Run :: module(
  run: (fn(self: Self) -> i32)
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
  result := act(dyn(dog, (DogSpeak, DogRun)));
  return result;
};
```

**Note:** `Dyn` types are internally reference-counted objects, providing automatic memory management without manual pointer handling.

## Attributes

Attributes are defined with the `@` symbol.

```rust
@doc("Add two numbers")
add :: (fn(x: i32, y: i32) -> i32)
  (x + y)
;

@derive(Eq, Ord)
Centimeters :: i32;


DropI32 :: impl(i32, Drop(
  @noop // ignored by the compiler when generating C code
  drop: ((value) -> {})
));
```

## C Interoperability

### To C

```rust
@c_name("c_add_numbers") // Export to C with the name `c_add_numbers`
add_numbers :: (fn(a: i32, b: i32) -> i32) {
  return (a + b);
};

@c_name("some_struct_t") // Export to C with the name `some_struct_t`
SomeStruct :: struct(
  @c_name("another_name") // Export to C with the name `another_name`
  a: i32,

  b: i32,
  c: i32
);
```

### From C

```c
// some_c.h
int add_numbers(int a, int b);

struct some_struct_t {
  int a;
  int b;
  int c;
};
```

```rust
{*} := import("./some_c.h");

extern "C" {
  @c_name("add_numbers") <| // Import from C with the name `add_numbers`
  (my_add_numbers: ((a: i32, b: i32)-> i32)), // Import from C

  @c_name("some_struct_t") <| // Import from C with the name some_struct_t
  (my_some_struct_t: {
    @c_name("a") <| // Import from C with the name `a`
    my_a: i32,

    b: i32,
    c: i32,
  })
}

my_add_numbers(1, 2); // calling add_numbers from C
```

- printf

```rust
{*} := import("stdio.h");
extern "C" {
  printf: ((format: *u8, ...args)-> i32)
};
```

## Naming Convention

2 spaces for indentation.

- `snake_case`
  - `file name`
  - `directory name`
  - `function`
  - `variable`
- `PascaleCase`
  - `trait`
  - `type` and its variants
- `UPPER_SNAKE_CASE`
  - `constant`

## Compilation `In Design`

1. Run the `lexer` to tokenize the source code.
2. Run the `parser` to convert the tokens into an AST.  
   This step also does the type checking and type inference.  
   This step will not change the semantics of the code.
3. Run the `transformer` to transform the AST into a new AST.  
   This step also does the borrow checking.  
   This step will change the semantics of the code.
4. Run the `code generator` to generate the code.  
   This step also does the optimization.

The current **Yo** compiler frontend is written in **TypeScript** as a proof of concept.

Boostrapping the **Yo** compiler is not a priority at the moment. We will do it when it's ready.

**Yo** currently compiles to C (C11, the version that most modern compilers support).  
We might support compiling to LLVM IR in the future.

## Meta-programming `In Design`

`quote` is similar to the `quasiquote` in Lisp.  
`unquote` can only be used in `quote`.  
`unquote_splicing` can only be used in `quote` to splice the values into the AST.

- `:` : `quote`
- `$` : `unquote`

```rust
x := 2;

list := :((1, $(x), 3)); // tuple (1, 2, 3)

list2 = :((1, x, 3)); // tuple (1, :(x), 3)

:((0, ...($(list.args)), 4)); // tuple (0, 1, 2, 3, 4)
```

### Underscore

1. Type inference

   ```rust
   x := 5; // x: compt(i32)
   (y: _) := 5; // y: compt(i32)
   ```

2. Placeholder in generics

   ```rust
   v := ArrayList(i32).from([1, 2, 3]); // v: ArrayList<i32>
   (v2: ArrayList(_)) := v.iter().map(fn(x)=> (x * 2)).collect(); // v2: ArrayList<i32>

   Id(_).id(15); // Id<i32>.id(15);
   ```

3. Ignore value

   ```rust
   (a, _, c) := (1, 2, 3); // a: i32, c: i32
   ```

### Macro

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
