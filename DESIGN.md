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
    - [Region `Might be removed`](#region-might-be-removed)
      - [`safe` Region `In Design`](#safe-region-in-design)
    - [Variable Declaration](#variable-declaration)
    - [Type inference](#type-inference)
      - [Uninitialized variable `Might be removed`](#uninitialized-variable-might-be-removed)
    - [Transfer ownership](#transfer-ownership)
    - [`read` and `write` references](#read-and-write-references)
  - [Function Declaration](#function-declaration)
    - [Uniform Function Call Syntax](#uniform-function-call-syntax)
    - [Dependent types `In Design`](#dependent-types-in-design)
    - [Refinement types `In Design`](#refinement-types-in-design)
    - [`defer`](#defer)
    - [`recur`](#recur)
    - [Custom Operators](#custom-operators)
    - [Mulitple Return Values `In Design`](#mulitple-return-values-in-design)
  - [Duck Typing `In Design`](#duck-typing-in-design)
  - [Closure `In Design`](#closure-in-design)
    - [Closure group `In Design`](#closure-group-in-design)
  - [Mutability `To be updated`](#mutability-to-be-updated)
  - [Generic](#generic)
    - [Type parameters](#type-parameters)
    - [Type constraints](#type-constraints)
  - [2nd-Class Reference](#2nd-class-reference)
  - [Control Flow](#control-flow)
    - [Brace elision `In Design`](#brace-elision-in-design)
      - [repeat](#repeat)
      - [for](#for)
  - [Type synonyms](#type-synonyms)
  - [Enum (Algebraic Data Types)](#enum-algebraic-data-types)
    - [Generalized Algebraic Data Types (GADTs) `In Design`](#generalized-algebraic-data-types-gadts-in-design)
    - [Explicit enum variant type](#explicit-enum-variant-type)
  - [`interface` (type class/trait)](#interface-type-classtrait)
    - [Function Overloading](#function-overloading)
    - [Implicit `drop` function on `Linear` types - RAII](#implicit-drop-function-on-linear-types---raii)
  - [`implicit` keyword `In Design`](#implicit-keyword-in-design)
  - [Pattern Matching](#pattern-matching)
  - [Collections](#collections)
    - [Array](#array)
    - [String](#string)
    - [Map](#map)
  - [Slice](#slice)
  - [Error handling](#error-handling)
  - [Recoverable Errors with Result](#recoverable-errors-with-result)
  - [Type casting](#type-casting)
  - [Async/Await](#asyncawait)
  - [Algebraic effects](#algebraic-effects)
    - [Effectful function](#effectful-function)
    - [Effect handler](#effect-handler)
    - [Continuation](#continuation)
      - [resume](#resume)
      - [abort](#abort)
      - [handling `abort` with `abortdefer`](#handling-abort-with-abortdefer)
    - [Tail-resumptive operation](#tail-resumptive-operation)
    - [Rename effectful operation](#rename-effectful-operation)
    - [Effect polymorphism `In Design`](#effect-polymorphism-in-design)
  - [Modules](#modules)
  - [Compile time execution `In Design`](#compile-time-execution-in-design)
  - [Compilation `In Design`](#compilation-in-design)
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
  - ~~Borrowing~~
- [Haskell](https://www.haskell.org/)
  - Type and typeclass
- [Python](https://python.org/)
  - Keyword arguments
- [C++](https://isocpp.org/)
  - Reference
- [Scheme (Lisp)](https://www.scheme.com/)
  - `set!`
- [Zig](https://ziglang.org/)
  - Compile time execution
  - `defer`
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

### Region `Might be removed`

A **Region** here is a block that specifies the lifetime of values.

Block `{...}`, function call `func(...)`, `if` statement, and update mutable reference by `=` create new regions.

**Mo** is explicit about the regions and lifetime of values.

```typescript
let factorial = (x: i32)=> i32 { // Region 1
  if (x > 1) { // Region 2
    x * factorial(x - 1) // Region 3 for calling `factorial`
  } else { // Region 3
    result
  }
}

let test = (flag: boolean)=> { // Region 1
  if (flag) { // Region 2
    add()   // Region 3 for calling `add`
  } else {  // Region 4
    sub()   // Region 5 for calling `sub`

    {       // Region 6
      mul() // Region 7 for calling `mul`
    }
  }
}

let update = ()=> { // Region 1
  var x = 1;
  x = 2; // Region 2
}
```

#### `safe` Region `In Design`

We can specify a region to be `safe` by adding `safe` keyword before the block.

The `safe` region prevent values inside it from having mutable & immutable references outside the `safe` region.

```typescript
safe {
  // ...
}
```

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
let mySymbol = @"Hi"; // Symbol. Free type

let myStrSlice: char[] = "Hello, world"; // Stored on stack. Free type

let myString: String = String.from("Hello, world"); // Stored on heap. Linear type.
let myString2 = myString; // myString2: String. Linear type. myString is moved and consumed. myString2 now takes the ownership.
let myString3 = myString; // Error: myString is already consumed.
let myString4: read String = read myString2; // myString4: read String. Free type
let myString5 = myString4; // myString5: read String. Free type

let myInt = 1; // Stored on stack. Free type
let myInt2 = myInt; // myInt2: i32, Free type
let myInt3: read i32 = read myInt; // myInt3: read i32. Free type
let myInt4 = myInt3; // myInt4: read i32. Free type

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

#### Uninitialized variable `Might be removed`

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

### `read` and `write` references

We have `read` reference to immutable values, and `write` reference to mutable or immutable values.

So we have the following permissions:

- `read` : Can read.
- `write` : Can read, and write.
- `own` : Can read, write, and move ownership.

```typescript
{
  let i = malloc(); // i: Data
  let ref = read i; // ref: read Data, because i is not mutable.
}

{
  var i = malloc(); // i: Data
  var ref = write i; // ref: write Data, because i is mutable.
               // Must use `var` to declare write reference.
}

// Please note you cannot reseat a reference.
{
  var i = 1; // i: i32
  var ref = write i; // ref: write i32

  var j = 2; // j: i32
  ref = write j; // Compiler Error: Cannot reseat a reference.
}
```

```typescript
{
  var x = 1; // x: copied i32. Free type
  let r: read i32 = read x; // r: read i32. Free type
  var p: write i32 = write x; // p: write i32. Free type.
  p = 2;
  // x == 2
  // r == 2
  // p == 2
}
```

A longer example:

```typescript
let length = (x: read String)=> i32;
let push = (x: write String, value: read String)=> ();
let drop = (x: String)=> ();

let main = ()=> {
  var x = String.from("Hello, world"); // x: String. mutable
  var y = write x; // y: write String @x     // mutable reference, must use `var`
  let z = read x; // z: read String @x      // immutable reference, must use `let`

  length(x); // allowed
  length(y); // allowed
  length(z); // allowed

  let t = own x;                           // transfer ownership

  length(x); // error: cannot access `x` because `x` is consumed.
  length(y); // allowed
  length(z); // allowed

  drop(own t);                             // consume `t`

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
  let name: read String = read p.name; // name: read String. Free type.
  let age = read p.age; // age: read i32. Free type.
}
{
  let pRef = read p; // pRef: read Person. Free type.
  let name = read pRef.name; // name: read String. Free type.

  let age = read pRef.age; // age: read i32. Free type.
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
  let ref = read x; // ref: read i32[5]. Free type
  let first = ref[0]; // i32. Free type
}
{
  let firstRef = write x[0]; // write i32. Free type
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
  let s = write x[1]; // s: write String. Free type
  let old = (s = String.from("Earth"));
  // old: String. Linear type. old == String.from("World")
}

// x: [String.from("Hi"), String.from("Earth")]
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
// We use `<..>` to denote the effects of a function.
let main = ()=> [Console] () {
  println("Hello, world");
}

// Value constraint `In Design`
let divide = (x: i32, y: i32)=> i32
where y != 0 {
  x / y
}

// Type constraint
let add = <T: Type given Integral<T>>(x: T, y: T)=> [Console] T {
  println(x + y)
}

// Closure
let add = [write](x: i32, y: i32)=> i32 {
  x + y
};

// Curried function `In Design`
let add = (x: i32) => (y: i32) => i32 {
  x + y
}
let addOne = add(1);
addOne(2); // 3
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
(read s).length(); // 12
// is equalvalent to
length(read s); // 12

// Type coercion for `read` and `write` references
s.length(); // 12. s is coerced to `read` reference.
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

The duck typing only works in the `read` / `write` reference.

```typescript
// This function can take any type that has a `length: i32` property.
let print = (x: read { length: i32 })=> {
  println(x.length);
}

let main = ()=> {
  let s = String.from("Hello, world");
  print(s);
}
```

## Closure `In Design`

```
[permission]<type parameters>(parameters) => return_type { body }
```

The closure in **Mo** is a function that can capture ~~Linear~~ values from the outer scope.

The closure in **Mo** has **Linear** type and needs to be freed manually.

- **read/write closure** `call` that doesn't take ownership

  ```typescript
  let test = ()=> {
    var x = Box(1);

    // var increment = {x: x};
    var increment: [write](a: i32)=> () = [write](a: i32)=> {
      // var {x} = write increment;
      x = x + a;
    }
    // Generate: call(closure: write [write](a: i32)=> (), a: i32);
    increment.call(1); // call(write increment, 1);
    increment.call(2); // call(write increment, 2);
    {
      let x = read increment.x;
      println(x); // 4
    }
    drop(increment);
  }
  ```

- **own closure** `call` that takes ownership

  ```typescript
  let test = ()=> {
    var x: Data = malloc();

    // var increment = {x: x};
    var increment: [own]()=>() = ()=> {
      // var {x} = increment;
      let old = (x = malloc());
      drop(old);
      drop(x);
    }
    // Generate: call(closure: ()=> ());
    increment.call(); // call(increment);
    increment.call(); // Compiler Error: closure is already consumed.
  }
  ```

### Closure group `In Design`

The collection of functions sharing the same closure is called a **closure group**.

Each closure group can have at most one **own closure** because calling it will consume the closure.

You can use the `+` operator to combine multiple functions into a **closure group**.

```typescript
let test = ()=> {
  var x = Box(1);
  var y = Box(2);

  var c = closure {
    addX: (a: i32)=> {
      x = x + a;
    },
    addY: (a: i32)=> {
      y = y + a;
    }
  }
  c.addX.call(1);
  c.addY.call(2);
  drop(c);

  c.addX.call(1); // Compiler Error: closure is already consumed.
  c.addY.call(2); // Compiler Error: closure is already consumed.
}
```

## Mutability `To be updated`

The builtin `=` function is used to update a value that can be `write`, with the following signature:

```typescript
let set! = <T: Type>(ref: write T, value: T)=> T;

// `=` is a syntactic sugar for `set!`

x = x + 1
// is equalvalent to
set!(write x, x + 1)
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

Type constraints are defined after the type parameters, separated by `implements`, followed by a list of interface implementations.

```typescript
let lessThan = <T: Type given Ord<T>, Show<T>>(x: T, y: T)=> boolean {
  println(x);
  x < y
}

implements<X: Type given Show<X>> Show<List<X>> {
  show: (list: List<X>)=> String {
    // ...
  }
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
  x: read i32;
}

enum CustomEnum {
  Some(value: read i32);
}

type CustomSlice = (read i32)[];

let swap = (x: write i32, y: write i32)=> {
  let temp = x;
  x = y;
  y = temp;
}
```

But the following is not allowed:

```typescript
let test = ()=> {
  var x = 1;
  var y = write x; // Compiler Error: write reference is not allowed in a local variable.
}
```

## Control Flow

```typescript
let main = () => {
  // If no return type, it is () unit
  let number = 3;

  if (number < 5) {
    println("condition was true");
  } else {
    println("condition was false");
  }
};
```

### Brace elision `In Design`

**Mo** does not support `while`, `for` loops from imperative languages, as they are not functional and they make it hard to reason about the code.  
Another reason is that they make it hard to translate the effectful function to a state machine, which is required for the algebraic effects.

#### repeat

```typescript
let factorial = (n: i32)=> i32 {
  var result = 1;
  repeat(n) (i)=> {
    result = result * i;
  }
  return result;
}

// is equalvalent to
let factorial = (n: i32)=> i32 {
  var result = 1;
  repeat(n, (i)=> {
    result = result * i
  })
  return result;
}
```

#### for

```typescript
let print10 = ()=> {
  for(1, 10) (i)=> {
    println(i);
  }
}

// is equalvalent to

let print10 = ()=> {
  for(1, 10, (i)=> {
    println(i);
  })
}
```

## Type synonyms

```typescript
// Record
@derive([Show])
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
interface Summary<T> extends Eq<T> {
  summarize: (self: T)=> String;
}

interface Display<T> extends Summary<T> {
  display: (self: T)=> String;
}

type NewsArticle = {
  headline: String;
  location: String;
  author: String;
  content: String;
};

// Implements the interface
implements Summary<NewsArticle> {
  summarize: (self: NewsArticle)=> String {
    "${self.headline}, by ${self.author} (${self.location})";
  }
}

// Pass in function
let notify = (item: NewsArticle)=> () {
  println("Breaking news! ", summarize(item));
  // or
  println("Breaking news! ", Summary<NewsArticle>.summarize(item));
  // or
  println("Breaking news! ", Summary.summarize(item));
}

let notify = <T>(
  item: T,
  implicit {*}: Display<T>
)=> () {
  println("Breaking news! ", item.summarize());
  println("Breaking news! ", item.display());
  // Or
  println("Breaking news! ", Display<T>.summarize(item));
  println("Breaking news! ", Display<T>.display(item));
}
```

### Function Overloading

Function overloading can be achieved using `interface`.

For example:

```typescript
interface Id<T> {
  id: (x: T)=> T;
}

implements Id<i32> {
  id(x: i32): i32 {
    x
  }
}

implements Id<f32> {
  id(x: f32): f32 {
    x
  }
}

let main = ()=> {
  let x = id(1);  // x: i32
  let y = id(3.2) // y: f32
}
```

### Implicit `drop` function on `Linear` types - RAII

```typescript
interface Drop<T: Linear> {
  drop: (self: T)=> ();
}

let main = ()=> {
  let x = String.from("Hello");

  // If `x` is not consumed, it will be dropped at the end of the scope implicitly.
  // The user needs to import the `drop` function. If no such function is found, it will be a compiler error.
  // drop(x); // This will be called implicitly.
}
```

## `implicit` keyword `In Design`

```typescript
let add = (x: i32, implicit y: i32)=> i32 {
  x + y
}
let test = ()=> {
  implicit let a: i32 = 13;

  // implicit let b: i32 = 14;  Conflict! Two possible implicits of the same type. Error will occur.

  add(1);    // 14
  add(1, 2); // 3
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
    Penny => {
      println("Lucky penny!");
      return 1;
    },
    Nickel => 5,
    Dime => 10,
    Quarter => 25,
  }
}

enum List<T> {
  Nil,
  Cons(head: T, tail: Box<List<T>>),
}


let ListLength = <T>(list: read List<T>)=> i32 {
  match (list) {
    Nil => 0,
    Cons => {
      const {tail} = list;
      1 + ListLength(tail)
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
let main = ()=> [Exception<MyError>] () {
  throw({
    message: "Something went wrong",
  });
}
```

## Recoverable Errors with Result

```typescript
enum Result<T, E> {
  Ok(T)
  Err(E)
}

import { open, drop } from "fs"
let main = ()=> {
  let greetingFileResult = open("greeting.txt");

  if greetingFileResult is Ok(file) {
    println("The file was opened successfully");
  } else if greetingFileResult is Err(error) {
    println("The file could not be opened: ${error}");
  }

  drop(greetingFileResult);
}
```

## Type casting

```typescript
let x: i32 = 1;
let y: f32 = x as f32;
```

## Async/Await

The async function in **Mo** is similar to the [async/await](https://developer.mozilla.org/en-US/docs/Learn/JavaScript/Asynchronous/Async_await) in JavaScript.  
But the async function in **Mo** doesn't require using the `async` keyword.  
Any function that returns a `Promise` will be treated as an async function.

It will be translated to a state machine in the backend, and two new functions, `resume` and `abort`, will be injected to the function as parameters.

- `resume` function is available in all functions that return a `Promise`.
- `abort` function is available in the effect operations that return a `Promise`.

Its real return type will be `()`.  
The `Promise` type is a `Linear` type, which means it must be consumed exactly once.  
The `await` keyword is used to take the value out of the `Promise`. The `await` keyword can only be used inside an async function.

```typescript
// Promise is Linear type.
let waitForSeconds = (seconds: i32)=> Promise<()> {
  setTimeout(()=> {
    resume(())
  }, seconds * 1000);
}

let main = ()=> Promise<()> {
  println("Hello");
  await waitForSeconds(12);
  println("World");
}
```

## Algebraic effects

Note: **Mo** only supports **one-shot delimited continuations**.  
This means that the continuation can only resume once.

Our implementation doesn't use CPS (Continuation Passing Style) transformation as it's memory consuming and not efficient.

We can define effect values in `interface`.

```typescript
interface GiveInt {
  giveInt: (x: i32)=> [GiveInt] i32; // Effectful function
  anotherGiveInt: (x: i32)=> i32;    // Normal function
}

implements GiveInt {
  // But we can implement the normal function.
  anotherGiveInt: (x: i32)=> i32 {
    x
  }
  // But it's usually not recommended to implement the effectful function in the interface.
  // Instead, we use the effect handler to handle the effectful function.
}

interface Exception<T = ()> {
  control raise: (msg: String)=> [Exception<T>] T; // Effectful function
}
```

The `control` keyword here means the function will have `resume` and `abort` to control the continuation.  
The `control` keyword is only allowed in the `interface`.

### Effectful function

Effects are defined order-insensitive.

```typescript
let safeDivide = (x: i32, y: i32)=> [Exception<i32>, Console] i32 {
  if (y == 0) {
    println("Cannot divide by 0"); // handled by Console effect
    raise("Cannot divide by 0");   // handled by Exception effect
  } else {
    resume(x / y);
  }
}
```

The following function signatures are equivalent:

```typescript
safeDivide: (x: i32, y: i32)=> [Exception<i32>, Console] i32;
safeDivide: (x: i32, y: i32)=> [Console, Exception<i32>] i32;
```

Function with no effect is written with `[]`, and `[]` can be suppressed in this case:

```typescript
let add = (x: i32, y: i32)=> i32 {
  // Equivalent to function add(x: i32, y: i32): [] i32
  x + y;
}
```

### Effect handler

Note: **Mo** only supports the **deep handlers**, that is a handler will handle all the effects in the scope, not just once.

```typescript
interface Exception<T> {
  control raise: (msg: String)=> [Exception<T>] T;
}

let safeDivide = (x: i32, y: i32)=> [Exception<i32>] i32 {
  if (y == 0) {
    raise("Cannot divide by 0")
  } else {
    x / y
  }
}

let handle = ()=> i32 {
  try {
    8 + safeDivide(1, 0) + 10 // 60
  } with Exception<i32> { // The effect handler dischard the `Exception<i32>` effect.
    control raise: (msg)=> i32 { // Please note the function is returning `i32` without `Exception<i32>`.
      resume(42)
    }
  }
}
```

### Continuation

Given the following function:

```typescript
interface Input {
  control read: ()=> [Input] String;
}

let hello = ()=> [Input] () {
  let name = read();
  println("Hello, ", name);
}
```

#### resume

```typescript
let main = ()=> {
  try {
    hello(); // Hello Alice
  } with Input {
    control read: ()=> String {
      resume("Alice");
    }
  }
}
```

#### abort

```typescript
let main = ()=> {
  try {
    hello(); // Error
    println("Hello, world!"); // This line won't be executed.
  } with Input {
    control read: ()=> String {
      abort("Error")
    }
  }
}
```

#### handling `abort` with `abortdefer`

```typescript
let example = ()=> [Exception<()>] () {
  let file: File = open("file.txt", "w");

  raise("Some exception");

  @consume(file); // This line might not be executed because of the `raise` above which might abort the execution.
  // But the `file` is not consumed yet.
}
```

What we can do is to use the `abortdefer` to defer the execution of certain code until the abort happens:

```typescript
let example = ()=> [Exception<()>] () {
  let file: File = open("file.txt", "w");
  abortdefer {
    println("Exception caught");
    @consume(file);
  }
  raise("Some exception")

  println("This line won't be executed");
  @consume(file);
}
```

### Tail-resumptive operation

Effect with only tail-resumptive operations is called [Linear Effect](<[LinearEffect](https://koka-lang.github.io/koka/doc/book.html#sec-linear)>).

```typescript
interface GiveInt {
  giveInt: (x: i32)=> [GiveInt] i32
}

let handleGiveInt = ()=> i32 {
  try {
    let x = giveInt(1);
    println(x); // 2
  } with GiveInt {
    giveInt: (x)=> i32 {
      x + 1
    }
  }
}
```

### Rename effectful operation

```typescript
interface Exception<T> {
  control raise: (msg: String)=> [Exception<T>] T;
}

let safeDivide = (x: i32, y: i32)=> [Exception<i32>{raise as newRaise}] i32 {
  if (y == 0) {
    newRaise("Cannot divide by 0");
  } else {
    x / y
  }
}
```

### Effect polymorphism `In Design`

```typescript
[*] // zero or more effects
```

```typescript
let map = <A: Type, B: Type>
( xs: *<List<A>>,
  func: (x: *<A>)=> [*] B
)=> [*] List<B>
{
  if (xs is Nil) {
    Nil
  } else if (xs is Cons) {
    let {head, tail} = xs;
    let newHead = func(head);
    let newTail = map(tail, func);
    Cons(newHead, Box.new(newTail))
  }
}
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

// Export the interface
export interface Id<T> {
  id: (x: T)=> T;
}

// Explicitly export the functions defined in the instance.
// The instance will be exported implicitly.
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
import {*} from "./test.mo"; // Import everything from test.mo
import {*} as Test from "./test.mo"; // Import everything from test.mo and put it in the Test namespace
import { test } from "./test.mo"; // Import test function from test.mo
import { test as test2 } from "./test.mo"; // Import test function from test.mo and rename it to test2

import { Option } from "./test.mo"; // Import Option enum from test.mo
import { Option: {Some, None} } from "./test.mo"; // Unwrap Some and None variant from Option enum from test.mo
import { Option: {*} } from "./test.mo"; // Unwrap all variants from Option enum from test.mo
import { Option as AnotherOption: {*} } from "./test.mo"; // Unwrap all variants from Option enum, and rename 'Option' to 'AnotherOption' from test.mo

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
