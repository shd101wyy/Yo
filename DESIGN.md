# Language Design

**Mo** 墨 🐼 is minimal, general-purpose, compiled programming language that incorporates the Linear Types, 2nd-Class References (Mutable Value Semantics), and Algebraic Effects (one-shot, lexical scoped).

**Mo** aims to be a simple to learn programming language. If you are familiar with TypeScript, you should be able to pick up **Mo** in 1 hour 😉.

**Mo** has a minimal syntax design that looks like TypeScript, and uses uniform call syntax (dot notation)~~, brace elison~~ to make the code more concise.

**Mo** is strong typed with a robust bidrectional type checker. **Mo** supports `interface` that works like typeclass/trait, combined with Algebraic Effects (one-shot, lexical scoped) and an efficient type system.

**Mo** (will &) tend to support advanced type system features such as generalized algebraic data types (GADT), dependent types, refinement types. `In Design`

**Mo** has no garbage collector. **Mo** utilizes the Linear type and Mutable Value Semantics to achieve memory safety.

Our goal is to be a practical language that is easy to use and easy to learn.

We will also post a series of articles on the design and implementation of **Mo**. Stay tuned!

<!-- @import "[TOC]" {cmd="toc" depthFrom=1 depthTo=6 orderedList=false} -->

<!-- code_chunk_output -->

