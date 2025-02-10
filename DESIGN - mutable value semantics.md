# Language Design

**Mo** 墨 🐼 is general-purpose, compiled programming language that incorporates the Linear Types, Mutable Value Semantics, and Algebraic Effects.

**Mo** aims to be a simple to learn programming language. If you are familiar with TypeScript, you should be able to pick up **Mo** in 1 hour 😉.

**Mo** has a syntax design that looks like TypeScript, and uses uniform call syntax (dot notation)~~, brace elison~~ to make the code more concise.

**Mo** (will &) tend to support advanced type system features such as generalized algebraic data types (GADT), dependent types, refinement types `In Design`.

Our goal is to be a practical language that is easy to use and easy to learn.

We will also post a series of articles on the design and implementation of **Mo**. Stay tuned!

<!-- @import "[TOC]" {cmd="toc" depthFrom=2 depthTo=6 orderedList=false} -->

<!-- code_chunk_output -->

- [Philosophy](#philosophy)
- [Inspiration](#inspiration)
- [Hello World](#hello-world)
- [CLI Usage](#cli-usage)
- [Types](#types)
  - [Type](#type)
    - [`Free` Types](#free-types)
    - [`Linear` Types.](#linear-types)
  - [Variable Declaration](#variable-declaration)
  - [Type inference](#type-inference)
    - [Uninitialized variable `In Design`](#uninitialized-variable-in-design)
  - [Transfer ownership](#transfer-ownership)
  - [immutable and mutable references](#immutable-and-mutable-references)
  - [Unique Pointer `In Design`](#unique-pointer-in-design)
  - [Cast Linear to Free](#cast-linear-to-free)
- [Function Declaration](#function-declaration)
  - [Named arguments](#named-arguments)
  - [Contextual parameters, aka implicit parameters](#contextual-parameters-aka-implicit-parameters)
    - [Compiletime](#compiletime)
    - [Runtime](#runtime)
  - [Uniform Function Call Syntax](#uniform-function-call-syntax)
  - [`defer`](#defer)
  - [`recur` `In Design`](#recur-in-design)
  - [Custom Operators](#custom-operators)
- [Duck Typing `In Design`](#duck-typing-in-design)
- [Tuple](#tuple)
- [Array & Slice](#array--slice)
- [Closure `In Design`](#closure-in-design)
- [Mutability `To be updated`](#mutability-to-be-updated)
- [Generic](#generic)
  - [Type parameters](#type-parameters)
  - [Type constraints](#type-constraints)
- [Control Flow](#control-flow)
  - [if/else](#ifelse)
  - [while `Might be removed`](#while-might-be-removed)
  - [for `Might be removed`](#for-might-be-removed)
- [Type synonyms](#type-synonyms)
- [Enum (Algebraic Data Types)](#enum-algebraic-data-types)
- [Advanced Types `In Design`](#advanced-types-in-design)
  - [Dependent types `In Design`](#dependent-types-in-design)
  - [Refinement types `In Design`](#refinement-types-in-design)
  - [Generalized Algebraic Data Types (GADTs) `In Design`](#generalized-algebraic-data-types-gadts-in-design)
- [Typeclass](#typeclass)
- [Pattern Matching](#pattern-matching)
  - [Using Range in `case`](#using-range-in-case)
- [Pointers](#pointers)
- [Collections](#collections)
  - [ArrayList](#arraylist)
  - [String](#string)
    - [C String](#c-string)
    - [UTF-8 string literal](#utf-8-string-literal)
    - [String (Immutable String)](#string-immutable-string)
  - [Map](#map)
- [Error handling](#error-handling)
- [Type casting](#type-casting)
- [Algebraic Effects `In Design`](#algebraic-effects-in-design)
  - [Effectful function](#effectful-function)
  - [Run multiple continuations `In Design`](#run-multiple-continuations-in-design)
- [Modules](#modules)
- [Attributes](#attributes)
- [C Interoperability](#c-interoperability)
  - [To C](#to-c)
  - [From C](#from-c)
- [Naming Convention](#naming-convention)
- [Compilation `In Design`](#compilation-in-design)
- [Meta-programming `In Design`](#meta-programming-in-design)
  - [Macro](#macro)
- [References](#references)

<!-- /code_chunk_output -->

## Philosophy

It's just "C"!  
Extended with a little bit of functional programming.

Explicit is better than Implicit.  
Strict is better than Loose.

## Inspiration

The **Mo** language is heavily inspired by:

- [TypeScript](https://www.typescriptlang.org/)
  - Syntax and semantics
  - Module system
- [Koka](https://koka-lang.github.io/)
  - ~~Brace elision~~
  - Dot notation (Uniform Function Call Syntax)
  - ~~Perceus and reuse~~
  - Algebraic effects
- [Rust](https://www.rust-lang.org/)
  - ~~Borrow checker~~
  - ~~Lifetime~~
  - Pattern matching
- [Austral](https://austral-lang.org/)
  - Linear types
  - ~~Borrowing~~ Replaced with 2nd-Class Reference
- [Haskell](https://www.haskell.org/)
  - Type and typeclass
- [Python](https://python.org/)
  - Keyword arguments
- [C++](https://isocpp.org/)
  - Reference
- [Scheme (Lisp)](https://www.scheme.com/)
  - `set!`
  - [Meta-programming (Macros)](https://docs.racket-lang.org/reference/quasiquote.html)
- [Zig](https://ziglang.org/)
  - Compile time execution
  - `defer`
- [Elixir](https://elixir-lang.org/)
  - [Meta-programming (Macros)](https://hexdocs.pm/elixir/quote-and-unquote.html)
- [Nim](https://nim-lang.org/)
  - [Custom Operators](https://nim-lang.org/docs/manual.html#lexical-analysis-operators)

Other languages that are worth mentioning that have influenced **Mo**:

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

```typescript
function main() {
  println("Hello World!");
}
```

## CLI Usage

```bash
mo --help
mo --version
mo init # Create a new project in the current directory

# Compilation
mo hello.mo -o hello
mo hello.mo --c-compiler clang -o hello
mo hello.mo --target wasm -o hello.wasm

# Package management
mo install # Install dependencies defined in `mo.json` and `mo.lock`
mo install package-name # Install a specific package
mo install package-name@version # Install a specific version of a package
mo install --global package-name # Install a package globally
mo uninstall package-name # Uninstall a package

# package-name could be
#   github:shd101wyy/some-package@master

# Run scripts
mo run test
```

## Types

A type can have the following **Kind**:

- Type
  - Free
  - Linear

### Type

#### `Free` Types

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
- `char` (utf-8 character)
- ~~`symbol` (a unique identifier)~~

#### `Linear` Types.

Linear types are types that can only be used exactly once. For example, a `String` is a linear type as it can only be used once.  
The [Austral language](https://austral-lang.org/) has a very good explanation on the incentive of using [Linear Types](https://austral-lang.org/tutorial/linear-types).

- Linear values must be consumed once.
- A Linear value cannot be consumed when there is a pointer or alias to it.

### Variable Declaration

Like `rust`, **Mo** has two kinds of variables:

```typescript
let y = 5; // y: i32, immutable
var x = 5; // x: i32, mutable

function example(x: i32, y: i32) {
  x = 1; // Error: x is immutable
  y = 2; // Error: y is immutable
}
```

#### No duplicate variable declaration

```typescript
let x = 1;
let x = 2; // Error: x is already declared
{
  let x = 2; // Error: x is already declared
}
```

Below is allowed as they are in different regions:

```typescript
{
  let x = 1;
}
{
  let x = 2;
}
```

### Type inference

```typescript
let my_string: String = String.from("Hello, world"); // Stored on heap. Linear type.
let my_string_2 = my_string; // my_string_2: String. Linear type. my_string is moved and consumed. my_string_2 now takes the ownership.
let my_string_3 = my_string; // Error: my_string is already consumed.
let my_string_4: *String = &my_string_2; // my_string_4: *String. Free type
let my_string_5 = my_string_4; // my_string_5: *String. Free type

let my_int = 1; // Stored on stack. Free type
let my_int_2 = my_int; // my_int_2: i32, Free type
let my_int_3: *i32 = &my_int; // my_int_3: *i32. Free type
let my_int_4 = my_int_3; // my_int_4: *i32. Free type

let my_int_array: i32[3] = [1, 2, 3]; // Stored on stack, with size 3. Free type
let my_int_array: i32[100] = [1, 2, 3]; // Stored on stack, with size 100. Free type
let my_int_array = [1, 2, 3]; // i32[3]; Free type
let my_array_list: ArrayList<i32> = ArrayList.from([1, 2, 3]); // Stored on heap. Linear type.

let my_set: Set<i32> = Set.from([1, 2, 3]); // Stored on heap. Linear type.
let my_map: Map<*u8[], i32> = Map.from([
  ["one", 1],
  ["two", 2],
]); // Stored on heap. Linear type.

enum Person { // Linear type, as it contains a linear type.
  Person(name: String, age: i32)
}
let p = Person.Person(String.from("Alice"), 30); // p: Person. Linear type.
```

#### Uninitialized variable `In Design`

```typescript
var x: i32; // x: i32, uninitialized

// Compiler prevents using uninitialized variable.
println(x); // Compiler Error: x is uninitialized.

x = 1; // x: i32, initialized

let y: i32; // y: i32, uninitialized
y = 12; // Compiler Error: cannot assign to constant.
```

### Transfer ownership

Linear types can only be used once. When a linear type is transferred, it is consumed and cannot be used again.

```typescript
let x = String.from("Hello"); // x: String. Linear type
let y = x; // y: String. Linear type. x is moved and consumed.
let z = x; // Compiler Error: x is already consumed.
```

### immutable and mutable references

```typescript
// Immutable reference, using `*` or `^`
{
  let some_i = malloc(sizeof<i32>()); // i: Option<^i32> Linear type
  let i = some_i.unwrap(); // i: ^i32. Linear type

  let p1: *i32 = i as *i32; // p: *i32. Free type

  let p2: *i32 = i; // p: *i32. Free type

  let p3 = i; // p: ^i32. Linear type, ownership is transferred.
  free(p3);

  println(*p1); // Compile Error: The value it points to is consumed.
}
```

```typescript
{
  var x = 1; // x: copied i32. Free type
  let p1 = &mut x; // r: *mut i32. Free type
  let p2: *mut i32 = &mut x; // p: *mut i32. Free type.
  *p1 = 2;
  // x == 2
  // *p1 == 2
  // *p2 == 2
}
```

A longer example:

```typescript
extern "C" {
  length: (x: *String)=> i32;
  push: (x: *String, value: String)=> ();
  drop: (x: String)=> ();
}

function main() {
  var x = String.from("Hello, world"); // x: String. mutable
  let y: *mut String = &mut x; // y: *mut String   // mutable reference
  let z: *String = &x; // z: *String   // immutable reference

  length(x);  // not allowed
  length(y);  // allowed
  length(z);  // allowed
  x.length(); // allowed, implicit conversion to *String

  let t = x;                           // transfer ownership

  length(x); // error: cannot access `x` because `x` is consumed.
  length(y); // allowed
  length(z); // allowed

  drop(t);                             // consume `t`

  length(x); // error: cannot access `x` because `x` is consumed.
  length(y); // error: cannot access `y` because `t` is consumed.
  length(z); // error: cannot access `z` because `t` is consumed.
}
```

We can only dereference the free type.

```typescript
enum Person { // Linear type, as it contains a linear type.
  Person(name: String, age: i32)
}
let name = String.from("Alice");
let p = Person.Person(name, 30); // p: Person. Linear type.

{
  let name = p.name; // name: String, Linear type. The `p` variable is consumed
                       // when you extract a linear field from it.
                       // NOTE: If `p` has more than one linear field, then when you destructure, you have to consume all the linear fields, otherwise it will be a compiler error.

  let age = p.age; // Compiler Error: `p` is consumed already.
}

{
  let { name, var age } = p;
}

{
  var { name, age } = p;
}

{
  let age = p.age; // age: i32, Free type. The `p` variable is not consumed
                    // when you extract a free field from it.

  let name = p.name; // name: String, Linear type. The `p` variable is consumed
}

{
  let { name } = p; // name: String, Linear type. The `p` variable is consumed
                    // when you destructure any linear type values from it.
}

{
  let { age } = p;  // age: i32, Free type. The `p` variable is not consumed
                    // when you destructure only free fields from it.
}

{
  // Creating references will not consume `p`:
  let name: *String = &p.name; // name: *String. Free type.
  let age = &p.age; // age: *i32. Free type.
}
{
  let p_ref = &p; // p_ref: *Person. Free type.
  let name = &p_ref.name; // name: *String. Free type.
  let age = &p_ref.age; // age: *i32. Free type.

  some_function(*p_ref); // Derference a reference of linear type is not allowed.
}
{
  var p = Person(String.from("Alice"), 30); // p: Person. Linear type.
  let p_ref = &p; // p_ref: *Person. Free type.
  let old_name = (p_ref.name = String.from("Bob")); // old_name: String. Linear type. Take the value out.
  // old_name == String.from("Alice")
}
```

```typescript
let name = String.from("Alice");
let p = Person(name, 30); // p: Person. Linear type.

let { name, age } = p; // p is consumed.

p = Person(name, 30); // This is allowed. We restored a consumed value.
```

```typescript
var x = [1, 2, 3, 4, 5]; // x: i32[5]. Free type
var y = x; // y: i32[5]. Free type. x is copied to y, not moved.

{
  let ref = &x; // ref: *i32[]. Free type
  let first = ref[0]; // i32. Free type
}
{
  let firstRef = &x[0]; // *i32. Free type
  *firstRef = 10;
}

// x: [10, 2, 3, 4, 5]
// y: [1, 2, 3, 4, 5]
```

```typescript
var x = [String.from("Hi"), String.from("World")];

{
  let s = x[0]; // Compiler Error: Cannot move linear type out of a slice.
}

{
  let s = &x[1]; // s: *String. Free type
  let old = (*s = String.from("Earth"));
  // old: String. Linear type. old == String.from("World")
}

// x: [String.from("Hi"), String.from("Earth")]
```

### Unique Pointer `In Design`

We use the `^` to denote the pointer, same as in Pascal.

```typescript
let some_int_ptr = malloc(sizeof<i32>()); // int_ptr: Option<^i32>. Linear type
match int_ptr {
  case Some: {
    let int_ptr = some_int_ptr.value; // int_ptr: ^i32. Linear type.
    *int_ptr = 10;
    free(int_ptr);
  }
  case None: {
    // handle error
  }
}
```

### Cast Linear to Free

NOTE: This is unsafe and should be avoided.

```typescript
let x = String.from("Hi"); // x: String. Linear type
let y = cast_to_free(x); // y: String. Free type
```

## Mutable Value Semantics

Guarantee memory safety in low-level programming language is hard.  
Rust uses the borrow checker to ensure memory safety, but it adds complexity to the language and burden to the programmer.  
Mutable Value Semantics in contrast is a restriction to first-class references which makes you lose some generality but gain simplicity.
Raw pointer is a natural thing in low-level programming languages. It's unavoidable.
The goal of the **Mo** language is to let you write workable and kinda memory-safe code without the need to use raw pointers.

### Second-Class References

References in **Mo** are second-class citizens.

- Can't be stored in data structures or variables.
- Can't be returned from functions.
- Can only be created at function call sites, as a special parameter-passing mode.

### Parameter passing modes

- `inout`

  The `inout` parameter is a reference to a value that can be read and written.

  ```typescript
  function swap(a: inout i32, b: inout i32) {
    let temp = a;
    a = b;
    b = temp;
  }
  let x = 1;
  let y = 2;
  swap(x, y);
  ```

- `in`

  The `in` parameter is a reference to a value that can only be read.

  ```typescript
  function print(x: in i32) {
    println(x);
  }
  let x = 1;
  print(x);
  ```

- `out`

  The `out` parameter is a reference to a value that can only be written.

  ```typescript
  function init(x: out i32) {
    x = 1;
  }
  let x: i32;
  init(x);
  ```

### RAII

**Mo** supports the RAII to automatically insert the `drop` function when the variable of linear type goes out of scope.

```typescript
function test() {
  let x = String.from("World!");

  // `drop(x)` will be automatically inserted here.
}
```

## Function Declaration

Function parameters are immutable by default.

```typescript
// Top level function.
// Type after `=>` is the return type. If it's not specified, it's `()`.
function add(x: i32, y: i32): i32 {
  return x + y;
}

// or
let add = (x: i32, y: i32)=> i32 {
  x + y // The last expression is the return value.  `return` is optional.
}

// or
let add: (i32, i32)=> i32 = (x, y)=> x + y;


function last_unit_expr(x: i32, y: i32) {
  x + y;
  // This is allowed as the last expression is `()`.
}


// Default parameter values
let add = (x: i32 = 1, y: i32 = 2): i32 => {
  return x + y;
}
add(); // 3
add(y: 3); // 4
add 2, 3; // 5

// Named return values
function exponent(base: i32, power: i32):
  ( result: i32,
    some_ref: *i32 &(result)) {
  var r = 1;
  for (let i = 0; i < power; i++) {
    r *= base;
  }
  return (r, &r);
}

// Generic function
function identity<T>(arg: T): T {
  return arg;
}

// Dependency injection
function main(?raise: (error: *u8[])=> i32) {
  let x: i32 = raise("Hello, world");
}

// Value constraint `In Design`
type NotZero = i32 where _ != 0;
function divide(x: i32, y: NotZero): i32 {
  return x / y;
}

// Type constraint
function add<T: Type Integral<T>>(x: T, y: T): T {
  return x + y;
}

// Closure
let add = [{y: 0}](x: i32): i32 => {
  y = x + y;
  return y;
};
add(1); // 1
add(1); // 2
// add.y == 2
```

### Named arguments

```typescript
function add(x: i32, y: i32): i32 {
  return x + y;
}
add(y: 2, x: 1); // 3

// QUESTION: Should we allow this?
// You can also call a function without the parentheses:
add y: 2, x: 1; // 3
```

### Contextual parameters, aka implicit parameters

The contextual parameters are passed implicitly to the function.  
**Mo** looks for the closest value that matches the contextual parameter by the **type**, not by **name**.

NOTE: `implicit` should be part of the `type`.

```typescript
function some_async_func(?Async<i32>): i32 {
  // Here we didn't give a parameter name for the implicit parameter.
}
```

#### Compiletime

```typescript
// id.mo
export class Id<T> {
  id: (x: T)=> T;
};

// main.mo
let { Id, id } = import("./id.mo");
let use_id = <T with Id>(x: T): T => {
  id(x)
}
```

#### Runtime

```typescript
function add(x: i32, ?y: i32): i32 {
  return x + y;
}

function main() {
  {
    add(3); // error: missing implicit parameter type i32
  }
  {
    let ?y = 4;
    add(3); // ok, 7
  }
  {
    let ?a = 4;
    ?i32 = 5; // without giving a name
    add(3); // will pick the closest value, which is 5, so it's 8
  }
  {
    add(3, 4); // ok, 7
  }
  {
    let ?y = 4;
    let ?y = 5;
    add(3); // ok, 8
  }
}
```

The arguments are provided in lexical scope, not dynamic scope.

```typescript
function test(x: i32, ?id: (x: i32)=> i32) {
  print(id(x))
}

let ?id = (x: i32)=> x;
function use_test() {
  test(3); // print 3

  let ?id = (x: i32)=> x + 1;
  test(3); // print 4
}

function main() {
  let ?id = (x: i32)=> x + 2; // This will not affect the `test` function calls in `use_test`
  use_test();  // print 3
              // print 4
}
```

### Uniform Function Call Syntax

```typescript
function add_one(x: i32): i32 {
  return x + 1;
}

(12).add_one(); // 13
// is equalvalent to
add_one(12); // 13

let s = String.from("Hello, world");
s.length(); // 12
// is equalvalent to
length(&s); // 12
// We will automatically convert to reference when needed.
```

### `defer`

`defer` will execute an expression at the end of the current scope.

```typescript
function test() {
  let x = String.from("World!");
  defer {
    println(x);
    drop(x);
  }

  let y = String.from("Hello, ");
  defer {
    println(y);
    drop(y);
  }
}

test(); // Hello, World!
```

```typescript
function deferExample() {
  var a = 1;

  {
    defer a = 2;
    a = 1;
  }

  println(a); // 2
  return a;
}
```

### `recur` `In Design`

Use the `recur` to call the function recursively.  
This is useful for anonymous function.  
If `recur` is the last expression, tail-call optimization will be applied.

- With tail-call optimization

  ```typescript
  (x: u32, acc: u32 = 1) => {
    if x == 1 {
      acc
    } else {
      recur(x - 1, acc * x)
    }
  };
  ```

- Without tail-call optimization

  ```typescript
  (x: u32) => {
    if x == 1 {
      1
    } else {
      x * recur(x - 1)
    }
  };
  ```

### Custom Operators

```typescript
function (|>) <T, U>(x: T, f: (value: T)=> U): U {
  f(x)
}

12 |> add_one; // 13

(|>)(12, add_one); // 13
```

We can define its precedence and associativity:

```typescript
infix  40 ==  // no associativity. Eg, 3==4==5 is invalid
infixr 80 **  // right associativity. Eg, 3 ** 4 ** 6 == 3 ** (4 ** 6)
infixl 60 +   // left associativity. Eg, 3 + 4 + 6 == (3 + 4) + 6
```

## Duck Typing `In Design`

```typescript
// This function can take any type that has a `length: i32` property.
function print_length(x: *{ length: i32 }) {
  println(x.length);
};

function main() {
  let s = String.from("Hello, world");
  print_length(&s);
  // ^ This works as the compiler converts it to below from the background:
  print_length(&{ length: s.length })
}
```

## Tuple

Tuple is defined as a sequence of elements of different types, separated by commas and enclosed in parentheses.

```typescript
let my_unit = (); // my_unit: (). Free type

let i32_tuple: (i32, i32, i32) = (1, 2, 3); // tuple: (i32, i32, i32). Free type

let mixed_tuple = (1, true, "Hello"); // mixed_tuple: (i32, boolean, *u8[6,'\0']). Free type

let (a, b, c) = mixed_tuple; // a: i32, b: boolean, c: *u8[6,'\0']. Free type
```

## Array & Slice

```typescript
var i32_array = [1, 2, 3, 4, 5]; // i32_array: i32[5]. Free type
                                 // In C: int i32_array[5] = {1, 2, 3, 4, 5};
i32_array.length; // 5, compile-time known

const immutabl_i32_array = [1, 2, 3, 4, 5]; // immutabl_i32_array: i32[5]. Free type
                                            // In C: const int immutabl_i32_array[5] = {1, 2, 3, 4, 5};

// Convert from array to slice using `&`
let i32_array_ptr = &i32_array; // i32_array_ptr: i32[]. Free type
i32_array_ptr.length; // 5, runtime known
i32_array_ptr[0] = 8; // automatically dereference
// i32_array: [8, 2, 3, 4, 5]

let i32_ptr = &i32_array[0]; // i32_ptr: *i32. Free type
*i32_ptr = 9;
// i32_array: [9, 2, 3, 4, 5]
```

Slice in **Mo** is a reference to an array. It is a pointer to the first element of the array and the length of the slice calculated from the **runtime**.

```typescript
let i32_array = [1, 2, 3]; // i32_array: i32[3]. Free type
let i32_ptr = &i32_array[0]; // i32_ptr: *i32. Free type
let i32_slice = &i32_array; // i32_slice: i32[]. Free type
let i32_slice = i32_array[0:some_func_return_usize()];  // i32_slice: i32[]
                                                        // Compiler Error: The size of the slice is not known at compile time.
                                                        //                 Please use `&` to coerce i32_array to slice type *i32[]
let i32_slice = &i32_array[0:some_func_return_usize()]; // Okay
let i32_slice = &i32_array[0:3]; // i32_slice: i32[]

i32_slice.length; // 3, runtime known
i32_slice[0] = 10;
// i32_array: [10, 2, 3, 4, 5]


function set_value(arr: *i32[], index: usize, value: i32) {
  if index < arr.length { // arr.length is runtime known
    arr[index] = value;
  }
}
set_value(i32_array, 0, 11); // Compiler error: Please use `&` to coerce i32_array to slice type i32[]
set_value(&i32_array, 0, 11); // Correct!
// i32_array: [11, 2, 3, 4, 5]
// i32_slice: [11, 2, 3]


function set_value(arr: i32[], index: usize, value: i32) { // Compiler Error: The size of the slice is not known at compile time.
                                                           //                 Please use `&` to coerce arr to slice type *i32[]
  // ...
}

// This is also allowed as the size of the array is known at compile time.
function set_value_3(arr: i32[3], index: usize, value: i32) {
  // ...
}
```

```typescript
type str = u8[,'\0'];

let constant_str = "Hello"; // constant_str: *u8[5,'\0']
                     // ['H', 'e', 'l', 'l', 'o', '\0']
constant_str.length; // 5 (excluding '\0'), compile-time known

var mutable_str = *"Hello"; // mutable_str: u8[5,'\0'], convert to mutable array
                     // ['H', 'e', 'l', 'l', 'o', '\0']
mutable_str.length; // 5 (excluding '\0'), compile-time known

let slice_1 = &mutable_str[0:2]; // slice_1: *u8[]
                           // ['H', 'e']
slice_1.length; // 2, runtime known
slice_1[0] = 'h';

// mutable_str: ['h', 'e', 'l', 'l', 'o', '\0']
// slice_1: ['h', 'e']
```

## Closure `In Design`

The closure in **Mo** is a function that can capture ~~Linear~~ values from the outer scope.  
**Mo** only supports **explicit captures** in closures.
**Mo** **doesn't** support references in captured values.

The closure type is defined as:

- Closure that can be called once:
  ```
  [^]<type parameters>(parameters)=> return_type { body }
  ```
- Closure that can be called multiple times:
  ```
  [&]<type parameters>(parameters)=> return_type { body }
  ```

A closure can be defined using the following syntax:

```
[{captures}]<type parameters>(paramters)=> return_type { body }
```

where `[=]` means to automatically capture the variable by value, and `[&]` means to automatically capture the variable by reference.

QUESTION: Should we make the captures explicit?

Examples:

```typescript
function test() {
  var x = 1;

  let increment: [*](a: i32)=> () = [{x: &x}](a: i32)=> {
  //                                  = [&](a: i32)=> {
    // let {x} = increment;
    *x = *x + a;
  }
  increment(1);
  increment(2);

  // x == 4
}
```

```typescript
function test() {
  var x: Data = malloc(); // Some `Fake` Data.

  var increment: [^]()=> (); = [{x: x}]()=> {
  //                           = [=]()=> {
    // let {x} = increment;
    drop(x);
  }
  increment(); //
  increment(); // Compiler Error: closure is already consumed.
}
```

**NOTE:** We can pass normal function ()=>() to a function argument that expects a closure, but not the other way around.

## Mutability `To be updated`

The builtin `=` function is used to update a value that can be `write`, with the following signature:

```typescript
let set! = <T: Type>(ref: *T, value: T)=> T;

// `=` is a syntactic sugar for `set!`

x = x + 1
// is equalvalent to
set!(&x, x + 1)
// so we append `write` to the variable on the left hand side of `=`
```

Below is an example of updating a field of a linear type:

```typescript
enum Person { // Linear type.
  Person(name: String, age: i32)
}
var p = Person(String.from("Alice"), 30); // p: Person. Linear type.

// Update the field
let oldName = (p.name = String.from("Bob"));
// oldName is the `value` moved out.
// oldName == String.from("Alice")
```

## Generic

### Type parameters

Type parameters are defined inside `<...>`

```typescript
function id<T: Type>(x: T): T {
  return x;
}

// or
function id<T>(x: T): T { // T will be inferred as `Type` kind
  return x;
}
```

### Type constraints

Type constraints are achieved using the `with` keyword.

```typescript
// Type constraints
function three_are_equal<T: Type with Eq<T>>(x: T, y: T, z: T): bool {
  x == y && y == z
}

function show_compare<T: Type with (Show<T>, Ord<T>)>(x: T, y: T): String {
  match(compare(x, y)) {
    case LT: "Less than"
    case EQ: "Equal"
    case GT: "Greater than"
  }
}

// Instance dependencies
instance<A with Show<A>> Show<A[]> {
  show: (x: A[])=> {
    // ...
  }
}
instance <A with Show<A>,
          B with (Show<B>, Show<(A, B)>)> {
  show: (x: (A, B))=> {
    // ...
  }
}
```

```typescript
// show.mo
export class Show<T> {
  show: (x: T)=> String;
}

instance Show<i32> {
  show: (x: i32)=> {
    // ...
  }
}

instance Show<String> {
  show: (x: String)=> {
    // ...
  }
}

// main.mo
let { show, Show } = import("./show.mo");

export function show<T with Show<T>>(x: Array<T>): String {
  // ...
}

let { show, Show } = import("./show.mo");

function less_than<T: Type with (Ord<T>, Show<T>)>(x: T, y: T): boolean {
  println(show(x));
  return x < y;
}
```

## Control Flow

### if/else

```typescript
function main() {
  // If no return type, it is `()`
  let number = 3;

  if number < 5 {
    println("condition was true");
  } else {
    println("condition was false");
  }
};
```

### while `Might be removed`

```typescript
function factorial(n: i32): i32 {
  var result = 1;
  var i = 1;
  while (i <= n) {
    result *= i;
    i += 1;
  }
  return result;
}
```

### for `Might be removed`

```typescript
function factorial(n: i32): i32 {
  var result = 1;
  for (var i = 1; i <= n; i += 1) {
    result *= i;
  }
  return result;
}
```

## Type synonyms

```typescript
// Record
type User: Linear = {
  active: boolean;
  username: String;
  email: String;
  age: i32;
};

type str = u8[,'\0'];

let user: User = User {
  active: true,
  username: String.from("johndoe"),
  email: String.from("test@gmail.com"),
  age: 13
};

// Define an extern type
type Pointer<T: Type>;
```

Extending the records

```typescript
/*
type Lang<l> = { language: String | l}; // Intersection types
type Language = Lang<(year: i32)>;
// Language is equal to
type Language = { language: String; year: i32 };
*/
type Lang<l> = { language: String } & l; // Intersection types
type Language = Lang<{ year: i32 }>;
// Language is equal to
type Language = { language: String; year: i32 };
```

Destructure the record:

```typescript
let user: User = User {
  name: String.from("johndoe"),
  age: 12
}

{
  let {age} = user; // Compiler Error: `user` is consumed while `name` is not moved out.
}

{
  let {name, age} = user;
  // name: String, linear type
  // age: i32. Free type
}

{
  // Rename the field with `as`
  // Specify the type with `:`
  let {name as username, age} = user;
  println(username); // johndoe
  // username: String, linear type.
  // age: i32. Free type.
}
```

## Enum (Algebraic Data Types)

Enum is basically another type of Record with a hidden field `tag` that indicates the variant type.

Therefore, when a value of a variant is decided, we can access the field of the value just like accessing the field of a record.

There is also some optimization on the enum type. For example, if the enum has only one variant, the `tag` field will be omitted.

In addition, if there is only one variant with one field, the field type will be used directly instead of wrapping it in a record. This is like the [newtype](https://wiki.haskell.org/Newtype) in Haskell.

```typescript
enum Option<T> {
  Some(value: T),
  None
}
let {*} = Option; // The, `*` means to destructure everything.

let none: Option<i32> = None;
let some: Option<i32> = Some(42);

// Access the field:
some.value;
let {value} = some;

enum IpAddr {
  V4(v0: u8 = 255, v1: u8 = 255, v2: u8 = 255, v3: u8 = 255),
  V6(v: String)
}


let home = IpAddr.V4(127, 0, 0, 1);
let anotherHome = IpAddr.V4(v3: 200);
let loopback = IpAddr.V6(String.from("::1"))
```

## Advanced Types `In Design`

### Dependent types `In Design`

Dependent types are types which depend on values.

```typescript
type Vector<N: i32> = Array<i32, N>;

function add_vectors<N: i32>(a: Vector<N>, b: Vector<N>): Vector<N> {
  return a.map((x, i)=> x + b[i]);
}

let v1: Vector<3> = [1, 2, 3];
let v2: Vector<3> = [4, 5, 6];
let result = add_vectors(v1, v2); // [5, 7, 9];

// The code below will not compile
let v3: Vector<2> = [1, 2];
let v4: Vector<3> = [4, 5, 6];
// let error = add_vectors(v3, v4); // Compiler Error: Vector<2> and Vector<3> are different types.
```

### Refinement types `In Design`

Refinement types consists of all values of a given type which satisfy a given predicate.

```typescript
type PositiveNumber = i32 where _ > 0;
type NonEmptyString = String where _.length > 0;

function divide(x: PositiveNumber, y: PositiveNumber): PositiveNumber {
  x / y
}

let x: PositiveNumber = 10; // Valid
let y: PositiveNumber = -10; // Compiler Error: -10 is not a PositiveNumber

let result = divide(10, 2); // Valid
```

```typescript
type NaturalNumber = i32 where _ >= 0;
type PositiveNumber = i32 where _ > 0;
type Equal<n: i32> = i32 where _ == n;
type Index<T: Type, a: T[]> = NatureNumber where _ < a.length();
type NotEmptyArray<T> = T[] where _.length() > 0;

function get<T, a: T[]>(index: Index<T, a>, array: a): T {
  return array[index];
}

function set<T, a: T[]>(index: Index<T, a>, array: a, value: T) {
  return array[index] = value;
}

function head<T>(array: NotEmptyArray<T>): T {
  return array[0];
}
```

### Generalized Algebraic Data Types (GADTs) `In Design`

```typescript
enum Expr<T> {
  IntExpr(i: i32): Expr<i32>,
  BoolExpr(b: boolean): Expr<boolean>,
  EqExpr(left: Expr<i32>, right: Expr<i32>): Expr<boolean>
}

function eval<T>(expr: Expr<T>): T {
  // with Expr<T>;
  match (expr) {
    case Expr.IntExpr: expr.i,
    case Expr.BoolExpr: expr.b,
    case Expr.EqExpr: eval(expr.left) == eval(expr.right)
  }
}

let expr1 : Expr<boolean> = EqExpr(IntExpr(1), IntExpr(2));
eval(expr1); // false
```

## Typeclass

```typescript
class Summary<T> {
  summarize: (self: *T)=> String;
};

class Display<T, Summary<T>> {
  display: (self: *T)=> String;
};

type NewsArticle = {
  headline: String;
  location: String;
  author: String;
  content: String;
};

instance Summary<NewsArticle> {
  summarize: function(self: *NewsArticle): String {
    return "${self.headline}, by ${self.author} (${self.location})";
  }
}

// Pass in function
function notify(item: *NewsArticle) {
  println("Breaking news! ", summarize(item));
}

function notify<T, Display<T>>(
  item: *T
) {
  println("Breaking news! ", summarize());
  println("Breaking news! ", display(item));
}
```

## Pattern Matching

The compiler implements an exhaustive check on the pattern matching.

```typescript
enum Coin {
  Penny,
  Nickel,
  Dime,
  Quarter,
}

// Reference:
// - https://doc.rust-lang.org/book/ch06-02-match.html
// - https://github.com/tc39/proposal-pattern-matching
function value_in_cents(coin: Coin): u8 {
  match coin {
    case Coin.Penny: {
      println("Lucky penny!");
      return 1;
    },
    case Coin.Nickel: 5,
    case Coin.Dime: 10,
    case Coin.Quarter: 25,
  }
}

enum List<T> {
  Nil,
  Cons(head: T, tail: Box<List<T>>),
}


function list_length<T>(list: &List<T>): i32 {
  match (list) {
    case List.Nil: 0,
    case List.Cons: {
      let {tail} = list;
      1 + list_length(tail)
    }
  }
}
```

### Using Range in `case`

```typescript
function check_int(x: i32) {
  match (x) {
    case 1:
    case 2:
    case 3:
    case 4:
    case 5:
    case 6: {
      println("1 to 6");
    }
    case 7:
    case 8:
    case 9:
    case 10: {
      println("7 to 10");
    }
    default: {
      println("Other");
    }
  }
}
```

Can also use range:

```typescript
function check_int(x: i32) {
  match (x) {
    case 1 .. 6: {
      println("1 to 6");
    }
    case 7 .. 10: {
      println("7 to 10");
    }
    default: {
      println("Other");
    }
  }
}
```

## Pointers

In C, there are 4 types of pointers:

- Pointer to a constant
  `const int*`
- Constant pointer to a constant
  `const int* const`
- Pointer to a non-constant
  `int*`
- Constant pointer to a non-constant
  `int* const`

In Mo, these 4 categories are represented as:

```typescript
// Pointer to a constant
let constant_i32 = 12;
var ptr_to_constant = &constant_i32; // ptr_to_constant: *i32. Free type

// Constant pointer to a constant
let constant_i32 = 12;
let constant_ptr_to_constant = &constant_i32; // constant_ptr_to_constant: *i32. Free type

// Pointer to a non-constant
var i32_val = 12;
var ptr_to_i32 = &mut i32_val; // ptr_to_i32: *mut i32. Free type

// Constant pointer to a non-constant
var i32_val = 12;
let constant_ptr_to_i32 = &mut i32_val; // constant_ptr_to_i32: *mut i32. Free type
```

## Collections

### ArrayList

This is the dynamic array.

```typescript
let v: ArrayList<i32> = ArrayList.new();
let v2 = ArrayList.from([1, 2, 3]);
let value = v2.at(0);
```

### String

#### C String

0 terminated string.

```typescript
let s = c"Hello"; // s: *u8
// (const char) *const s1 = "Hello";
```

#### UTF-8 string literal

This is not a 0 terminated string.
Similar to the `str` in Rust.
NOTE: UTF-8 is a variable-width encoding (each character can be 1 to 4 bytes long), so we cannot get the `n`th character like `s[n]`.

```typescript
let immutable_s = "Hello"; // immutable_s: *str, free type
immutable_s.length; // 5

// where it is stored in struct like
type str = {
  data: u8;
  length: usize;
};
```

#### String (Immutable String)

UTF-8 encoded string.

```typescript
let s = String.new();
let s2 = String.from("Hello World!");
let s3 = s + s2; // Create a new string.
```

### Map

```typescript
let m: Map<String, i32> = Map.new();
let m2 = Map.from([
  [String.from("one"), 1],
  [String.from("two"), 2],
  [String.from("three"), 3],
]);

m.set(String.from("one"), 1);
```

## Error handling

```typescript
type MyError = {message: char[]};
function main(?throw: Exception<MyError>) {
  throw({
    message: "Something went wrong",
  });
}
```

## Type casting

Use `as` to cast a value to another type.

```typescript
let x: i32 = 1;
let y: f32 = x as f32;
```

### Type casting in destructuring

```typescript
let arr = [1, 2, 3];
let [x as f32, y, z] = arr;

let obj = {x: 1, y: 2, z: 3};
let {x: new_name as f32, y, z} = obj;
```

## Algebraic Effects `In Design`

NOTE: It is too hard to implement. And it makes the type system complicated. We need to find some way to simplify the type system.

**Mo** supports the one-shot delimited continuation.

### Effectful function

QUESTION: Should we allow an effectful function to be a closure?

An effectful function is defined with the `effect` keyword.

The continuation `k` will be exposed to the effectful function.  
`k` is linear, and it must be consumed once.  
Either `resume` or `abort` function can be called with the continuation `k`.

The `do` keyword is used to call the effectful function.  
The `do` keyword decides where to `resume` the continuation.
The `do` keyword is necessary to notify the programmer that the continuation might `abort`.

The `return` keyword is not allowed in the continuation function.

```typescript
function safe_divide( x: i32,
                      y: i32,
                      raise: effect (msg: *u8[])=> i32
  ): i32 {
  if y == 0 {
    do raise("Division by zero")
  } else {
    x / y
  }
}

// `resume`
function handle_resume(): i32 {
  let raise = effect (msg: *u8[]): i32 => {
    resume(10, /* k */);
  }
  return 1 + safe_divide(3, 0, raise) + 2; // 13
}

// `abort`
function handle_abort(): i32 {
  let raise = effect (msg: *u8[]): i32 => {
    abort(10, /* k */);
  }
  return 1 + do safe_divide(3, 0, raise) + 2; // 10
}
```

```typescript
function main() {
  let wait_for_seconds = effect (seconds: u32): i32 => {
    set_timeout(()=> {
      println("Done");
      resume(12);
    }, seconds * 1000);
  }

  println("Before timeout");
  let result = do wait_for_seconds(1);
  println("After timeout");
  println(result); // 12
}
```

### Run multiple continuations `In Design`

QUESTION: This approach has the problem that if one of them abort, then how should we handle the rest of the continuations?

```typescript
function main() {
  effect wait_for_seconds(sec: u32): i32 {
    set_timeout([=]()=> {
      println(sec);
      resume(sec);
    }, sec * 1000);
  }

  print("before waits");
  let (wait1, wait2, wait3) = do (
    wait_for_seconds(1),
    wait_for_seconds(2),
    wait_for_seconds(3),
  );
  print("after waits");
  // Will wait for 3 seconds
}
```

## async/await `In Design`

NOTE: Having async/await like javascript makes mo not distinguishable from javascript. We need to find some way to make mo unique. So probably we will not implement async/await. The function shouldn't be colored with the async keyword.

```typescript
async function main() {
  let result = await fetch("https://api.example.com");
  println(result);
}
```

## Modules

QUESTION: Should we allow to `export` a linear type value?

NOTE: Why not use javascript like import:

- To support condtional import in the future.
- To allow import happening in the middle of the code, like inside a function.
- for consistency with the destructuring. Like for javascript, it uses `import {x as y} from "module.ts"` but destructuring uses `let {x: y} = obj`.

```typescript
let { copy } = import("https://github.com/mo-lang/mo/std/fs.mo")

function test() {
  println("Hello, world!");
}

export { test, copy };

// Export the enum.
export enum Option<T> {
  Some(value: T),
  None,
}

// Export the class
export class Id<T> {
  id: (x: T)=> T;
}

// Explicitly export the functions defined in the instance.
// The implementations will be exported implicitly.
instance Id<i32> {
  id: (x: i32)=> i32 {
    x
  }
}

// Prevent name mangling.
export let x = 1;
```

```typescript
let {*} = import("./test.mo"); // Import everything from test.mo
let Test = import("./test.mo"); // Import everything from test.mo and put it in the Test namespace
let { test } = import("./test.mo"); // Import test function from test.mo
let { test: test2 } = import("./test.mo"); // Import test function from test.mo and rename it to test2

let { Option } = import("./test.mo"); // Import Option enum from test.mo

/*
// BELOW ARE IN DESIGN
let { Option:{Some, None} } = import("./test.mo"); // Unwrap Some and None variant from Option enum from test.mo
let { Option:{*} } = import("./test.mo"); // Unwrap all variants from Option enum from test.mo
let { Option as AnotherOption:{*} } = import("./test.mo"); // Unwrap all variants from Option enum, and rename 'Option' to 'AnotherOption' from test.mo
*/

// All exported instances are implicitly imported.
let { id } = import("./test.mo"); // Import `id` function defined in `Id` interface from test.mo
let { Id } = import("./test.mo"); // Import `Id` class from test.mo
```

`mo.json` and `mo.lock`

```json
{
  "name": "my-project",
  "version": "0.1.0",
  "dependencies": {
    "std": ""
  }
}
```

## Attributes

Attributes are defined with the `@` symbol.

```typescript
@doc(`Add two numbers`)
function add(x: i32, y: i32): i32 {
  return x + y;
}

@derive(Eq, Ord)
type Centimeters = i32;
```

## C Interoperability

### To C

```typescript
@c_name("c_add_numbers") // Export to C with the name `c_add_numbers`
function add_numbers(a: i32, b: i32): i32 {
  return a + b;
}

@c_name("some_struct_t") // Export to C with the name `some_struct_t`
type SomeStruct = {
  @c_name("another_name") // Export to C with the name `another_name`
  a: i32,

  b: i32,
  c: i32,
};
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

```typescript
import * from "./some_c.h";

extern "C" {
  @c_name("add_numbers") // Import from C with the name `add_numbers`
  my_add_numbers: (a: i32, b: i32)=> i32, // Import from C

  @c_name("some_struct_t") // Import from C with the name some_struct_t
  my_some_struct_t: {
    @c_name("a") // Import from C with the name `a`
    my_a: i32,

    b: i32,
    c: i32,
  };
}

my_add_numbers(1, 2); // calling add_numbers from C
```

## Naming Convention

2 spaces for indentation.

- `snake_case`
  - `file name`
  - `directory name`
  - `function`
  - `variable`
- `PascaleCase`
  - `class`
  - `type`
  - `enum` and its variants
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

The current **Mo** compiler frontend is written in **TypeScript** as a proof of concept.

Boostrapping the **Mo** compiler is not a priority at the moment. We will do it when it's ready.

**Mo** currently compiles to C (C11). We might support compiling to LLVM IR, JavaScript, and WebAssembly in the future.

## Meta-programming `In Design`

`quote` is similar to the `quasiquote` in Lisp.  
`unquote` can only be used in `quote`.  
`unquote_splicing` can only be used in `quote` to splice the values into the AST.

```typescript
let x = 1;

let list = quote([0, unquote(x), 2]); // [0, 1, 2]

let list2 = quote([0, x, 2]); // [0, [:variable, :x], 2]

quote([0, unquote_splicing(list), 4]); // [0, 1, 2, 3, 4]
```

### Macro

QUESTION: Should we allow `macro`? It brings a lot of complexity to the language.

Use the `macro` keyword to define a macro.

```typescript
export macro my_if(condition, then) {
  quote {
    if unquote(condition) unquote(then)
  }
}

my_if true, {
  println("true");
}

export macro my_if(condition, then: then_clause, else: else_clause) {
  quote {
    match unquote(condition) {
      case true: unquote(then_clause),
      default: unquote(else_clause)
    }
  }
}

my_if true, then: {
  println("true");
}, else: {
  println("false");
}

export macro unless(condition, do) {
  quote {
    my_if (!unquote(condition), do: unquote(do))
  }
}
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
