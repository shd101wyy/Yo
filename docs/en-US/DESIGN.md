# Language Design

**Yo** is a multi-paradigm, general-purpose, compiled programming language.
Yo aims to be **Simple** and **Fast** (around 0% - 15% slower than C).

**Yo** aims to be a simple to learn programming language for C and JavaScript (TypeScript) programmers 😉.

**Yo** (will &) tend to support advanced type system features such as generalized algebraic data types (GADT), dependent types, refinement types [In Design](../../plans/backlog/IN_DESIGN.md).

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
    - [Compile-time known types:](#compile-time-known-types)
    - [C compatible types:](#c-compatible-types)
    - [Type universes:](#type-universes)
    - [Composite types:](#composite-types)
    - [Pointer types:](#pointer-types)
    - [Static/Dynamic dispatch types:](#staticdynamic-dispatch-types)
    - [Value Types vs Reference-Semantics Types](#value-types-vs-reference-semantics-types)
  - [Variable Declaration](#variable-declaration)
    - [No variable shadowing](#no-variable-shadowing)
  - [Type inference](#type-inference)
    - [Uninitialized variable](#uninitialized-variable)
- [Function Declaration](#function-declaration)
  - [Named arguments](#named-arguments)
  - [Default parameter values](#default-parameter-values)
  - [Generic function](#generic-function)
  - [Type constraints](#type-constraints)
  - [Trait Method Disambiguation](#trait-method-disambiguation)
  - [Partial Application with `_`](#partial-application-with-_)
  - [Type Methods](#type-methods)
  - [recur](#recur)
  - [Reference-Semantics Types and Memory Management](#reference-semantics-types-and-memory-management)
    - [Reference-Semantics Type](#reference-semantics-type)
    - [Compile-Time Reference Counting Optimization](#compile-time-reference-counting-optimization)
- [Pointers](#pointers)
  - [Pointer Operations](#pointer-operations)
  - [Pointer Arithmetic and Comparison](#pointer-arithmetic-and-comparison)
  - [Pointer Operations Reference](#pointer-operations-reference)
  - [The consume Function](#the-consume-function)
  - [Nullable Pointers](#nullable-pointers)
  - [RAII (Resource Acquisition Is Initialization)](#raii-resource-acquisition-is-initialization)
- [Tuple](#tuple)
- [Array & Ranges](#array--ranges)
  - [Range with `..`](#range-with-)
  - [Array Methods](#array-methods)
    - [Array.fill](#arrayfill)
    - [Array.len](#arraylen)
  - [Array Length Inference](#array-length-inference)
  - [Array Assignment and Copying](#array-assignment-and-copying)
- [Control Flow](#control-flow)
  - [cond](#cond)
  - [if/else](#ifelse)
  - [while](#while)
  - [Iterator and for loop](#iterator-and-for-loop)
- [Algebraic Data Types (ADT)](#algebraic-data-types-adt)
- [Advanced Type System](#advanced-type-system)
  - [Higher-Kinded Types (HKT)](#higher-kinded-types-hkt)
    - [HKT generic parameters](#hkt-generic-parameters)
    - [HKT traits](#hkt-traits)
    - [Generic functions with HKT where clauses](#generic-functions-with-hkt-where-clauses)
  - [Generalized Algebraic Data Types (GADTs)](#generalized-algebraic-data-types-gadts)
    - [GADT match type refinement](#gadt-match-type-refinement)
    - [GADT exhaustiveness](#gadt-exhaustiveness)
    - [Multi-parameter GADTs](#multi-parameter-gadts)
    - [GADTs with custom discriminants](#gadts-with-custom-discriminants)
    - [Mixed GADT and regular variants](#mixed-gadt-and-regular-variants)
- [C struct](#c-struct)
- [Newtype](#newtype)
- [C union](#c-union)
- [C enum](#c-enum)
- [Traits](#traits)
- [Pattern Matching](#pattern-matching)
- [String](#string)
  - [String literal as `str` or C string pointer](#string-literal-as-str-or-c-string-pointer)
  - [String (Growable UTF-8 String)](#string-growable-utf-8-string)
    - [Template string interpolation with `${}` syntax:](#template-string-interpolation-with--syntax)
- [Collections](#collections)
  - [ArrayList](#arraylist)
  - [HashMap](#hashmap)
  - [HashSet](#hashset)
  - [LinkedList](#linkedlist)
- [Closure](#closure)
  - [Basic Closure Syntax](#basic-closure-syntax)
  - [Closure Capture Semantics](#closure-capture-semantics)
  - [Closure Type Restrictions](#closure-type-restrictions)
  - [Closures with Reference-Semantics Types](#closures-with-reference-semantics-types)
- [Box and Boxing](#box-and-boxing)
  - [Box Type](#box-type)
  - [Usage Examples](#usage-examples)
  - [Box with Assignments](#box-with-assignments)
  - [Box and Reference Counting](#box-and-reference-counting)
  - [When to Use Box](#when-to-use-box)
- [Impl Types](#impl-types)
  - [Basic Usage](#basic-usage)
  - [Impl as Return Type](#impl-as-return-type)
  - [Impl with Multiple Traits](#impl-with-multiple-traits)
- [Dynamic Dispatch](#dynamic-dispatch)
  - [`Dyn` and `dyn`](#dyn-and-dyn)
  - [Examples](#examples)
- [Impl vs Dyn](#impl-vs-dyn)
- [Algebraic Effects and Handlers](#algebraic-effects-and-handlers)
- [Error Handling](#error-handling)
  - [Result Type](#result-type)
  - [Error Trait and AnyError](#error-trait-and-anyerror)
  - [Exception (Non-Resumable)](#exception-non-resumable)
  - [ResumableException](#resumableexception)
- [Async/Await](#asyncawait)
- [Parallelism](#parallelism)
- [Isolated Types](#isolated-types)
- [Arc Types](#arc-types)
- [Module importing and exporting](#module-importing-and-exporting)
  - [Anonymous module](#anonymous-module)
  - [Module-level mutable variables](#module-level-mutable-variables)
- [Naming Convention](#naming-convention)
- [Testing](#testing)
  - [Basic Test Syntax](#basic-test-syntax)
  - [Running Tests](#running-tests)
  - [Assertions](#assertions)
    - [Runtime Assertions](#runtime-assertions)
    - [Compile-Time Assertions](#compile-time-assertions)
  - [Testing Expected Errors](#testing-expected-errors)
  - [Test Organization](#test-organization)
  - [Testing with Reference-Semantics Types](#testing-with-reference-semantics-types)
  - [Test Files](#test-files)
- [Meta-programming](#meta-programming)
  - [Macro functions](#macro-functions)
- [Derive Traits](#derive-traits)
  - [Built-in derives](#built-in-derives)
  - [User-defined derive rules with `derive_rule`](#user-defined-derive-rules-with-derive_rule)
- [Type Reflection](#type-reflection)
- [Compile-Time Evaluation](#compile-time-evaluation)
  - [Compile-Time Variables](#compile-time-variables)
  - [Compile-Time Arithmetic](#compile-time-arithmetic)
  - [Compile-Time Arrays](#compile-time-arrays)
  - [Compile-Time Assertions](#compile-time-assertions-1)
  - [Compile-Time Expected Errors](#compile-time-expected-errors)
  - [Compile-Time vs Runtime](#compile-time-vs-runtime)
  - [Benefits of Compile-Time Evaluation](#benefits-of-compile-time-evaluation)
- [Inline Assembly](#inline-assembly)
- [Index Trait](#index-trait)
- [In Design](#in-design)
- [References](#references)

<!-- /code_chunk_output -->

## Philosophy

**LLM-friendly to write, human-friendly to read.** The two goals
align: a snippet that an LLM can produce without scope-chain reasoning
is also a snippet a human reviewer can understand in a diff. The
design lever is _explicitness_ — every effect, parameter, and capture
is visible at the call site, so what you see is what runs.

**Key Design Principles:**

- **Simple syntax inspired by Lisp** (no keywords, minimal)
- **LLM-friendly syntax** (function, keyword, and prefix-operator calls always use immediate parentheses)
- **First-class types** (types are values)
- **Compile-time evaluation** (powerful `comptime` system)
- **Reference counting with ownership analysis** (eliminate unnecessary RC)
- **Pointer-based memory model** (no references/borrowing complexity)

**A few NO design choices:**

- **No operator precedence** (same-operator chains left-associate; adjacent different operators require explicit parentheses)
- **No variable shadowing** (similar to Zig)
- **No stop-the-world GC** (optional thread-local cycle collector for reference-semantics types)

## Inspiration

The **Yo** language is inspired by the following programming languages and absorbs some of their good ideas:

- Lisp
  - [Scheme](https://www.scheme.com/)
  - [Clojure](https://clojure.org/)
- [C](https://www.c-language.org/)/[C++](https://isocpp.org/)
- [Rust](https://www.rust-lang.org/)
- [Haskell](https://www.haskell.org/), [OCaml](https://ocaml.org/), [PureScript](https://www.purescript.org/), [Scala](https://www.scala-lang.org/)
- [JavaScript](https://developer.mozilla.org/en-US/docs/Web/JavaScript), [TypeScript](https://www.typescriptlang.org/)
- [Jai](https://github.com/Ivo-Balbaert/The_Way_to_Jai), [Zig](https://ziglang.org/), [Odin](https://odin-lang.org/)
- [Koka](https://koka-lang.github.io/), [Effekt](https://effekt-lang.org/), [Flix](https://flix.dev/)
- [Nim](https://nim-lang.org/)
- [Dafny](https://dafny.org/)
- [Austral](https://austral-lang.org/)
- [Elixir](https://elixir-lang.org/)
- [Io](https://iolanguage.org/)
- [ATS](https://www.ats-lang.org/)
- [Go](https://go.dev/)
- [Ada](https://www.adacore.com/)
- [hylo](https://www.hylo-lang.org/)
- [Lobster](https://aardappel.github.io/lobster/README_FIRST.html)
- [pony](https://www.ponylang.io/)
- [Swift](https://swift.org/)
- [Vale](https://vale.dev/)

## Hello World

```rust
{ println } :: import("std/fmt");

main :: (fn() -> unit)({
  println("Hello, world!");
});

export(main);
```

## CLI Usage

```bash
yo --help
yo --version

# Project scaffolding
yo init                     # Create a new project in the current directory
yo init my-project          # Create a new project in ./my-project
yo init my-project --name x # Set project name to "x"

# Build system (see BUILD_SYSTEM.md for details)
yo build              # Build all artifacts (default "install" step)
yo build run          # Build and run the executable
yo build test         # Run tests
yo build --list-steps # List available build steps
yo build --cc zig     # Use zig as the C compiler
yo build --target wasm32-unknown-emscripten  # Cross-compile for WASM (Emscripten)

# Direct compilation (single file, no build.yo needed)
yo compile hello.yo -o hello
yo compile hello.yo --cc clang -o hello
yo compile hello.yo --target wasm32-unknown-emscripten -o hello.html

# Formatting (fixed style, 2-space indentation)
yo fmt                     # Format all .yo files in the current directory
yo fmt src tests           # Format .yo files under src and tests
yo fmt --check             # Check formatting without writing changes
```

For the full build system documentation, see [BUILD_SYSTEM.md](./BUILD_SYSTEM.md).

`yo fmt` is intentionally not configurable, following the same philosophy as `go fmt`: all Yo projects share one compact, consistent style with 2-space indentation.

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
           // Paren-less calls such as func x, y are invalid.

// Calls must use immediate parentheses. These are invalid:
// func x, y
// func (x, y)

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
// "." has its own parsing rules, for example a.b + c.d is parsed as .(a, b) + .(c, d)

// Every infix operator takes two arguments on its left and right.
//
// Yo has NO operator precedence. A chain of the SAME operator is
// left-associative, so no parentheses are needed:
3 + 4 + 5; // parsed as (3 + 4) + 5

// But adjacent DIFFERENT operators are ambiguous and must be
// disambiguated with explicit parentheses:
//
//   3 + 4 - 5; // error: "+" and "-" are different operators
//
// must be written as
3 + (4 - 5);
// or
(3 + 4) - 5;

// Yo has a CLOSED operator set (plans/OPERATOR_SET_AND_PRECEDENCE.md).
// A run of operator characters is split greedily against two fixed tables;
// anything not in them is a LEX ERROR, not a user-defined operator.
//   two-char: != && -> :: := <: << <= == => >= >> ?= ||
//   one-char: ! # % & * + - / : < = > ? ^ | ~
//   dot family: . .. ..= ... ...#
// Infix operators are translated to a dot method call:
// But they will be translated as dot method call:
(3 + 4) * 5; // is the same as
3.(+)(4).(*)(5);

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
- Reference-counted reference-semantics types defined with `ref(struct(...))` or `ref(enum(...))` (and their atomic variants `atomic(ref(struct(...)))` / `atomic(ref(enum(...)))`)
- Fixed-size arrays: `Array(T, N)` or `[T; N]`
- The static string view: `str` (string literals; refers only to static data)
- Newtypes defined with `newtype(...)`
- Tuples: `Tuple(T1, T2, ...)` or `(T1; T2; ...)`

#### Pointer types:

- `*(T)` (pointer to T)

#### Static/Dynamic dispatch types:

- `Impl(Trait)` (static dispatch type that implements Trait)
- `Dyn(Trait)` (dynamic dispatch type that implements Trait)

#### Value Types vs Reference-Semantics Types

**Value Types** (stack-allocated, copied on assignment):

- Primitive types: `i32`, `bool`, `f32`, etc.
- Structs defined with `struct(...)`
- Enums/ADTs defined with `enum(...)`
- Unions defined with `union(...)`
- Fixed-size arrays: `Array(T, N)` or `[T; N]`
- Tuples: `Tuple(T1, T2, ...)` or `(T1; T2; ...)`

**Reference-Semantics Types** (heap-allocated, reference-counted):

- Types defined with `ref(struct(...))` or `ref(enum(...))` (and their atomic variants `atomic(ref(struct(...)))` / `atomic(ref(enum(...)))`)
- Automatic cycle detection and collection
- Thread-affinity for performance (objects stay on the thread that created them)

```rust
// Value type - stack-allocated, copied
Point :: struct(x : i32, y : i32);
p1 := Point(3, 4);
p2 := p1;  // p2 is a copy of p1

// Reference-semantics type - heap-allocated, reference-counted
MyString :: ref(struct(
  _bytes : ArrayList(u8)
));
s1 := MyString.from("Hello");
s2 := s1;  // s2 and s1 point to the same object (reference counted)
```

### Variable Declaration

Variables in Yo are declared with `:=` (runtime) or `::` (compile-time).

```rust
               // "comptime" here means compile-time known
x := 5;        // x: i32, runtime variable
y :: 5;        // y: comptime_int, compile-time variable

// with explicit type declaration
(x : i32) = 5; // x: i32, runtime variable
(comptime(y) : comptime_int) = 5; // y: comptime_int, compile-time variable
// or
comptime(y) := 5;

// All variables are mutable by default
x := 1;
x = 2;  // OK: reassignment is allowed

// (:) function is used to denote a type
// (=) function is used to update a variable with a new value, or initialize a variable with a value
// (:=) function is used to denote a runtime variable with type inferred
// (::) function is used to denote a comptime variable with type inferred

x : i32;        // Define a runtime variable
comptime(x) : i32; // Define a compile-time variable
// All variables are mutable by default. There is no immutable variable, for simplicity.

// Initialize variables
(comptime(x) : comptime_int) = 12;
(y : i32) = 14;
(z : i32) = 16;

// can be written as:
(=)((:)(comptime(x), comptime_int), 12);
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
// String is an reference-semantics type with automatic reference counting
(my_string : String) = String.from("Hello, world"); // Heap-allocated
my_string_2 := my_string; // Both point to the same object (RC incremented)

// Primitive types are copied
my_int := 1; // Stack-allocated
my_int_2 := my_int; // my_int_2 is a copy

// Fixed-size arrays are value types
(my_int_array : Array(i32, 3)) = [1, 2, 3]; // Stack-allocated
my_int_array := [1, 2, 3]; // Array(i32, 3)

// ArrayList is an reference-semantics type
(my_array_list : ArrayList(i32)) = ArrayList(i32).new(); // Heap-allocated, RC

// Enum/ADT can be value or reference-semantics type depending on definition
Person :: struct(name : String, age : i32); // Value type (but holds a reference-semantics field)
p := Person(name : String.from("Alice"), age : 30);
_(name, age) := p; // name : String, age : i32
```

#### Uninitialized variable

```rust
x : i32; // x : i32, uninitialized

// Compiler prevents using uninitialized variable.
println(x); // Compiler Error: x is uninitialized.

x = 1; // x : i32, initialized
```

## Function Declaration

Functions are declared using the `::` operator for compile-time definitions or `:=` for runtime values.

```rust
// Function declaration with explicit type
// function type is written as fn(args...) -> return_type
add :: (fn(x : i32, y : i32) -> i32)(
  x + y // Function body
);
// calling a function type with function body creates a function value

// Or define type first, then implementation
comptime(add) : (fn(x : i32, y : i32) -> i32);
add = _(x + y); // `_` here infers the function type from `add`

// or define the function body with anonymous function
add = ((a, b) -> (a + b));  // Type inferred from usage. Can have different parameter names

// With explicit return type
multiply :: (fn(x : i32, y : i32) -> i32)({
  return((x * y));  // Explicit return
});

// Last expression is the return value
divide :: (fn(x : i32, y : i32) -> i32)(x / y);

// Function can take `comptime` parameter and can return `comptime` value, like Type:
Point :: (fn(comptime(T) : Type) -> comptime(Type))({
  return(struct(
    x : T,
    y : T
  ));
});
I32Point :: Point(i32);
BoolPoint :: Point(bool);

p1 := I32Point(3, 4);
p2 := BoolPoint(true, false);
```

### Named arguments

Named arguments in Yo must be provided in the same order as they are defined in the function signature:

```rust
add :: (fn(x : i32, y : i32) -> i32)((x + y));

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
  ) -> User)(
  User(name: name, age: age)
);

create_user(name: "Alice");  // Uses defaults: age=18
create_user(name: "Bob", age: 30);  // Explicit age
```

> Note: Default parameters must use compile-time known values.

### Generic function

You can use `generic` to define generic functions:

```rust
identity :: (fn(generic(T : Type), arg : T) -> T)(arg);

x := identity(12);     // Type inferred: x: i32
y := identity(true);   // Type inferred: y: bool
```

### Type constraints

You can use `where` clause to add type constraints on generic parameters:

```rust
add :: (fn(generic(T : Type), x: T, y: T, where(T <: Add(T))) -> T)((x + y));
```

`where` clause can specify multiple constraints:

```rust
compare_and_add :: (fn(
    generic(T : Type),
    x: T,
    y: T,
    z: T,
    where(T <: (Add(T), Eq(T)))
  ) -> T)(
  cond(
    (x == y) => (x + z),
    true => (y + z)
  )
);
```

### Trait Method Disambiguation

When a type implements multiple traits that define methods with the same name, `where` clause constraints determine which trait's method is used:

```rust
T1 :: trait(get_number : (fn(self : Self) -> i32));
T2 :: trait(get_number : (fn(self : Self) -> i32));

Point :: struct(x : i32, y : i32);
impl(Point, T1(get_number : (self -> self.x)));
impl(Point, T2(get_number : (self -> self.y)));

// Implicit dispatch — where(T <: T1) constrains self.get_number() to T1's method
use_t1 :: (fn(generic(T : Type), self : T, where(T <: T1)) -> i32)({
  return(self.get_number());  // Returns self.x (10)
});

// Explicit dispatch — (T <: T2).method(self) syntax
use_t2 :: (fn(generic(T : Type), self : T, where(T <: T2)) -> i32)({
  return((T <: T2).get_number(self));  // Returns self.y (20)
});

point := Point(10, 20);
use_t1(point);  // 10
use_t2(point);  // 20
```

### Partial Application with `_`

Multi-parameter type constructors can be partially applied using `_` as a placeholder. This creates a new type constructor with reduced arity:

```rust
// Result has kind: (Type, Type) -> Type
// Partial application fixes one parameter:
IntResult :: Result(_, i32);    // kind: Type -> Type
StrOkResult :: Result(str, _);  // kind: Type -> Type

// Use like any type constructor:
(r : IntResult(bool)) = .Ok(true);      // = Result(bool, i32)
(r2 : StrOkResult(i32)) = .Err(i32(404)); // = Result(str, i32)
```

Partial application works **only** on comptime functions (functions whose return type is `comptime`). It cannot be used on runtime functions.

```rust
// Type constructors (return comptime(Type)):
IntResult :: Result(_, i32);    // kind: Type -> Type

// Comptime value functions (return comptime(i32), comptime(bool), etc.):
add :: (fn(comptime(x) : i32, comptime(y) : i32) -> comptime(i32))(x + y);
add1 :: add(i32(1), _);  // fn(comptime(y) : i32) -> comptime(i32)
result :: add1(i32(2));   // 3
```

Partially applied type constructors can be used as HKT generic arguments:

```rust
IntResult :: Result(_, i32);
// IntResult has kind: Type -> Type, so it can be passed where F : (Type -> Type)
```

### Type Methods

Yo supports **type methods** - methods defined within the type's trait.

**Method calls only work for:**

1. Methods defined in the type's own trait
2. Methods from implemented traits

```rust
// Define a type with methods in its trait
Point :: struct(
  x : i32,
  y : i32
);
impl(Point,
  // Type methods are defined in the struct's trait
  distance_from_origin : (fn(self: Self) -> f64)(
    f64(
      sqrt(
        (self.x * self.x) +
        (self.y * self.y)))
  ),

  move_by : (fn(inout(self) : Self, dx : i32, dy : i32) -> unit)({
    self.x = (self.x + dx);
    self.y = (self.y + dy);
  })
);

p := Point(3, 4);
d := p.distance_from_origin();  // Type method call - OK

p2 := Point(0, 0);
p2.move_by(5, 10);  // `inout(self)` lowers to `Self*` — &(p2) is taken automatically
// p2 is now Point(5, 10)
```

**Automatic pointer conversion for `inout`:**

`inout(name) : T` parameters lower to `T*` in C. At call sites, Yo automatically takes the address of the matching argument, so callers see plain value-call syntax:

```rust
Point :: struct(x : i32, y : i32);
impl(Point,
  set_x : (fn(inout(self) : Self, new_x : i32) -> unit)({
    self.x = new_x;
  })
);

p := Point(3, 4);
p.set_x(10);  // No `&(p)` required — the compiler inserts it
```

### recur

Use `recur` to call the function recursively.  
This is useful for anonymous functions.  
If `recur` is the last expression, tail-call optimization will be applied.

- With tail-call optimization

  ```rust
  (fn(x : u32, acc : u32) -> u32)(
    if(x == 1,
      then: acc,
      else:
        recur(x - 1, acc * x)
    )
  );
  ```

- Without tail-call optimization

  ```rust
  (fn(x : u32) -> u32)(
    if(x == 1,
      then: 1,
      else:
        x * recur(x - 1)
    )
  );
  ```

### Reference-Semantics Types and Memory Management

Yo uses **reference-semantics types** with [Compile-time Reference Counting with Ownership and Lifetime Analysis](./COMPILE_TIME_RC_WITH_OWNERSHIP_ANALYSIS.md) for safe and efficient memory management.

#### Reference-Semantics Type

Reference-semantics types are heap-allocated types with automatic reference counting:

```rust
// Define a reference-semantics type
MyString :: ref(struct(
  _bytes : ArrayList(u8)
));
impl(MyString,
  // Methods
  from : (fn(s : str) -> Self)({
    // Implementation...
  }),

  length : (fn(self : Self) -> usize)({
    // Implementation...
  }),

  dispose : (fn(self : Self) -> unit)({
    // The `dispose` function is called when the reference count reaches zero
  })
);

// Usage
s1 := MyString.from("Hello");  // RC = 1
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

Yo uses pointers (`*(T)`) for direct memory access, similar to C. Operations that dereference or do arithmetic on raw pointers require an explicit `unsafe(...)` wrap — see [Memory Safety](#memory-safety) below.

```rust
// Pointer type: *(T)
x := 1;
y := 2;

swap :: (fn(a : *(i32), b : *(i32)) -> unit)(unsafe({
  tmp := a.*;  // Dereference pointer
  a.* = b.*;
  b.* = tmp;
}));

swap(&(x), &(y));  // Pass pointers to x and y
// Now x == 2, y == 1
```

For day-to-day in-place mutation, prefer the `inout(name) : T` parameter form (see [Type Methods](#type-methods)) — it lowers to the same `T*` ABI but stays safe and the caller writes plain value-call syntax (`swap(x, y)`). Raw `*(T)` is reserved for FFI and the low-level cases this section covers.

### Pointer Operations

```rust
// Create pointer with & operator
x := 42;
ptr := &(x);  // ptr: *(i32)

// Dereference with .* (requires unsafe — may read invalid memory)
value := unsafe(ptr.*);  // value == 42

// Modify through pointer (requires unsafe — could write to invalid memory)
unsafe(ptr.* = 100);  // x is now 100

// Pointer arithmetic (requires unsafe — could produce OOB address)
arr := [1, 2, 3, 4, 5];
ptr := &(arr(0));  // Pointer to first element
ptr2 := unsafe(ptr.add(2));  // Point to third element
value := unsafe(ptr2.*);  // value == 3

// Pointer casting (safe — just changes type label on the address)
float_ptr := *(f32)(ptr);  // Cast pointer to *(f32)
```

### Pointer Arithmetic and Comparison

Pointer arithmetic uses methods — `p.add(n)`, `p.sub(n)`, `p.offset_from(q)` — which require `unsafe(...)`. Pointer comparison uses the ordinary operators (`==`, `!=`, `<`, `<=`, `>`, `>=`) via the `Eq`/`Ord` impls on `*(T)` and stays safe — comparing addresses can't violate memory safety. Note that `*(T) ==` compares ADDRESSES (identity), while reference-semantics types compare VALUES via their own `Eq` impls.

```rust
test("Pointer arithmetic", {
  x := 12;
  p := &(x);

  // Addition and subtraction (require unsafe — could produce
  // out-of-bounds addresses):
  q := unsafe(p.add(2));   // Advance pointer by 2 elements
  z := unsafe(q.sub(2));   // Go back 2 elements

  // Comparison operators (safe — addresses are just data):
  assert(q > p);  // q is after p
  assert(p < q);  // p is before q
  assert(q >= p); // Greater or equal
  assert(p <= q); // Less or equal
  assert(z == p); // Equal (same address)
  assert(p != q); // Not equal

  // Pointer difference also requires unsafe (assumes both point
  // into the same object):
  diff := unsafe(q.offset_from(p));  // Distance: 2 elements
  assert(diff == 2);
});
```

### Pointer Operations Reference

Arithmetic (methods, require `unsafe(...)`):

- `p.add(n)` : Advance by `n` elements
- `p.sub(n)` : Go back by `n` elements
- `p.offset_from(q)` : Signed element distance (`isize`)

Comparison (ordinary operators via `Eq`/`Ord` on `*(T)`, safe):

- `==` / `!=` : Address equality / inequality
- `<` / `<=` / `>` / `>=` : Address ordering

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
// malloc returns Option(*(void)) — it is NOT generic, so cast before use.
some_ptr := malloc(sizeof(i32));
match(some_ptr,
  .Some(vp) => {
    ptr := *(i32)(vp);
    ptr.* = i32(42);
    printf("value: %d\n", ptr.*);
    free(some_ptr);
  },
  .None => printf("Allocation failed\n")
);
```

**Note**: Raw pointers are unsafe. Use reference-semantics types for safe memory management whenever possible.

### Memory Safety

For the user-facing guide, see [MEMORY_SAFETY.md](MEMORY_SAFETY.md) — covers the safe-by-default contract, `inout(name)` parameters, the `pragma(Pragma.AllowUnsafe);` opt-in, `unsafe(...)` per-op wraps, `// SAFETY:` comment convention, `yo unsafe-report`, and `-fwrapv` for signed-integer overflow.

Yo's safety model is layered (the design plan is [plans/MEMORY_SAFETY.md](../../plans/MEMORY_SAFETY.md)):

- **Reference-semantics types** (`ref(struct(...))` / `ref(enum(...))`, and the `atomic(ref(...))` variants) are reference-counted and automatically freed (RC + cycle removal). Memory-safe by construction.
- **`Iso(T)` / `Arc(T)`** provide affine and atomic-RC ownership for transfer and thread-shared cases.
- **`*(T)` raw pointers** are available only in a file that declares `pragma(Pragma.AllowUnsafe);`. Inside such a file the `unsafe(...)` wrap is the per-operation AUDIT MARKER that `yo unsafe-report` keys on — and the convention `std/`, `src/` and `tests/` follow — not a second compiler gate: a bare `p.*` in a pragma'd file compiles. In a file WITHOUT the pragma the whole raw-pointer surface is rejected, including the `*(T)` type itself.

`unsafe(...)` is a regular builtin call that takes exactly one expression. It is purely a compile-time marker — at codegen time it lowers to its inner expression, no runtime cost.

```rust
// Pointer deref requires unsafe:
read :: (fn(p : *(i32)) -> i32)(unsafe(p.*));

// Pointer arithmetic likewise:
advance :: (fn(p : *(i32), n : usize) -> *(i32))(unsafe(p.add(n)));

// Multi-statement unsafe with begin-block (semicolons required —
// `{ ... }` without semicolons is a struct literal, not a block):
write_and_read :: (fn(p : *(i32), v : i32) -> i32)(unsafe({
  p.* = v;
  p.*
}));

// Pointer comparison (==, <, etc.) and *(T) casts (e.g., *(u8)(p))
// stay safe — they don't dereference, so they're not gated.
```

**What requires `unsafe(...)`**: pointer dereference (`.*`), pointer arithmetic (`.add(n)`, `.sub(n)`, `.offset_from(q)`), and `consume(p.* = v)`.

**What needs no additional `unsafe(...)` wrap** (inside a file that already declares `pragma(Pragma.AllowUnsafe);`): taking an address (`&(x)`), passing/storing/returning pointers, pointer comparison (`<`, `==`, etc.), pointer-type casts (`*(u8)(p)`), and `asm(...)` (already implicitly unsafe). None of these are available in SAFE code — without the pragma, `&(x)` is rejected at the construction site and a `*(T)` type in any signature is rejected outright.

The unsafe surface is greppable: every `unsafe(` token marks a place where raw memory ops happen. A file must declare `pragma(Pragma.AllowUnsafe);` at the top before it can use `unsafe(...)` or perform raw pointer operations. `std/`, `src/`, and `tests/` files declare this pragma explicitly; user code (`main.yo`, the rest of your project) defaults to safe mode and gets a compile error if it tries to use `unsafe(...)`.

For an at-a-glance audit, run `yo unsafe-report` (or `yo unsafe-report ./std` for stdlib alone). It lists every `unsafe(...)` site, `asm(...)` block, `extern(...)` declaration, and pragma-declaring file, with `file:line:col` jumps for editors. The `--json` flag emits machine-readable output for CI integrations.

```rust
// File without pragma — `unsafe(...)` is rejected:
main :: (fn() -> unit)({
  x := i32(42);
  v := unsafe(x);   // error: 'unsafe(...)' is not available in safe code.
                    //        To use raw pointer operations, declare at the top:
                    //            pragma(Pragma.AllowUnsafe);
});

// Opt in by adding the pragma at the top of the file:
pragma(Pragma.AllowUnsafe);

main :: (fn() -> unit)({
  x := i32(42);
  p := &(x);
  v := unsafe(p.*);  // OK
});
```

### `inout` Parameters

For in-place mutation without raw pointers, use the `inout(name) : T` parameter modifier. The modifier wraps the parameter name (parallel to the existing `own(name)`), and the parameter behaves like a binding to the caller's variable — reads access the current value, writes update the caller's storage. At codegen time `inout(name) : T` lowers to `T*` in C; the caller passes `&(arg)` automatically.

```rust
swap :: (fn(inout(a) : i32, inout(b) : i32) -> unit)({
  tmp := a;
  a = b;
  b = tmp;
});

increment :: (fn(inout(n) : i32) -> unit)({
  n = (n + i32(1));
});

main :: (fn() -> unit)({
  x := i32(1);
  y := i32(2);
  swap(x, y);              // no `&()` syntax at the call site
  assert((x == i32(2)), "swapped");
  assert((y == i32(1)), "swapped");

  counter := i32(0);
  increment(counter);
  increment(counter);
  assert((counter == i32(2)), "incremented");
});
```

`inout(...)` cannot be combined with `own(...)` (opposite calling conventions) or with `comptime`/`generic` (`inout` is runtime-only). For chained calls, passing an `inout`-param through to another function's `inout`-param works as expected:

```rust
double :: (fn(inout(n) : i32) -> unit)({
  n = (n + n);
});

double_both :: (fn(inout(x) : i32, inout(y) : i32) -> unit)({
  double(x);  // passes &x through to double's inout-param
  double(y);
});
```

### RAII (Resource Acquisition Is Initialization)

Yo automatically manages memory for reference-semantics types through reference counting. When an object's reference count reaches zero, it is automatically freed.

```rust
test :: (fn() -> unit)({
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
my_i32_tuple := (12,); // my_i32_tuple: (i32;). Free type

// NOTE the separator: tuple VALUES use commas, tuple TYPES use SEMICOLONS.
(i32_tuple : (i32; i32; i32)) = (1, 2, 3);

mixed_tuple := (1, true, "Hello"); // mixed_tuple: (i32; bool; str)

(a, b, c) := mixed_tuple; // a: i32, b: bool, c: str

a := mixed_tuple.0;
b := mixed_tuple.1;
c := mixed_tuple.2;

// NOTE: a 1-element tuple TYPE still needs the separator, or it is just the
// element type itself.
MyTuple :: (i32);
// is equivalent to
MyTuple :: i32;
// to make it a 1-element tuple type:
MyTuple :: (i32;);
```

## Array & Ranges

```rust
i32_array := [i32;_](1, 2, 3); // i32_array: [i32; 3]
                              // In C: int i32_array[3] = {1, 2, 3};
i32_array.len(); // 3, compile-time known

(i32_array2 : [i32; _]) = [1, 2, 3]; // i32_array2: [i32; 3]
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
  `xs.get(i)` returns the element (a handle for reference-semantics types, which
  survives container growth; a copy for struct types, written back with
  `xs(i) = v`). See [FLOWABILITY.md](./FLOWABILITY.md).

### Range with `..`

```rust
list := ArrayList(i32).new();
list.push(i32(1)); list.push(i32(2)); list.push(i32(3)); list.push(i32(4));

// Copy of elements 1..3 (end-exclusive) — an independent ArrayList(i32)
part := list(usize(1)..usize(3));   // [2, 3]

// End-inclusive variant
part2 := list(usize(1)..=usize(3)); // [2, 3, 4]

// Mutating the copy does not affect the source
part(usize(0)) = i32(99);
assert(list(usize(1)) == i32(2));
```

### Array Methods

Arrays in Yo come with useful methods:

#### Array.fill

Create an array filled with a value:

```rust
// `fill` requires a COMPILE-TIME value (it is defined under `where(T <: Comptime)`
// and takes a `comptime(val)`), so there is no runtime fill. The two forms below
// differ only in binding the comptime result to a runtime (`:=`) or comptime (`::`) name.
zeros := Array(i32, 10).fill(0);  // [0,0,0,0,0,0,0,0,0,0]

// Fill at compile-time
ones :: Array(i32, 5).fill(1);    // [1,1,1,1,1]
```

#### Array.len

Get the length of an array:

```rust
arr := [1, 2, 3, 4, 5];
len := arr.len();  // 5 (a runtime value; the length is in the TYPE, reachable
                   //    at compile time via Type.get_info([i32; 5]) -> .Array(_, n))

// Works with generic arrays
generic_len :: (fn(comptime(T) : Type, comptime(n) : usize, arr : [T; n]) -> usize)(arr.len());  // Returns n
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

### cond

```rust
use_cond :: (fn(x: i32) -> unit)(
  cond(
    (x == 1) => println("x is 1"),
    (x == 2) => println("x is 2"),
    true => println("x is not 1 or 2")
  )
);
```

> Note: The last condition must be compile-time known value `true` to act as the default case.

### if/else

`if(condition, then, else)`

`if` is sugar for `cond`: the compiler desugars every `if(...)` call to
`cond(condition => then, true => else)` at parse time, so downstream
passes (including the async state machine) see a real `cond` node. The
prelude still carries the equivalent macro definition as the
specification and as a fallback for dynamically constructed ASTs (see
`std/prelude.yo` and `plans/MACRO_POLICY.md`):

```rust
// Definition in prelude.yo (spec/fallback — normally desugared at parse time)
if :: (fn(
        quote(condition): Expr,
        quote(then): Expr,
        (quote(else): Expr) ?= quote(())
      ) -> unquote(Expr))(
  quote(
    cond(
      unquote(condition) => unquote(then),
      true => unquote(else)
    )
  )
);

// Usage
main :: (fn() -> unit)({
  // If no return type, it is unit
  number := 3;

  if(number < 5, then: {
    println("condition was true");
  }, else: {
    println("condition was false");
  });

  if(number < 5, println("condition was true"), println("condition was false"));
});
```

### while

`while(condition, body)` or
`while(condition, step, body)`

```rust
factorial :: (fn(n: i32) -> i32)({
  result := 1;
  i := 1;
  while(i <= n, {
    result = (result * i);
    i = (i + 1);
  });
  result
});

factorial2 :: (fn(n: i32) -> i32)({
  result := 1;
  i := 1;
  while((i <= n), (i = (i + 1)), {
    result = (result * i);
  });
  result
});
```

### Iterator and for loop

The `Iterator` trait defines a sequence of values. It has an associated type `Item` and a `next` method that returns `Option(Self.Item)`:

```rust
Iterator :: trait(
  Item : Type,
  next : (fn(inout(self) : Self) -> Option(Self.Item))
);
```

To implement `Iterator` for a type, provide the `Item` type and a `next` function:

```rust
Counter :: struct(_current : i32, _max : i32);

impl(Counter, Iterator(
  Item : i32,
  next : (self -> cond(
    (self._current >= self._max) => .None,
    true => {
      val := self._current;
      self._current = (self._current + i32(1));
      .Some(val)
    }
  ))
));
```

The `IntoIterator` trait converts a collection into an iterator. It has a `where` clause that constrains the `IntoIter` associated type to implement `Iterator` with the matching `Item` type:

```rust
IntoIterator :: trait(
  Item : Type,
  IntoIter : Type,
  into_iter : (fn(self : Self) -> Self.IntoIter),
  where(Self.IntoIter <: Iterator(Item := Self.Item))
);
```

The `for` macro provides syntactic sugar for iterating. It calls `.next()` in a loop and pattern-matches on `Option`:

```rust
// for loop syntax
for(iter_expr, (variable) => {
  // body
});
```

The `for` macro iterates **by value** — `for(coll, (x) => body)` lowers to `coll.into_iter()` followed by a standard `next()`-loop. For reference-semantics element types, `x` is a handle to the element, so mutating `x` in the body mutates the element in place. In-place mutation of struct/scalar elements uses an index loop with index writes:

```rust
// Value form — each `x` is yielded by value.
list := ArrayList(i32).new();
list.push(i32(10));
list.push(i32(20));
for(list, (value) => {
  println(value);
});

// Reference-semantics elements are handles — mutation lands in the collection.
for(names, (s) => {
  s.push_str("!");
});

// Struct/scalar elements: index writes mutate in place.
arr := Array(i32, 3)(1, 2, 3);
i := usize(0);
while(i < usize(3), {
  arr(i) = (arr(i) * i32(10));
  i = (i + usize(1));
});
// arr is now [10, 20, 30].
```

Combinator chains (`coll.into_iter().map(f)`, `.filter(p)`, `.fold(init, f)`, etc.) keep the value-yielding `Iterator` shape; a blanket `into_iter` impl `generic(I), where(I <: Iterator), I, into_iter : (fn(self) -> Self)` (identity) lets `for(combinator_chain, (x) => body)` work uniformly.

The old borrow form `for(coll, inout(x) => body)` was removed (interior refs into reallocatable storage are inexpressible — see [FLOWABILITY.md](./FLOWABILITY.md)); using it produces a compile error with the migration recipe.

Strings have explicit `chars()` (rune iteration), `char_indices()` (rune
iteration carrying each rune's byte offset) and `bytes()` (byte iteration).
String indexing itself is BYTE-based, like Rust and Go: `len()` is the byte
count at O(1), and every index a string method takes or returns is a byte
offset on a UTF-8 character boundary. The rune count is `s.chars().count()`.
See [STRINGS.md](./STRINGS.md) for the full contract.

## Algebraic Data Types (ADT)

ADT is basically another type of Record with a hidden field `tag` that indicates the variant type.

Therefore, when a value of a variant is decided, we can access the field of the value just like accessing the field of a record.

There is also some optimization on the ADT. For example, if the ADT has only one variant, the `tag` field will be omitted.

In addition, if there is only one variant with one field, the field type will be used directly instead of wrapping it in a record. This is like the [newtype](https://wiki.haskell.org/Newtype) in Haskell.

```rust
Option :: (fn(comptime(T) : Type) -> comptime(Type))
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

## Advanced Type System

### Higher-Kinded Types (HKT)

Yo supports higher-kinded types through **comptime function types as kinds**. Type constructors like `Option` and `Result` are already first-class comptime function values — HKT lets you abstract over them.

| Haskell Kind  | Yo Equivalent                                                  |
| ------------- | -------------------------------------------------------------- |
| `*`           | `Type`                                                         |
| `* -> *`      | `fn(comptime(T) : Type) -> comptime(Type)`                     |
| `* -> * -> *` | `fn(comptime(A) : Type, comptime(B) : Type) -> comptime(Type)` |

#### HKT generic parameters

Declare a generic parameter with a function-type kind to accept type constructors:

```rust
// F is a type constructor (kind: Type → Type)
identity :: (fn(
  generic(F : (fn(comptime(T) : Type) -> comptime(Type)), A : Type),
  x: F(A)
) -> F(A))(x);

// Usage:
(x : Option(i32)) = .Some(i32(42));
result := identity(generic(Option, i32), x);  // result: Option(i32)
```

#### HKT traits

Define traits parameterized by type constructors:

```rust
// Functor trait — F is a type constructor
Functor :: (fn(comptime(F) : (fn(comptime(T) : Type) -> comptime(Type))) -> comptime(Trait))(
  trait(
    map : (fn(generic(A : Type, B : Type), self: F(A), f: (fn(a : A) -> B)) -> F(B))
  )
);

// Implement Functor for Option
impl(generic(A : Type), Option(A), Functor(Option)(
  map : (fn(generic(A : Type, B : Type), self: Option(A), f: (fn(a : A) -> B)) -> Option(B))(
    match(self,
      .Some(v) => .Some(f(v)),
      .None => .None
    )
  )
));

// Use the trait method
(x : Option(i32)) = .Some(i32(42));
result := x.map(generic(i32), (fn(a: i32) -> i32)((a + i32(1))));
// result = .Some(i32(43))
```

#### Generic functions with HKT where clauses

```rust
do_map :: (fn(
  generic(F : (fn(comptime(T) : Type) -> comptime(Type)), A : Type, B : Type),
  container: F(A),
  f: (fn(a : A) -> B),
  where(F(A) <: Functor(F))
) -> F(B))(
  container.map(generic(B), f)
);

(x : Option(i32)) = .Some(i32(10));
result := do_map(generic(Option, i32, i32), x, (fn(a: i32) -> i32)((a * i32(2))));
// result = .Some(i32(20))
```

### Generalized Algebraic Data Types (GADTs)

GADTs extend enum types by allowing each constructor to specify the exact type parameter instantiation it returns, using `-> recur(Type1, ...)`:

```rust
Value :: (fn(comptime(T) : Type) -> comptime(Type))(
  enum(
    IntVal(i : i32) -> recur(i32),
    BoolVal(b : bool) -> recur(bool),
    PairVal(a : i32, b : bool) -> recur(i32)
  )
);
```

#### GADT match type refinement

When pattern matching on a GADT value, the type system refines type variables in each branch:

```rust
eval_value :: (fn(generic(T : Type), v : Value(T)) -> T)(
  match(v,
    .IntVal(i) => i,      // T refined to i32, returns i32 ✓
    .BoolVal(b) => b,     // T refined to bool, returns bool ✓
    .PairVal(a, b) => a   // T refined to i32, returns i32 ✓
  )
);

v := Value(i32).IntVal(i32(42));
result := eval_value(v);  // result : i32 = 42
```

#### GADT exhaustiveness

When matching a GADT value with a concrete type, unreachable variants are excluded from exhaustiveness checking:

```rust
// Value(i32) can only be IntVal or PairVal
// BoolVal is unreachable (it returns Value(bool), not Value(i32))
eval_int_only :: (fn(v : Value(i32)) -> i32)(
  match(v,
    .IntVal(i) => i,
    .PairVal(a, b) => a
    // No .BoolVal needed — it's unreachable for Value(i32)
  )
);
```

#### Multi-parameter GADTs

```rust
MyPair :: (fn(comptime(A) : Type, comptime(B) : Type) -> comptime(Type))(
  enum(
    MkIntBool(x : i32, y : bool) -> recur(i32, bool),
    MkBoolInt(x : bool, y : i32) -> recur(bool, i32)
  )
);

my_fst :: (fn(generic(A : Type, B : Type), p : MyPair(A, B)) -> A)(
  match(p,
    .MkIntBool(x, y) => x,
    .MkBoolInt(x, y) => x
  )
);
```

#### GADTs with custom discriminants

```rust
Tagged :: (fn(comptime(T) : Type) -> comptime(Type))(
  enum(
    (TagInt(i : i32) -> recur(i32)) = 10,
    (TagBool(b : bool) -> recur(bool)) = 20
  )
);
```

#### Mixed GADT and regular variants

```rust
MixedVal :: (fn(comptime(T) : Type) -> comptime(Type))(
  enum(
    MInt(i : i32) -> recur(i32),
    MBool(b : bool) -> recur(bool),
    MGeneric(v : T)  // no GADT annotation — unconstrained
  )
);
```

GADTs have the same runtime representation as regular enums — all type refinement is purely compile-time. For the full design document, see [GADTS.md](GADTS.md).

## C struct

```rust
Point :: struct(x: i32, y: i32);

my_point := Point(
  x: i32(10),
  y: i32(20)
);

```

Compiles to C

```c
struct Point {
  int x;
  int y;
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

```rust
newtype(
  // Only one field
  field_name : FieldType
);
```

**Example:** (see `std/string/rune.yo`):

```rust
rune :: newtype(
  char : u32
);
impl(rune,
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
  NUL        : Self(char : 0x00),
  TAB        : Self(char : 0x09),
  NEWLINE    : Self(char : 0x0A),
  SPACE      : Self(char : 0x20)
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
UserId :: newtype(value : i32);
// sizeof(UserId) == sizeof(i32)
// In C: just an i32, no struct wrapper at runtime
```

## C union

```rust
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

## C enum

It's the same as the ADT, but all variants have no fields.

```rust
State :: enum(
  Working,
  Failed
);
Week :: enum(
  Monday, // 0
  Tuesday, // 1
  Wednesday // 2
);

day := Week.Wednesday;
printf("%d", day); // 2
```

## Traits

Traits define collections of functions and types that can be implemented for types. They work similarly to traits in Rust. Note that `impl` takes the receiver type as the first argument, followed by the trait implementation.

A trait is defined as a function that returns a `Trait` type containing field definitions.

```rust
// Define a trait (like a trait in Rust)
Summary :: trait(
  summarize : (fn(inout(self) : Self) -> String)
);

Display :: trait(
  display : (fn(inout(self) : Self) -> String),
  where(Self <: Summary) // Constraint
);

NewsArticle :: struct(
  headline : String,
  location : String,
  author   : String,
  content  : String
);

// Implement the Summary trait for NewsArticle
impl(NewsArticle, Summary(
  summarize : ((self) ->
    `${self.headline}, by ${self.author} (${self.location})`
  )
));

// Implement the Display trait for NewsArticle
impl(NewsArticle, Display(
  display : ((self) ->
    `Headline: ${self.headline}\n`
  )
));

// Pass in function
notify :: (fn(inout(item) : NewsArticle) -> unit)({
  println(`Breaking news! ${item.summarize()}`);
});

// Generic function with trait constraint
notify2 :: (fn(generic(T : Type), inout(item) : T, where(T <: Display)) -> unit)({
  println(`Breaking news! ${item.summarize()}`);
  println(`Breaking news! ${item.display()}`);
});
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
value_in_cents :: (fn(coin: Coin) -> u8)(
  match(coin,
    .Penny => {
      printf("Lucky penny!\n");
      1
    },
    .Nickel => 5,
    .Dime => 10,
    .Quarter => 25
  )
);

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

### String literal as `str` or C string pointer

```rust
s := "Hello"; // s : str — a string literal is the builtin static string view `str`.
(s2 : *(u8)) = "Hi"; // You can explicitly declare a C string pointer (unsafe-capable files only).
s3 := *(u8)("Hi"); // Or use a pointer cast to get a C string pointer.
```

### String (Growable UTF-8 String)

Heap-allocated, growable UTF-8 string — the same shape as Rust's `String`. It is
NOT immutable: `push_str`, `push_string`, `push_byte`, `reserve` and `clear` take
`inout(self)` and mutate in place. Operators like `+` still produce a new string.

For an immutable, atomically reference-counted string that is safe to share across
threads, see `std/imm/string`, whose "modification" methods all return a new value.

```rust
s := String.new();
s2 := String.from("Hello World!");
s3 := (s + s2); // Create a new string.
```

#### Template string interpolation with `${}` syntax:

The template string works similarly to JavaScript's template literals, allowing you to embed expressions inside a string using `${}` syntax. The value inside `${}` must implement the `ToString` trait to be converted to a `String`.

```rust
name := "Alice";
age := 16;
greeting := `Hello, ${name}!, age: ${age}`;
// greeting: String
// value "Hello, Alice!, age: 16"
```

##### Format specifications — `${value:spec}`

An interpolation may carry a format spec after a colon, using Rust's and Python's
grammar (minus dynamic width/precision):

```text
spec  := [[fill]align][+][#][0][width][.precision][kind]
align := "<" | ">" | "^"
kind  := "x" | "X" | "b" | "o"
```

```rust
name := `ada`;
n := i32(255);
pi := f64(3.14159);

`[${name:>8}]`    // "[     ada]"   right-align to width 8
`[${name:<6}]`    // "[ada   ]"     left-align
`[${name:^7}]`    // "[  ada  ]"    center
`[${name:*>6}]`   // "[***ada]"     custom fill character
`${n:x}`          // "ff"           lowercase hex
`${n:#06x}`       // "0x00ff"       alternate form, zero-padded
`${pi:.2}`        // "3.14"         two decimals
`${pi:>8.3}`      // "   3.142"     width applies after precision
```

Width is counted in CHARACTERS, and zero padding on a number goes between the
sign or radix prefix and the digits (`${i32(-(42)):08}` is `-0000042`, not
`000-0042`).

Any value that implements `ToString` accepts the width, fill, alignment and
truncation parts; numbers additionally accept sign, radix and zero-fill.

The spec is separated from the expression by a colon with **no space before it**.
A spaced colon is left alone, so an ordinary colon pair inside an interpolation
keeps its meaning, and a colon inside a call's arguments or inside a string
literal — `${parts.join(":")}` — is never mistaken for a separator.

## Collections

Please check [std/collections](../std/collections) for the full list of collection types and their APIs.

Yo provides efficient, reference-counted collection types in the standard library.

### ArrayList

Dynamic array with automatic resizing.

```rust
{ ArrayList } :: import("std/collections/array_list");

// Create a new ArrayList
list := ArrayList(i32).new();

// Push elements
list.push(i32(42));
list.push(i32(100));
list.push(i32(200));

printf("Length: %zu\n", list.len());
printf("Capacity: %zu\n", list.capacity());

// Get elements by index
first := list.get(usize(0));
match(first,
  .Some(value) => printf("First element: %d\n", value),
  .None => printf("No first element\n")
);

// Set an element
list(usize(1)) = i32(150);

// Pop an element
popped := list.pop();
match(popped,
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

```rust
{ HashMap } :: import("std/collections/hash_map");

// Create a new HashMap
map := HashMap(i32, i32).new();

// Insert key-value pairs
result := map.insert(i32(1), i32(100));
match(result,
  .Ok(opt) => match(opt,
    .None => printf("Inserted new key\n"),
    .Some(old_val) => printf("Updated, old value: %d\n", old_val)
  ),
  .Error(_) => printf("Insert failed\n")
);

// Get a value
value_opt := map.get(i32(1));
match(value_opt,
  .Some(v) => printf("Value: %d\n", v),
  .None => printf("Key not found\n")
);

// Check if key exists
cond(
  (map.contains_key(i32(1))) => printf("Contains key 1\n"),
  true => printf("Does not contain key 1\n")
);

// Remove a key
removed := map.remove(i32(1));
match(removed,
  .Some(v) => printf("Removed value: %d\n", v),
  .None => printf("Key not found\n")
);

// Check length and empty
printf("Length: %zu\n", map.len());
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
{ HashSet } :: import("std/collections/hash_set");

// Create a new HashSet
set := HashSet(i32).new();

// Insert elements
result := set.insert(i32(42));
match(result,
  .Ok(was_new) => cond(
    was_new => printf("Inserted new element\n"),
    true => printf("Element already exists\n")
  ),
  .Error(_) => printf("Insert failed\n")
);

// Check if has
cond(
  (set.contains(i32(42))) => printf("Contains 42\n"),
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
match(union_result,
  .Ok(union_set) => printf("Union size: %zu\n", union_set.len()),
  .Error(_) => printf("Union failed\n")
);

// Intersection
inter_result := set1.intersection(set2);
match(inter_result,
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

### LinkedList

Doubly-linked list.

```rust
{ LinkedList } :: import("std/collections/linked_list");

// Create a new LinkedList
list := LinkedList(i32).new();

// Push to front and back
list.push_front(i32(1));
list.push_back(i32(2));
list.push_front(i32(0));

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
match(list.get(usize(0)),
  .Some(v) => printf("At index 0: %d\n", v),
  .None => printf("Index out of bounds\n")
);

// Insert at index
match(list.insert(usize(1), i32(20)),
  .Ok(_) => printf("Inserted at index 1\n"),
  .Error(err) => match(err,
    .IndexOutOfBounds => printf("Index out of bounds\n"),
    .EmptyList => printf("List is empty\n")
  )
);

// Remove at index
match(list.remove(usize(0)),
  .Ok(v) => printf("Removed: %d\n", v),
  .Error(err) => printf("Remove failed\n")
);

// Check if has
cond(
  (list.contains(i32(20))) => printf("Contains 20\n"),
  true => printf("Does not contain 20\n")
);

// Reverse the list
list.reverse();

// Clear
list.clear();
assert(list.is_empty(), "List should be empty");
```

## Closure

Yo supports closures (anonymous functions that capture their environment).

A closure compiles to a **capture struct** holding the variables it uses. How that struct is stored and called depends on the type it is given:

- **`Impl(Fn(...))` — static dispatch, not reference counted.** The compiler monomorphizes the closure into its own function, passes the capture struct **by value**, and emits a direct call. No heap allocation, no vtable, no reference count. Each closure has its own distinct type (see [Closure Type Restrictions](#closure-type-restrictions)), so this form cannot hold two different closures in one variable.
- **`Dyn(Fn(...))` — dynamic dispatch, reference counted.** The capture struct is boxed on the heap behind a reference-count header, and the value is a fat pointer of `{data, vtable}`. Use this when closures of different types must share one type — storing them in a collection, returning them from different branches, or accepting any callable. Write `dyn(...)` around the closure to coerce it.

In both cases the *captured values* follow the usual rules: a captured reference-semantics value is retained by the capture and released when the capture is dropped.

Please check [closure.test.yo](../tests/closure.test.yo) for closure examples and usage.

### Basic Closure Syntax

There are two ways to create closures:

1. **Using `Impl(Fn(...))`** - Explicit closure type:

```rust
test_closure :: (fn() -> unit)({
  x := 1;

  // Explicit closure type using Impl
  (closure : Impl(Fn(y : i32) -> i32)) = ((y) => {
    x = (x + y);
    return(x);
  });

  closure(1); // x is now 2
  closure(1); // x is now 3
  result := closure(2); // x is now 5

  assert(result == 5);
});
```

2. **Using `ClosureType({...})`** - Closure value from type:

```rust
test_closure :: (fn() -> unit)({
  x := 1;

  ClosureType :: Impl(Fn(y : i32) -> i32);
  closure := (ClosureType {
    x = (x + y);
    return(x);
  });

  result := closure(2);
  assert(result == 3);
});
```

### Closure Capture Semantics

Closures capture variables from their environment:

- **Value types** (primitives, structs) are captured by value (copied)
- **Reference-semantics types** (reference-counted) are captured by reference
- Captured variables maintain their mutability

```rust
test_capture :: (fn() -> unit)({
  // Value type - captured by value
  counter := 0;

  // Reference-semantics type - captured by reference
  data := Box(i32)(42);

  closure := ((increment : i32) => {
    counter = (counter + increment);  // Modifies local copy
    data.* = (data.* + increment);     // Modifies shared object
    return(counter);
  });

  closure(5);
  // counter is still 0 (closure has its own copy)
  // data.* is now 47 (shared reference)
});
```

### Closure Type Restrictions

Each closure has a unique type, even if they look identical:

```rust
// This will fail - each closure has a distinct type
test_error :: (fn() -> unit)({
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
});
```

### Closures with Reference-Semantics Types

Closures work seamlessly with reference-semantics types:

```rust
MyBox :: ref(struct(
  (*) : i32
));

make_incrementer :: (fn(start : MyBox) -> Impl(Fn() -> i32))({
  return((unit) => {
    start.* = (start.* + 1);
    return(start.*);
  });
});

test :: (fn() -> unit)({
  counter := MyBox(0);
  inc := make_incrementer(counter);

  assert(inc(()) == 1);
  assert(inc(()) == 2);
  assert(counter.* == 2);
});
```

For more examples, see [closure.test.yo](../tests/closure.test.yo).

## Box and Boxing

Yo provides `Box` and `box` for heap-allocating value types with automatic reference counting.

### Box Type

`Box(T)` is a generic reference-semantics type that wraps any value type:

```rust
// Box is defined in std/prelude.yo
Box :: (fn(comptime(V) : Type) -> comptime(Type))(
  ref(struct(
    (*) : V
  ))
);

// box function creates a Box
box :: (fn(generic(V : Type), value : V) -> Box(V))(
  Box(V)(value)
);
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
test("Box assignment behavior", {
  x := box(1);
  y := (x = box(2));  // y gets the old value

  assert(x.* == 2);   // x now points to new Box
  assert(y.* == 1);   // y has the old Box
});
```

### Box and Reference Counting

`Box(T)` is an reference-semantics type, so it uses automatic reference counting:

```rust
test("Box reference counting", {
  original := box(42);
  copy := original;        // RC increment
  another := copy;         // RC increment

  // All three point to the same Box
  assert(original.* == 42);
  original.* = 100;
  assert(copy.* == 100);   // Shared!
  assert(another.* == 100);

  // RC decrements when variables go out of scope
});
```

### When to Use Box

- **Heap allocation**: When you need a value type on the heap
- **Shared mutability**: Multiple references to the same mutable value
- **Dynamic dispatch**: Boxing value types for use with `Dyn`
- **Recursive types**: Breaking cycles in type definitions

```rust
// Dynamic dispatch requires reference-semantics types
impl(i32, SomeTrait(...));

// Value types must be boxed for Dyn
use_dyn :: (fn(value: Dyn(SomeTrait)) -> unit)({ ... };

// Box the i32 for use with Dyn
use_dyn(dyn box(42));
```

## Impl Types

`Impl(TraitName)` creates a type representing any type that implements the specified trait(s). This is similar to `impl Trait` in Rust.

### Basic Usage

```rust
// Define a trait
Id :: trait(
  id : (fn(self : Self) -> Self)
);

// Function accepting any type implementing Id
use_id :: (fn(
  generic(T : Type),
  value : T,
  where(T <: Id)
) -> T)({
  return(value.id());
});

// Implement Id for i32
impl(i32, Id(
  id : ((self) -> {
    printf("i32: %d\n", self);
    return(self);
  })
));

// Use it
result := use_id(42);  // Prints "i32: 42", returns 42
```

### Impl as Return Type

`Impl` can be used in return types for static dispatch:

```rust
RetI32 :: trait(
  return_i32 : (fn(inout(self) : Self) -> i32)
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
get_any :: (fn(use_bool : bool) -> Dyn(RetI32))({
  cond(
    use_bool => return(dyn(true)),
    true => return(dyn(i32(42)))
  );
});
```

**Important**: Each return path must return a concrete type, not different types that happen to implement the same trait.

### Impl with Multiple Traits

```rust
Speak :: trait(
  speak : (fn(self : Self) -> unit)
);

Run :: trait(
  run : (fn(self : Self) -> unit)
);

// Type must implement both Speak and Run
perform :: (fn(
  generic(T : Type),
  actor : T,
  where(T <: (Speak, Run))
) -> unit)({
  actor.speak();
  actor.run();
});
```

## Dynamic Dispatch

See [DYN_DESIGN.md](./DYN_DESIGN.md) for comprehensive documentation on dynamic dispatch with `Dyn` and `dyn`.

### `Dyn` and `dyn`

Use `Dyn` to define dynamic dispatch types that can hold any object implementing specified traits. Use the `dyn()` function to create a `Dyn` instance from an object.

`Dyn` types in Yo are reference-counted, like other reference-semantics types. They enable dynamic dispatch through trait objects. This applies to closures too: a `Dyn(Fn(...))` closure is heap-boxed and reference counted, whereas the `Impl(Fn(...))` form is monomorphized, passed by value and carries no reference count of its own.

**Key features:**

- Reference counted automatically
- No need for `&` operator - they are objects
- Automatic memory management
- Support multiple trait bounds

### Examples

```rust
Speak :: trait(
  speak: (fn(self : Self) -> i32)
);

Run :: trait(
  run: (fn(self : Self) -> i32)
);

// Must be a reference-semantics type to work with Dyn
Dog :: ref(struct());

DogSpeak :: impl(Dog, Speak(
  speak: ((self: Self) -> {
    printf("Woof!\n");
    return(1);
  })
));

DogRun :: impl(Dog, Run(
  run: ((self: Self) -> {
    printf("The dog is running!\n");
    return(2);
  })
));

// Dyn type is reference counted - no & needed
act :: (fn(s: Dyn(Speak, Run)) -> i32)((s.speak() + s.run()));

main :: (fn() -> i32)({
  dog := Dog();
  // dyn() creates a reference-counted trait object
  result := act(dyn(dog));
  return(result);
});
```

**Note:** `Dyn` types are internally reference-counted objects, providing automatic memory management without manual pointer handling.

## Impl vs Dyn

- **Impl**: Static dispatch, compile-time polymorphism, no runtime overhead
- **Dyn**: Dynamic dispatch, runtime polymorphism, requires reference-semantics types

```rust
// Impl - static dispatch (monomorphization)
use_impl :: (fn(generic(T), value: T, where(T <: SomeTrait)) -> unit)({
  value.method();  // Statically dispatched
});

// Dyn - dynamic dispatch (vtable)
use_dyn :: (fn(value: Dyn(SomeTrait)) -> unit)({
  value.method();  // Dynamically dispatched
});
```

For more examples, see [impl.test.yo](../tests/impl.test.yo).

## Algebraic Effects and Handlers

Yo supports **algebraic effects** — one-shot delimited continuations
for control flow. Handlers are values of a dedicated **control
function** type `ctl(args) -> ret` (parallel to `fn(args) -> ret`),
passed as regular function parameters at every call site.

1. **Control function type (`ctl`)**: A handler value has type
   `ctl(args) -> ret`. Its body may use `unwind(value)` to discard the
   continuation, or `return(value)` to resume it. Plain `fn(args) ->
ret` bodies cannot contain `unwind`.
2. **Effect parameters are explicit**: A function that needs an
   effect takes the handler as a regular parameter (`raise : Raise`).
   Callers pass the handler explicitly at every call site.

Effects compose with `async`/`await`: handlers inside `io.async`
tasks work correctly. If `unwind` is called inside an async task, the
Future is marked as escaped and awaiting it causes a panic.

See [ALGEBRAIC_EFFECTS.md](./ALGEBRAIC_EFFECTS.md) for comprehensive
documentation.

## Error Handling

Yo provides two approaches to error handling:

1. **Result ADT** — explicit `Result(T, E)` values with pattern matching
2. **Exception / ResumableException** — algebraic effects for exception-like control flow

### Result Type

The `Result` type is an algebraic data type for functions that can fail:

```rust
// Define an error type
DivisionError :: enum(
  DivideByZero,
  Overflow
);

// Function that can fail
safe_div :: (fn(a: i32, b: i32) -> Result(i32, DivisionError))(
  cond(
    (b == i32(0)) => .Error(.DivideByZero),
    true => .Ok((a / b))
  )
);

// Handle errors with pattern matching
result := safe_div(10, 2);
match(result,
  .Ok(value) => printf("Result: %d\n", value),
  .Error(error) => match(error,
    .DivideByZero => printf("Error: Cannot divide by zero\n"),
    .Overflow => printf("Error: Overflow\n")
  )
);
```

### Error Trait and AnyError

The standard library defines an `Error` trait and `AnyError` type for dynamic error handling:

```rust
open(import("std/error"));

// Error trait requires ToString. Custom error types implement both:
MathError :: enum(
  DivisionByZero,
  NegativeSqrt
);
impl(MathError, ToString(
  to_string : ((self) -> match(self,
    .DivisionByZero => `Division by zero`,
    .NegativeSqrt => `Square root of a negative number`
  ))
));
impl(MathError, Error());

// AnyError is Dyn(Error) — any type implementing Error can be wrapped:
(err : AnyError) = dyn(MathError.DivisionByZero);

// Downcast back to the concrete type:
match(downcast(err, MathError),
  .Some(math_err) => printf("Got MathError\n"),
  .None => printf("Not a MathError\n")
);
```

### Exception (Non-Resumable)

`Exception` is an effect bundle for non-resumable exception handling.
Its `throw` field is a `ctl(...) -> ret` handler — calling
`unwind(...)` inside its body discards the continuation and returns
from the enclosing function:

```rust
open(import("std/error"));

safe_divide :: (fn(x: i32, y: i32, exn : Exception) -> i32)(
  cond(
    (y == i32(0)) => exn.throw(dyn(MathError.DivisionByZero)),
    true => (x / y)
  )
);

// Install the handler — note the outer parens around the lambda
// (Yo has no operator precedence).
(exn : Exception) = Exception(
  throw : (
    (err) -> {
      println(`Error: ${err}`);  // prints "Error: Division by zero"
      unwind(());                // discard continuation, return from enclosing fn
    }
  )
);

result := safe_divide(6, 3, exn);     // result = 2
safe_divide(10, 0, exn);         // handler fires, unwinds — code after this is unreached
```

### ResumableException

`ResumableException(ResumeType)` is for resumable exception handling.
When the handler calls `return`, it resumes the continuation with a
recovery value:

```rust
open(import("std/error"));

safe_divide :: (fn(x: i32, y: i32, exn : ResumableException(i32)) -> i32)(
  cond(
    (y == i32(0)) => exn.throw(dyn(`division by zero`)),
    true => (x / y)
  )
);

(exn : ResumableException(i32)) = ResumableException(i32)(
  throw : (
    (err) -> {
      println(`Error: ${err}`);
      return(i32(0));  // resume with recovery value 0
    }
  )
);

result := safe_divide(6, 3, exn);    // result = 2
result2 := safe_divide(10, 0, exn);  // handler resumes with 0, result2 = 0
```

For more examples, see [error.test.yo](../tests/error.test.yo).

## Async/Await

Yo uses **async/await with state machine transformation** for efficient **single-threaded concurrency**. Async tasks are **lazy** — they don't start until explicitly awaited or joined.

```rust
{ yield } :: import("std/async");

main :: (fn(io : Io) -> unit)({
  task1 := io.async((io : Io)=> {
    io.await(yield(io), io);
    return(i32(1));
  });
  task2 := io.async((io : Io)=> {
    io.await(yield(io), io);
    return(i32(2));
  });
  handle1 := io.spawn(task1, io);  // start task1, returns JoinHandle(i32)
  handle2 := io.spawn(task2, io);  // start task2, returns JoinHandle(i32)
  r1 := handle1.await(io);  // wait → Option(i32)
  r2 := handle2.await(io);
});
export(main);
```

Key properties:

- `io.async(fn)` creates a **cold Future** — the body does NOT execute until awaited or spawned
- `io.await(future, e)` starts a cold future and runs it to completion; can be called **multiple times** on the same Future (`e` is the effect record — just `io` for pure-Io tasks)
- `io.spawn(future, e)` starts a cold future without waiting, returns `JoinHandle(T)`
- `handle.await(io)` waits for a spawned task, returns `Option(T)` — `.None` on unwind (abort)
- All async code runs on the **same thread** (no thread spawning, no data races)

See [ASYNC_AWAIT.md](./ASYNC_AWAIT.md) for comprehensive documentation.

## Parallelism

Please check [PARALLELISM.md](./PARALLELISM.md) for details on parallel programming in Yo.

## Isolated Types

Please check [ISOLATED.md](./ISOLATED.md) for details on isolated types in Yo.

## Arc Types

`Arc(T)` provides **shared ownership** with atomic reference counting. It is no longer
a compiler built-in; it is defined in `std/prelude.yo` as a thin
`atomic(ref(struct(...)))` wrapper. `Arc(T)` requires `T <: (Send, Acyclic)` — thread-shareable AND unable to form a reference cycle (atomic RC is not cycle-collected) — so it only wraps
thread-shareable values. Use `Arc(T)` when you want to share a single value.
Use `atomic(ref(struct(...)))` when defining your own shared types.

```rust
// Create with the arc() helper
shared := arc(i32(42));

// Dereference with .(*)  (borrowed, read-only)
val := shared.(*);          // val == 42

// Copying increments refcount
copy := shared;             // refcount: 1 → 2

// Cross-thread sharing
{ Thread } :: import("std/thread");
shared := arc(i32(42));
t := Thread.spawn((io) => {
  assert((shared.(*) == i32(42)), "thread sees shared value");
});
t.join();
assert((shared.(*) == i32(42)), "main still sees shared value");
```

See [ARC.md](./ARC.md) for full details.

## Module importing and exporting

```rust
// module1.yo
test :: (fn() -> unit)({
  println("Hello, world!");
});
export(test);

// module2.yo
// Export the type
Option :: (fn(comptime(T): Type) -> comptime(Type))(
  enum(
    Some(value : T),
    None
  )
);
export(Option);
```

```rust
open(import("./test.yo")); // Import everything from test.yo
test_module :: import("./test.yo"); // Import everything from test.yo and put it in the Test namespace
{ test } :: import("./test.yo"); // Import test function from test.yo
{ test : test2 } :: import("./test.yo"); // Import test function from test.yo and rename it to test2
{ Option } :: import("./test.yo"); // Import Option type from test.yo
```

### Anonymous module

The anonymous module is defined using `impl` keyword followed by a `begin` block:

```rust
my_module :: impl({
  my_function :: (fn() -> unit)({
    println("Hello from my_module!");
  });
  export(my_function);
});
```

### Module-level mutable variables

Yo supports mutable runtime variables at the top level of a module (file scope). These become C `static` file-scope variables, initialized before `main` runs.

Two syntaxes are supported:

```rust
// := initialization
counter := i32(0);

// Binding pattern initialization
(flag : bool) = false;
```

Functions defined in the same module can read and write these variables:

```rust
inc :: (fn() -> unit)({
  counter = (counter + i32(1));
});
```

**Restrictions:**

- Standalone type annotations without initialization are not allowed at module scope:
  ```rust
  a : i32;  // ❌ Error: use `a := i32(0);` or `(a : i32) = i32(0);` instead
  ```
- Mutable runtime variables (`:=` or `(x : T) = val`) are **not allowed inside `impl` blocks**. Use `::` for compile-time definitions:
  ```rust
  m :: impl {
    b := i32(13);  // ❌ Error: not allowed inside impl
    b :: 13;       // ✅ OK: compile-time constant
    export(b);
  };
  ```
- Module-level mutable variables **cannot be exported**. Only compile-time known values can be exported from modules.

## Naming Convention

2 spaces for indentation.

- `snake_case`
  - `file name`
  - `directory name`
  - `function`
  - `variable`
  - `module`
- `PascaleCase`
  - `trait`
  - `type` and its variants
- `UPPER_SNAKE_CASE`
  - `constant`

## Testing

Yo has a built-in testing framework accessible via the `test` keyword.

### Basic Test Syntax

```rust
test("Test description", {
  // Test code here
  x := 1 + 1;
  assert(x == 2);
});

// Io is implicitly available via `io` in all test bodies
test("With effects", {
  io.await(sleep(u64(1000)), io);
});
```

### Running Tests

Tests can be run using the Yo CLI:

```bash
# Run all tests in a file
$ yo test path/to/file.test.yo

# Run specific test by pattern
$ yo test path/to/file.test.yo --test-name-pattern "Test addition"

# Stop on first failure
$ yo test path/to/file.test.yo --bail

# Verbose output
$ yo test path/to/file.test.yo -v
```

### Assertions

#### Runtime Assertions

```rust
test("Runtime assertions", {
  x := 42;

  // Basic assertion
  assert(x == 42);

  // Assertion with message
  assert(x > 0, "x should be positive");

  // Complex assertions
  arr := [1, 2, 3];
  assert(arr.len() == 3, "Array should have 3 elements");
});
```

#### Compile-Time Assertions

Use `comptime_assert` for compile-time verification:

```rust
test("Compile-time assertions", {
  // These are checked during compilation
  comptime_assert((2 + 2) == 4);
  comptime_assert(Array(i32, 5).fill(0).len() == 5);
  comptime_assert(f32(3.14) > f32(3.0));

  // Type-level assertions
  T :: i32;
  comptime_assert(Type.to_comptime_string(T) == "i32");
});
```

### Testing Expected Errors

Verify that certain code produces compile-time errors:

```rust
test("Expected compile errors", {
  // Expect an error without specific message
  comptime_expect_error({
    x :: (1 / 0);  // Division by zero
  });

  // Expect an error with specific message
  comptime_expect_error(
    {
      arr : Array(i32, _);
      arr = [1, 2, 3];
    },
    "Cannot infer array length in binding"
  );

  // Test that certain patterns are invalid
  comptime_expect_error({
    closure1 := ((x) => (x + 1));
    closure2 := ((x) => (x + 1));
    // Each closure has unique type
    (c : typeof(closure1)) = closure2;  // Error!
  }, "no two closures have the same type");
});
```

### Test Organization

Organize related tests in the same file:

```rust
// arithmetic.test.yo

test("Addition", {
  assert((1 + 1) == 2);
  assert((5 + 3) == 8);
});

test("Subtraction", {
  assert((5 - 3) == 2);
  assert((10 - 10) == 0);
});

test("Multiplication", {
  assert((2 * 3) == 6);
  assert((7 * 0) == 0);
});

test("Division", {
  assert((10 / 2) == 5);
  assert((9 / 3) == 3);
});
```

### Testing with Reference-Semantics Types

Test cleanup and disposal:

```rust
MyBox :: ref(struct(
  (*) : i32
));
impl(MyBox, Dispose(
  dispose : (self -> {
    printf("Disposing MyBox with value: %d\n", self.*);
  })
));

test("Object disposal", {
  // Box is automatically disposed at end of scope
  b := MyBox(42);
  assert(b.* == 42);
  b.* = 100;
  assert(b.* == 100);
  // dispose() called automatically here
});
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
x := quote(2); // comptime(x) : Expr

list := quote((1, unquote(x), 3)); // tuple (1, 2, 3)

list2 = quote((1, x, 3)); // tuple (1, x, 3)

quote((0, unquote_splicing(list.get_args()), 4)); // tuple (0, 1, 2, 3, 4)
```

### Macro functions

Macro functions use `quote` and `unquote` for code generation. A macro is
an ordinary comptime function with one or both of two signature flags: a
`quote(name) : Expr` parameter (the caller's raw AST is bound without
being evaluated) and an `-> unquote(Expr)` return type (the returned AST
is spliced into the call site). See `std/prelude.yo` for real examples
like the `if` macro.

- `quote(...)` : Quote an expression
- `unquote(...)` : Unquote within a quoted expression
- `gensym(...)` : Generate unique symbol

`unquote` can only be used within `quote`.

**Defining a macro requires `pragma(Pragma.AllowMacroDef);`** at the top
of the file — like `Pragma.AllowUnsafe` for pointer ops, macro definition
is a per-file opt-in (macros are unhygienic and splice code into their
callers, so the ability to define them is gated; see
`plans/MACRO_POLICY.md`). *Calling* macros (`if`, `for`, collection
literals) never needs the pragma, and neither does working with quoted
`Expr` values in comptime functions (the mechanism `derive_rule` uses).

```rust
pragma(Pragma.AllowMacroDef);

// Custom macro example — a lazy-body `unless`
unless :: (fn(quote(condition): Expr, quote(do): Expr) -> unquote(Expr))(
  quote(
    cond(unquote(condition) => (), true => unquote(do))
  )
);
```

The prelude's `if` macro is the canonical example (current compilers
desugar `if(...)` calls to `cond(...)` at parse time, keeping this
definition as the spec/fallback):

```rust
if :: (fn(quote(condition): Expr,
        quote(then): Expr,
        (quote(else): Expr) ?= quote(())
      ) -> unquote(Expr))(
  quote(
    cond(
      unquote(condition) => unquote(then),
      true => unquote(else)
    )
  )
);

// Usage
if(true, {
  println("true");
});
```

> The std `try` macro was removed (it hid a caller-frame `return` and
> collided conceptually with algebraic effects). Match on the `Result`
> instead, or define an equivalent macro locally under
> `pragma(Pragma.AllowMacroDef);` —
> `tests/codegen-bootstrap/try_macro_assign.yo` keeps a working version.

## Derive Traits

Yo supports automatic trait derivation similar to Rust's `#[derive(...)]`, but using function-call syntax. The `derive` function generates `impl` blocks for common traits automatically based on a type's structure.

### Built-in derives

Six traits have built-in derive support: `Eq`, `Hash`, `Clone`, `Ord`, `Default`, and `ToString`. They work for both structs and enums:

```rust
Point :: struct(x : i32, y : i32);
derive(Point, Eq(Point), Hash, Clone, Ord(Point), ToString);

// Now Point supports ==, !=, hashing, cloning, comparison, and string conversion
main :: (fn() -> unit)({
  p1 := Point(1, 2);
  p2 := Point(1, 2);
  assert((p1 == p2), "equal");
  assert((p1.to_string() == `Point(1, 2)`), "to_string");
});
export(main);
```

### User-defined derive rules with `derive_rule`

Trait authors can register custom derive rules using `derive_rule`. A derive rule is **not a macro** — it is a regular comptime function returning `comptime(Expr)` that builds the `impl` block with `quote`/`unquote`; the `derive` builtin evaluates the returned Expr explicitly (so no `Pragma.AllowMacroDef` is needed):

```rust
MyEq :: (fn(comptime(Rhs) : Type) -> comptime(Trait))(
  trait(my_eq : (fn(self : Self, other : Rhs) -> bool))
);

my_derive_eq :: (fn(comptime(T) : Type, comptime(ctx) : DeriveContext, comptime(trait_params) : ComptimeList(Expr)) -> comptime(Expr))({
  eq_body :: Type.join_fields(
    T,
    (fn(comptime(field) : FieldInfo) -> comptime(Expr))(
      quote(self.(#(field.name.to_expr())).my_eq(other.(#(field.name.to_expr()))))
    ),
    quote(&&)
  );
  ctx.make_impl(quote(
    MyEq(...#(trait_params))(
      my_eq : ((self, other) -> #(eq_body))
    )
  ))
});
derive_rule(MyEq, my_derive_eq);

Point :: struct(x : i32, y : i32);
derive(Point, MyEq(Point));  // Uses the registered derive_rule
```

## Type Reflection

Yo provides compile-time type reflection through the `TypeInfo` enum and `Type.get_info()`. Unlike simple type tag systems, `TypeInfo` carries rich structural metadata — struct fields, enum variants, function parameters, and more.

```rust
info :: Type.get_info(i32);
comptime_assert(info.is_primitive(), "i32 is primitive");
comptime_assert(info.is_integer(), "i32 is an integer");

info2 :: Type.get_info(Point);
comptime_assert(info2.is_struct(), "Point is a struct");
```

Compound variants carry metadata that can be extracted via `match`:

```rust
// Extract array element type and length
arr_info :: Type.get_info([i32; 3]);
elem :: match(arr_info, .Array(e, _) => e, _ => unit);
len :: match(arr_info, .Array(_, l) => l, _ => 0);
comptime_assert((len == 3), "array length is 3");

// Inspect struct fields
pt_info :: Type.get_info(Point);
field_count :: match(pt_info, .Struct(f, _) => f.len(), _ => usize(0));
comptime_assert((field_count == usize(2)), "Point has 2 fields");

// Match dispatch on type info
describe :: (fn(comptime(T) : Type) -> comptime(comptime_str))(
  match(Type.get_info(T),
    .I32 => "32-bit signed integer",
    .Struct(_, _) => "struct type",
    .Enum(_) => "enum type",
    _ => "other type"
  )
);
```

Guard methods on `TypeInfo`:

- **Structural**: `is_struct()`, `is_enum()`, `is_union()`, `is_tuple()`, `is_array()`, `is_str()`, `is_function()`, `is_pointer()`, `is_trait()`, `is_void()`
- **Numeric**: `is_primitive()`, `is_integer()`, `is_float()`, `is_numeric()`, `is_comptime()`

For the full TypeInfo enum definition, metadata structs, and detailed usage, see [TYPE_REFLECTION.md](./TYPE_REFLECTION.md).

## Compile-Time Evaluation

Yo has powerful compile-time evaluation capabilities. You can perform computations, type manipulations, and code generation at compile time.

### Compile-Time Variables

Variables declared with `::` are compile-time constants:

```rust
// Compile-time integer
x :: 42;                    // comptime_int
y :: (x + 10);              // comptime_int = 52

// Compile-time type
MyInt :: i32;               // comptime(Type)
value := MyInt(100);        // Runtime i32

// Compile-time computation
factorial :: (fn(comptime(n) : comptime_int) -> comptime(comptime_int))(
  cond(
    (n <= 1) => 1,
    true => (n * recur(n - 1))
  )
);
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
create_array :: (fn(comptime(T) : Type, comptime(n) : usize, value : T) -> [T; n])(Array(T, n).fill(value));

int_array :: create_array(i32, 5, 42);  // [42,42,42,42,42]
```

### Compile-Time Assertions

Use `comptime_assert` to verify compile-time conditions:

```rust
test("Compile-time assertions", {
  // These are checked at compile time
  comptime_assert((2 + 2) == 4);
  comptime_assert(f32(100.5) > f32(50.0));
  comptime_assert(Array(i32, 5).fill(0).len() == 5);

  // Compile-time type checks
  T :: i32;
  comptime_assert(Type.to_comptime_string(T) == "i32");
});
```

### Compile-Time Expected Errors

Test that code produces compile-time errors:

```rust
test("Expected compile errors", {
  // Verify that this code produces an error
  comptime_expect_error(
    x :: (1 / 0),  // Division by zero
    "Division by zero"
  );

  comptime_expect_error({
    arr : Array(i32, _);  // Cannot infer length in binding
    arr = [1, 2, 3];
  });
});
```

### Compile-Time vs Runtime

Understanding when things happen:

```rust
// Compile-time: declared with :: or comptime(...)
COMPT_VALUE :: 42;                // Computed at compile time
ComptimeType :: i32;                 // Type selected at compile time

// Runtime: declared with :=
runtime_value := 42;              // Computed at runtime
runtime_type := i32(100);         // Value created at runtime

// Mixed: compile-time type, runtime value
(x : i32) = 42;                   // Type known at compile time
                                  // Value computed at runtime

// Compile-time function parameter
array_fn :: (fn(comptime(n) : usize) -> Array(i32, n))
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

For more examples, see [comptime.test.yo](../tests/comptime.test.yo).

## Inline Assembly

Yo provides `asm()` and `global_asm()` builtins for embedding inline assembly, inspired by Rust's `asm!` macro. Features include:

- **Operand types**: `in`, `out`, `inout`, `lateout`, `inlateout`, `const_val`, `sym`
- **Register constraints**: `reg`, `imm`, `mem`, explicit register names (e.g., `"rax"`)
- **Named operands**: `out("result", reg, i32)` with template references `{result}`
- **Variable-target outputs**: `out(reg, x)` writes directly to a variable, including uninitialized ones
- **Clobbers and options**: `clobber("memory")`, `asm_options(volatile, noreturn)`
- **Multi-architecture**: x86_64 and aarch64 support

```rust
// Simple example: move immediate to register
result := asm(
  "mov {0}, #42",
  out(reg, i32)
);

// Uninitialized variable output
x : i32;
asm("mov {0}, #42", out(reg, x));
```

For the full design, syntax reference, and C codegen details, see [INLINE_ASSEMBLY.md](../INLINE_ASSEMBLY.md).

## Index Trait

Yo provides a unified `Index` trait for custom indexing on any type. Types that implement `Index(Idx)` can use function-call syntax `value(index)` for element access, pointer access via `&(value(index))`, and mutation via the call-syntax assignment `value(index) = new_value`.

The standard library implements `Index` for its collection types, including `ArrayList`, `HashMap`, `BTreeMap`, `Deque`, `LinkedList` and `String`. Fixed-size arrays and `str` use built-in indexing with the same syntax; `..` and `..=` ranges on collections produce owned copies (`slice_copy`), while ranges on `str` are zero-copy static windows.

For the full design, trait definition, and implementation details, see [INDEX_TRAIT.md](./INDEX_TRAIT.md).

## In Design

Please check [IN_DESIGN.md](../../plans/backlog/IN_DESIGN.md) for features that are still in design phase.

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
- [Generalized Evidence Passing for Effect Handlers](https://www.microsoft.com/en-us/research/uploads/prod/2021/03/multip-tr-v4.pdf)
- [Structured Asynchrony with Algebraic Effects](https://www.microsoft.com/en-us/research/wp-content/uploads/2017/05/asynceffects-msr-tr-2017-21.pdf)
- [Effects as Capabilities: Effect Handlers and Lightweight Effect Polymorphism](https://dl.acm.org/doi/pdf/10.1145/3428194)
- [A Typed Continuation-Passing Translation for Lexical Effect Handlers](https://se.cs.uni-tuebingen.de/publications/schuster22typed.pdf)
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