- [Language Design](#language-design)
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
    - [Pointer `In Design`](#pointer-in-design)
    - [Cast Linear to Free](#cast-linear-to-free)
  - [Function Declaration](#function-declaration)
    - [Contextual parameters, aka implicit parameters](#contextual-parameters-aka-implicit-parameters)
      - [Compiletime](#compiletime)
      - [Runtime](#runtime)
    - [Uniform Function Call Syntax](#uniform-function-call-syntax)
    - [Dependent types `In Design`](#dependent-types-in-design)
    - [Refinement types `In Design`](#refinement-types-in-design)
    - [`defer`](#defer)
    - [`recur`](#recur)
    - [Custom Operators](#custom-operators)
    - [Mulitple Return Values `In Design`](#mulitple-return-values-in-design)
  - [Duck Typing `In Design`](#duck-typing-in-design)
  - [Closure `In Design`](#closure-in-design)
  - [Mutability `To be updated`](#mutability-to-be-updated)
  - [Generic](#generic)
    - [Type parameters](#type-parameters)
    - [Type constraints](#type-constraints)
  - [2nd-Class Reference](#2nd-class-reference)
  - [Control Flow](#control-flow)
  - [Type synonyms](#type-synonyms)
  - [Enum (Algebraic Data Types)](#enum-algebraic-data-types)
    - [Generalized Algebraic Data Types (GADTs) `In Design`](#generalized-algebraic-data-types-gadts-in-design)
    - [Explicit enum variant type](#explicit-enum-variant-type)
  - [`interface` (type class/trait)](#interface-type-classtrait)
  - [Pattern Matching](#pattern-matching)
    - [Using Range in `case`](#using-range-in-case)
  - [Collections](#collections)
    - [Array](#array)
    - [String](#string)
    - [Map](#map)
  - [Slice](#slice)
  - [Error handling](#error-handling)
  - [Type casting](#type-casting)
  - [Modules](#modules)
  - [Compile time execution `In Design`](#compile-time-execution-in-design)
  - [Compilation `In Design`](#compilation-in-design)
  - [Meta-programming `In Design`](#meta-programming-in-design)
  - [References](#references)

<!-- /code_chunk_output -->

## Philosophy

A little bit safer "C", with zero-cost abstraction, and a little bit of functional programming.  
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
let main = () => {
  println("Hello World!");
};
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

# Run scripts
mo run test
```

## Types

A type can have the following **Kind**:

- Type
  - Free
  - Linear
- ~~Region~~ `Removed now`
- Interface

### Type

#### `Free` Types

- `boolean`
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
- `char` (Unicode character, 4 bytes)
- `string` (UTF-8 string, immutable)
- `usize` (pointer size. It's `u32` on 32-bit system, `u64` on 64-bit system)
- `symbol` (unique global string, `const char*` in C)
- `()` (unit)

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

let example = (x: i32, y: i32) => {
  x = 1; // Error: x is immutable
  y = 2; // Error: y is immutable
};
```

### Type inference

```typescript
let mySymbol = "Hi"; // symbol. Free type

let myString: String = String.from("Hello, world"); // Stored on heap. Linear type.
let myString2 = myString; // myString2: String. Linear type. myString is moved and consumed. myString2 now takes the ownership.
let myString3 = myString; // Error: myString is already consumed.
let myString4: &String = &myString2; // myString4: &String. Free type
let myString5 = myString4; // myString5: &String. Free type

let myInt = 1; // Stored on stack. Free type
let myInt2 = myInt; // myInt2: i32, Free type
let myInt3: &i32 = &myInt; // myInt3: &i32. Free type
let myInt4 = myInt3; // myInt4: &i32. Free type

let myIntSlice: int[] = [1, 2, 3]; // Stored on stack, with size 3. Free type
let myIntSlice: int[100] = [1, 2, 3]; // Stored on stack, with size 100. Free type
let myArray: Array<int> = Array.from([1, 2, 3]); // Stored on heap. Linear type.

let mySet: Set<int> = Set.from([1, 2, 3]); // Stored on heap. Linear type.
let myMap: Map<string, int> = Map.from([
  ["one", 1],
  ["two", 2],
]); // Stored on heap. Linear type.

enum Person { // Linear type, as it contains a linear type.
  Person(name: String, age: i32)
}
let p = Person(String.from("Alice"), 30); // p: Person. Linear type.
```

#### Uninitialized variable `In Design`

IDEA: Uninitialized variable is only available for **Free** type.

```typescript
var x?: i32; // x: i32, uninitialized

x = 1; // x: i32, initialized

let y?: i32; // y: i32, uninitialized

y = 1; // y: i32, initialized
y = 2; // Compiler Error: y is already initialized
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
// Immutable reference, using `&`
{
  let i = malloc(); // i: Data
  let ref = &i; // ref: &Data
}

// Mutable reference, using `@`
{
  var i = malloc(); // i: Data
  let ref = @i; // ref: @Data
}
```

```typescript
{
  var x = 1; // x: copied i32. Free type
  let r: &i32 = &x; // r: &i32. Free type
  let p: @i32 = @x; // p: @i32. Free type.
  *p = 2;
  // x == 2
  // *r == 2
  // *p == 2
}
```

A longer example:

```typescript
extern "C" {
  length: (x: &String)=> i32;
  push: (x: @String, value: String)=> ();
  drop: (x: String)=> ();
}

let main = ()=> {
  var x = String.from("Hello, world"); // x: String. mutable
  let y = @x; // y: @String   // mutable reference
  let z = &x; // z: &String   // immutable reference

  length(x); // allowed
  length(y); // allowed
  length(z); // allowed

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
let name = String.from("Alice");
let p = Person.Person(name, 30); // p: Person. Linear type.

{
  let name = p.name; // name: String, Linear type. The `p` variable is consumed
                       // when you extract a linear field from it.
                       // NOTE: If `p` has more than one linear field, then when you destructure, you have to consume all the linear fields, otherwise it will be a compiler error.

  let age = p.age; // Compiler Error: `p` is consumed already.
}

{
  let {name, var age} = p;
}

{
  var {name, age} = p;
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
  let name: &String = &p.name; // name: &String. Free type.
  let age = &p.age; // age: &i32. Free type.
}
{
  let pRef = &p; // pRef: &Person. Free type.
  let name = &pRef.name; // name: &String. Free type.
  let age = &pRef.age; // age: &i32. Free type.
}
```

```typescript
let name = String.from("Alice");
let p = Person.Person(name, 30); // p: Person. Linear type.

let { name, age } = p; // p is consumed.

p = Person.Person(name, 30); // This is allowed. We restored a consumed value.
```

```typescript
var x = [1, 2, 3, 4, 5]; // x: i32[5]. Free type
var y = x; // y: i32[5]. Free type. x is copied to y, not moved.

{
  let ref = &x; // ref: &i32[5]. Free type
  let first = ref[0]; // i32. Free type
}
{
  let firstRef = @x[0]; // @i32. Free type
  firstRef = 10;
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
  let s = @x[1]; // s: @String. Free type
  let old = (s = String.from("Earth"));
  // old: String. Linear type. old == String.from("World")
}

// x: [String.from("Hi"), String.from("Earth")]
```

### Pointer `In Design`

We use the `^` to denote the pointer, same as in Pascal.

```typescript
type IntPtr = ^i32;

let x = 1;
let xRef = &x as ^i32
```

### Cast Linear to Free

NOTE: This is unsafe and should be avoided.

```typescript
let x = String.from("Hi"); // x: String. Linear type
let y = castToFree(x); // y: String. Free type
```

## Function Declaration

Unlike imperative languages, **Mo** has no `return` keyword. The last expression of a function is the return value.

```typescript
// Top level function.
// Type after `=>` is the return type. If it's not specified, it's `()` unit.
let add = (x: i32, y: i32)=> i32 {
  x + y
}

// Or abbreviated form: `Not adopted yet`
let add(x: i32, y: i32)=> i32 {
  x + y
}

// Default parameter values
let add = (x: i32 = 1, y: i32 = 2)=> i32 {
  x + y
}

// Generic function
let identity = <T>(arg: T)=> T {
  arg
}

// Dependency injection (Effectful function)
let main = (?raise: (error: symbol)=> i32)=> () {
  let x: i32 = raise("Hello, world");
}

// Value constraint `In Design`
let divide = (x: i32, y: i32)=> i32
where y != 0 {
  x / y
}

// Type constraint
let add = <T: Type, using Integral<T>>(x: T, y: T)=> T {
  println(x + y)
}

// Closure
let add = [{y: 0}](x: i32)=> i32 {
  y = x + y
};
add(1); // {y: 1}
add(1); // {y: 2}

// Curried function `In Design`
let add = (x: i32)=> (y: i32)=> i32 {
  x + y
}
let addOne = add(1);
addOne(2); // 3
```

### Contextual parameters, aka implicit parameters

The contextual parameters are passed implicitly to the function.  
**Mo** looks for the closest value that matches the contextual parameter by the **type** and **name**.

#### Compiletime

```typescript
// id.mo
export class Id<T> {
  id: (x: T)=> T;
};

// main.mo
import {Id, id} from "./id.mo";
let useId = <T, using Id<T>>(x: T)=> T {
  id(x)
}
```

#### Runtime

```typescript
let add = (x: i32, ?y: i32)=> i32 {
  x + y
}

let main = ()=> {
  {
    add(3); // error: missing implicit parameter y
  }
  {
    let ?y = 4;
    add(3); // ok, 7
  }
  {
    let ?z = 4;
    add(3); // error: missing implicit parameter y
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
let test = (x: i32, ?id: (x: i32)=> i32) {
  print(id(x))
}

let ?id = (x: i32)=> x;
let useTest = ()=> {
  test(3); // print 3

  let ?id = (x: i32)=> x + 1;
  test(3); // print 4
}

let main = ()=> {
  let ?id = (x: i32)=> x + 2; // This will not affect the `test` function calls in `useTest`
  useTest();  // print 3
              // print 4
}
```

### Uniform Function Call Syntax

```typescript
let addOne = (x: i32)=> i32 {
  x + 1;
}

(12).addOne(); // 13
// is equalvalent to
addOne(12); // 13

let s = String.from("Hello, world");
(&s).length(); // 12
// is equalvalent to
length(&s); // 12
```

### Dependent types `In Design`

Dependent types are types which depend on values.

```typescript
let dependOnBoolean = (b: boolean)=> i32
where b == true
{
  1
}
let dependOnBoolean = (b: boolean)=> f32
where b == false
{
  1.0
}

dependOnBoolean(true); // 1
dependOnBoolean(false); // 1.0
dependOnBoolean(returnBoolean()); // Compiler Error: value constraint not satisfied for both `dependOnBoolean` functions
```

```typescript
let divide = (x: i32, y: i32)=> i32
where y != 0
{
  x / y
}

let main = ()=> {
  let x = readInt();
  let y = readInt();
  if y != 0 {
    divide(x, y);
  } else {
    divide(x, y); // Compiler Error: y is not equal to 0
  }
}
```

### Refinement types `In Design`

Refinement types consists of all values of a given type which satisfy a given predicate.

```typescript
let makeArray = (size: i32)=> Array<i32>
where size < 10 && size > 0 {
  return Array<i32>.new(size)
}

let main = ()=> {
  let size = readInt()
  if (size < 10 && size > 0) {
    let arr = makeArray(size) // The function is guaranteed to return an array of size between 1 and 9
  } else {
    makeArray(size) // Compiler Error: size is not between 1 and 9
  }
}
```

```typescript
let inBetween = (x: i32, min: i32, max: i32)=> boolean
where min < max && x >= min
{
  true
}
let main = ()=> {
  let x = readInt();
  let min = readInt();
  let max = readInt();
  if min < max && x >= min {
    inBetween(x, min, max);
  } else {
    inBetween(x, min, max); // Compiler Error: Predicate not satisfied.
  }
}
```

### `defer`

`defer` will execute an expression at the end of the current scope.

```typescript
let test = ()=> {
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
let deferExample = ()=> {
  var a = 1;

  {
    defer a = 2;
    a = 1;
  }

  println(a); // 2
  a
}
```

### `recur`

Use the `recur` to call the function recursively.  
This is useful for anonymous function.  
If `recur` is the last expression, tail-call optimization will be applied.

- With tail-call optimization

  ```typescript
  (x: u32, acc: u32 = 1) => {
    if (x == 1) {
      1;
    } else {
      recur(x - 1, acc * x);
    }
  };
  ```

- Without tail-call optimization

  ```typescript
  (x: u32) => {
    if (x == 1) {
      1;
    } else {
      x * recur(x - 1);
    }
  };
  ```

### Custom Operators

```typescript
let (|>) = <T, U>(x: T, f: (value: T)=> U)=> U {
  f(x)
}

12 |> addOne; // 13

(|>)(12, addOne); // 13
```

We can define its precedence and associativity:

```typescript
infix  40 ==  // no associativity. Eg, 3==4==5 is invalid
infixr 80 **  // right associativity. Eg, 3 ** 4 ** 6 == 3 ** (4 ** 6)
infixl 60 +   // left associativity. Eg, 3 + 4 + 6 == (3 + 4) + 6
```

### Mulitple Return Values `In Design`

REASON: Necessary for returning multiple references.

```typescript
let vals = ()=> (i32, i32) {
  1, 2
}

let main = ()=> {
  let a, b = vals();
}
```

## Duck Typing `In Design`

```typescript
// This function can take any type that has a `length: i32` property.
let printLength = (x: &{ length: i32 })=> {
  println(x.length);
};

let main = ()=> {
  let s = String.from("Hello, world");
  printLength(&s);
  // ^ This works as the compiler converts it to below from the background:
  printLength(&{ length: s.length })
}
```

## Closure `In Design`

The closure in **Mo** is a function that can capture ~~Linear~~ values from the outer scope.  
**Mo** only supports **explicit captures** in closures.
**Mo** **doesn't** support references in captured values.

The closure type is defined as:

```
[=]<type parameters>(parameters)=> return_type { body }
```

A closure can be defined using the following syntax:

```
[{captures}]<type parameters>(paramters)=> return_type { body }
```

Examples:

- **&/@ closure** of Free type

  ```typescript
  let test = ()=> {
    var x = 1;

    let increment: [@](a: i32)=> () = [{x: @x}](a: i32)=> {
      // let {x} = increment;
      *x = *x + a;
    }
    increment(1);
    increment(2);
    {
      let x = *increment.x;
      println(x); // 4
    }
  }
  ```

  **NOTE:** The example above will not actually compile because according to the rule of 2nd-class reference, the closure `increment` contains the reference so it cannot be saved to a local variable.

- **own closure** `call` that takes ownership

  ```typescript
  let test = ()=> {
    var x: Data = malloc();

    // var increment = {x: x};
    var increment: Closure<()=>(), {x: Data}> = [{x: x}]()=> {
      // let {x} = increment;
      drop(x);
    }
    // Generate: call(closure: ()=> ());
    increment(); //
    increment(); // Compiler Error: closure is already consumed.
  }
  ```

**NOTE:** We can pass normal function ()=>() to a function argument that expects a closure, but not the other way around.

## Mutability `To be updated`

The builtin `=` function is used to update a value that can be `write`, with the following signature:

```typescript
let set! = <T: Type>(ref: @T, value: T)=> T;

// `=` is a syntactic sugar for `set!`

x = x + 1
// is equalvalent to
set!(@x, x + 1)
// so we append `write` to the variable on the left hand side of `=`
```

Below is an example of updating a field of a linear type:

```typescript
enum Person { // Linear type.
  Person(name: String, age: i32)
}
var p = Person.Person(String.from("Alice"), 30); // p: Person. Linear type.

// Update the field
let oldName = (p.name = String.from("Bob"));
// oldName is the `value` moved out.
// oldName == String.from("Alice")
```

## Generic

### Type parameters

Type parameters are defined inside `<...>`

```typescript
let id = <T: Type>(x: T)=> T {
  x
}

// or
let id = <T>(x: T)=> T { // T will be inferred as `Type` kind
  x
}
```

### Type constraints

Type constraints are achieved using the implicit parameters.

```typescript
// show.mo
export class Show<T> {
  show: (x: T)=> string;
}

implements Show<i32> {
  show: (x: i32)=> {
    // ...
  }
}

implements Show<string> {
  show: (x: string)=> {
    // ...
  }
}

// main.mo
import { show, Show } from "./show.mo";
export let show = <T, using Show<T>>(x: Array<T>)=> string {
  // ...
}

import { show, Show } from "./show.mo";
let lessThan = <T: Type,
  using Ord<T>, Show<T>>(x: T, y: T)=> boolean {
  println(show(x));
  x < y
}
```

## 2nd-Class Reference

> Mutable value semantics is a programming discipline that upholds the independence of values to support local
> reasoning. In the discipline’s strictest form, references become second-class citizens: they are only created implicitly, at function
> boundaries, and cannot be stored in variables or object fields. Hence, variables can never share mutable state. Unlike pure
> functional programming, however, mutable value semantics allows part-wise in-place mutation, thereby eliminating the memory
> traffic usually associated with functional updates of immutable data.

> MVS does not
> surface references as a first-class concept in the programming
> model. As such, they can neither be assigned to a variable nor
> stored in object fields, and all values form disjoint topological
> trees rooted in the program’s variables

The references in **Mo** are second-class citizens.

However, unlike the [hylo language](https://www.hylo-lang.org/), we allow to define them in types. We only disable to bind them to a local variable defined in either `let` or `var` statements, but we can pass them in function arguments.

We also disable to return a reference to a local value from a function.

For example, the types below are allowed:

```typescript
type CustomType = {
  x: &i32;
}

enum CustomEnum {
  Some(value: &i32);
}

type CustomSlice = (&i32)[];

let swap = (x: @i32, y: @i32)=> {
  let temp = x;
  x = y;
  y = temp;
}
```

But the following is not allowed:

```typescript
let test = ()=> {
  var x = 1;
  let y = @x; // Compiler Error: write reference is not allowed in a local variable.
}
```

## Control Flow

```typescript
let main = ()=> {
  // If no return type, it is () unit
  let number = 3;

  if (number < 5) {
    println("condition was true");
  } else {
    println("condition was false");
  }
};
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

type string = char[];

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
type Lang<l> = { language: string | l}; // Intersection types
type Language = Lang<(year: i32)>;
// Language is equal to
type Language = { language: string; year: i32 };
*/
type Lang<l> = { language: string } & l; // Intersection types
type Language = Lang<{ year: i32 }>;
// Language is equal to
type Language = { language: string; year: i32 };
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

let none: Option<i32> = None;
let some: Option<i32> = Some(42);

// Access the field:
some.value;
let {value} = some;

enum IpAddr {
  V4(v0: u8 = 255, v1: u8 = 255, v2: u8 = 255, v3: u8 = 255),
  V6(v: String)
}


let home = V4(127, 0, 0, 1);
let anotherHome = V4(v3 = 200);
let loopback = V6(String.from("::1"))
```

### Generalized Algebraic Data Types (GADTs) `In Design`

```typescript
enum Expr<T> {
  IntExpr(i: i32): Expr<i32>,
  BoolExpr(b: boolean): Expr<boolean>,
  EqExpr(left: Expr<i32>, right: Expr<i32>): Expr<boolean>
}

let eval = <T>(expr: Expr<T>)=> T {
  // with Expr<T>;
  if (expr is IntExpr(i)) {
    i
  } else if (expr is BoolExpr(b)) {
    b
  } else if (expr is EqExpr(left, right)) {
    eval(left) == eval(right)
  }
}

let expr1 : Expr<boolean> = EqExpr(IntExpr(1), IntExpr(2));
eval(expr1); // false
```

### Explicit enum variant type

```typescript
let x: Option = Some(1); // x: Option<i32>.Some
                           // .Some means the variant type is Some

let unwrap = <T>(x: Option<T>)=> T
where x is Option<T>.Some
{
  x.value
}
unwrap(x); // 1
unwrap(None); // Won't compile. None is not a Some variant.
```

## `interface` (type class/trait)

```typescript
class Summary<T, using Eq<T>> {
  summarize: (self: T)=> String;
};

class Display<T, using Summary<T>> = {
  display: (self: T)=> String;
};

type NewsArticle = {
  headline: String;
  location: String;
  author: String;
  content: String;
};

implements Summary<NewsArticle> {
  summarize: (self: NewsArticle)=> String {
    "${self.headline}, by ${self.author} (${self.location})"
  }
}

// Pass in function
let notify = (item: NewsArticle)=> () {
  println("Breaking news! ", summarize(item));
}

let notify = <T, using Display<T>>(
  item: T
)=> () {
  println("Breaking news! ", summarize(item));
  println("Breaking news! ", display(item));
}
```

## Pattern Matching

Pattern matching using `is` keyword.  
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
let valueInCents = (coin: Coin)=> u8 {
  match (coin) {
    case Penny: {
      println("Lucky penny!");
      return 1;
    },
    case Nickel: 5,
    case Dime: 10,
    case Quarter: 25,
  }
}

enum List<T> {
  Nil,
  Cons(head: T, tail: Box<List<T>>),
}


let ListLength = <T>(list: &List<T>)=> i32 {
  match (list) {
    case Nil: 0,
    case Cons: {
      const {tail} = list;
      1 + ListLength(tail)
    }
  }
}
```

### Using Range in `case`

```typescript
let checkInt = (x: i32)=> {
  match(x) {
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
let checkInt = (x: i32)=> {
  match(x) {
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

## Collections

### Array

```typescript
let v: Array<i32> = Array.new();
let v2 = Array.from([1, 2, 3]);
let value = v2.at(0);
```

### String

```typescript
let s = String.new();
let s2 = String.from("Hello World!");
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

## Slice

```typescript
let x: string = "Hello, world";
let xs: i32[5] = [1, 2, 3, 4, 5];
let emptyArray: i32[0] = [];
```

## Error handling

```typescript
type MyError = {message: char[]};
let main = (using {throw}: Exception<MyError>)=> () {
  throw({
    message: "Something went wrong",
  });
}
```

## Type casting

```typescript
let x: i32 = 1;
let y: f32 = x as f32;
```

## Modules

Similar to the ECMAScript modules, we use the `import` and `export` keywords to import and export modules. The syntax is changed and extended a bit.

```typescript
import { copy } from "https://github.com/mo-lang/mo/std/fs.mo";

let test = ()=> {
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
implements Id<i32> {
  id: (x: i32)=> i32 {
    x
  }
}

// Prevent name mangling.
export "C" let x = 1;
```

```typescript
// There is no `default` export.
import * from "./test.mo"; // Import everything from test.mo
import * as Test from "./test.mo"; // Import everything from test.mo and put it in the Test namespace

import { test } from "./test.mo"; // Import test function from test.mo
import { test as test2 } from "./test.mo"; // Import test function from test.mo and rename it to test2

import { Option } from "./test.mo"; // Import Option enum from test.mo

/*
// BELOW ARE IN DESIGN
import { Option:{Some, None} } from "./test.mo"; // Unwrap Some and None variant from Option enum from test.mo
import { Option:* } from "./test.mo"; // Unwrap all variants from Option enum from test.mo
import { Option as AnotherOption:* } from "./test.mo"; // Unwrap all variants from Option enum, and rename 'Option' to 'AnotherOption' from test.mo
*/

// All exported instances are implicitly imported.
import { id } from "./test.mo"; // Import `id` function defined in `Id` interface from test.mo
import { Id } from "./test.mo"; // Import `Id` interface from test.mo
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

## Compile time execution `In Design`

`#` prefix is used to indicate compile time execution.

The type comparison and value comparison cannot be used at the same time.  
The type comparison is done at compile time, while the value comparison is done at runtime.

```typescript
let add = <T>(x: T)=> T {
  if T == i32 { // Type comparison
    x + 1
  } else if T == f32 {
    x + 1.0
  } else {
    x
  }
}

let mul = (x: i32, y: i32)=> i32 { x * y }

let x: i32[#mul(2, 3)] = 6;
```

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

```typescript
macro add("(", e: Expr, ")") {
  `((${e}) + 1)`
}

let x = 1;
let y = add(x + 1); // 3
// The above code is equal to
let y = ((x + 1) + 1);
```

```typescript
macro add("(", ...exprs: Expr[], ")") {
  `(${exprs.join(" + ")})`
}

add(1, 2, 3); // 6
// The above code is equal to
(1 + 2 + 3)
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
