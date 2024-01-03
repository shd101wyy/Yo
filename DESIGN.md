# Language Design

**Mo** (墨) is minimal, general-purpose, functional (not pure), compiled programming language.

**Mo** aims to be a simple to learn programming language. If you are familiar with TypeScript, you should be able to pick up **Mo** in 1 hour 😉.

**Mo** has a minimal syntax design that looks like TypeScript, and uses uniform call syntax (dot notation), brace elison to make the code more concise.

**Mo** is strong typed with a robust bidrectional type checker. **Mo** supports typeclass and instances, combined with algebraic effects (one-shot) and an efficient type system.

**Mo** (will &) tend to support advanced type system features such as generalized algebraic data types (GADT), dependent types, refinement types. `In Design`

**Mo** has no garbage collector as it utilizes the [Linear Types](https://en.wikipedia.org/wiki/Substructural_type_system#:~:text=Linear%20types%20corresponds%20to%20linear,transitioned%20to%20a%20different%20state.) and implemented a strict borrow checker. The **Mo** compiler helps you eliminate potential errors before the code is executed.

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
    - [Region](#region)
      - [Named Region `Might be removed`](#named-region-might-be-removed)
    - [Variable Declaration](#variable-declaration)
    - [Type inference](#type-inference)
      - [Uninitialized variable](#uninitialized-variable)
    - [Reference and Dereference](#reference-and-dereference)
  - [Function Declaration](#function-declaration)
    - [Uniform Function Call Syntax](#uniform-function-call-syntax)
    - [Dependent types `In Design`](#dependent-types-in-design)
    - [Refinement types `In Design`](#refinement-types-in-design)
    - [`defer`](#defer)
    - [Tail-call optimization `In Design`](#tail-call-optimization-in-design)
  - [Mutability](#mutability)
  - [Borrow checker](#borrow-checker)
  - [Control Flow](#control-flow)
    - [Brace elision `In Design`](#brace-elision-in-design)
      - [repeat](#repeat)
      - [for](#for)
  - [Type synonyms](#type-synonyms)
  - [Enum (Algebraic Data Types)](#enum-algebraic-data-types)
    - [Generalized Algebraic Data Types (GADTs) `In Design`](#generalized-algebraic-data-types-gadts-in-design)
    - [Explicit enum variant type](#explicit-enum-variant-type)
  - [Typeclass](#typeclass)
    - [Function Overloading](#function-overloading)
    - [Implicit `drop` function on `Linear` types](#implicit-drop-function-on-linear-types)
  - [Pattern Matching](#pattern-matching)
  - [Collections](#collections)
    - [Array](#array)
    - [String](#string)
    - [Map](#map)
  - [Slice](#slice)
  - [Error handling](#error-handling)
  - [Recoverable Errors with Result](#recoverable-errors-with-result)
  - [Pointer](#pointer)
  - [Type casting](#type-casting)
  - [Async/Await](#asyncawait)
  - [Algebraic effects](#algebraic-effects)
    - [Effectful function](#effectful-function)
    - [Effect handler](#effect-handler)
    - [Continuation](#continuation)
      - [resume](#resume)
      - [abort](#abort)
      - [handling `abort` with `defer!`](#handling-abort-with-defer)
    - [Tail-resumptive operation](#tail-resumptive-operation)
    - [Rename effectful operation](#rename-effectful-operation)
    - [Effect polymorphism](#effect-polymorphism)
  - [Modules](#modules)
  - [Compile time execution `In Design`](#compile-time-execution-in-design)
  - [Compilation `In Design`](#compilation-in-design)
  - [References](#references)

<!-- /code_chunk_output -->

## Philosophy

The explicit is better than the implicit.  
The strict is better than the loose.

## Inspiration

The **Mo** language is heavily inspired by:

- [TypeScript](https://www.typescriptlang.org/)
  - Syntax and semantics
  - Module system
- [Koka](https://koka-lang.github.io/)
  - Brace elision
  - Dot notation (Uniform Function Call Syntax)
  - Perceus and reuse
  - Algebraic effects
- [Rust](https://www.rust-lang.org/)
  - Borrow checker
  - Lifetime
- [Austral](https://austral-lang.org/)
  - Linear types
  - Borrowing
- [Haskell](https://www.haskell.org/)
  - Type and typeclass
- [Python](https://python.org/)
  - Keyword arguments
- [C++](https://isocpp.org/)
  - Reference
- [Scheme](https://www.scheme.com/)
  - `set!`
- [Zig](https://ziglang.org/)
  - Compile time execution
  - `defer`

Other languages that are worth mentioning that have influenced **Mo**:

- [Effekt](https://effekt-lang.org/)
- [PureScript](https://www.purescript.org/)
- [Clojure](https://clojure.org/)
- [Ante](https://antelang.org/)
- [ATS](https://www.ats-lang.org/)
- [Lean](https://leanprover.github.io/)
- [Swift](https://swift.org/)
- [Go](https://go.dev/)

## Hello World

```typescript
let main = ()-> {
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

# Run scripts
mo run test
```

## Types

A type can have the following **Kind**:

- Type
  - Free
  - Linear
- Region
- Effect
  - Linear
  - Controlled

### Type

#### `Free` Types

- `boolean`
- `u1` (1-bit unsigned integer)
- `i1` (1-bit signed integer)
- `i8` (8-bit signed integer)
- `u8` (8-bit unsigned integer)
- `i16` (16-bit signed integer)
- `u16` (16-bit unsigned integer)
- `i32` (32-bit signed integer)
- `u32` (32-bit unsigned integer)
- `i64` (64-bit signed integer)
- `u64` (64-bit unsigned integer)
- `i128` (128-bit signed integer)
- `u128` (128-bit unsigned integer)
- `f16` (16-bit floating point)
- `f32` (32-bit floating point)
- `f64` (64-bit floating point)
- `char` (ASCII character)
- `usize` (pointer size. It's `u32` on 32-bit system, `u64` on 64-bit system)
- `symbol` (unique global string)
- `()` (unit)

#### `Linear` Types.

Linear types are types that can only be used exactly once. For example, a `String` is a linear type as it can only be used once.  
The [Austral language](https://austral-lang.org/) has a very good explanation on the incentive of using [Linear Types](https://austral-lang.org/tutorial/linear-types).

### Region

A **Region** here is a block that specifies the lifetime of values.

Block `{...}`, function call `func(...)`, `if` statement, and update mutable reference by `=` create new regions.

**Mo** is explicit about the regions and lifetime of values.

```typescript
let factorial = (x: i32)-> i32 { // Region 1
  if (x > 1) { // Region 2
    x * factorial(x - 1) // Region 3 for calling `factorial`
  } else { // Region 3
    result
  }
}

let test = (flag: boolean)-> { // Region 1
  if (flag) { // Region 2
    add()   // Region 3 for calling `add`
  } else {  // Region 4
    sub()   // Region 5 for calling `sub`

    {       // Region 6
      mul() // Region 7 for calling `mul`
    }
  }
}

let update = ()-> { // Region 1
  let mut x = 1;
  x = 2; // Region 2
}
```

#### Named Region `Might be removed`

```typescript
{:R1
  let mut x = 1;
}
{:R2
  let mut x = 2;
  let mut y = 2;
}
{:R1 // Continue R1
  println(x); // 1
  println(y); // Compiler Error: y is not defined in R1
                  // R2 is not in scope
}
```

### Variable Declaration

Like `rust`, **Mo** has two kinds of variables:

```typescript
let y = 5; // y: i32, immutable
let mut x = 5; // x: i32, mutable

let example = (mut x: i32, y: i32)-> {
  x = 1; // x: i32, mutable
  y = 2; // Error: y is immutable
}
```

### Type inference

```typescript
let mySymbol = @"Hi"; // Symbol. Free type

let myStrSlice: char[] = "Hello, world"; // Stored on stack. Free type

let myString: String = String.from("Hello, world"); // Stored on heap. Linear type.
let myString2 = myString; // myString2: String. Linear type. myString is moved and consumed. myString2 now takes the ownership.
let myString3 = myString; // Error: myString is already consumed.
let myString4: Reference<String> = &myString2; // myString4: Reference<String, R> for some region R. Free type
let myString5 = myString4; // myString5: Reference<String, R> for some region R. Free type
let myString6 = *myString4; // Error: Cannot dereference a linear type.

let myInt = 1; // Stored on stack. Free type
let myInt2 = myInt; // myInt2: i32, Free type
let myInt3: Reference<i32> = &myInt; // myInt3: Reference<i32, R> for some region R. Free type
let myInt4 = myInt3; // myInt4: Reference<i32, R> for some region R. Free type
let myInt5: i32 = *myInt3; // myInt5: i32. Use `*` to dereference a reference if free type. Free type

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

#### Uninitialized variable

```typescript
let mut x?: i32; // x: i32, uninitialized

x = 1; // x: i32, initialized

let y?: i32; // y: i32, uninitialized

y = 1; // y: i32, initialized
y = 2; // Compiler Error: y is already initialized
```

### Reference and Dereference

A **reference** is a `Free` pointer to a `Linear` or `Free` value. References have a number of restrictions that preserve the linearity guarantees. There are two kinds of references:

- **Read references** allow you to read data from a linear value.
- **Read-write** or **mutable** references allow you to read from and write to a linear value.

```typescript
type Reference<T: Type, R: Region>: Free;
// Or written as &<T, R> for short

type MutableReference<T: Type, R: Region>: Linear;
// Or written as &!<T, R> for short
// There can only be one mutable reference to a value at a time.
```

We can use `&` to create a reference to a value, or `&!` to create a mutable reference to a value.

```typescript
&a.b.c.d
// will check
(&a)
// then
(&a.b)
// then
(&a.b.c)
// then
(&a.b.c.d)
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
  let {name, mut age} = p;
}

{
  let mut {name, age} = p;
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
  let name: &<String> = &p.name; // name: Reference<String, R> for some region R. Free type.
  let age = &p.age; // age: Reference<i32, R> for some region R. Free type.
}
{
  let pRef = &p; // pRef: Reference<Person, R> for some region R. Free type.
  let name = pRef.name; // name: Reference<String, R> for some region R. Free type.
  let name2 = *(pRef.name); // Error: Cannot dereference a linear type.
  // let unwrapName = *name; // Error: Cannot dereference a linear type.

  let age = pRef.age; // Reference<i32, R> for some region R. Free type.
  let age2 = *(pRef.age); // i32. Free type.
}
```

```typescript
let name = String.from("Alice");
let p = Person.Person(name, 30); // p: Person. Linear type.

const { name, age } = p; // p is consumed.

p = Person.Person(name, 30); // This is allowed. We restored a consumed value.
```

```typescript
let mut x = [1, 2, 3, 4, 5]; // x: i32[5]. Free type
let y = x; // y: i32[5]. Free type. x is copied to y, not moved.

{
  let ref = &!x; // ref: &!<i32[5], R> for some region R. Free type
  let first = ref[0]; // i32. Free type
}
{
  let firstRef = &!x[0]; // &!<i32, R> for some region R. Free type
  *firstRef = 10;
}

// x: [10, 2, 3, 4, 5]
// y: [1, 2, 3, 4, 5]
```

```typescript
let mut x = [String.from("Hi"), String.from("World")];

{
  let s = x[0]; // Compiler Error: Cannot move linear type out of a slice.
}

{
  let s = &!x[1]; // s: &<String, R> for some region R. Free type
  const old = (*s = String.from("Earth"));
  // old: String. Linear type. old == String.from("World")
}

// x: [String.from("Hi"), String.from("Earth")]
```

## Function Declaration

Unlike imperative languages, **Mo** has no `return` keyword. The last expression of a function is the return value.

```typescript
// Top level function.
// Type after `->` is the return type. If it's not specified, it's `()` unit.
let add = (x: i32, y: i32)-> i32 {
  x + y
}

// Default parameter values
let add = (x: i32 = 1, y: i32 = 2)-> i32 {
  x + y
}

// Generic function
let identity = <T>(arg: T)-> T {
  arg
}

// Dependency injection (Effectful function)
// We use `<..>` to denote the effects of a function.
let main = () -> [Console] () {
  println("Hello, world");
}

// Value constraint `In Design`
let divide = (x: i32, y: i32)-> i32
where y != 0 {
  x / y
}

// Type constraint
let add = <T: Type>(x: T, y: T)-> [Console] T
with Integral<T> {
  println(x + y)
}

// Closure
let add = (x: i32, y: i32): i32 => {
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
let addOne = (x: i32)-> i32 {
  x + 1;
}

(12).addOne(); // 13
// is equalvalent to
addOne(12); // 13

let s = String.from("Hello, world");
&s.length(); // 12
// is equalvalent to
length(&s); // 12
```

### Dependent types `In Design`

Dependent types are types which depend on values.

```typescript
let dependOnBoolean = (b: boolean) -> i32
where b == true
{
  1
}
let dependOnBoolean = (b: boolean) -> f32
where b == false
{
  1.0
}

dependOnBoolean(true); // 1
dependOnBoolean(false); // 1.0
dependOnBoolean(returnBoolean()); // Compiler Error: value constraint not satisfied for both `dependOnBoolean` functions
```

```typescript
let divide = (x: i32, y: i32)-> i32
where y != 0
{
  x / y
}

let main = ()-> {
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
let makeArray = (size: i32)-> Array<i32>
where size < 10 && size > 0 {
  return Array<i32>.new(size)
}

let main = ()-> {
  let size = readInt()
  if (size < 10 && size > 0) {
    let arr = makeArray(size) // The function is guaranteed to return an array of size between 1 and 9
  } else {
    makeArray(size) // Compiler Error: size is not between 1 and 9
  }
}
```

```typescript
let inBetween = (x: i32, min: i32, max: i32)-> boolean
where min < max && x >= min
{
  true
}
let main = ()-> {
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
let test = ()-> {
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
let deferExample = ()-> {
  let mut a = 1;

  {
    defer a = 2;
    a = 1;
  }

  println(a); // 2
  a
}
```

### Tail-call optimization `In Design`

Use the `recur` to make the tail-call.  
This is useful for anonymous function.

```typescript
(x: u32, acc: u32 = 1)-> {
  if (x == 1) {
    1
  } else {
    recur(x - 1, acc * x)
  }
}
```

## Mutability

The builtin `=` function is used to update a `MutableReference`, with the following signature:

```typescript
let set! = <T: Type, R: Region>(ref: MutableReference<T, R>, value: T)-> T;

// `=` is a syntactic sugar for `set!`

x = x + 1
// is equalvalent to
set!(&!x, x + 1)
// so we append `&!` to the variable on the left hand side of `=`

// &!* will cancel out, for example:
// &!*x is equalvalent to x
```

Below is an example of updating a field of a linear type:

```typescript
enum Person { // Linear type.
  Person(name: String, age: i32)
}
let mut p = Person.Person(String.from("Alice"), 30); // p: Person. Linear type.

// Update the field
let oldName = (p.name = String.from("Bob"));
// oldName is the `value` moved out.
// oldName == String.from("Alice")

let mut myInt = 1;
let myInt2 = &myInt;
let myInt3: i32 = *myInt2;
myInt = 2;
//  myInt == 2
// *myInt2 == 2
//  myInt3 == 1
```

## Borrow checker

> This is similar to the borrow checker in Rust, but stricter.

First, any borrow must last for a scope no greater than that of the owner. Second, you may have one or the other of these two kinds of borrows, but not both at the same time:

- One or more references (`&<T>`) to a resource.
- Exactly one mutable reference (`&!<T>`).

Example:

- Cannot have two mutable references to the same value [E0499](https://doc.rust-lang.org/error_codes/E0499.html).

```typescript
let main = ()-> {
  let mut x = 1;
  let y = &!x;
  let z = &!x; // Compiler Error: Cannot borrow `x` as mutable more than once at a time.
}
```

```typescript
type Coord = {
  x: i32,
  y: i32
}
let main = ()-> {
  let mut p = { x: 1, y: 2 };
  let pRef = &!p;
  let yRef = &!p.y; // Compiler Error: Cannot borrow `p` as mutable more than once at a time.
}
```

```typescript
let main = ()-> {
  let mut xs: i32[] = [1, 2, 3];
  let xsRef = &!xs;
  let firstRef = &!xs[0]; // Compiler Error: Cannot borrow `xs` as mutable more than once at a time.
}
```

- Cannot have an immutable reference while we have a mutable one [E0502](https://doc.rust-lang.org/error_codes/E0502.html).  
  Cannot have a mutable reference while we have an immutable one [E0502](https://doc.rust-lang.org/error_codes/E0502.html).

```typescript
let main = ()-> {
  let mut x = 1;
  let mut y: MutableReference<i32> = &!x;
  let mut z: Reference<i32> = &x; // Compiler Error: Cannot borrow `x` as immutable because it is also borrowed as mutable.
}
```

```typescript
let main = ()-> {
  let mut x = 1;
  let mut y: Reference<i32> = &x;
  let mut z: MutableReference<i32> = &!x; // Compiler Error: Cannot borrow `x` as mutable because it is also borrowed as immutable.
}
```

- Cannot use the value while it's borrowed [E0503](https://doc.rust-lang.org/error_codes/E0503.html).

```typescript
let main = ()-> {
  let mut x = 1;
  let mut y: MutableReference<i32> = &!x;
  let mut _sum = x + 1; // Compiler Error: A value was used after it was mutably borrowed.
}
```

- Cannot consume (move) the value while it's borrowed [E0505](https://doc.rust-lang.org/error_codes/E0505.html), [E0504](https://doc.rust-lang.org/error_codes/E0503.html).

```typescript
let main = ()-> {
  let x = String.from("Hello");
  let y: Reference<String> = &x;
  consume(x); // Compiler Error: A value was moved out while it was still borrowed.
}
```

```typescript
let main = ()-> {
  let x = String.from("Hello");
  let y: Reference<String> = &x;

  let mut z = move ()=> {
    println(x); // Compiler Error: Cannot move `x` into closure because it is borrowed.
  }
}
```

- Cannot assign to the value while it's borrowed [E0506](https://doc.rust-lang.org/error_codes/E0506.html).

```typescript
let main = ()-> {
  let mut x = 1;
  let y: Reference<i32> = &x;
  x = 2; // Compiler Error: An attempt was made to assign to a borrowed value
}
```

## Control Flow

```typescript
let main = ()-> {
  // If no return type, it is () unit
  let number = 3;

  if (number < 5) {
    println("condition was true");
  } else {
    println("condition was false");
  }
}
```

### Brace elision `In Design`

**Mo** does not support `while`, `for` loops from imperative languages, as they are not functional and they make it hard to reason about the code.  
Another reason is that they make it hard to translate the effectful function to a state machine, which is required for the algebraic effects.

#### repeat

```typescript
let factorial = (n: i32)-> i32 {
  let mut result = 1;
  repeat(n) (i)=> {
    result = result * i;
  }
  return result;
}

// is equalvalent to
let factorial = (n: i32)-> i32 {
  let mut result = 1;
  repeat(n, (i)=> {
    result = result * i
  })
  return result;
}
```

#### for

```typescript
let print10 = ()-> {
  for(1, 10) (i)=> {
    println(i);
  }
}

// is equalvalent to

let print10 = ()-> {
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

let user: User = {
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
let user: User = {
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

let eval = <T>(expr: Expr<T>)-> T {
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

let unwrap = <T>(x: Option<T>.Some)-> T {
  x.value
}
unwrap(x); // 1
unwrap(None); // Won't compile. None is not a Some variant.
```

## Typeclass

```typescript
class Summary<T> extends Eq<T> {
  summarize(self: T): String;
}

class Display<T> extends Summary<T> {
  display(self: T): String;
}

type NewsArticle = {
  headline: String;
  location: String;
  author: String;
  content: String;
};

// Implement the class instance
instance Summary<NewsArticle> {
  summarize(self: NewsArticle): String {
    "${self.headline}, by ${self.author} (${self.location})";
  }
}

// Pass in function
let notify = (item: NewsArticle)-> {
  println("Breaking news! ", item.summarize());
}

let notify = <T>(item: T) with Display<T> -> {
  println("Breaking news! ", item.summarize());
  println("Breaking news! ", item.display());
}
```

### Function Overloading

Function overloading can be achieved using typeclass.

For example:

```typescript
class Id<T> {
  id: (x: T)-> T;
}

instance Id<i32> {
  id(x: i32): i32 {
    x
  }
}

instance Id<f32> {
  id(x: f32): f32 {
    x
  }
}

let main = ()-> {
  let x = id(1);  // x: i32
  let y = id(3.2) // y: f32
}
```

### Implicit `drop` function on `Linear` types

NOTE: We might not need this as we have `defer` for explicit `drop`.

```typescript
class Drop<T: Linear> {
  drop(self: T): ();
}

let main = ()-> {
  let x = String.from("Hello");

  // If `x` is not consumed, it will be dropped at the end of the scope implicitly.
  // The user needs to import the `drop` function. If no such function is found, it will be a compiler error.
  // drop(x); // This will be called implicitly.
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
let valueInCents = (coin: Coin)-> u8 {
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


let ListLength = <T>(list: &List<T>)-> i32 {
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
let main = ()-> [Exception<MyError>] () {
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
let main = ()-> {
  let greetingFileResult = open("greeting.txt");

  if greetingFileResult is Ok(file) {
    println("The file was opened successfully");
  } else if greetingFileResult is Err(error) {
    println("The file could not be opened: ${error}");
  }

  drop(greetingFileResult);
}
```

## Pointer

```typescript
type Pointer<T: Type>: Linear;

let main = ()-> {
  // Allocate on heap
  /// malloc
  let dynamicFloat = malloc(@sizeOf<f32>() * 1); // dynamicFloat: Pointer<f32>. Linear type.

  /// calloc
  let dynamicInt = calloc<i32>(1); // dynamicInt: Pointer<i32>. Linear type.
  let dynamicIntArray = calloc<i32>(10); // dynamicIntArray: Pointer<i32>. Linear type.
  let dynamicString = calloc<char>(10); // dynamicString: Pointer<char>. Linear type.

  /// dereference
  let dynamicIntRef = dynamicInt.deref(); // dynamicIntRef: Reference<i32, R> for some region R. Free type.
  let dynamicIntArrayRef = dynamicIntArray.deref(offset=1);  // dynamicIntArrayRef: Reference<i32, R> for some region R. Free type.
  let dynamicStringRef = dynamicString.deref(offset=1); // dynamicStringRef: Reference<char, R> for some region R. Free type.

  /// free
  free(dynamicInt);
  free(dynamicIntArray);
  free(dynamicString);
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
let waitForSeconds = (seconds: i32)-> Promise<()> {
  setTimeout(()-> {
    resume(())
  }, seconds * 1000);
}

let main = ()-> Promise<()> {
  println("Hello");
  await waitForSeconds(12);
  println("World");
}
```

## Algebraic effects

Note: **Mo** only supports **one-shot delimited continuations**.  
This means that the continuation can only resume once.

Our implementation doesn't use CPS (Continuation Passing Style) transformation as it's memory consuming and not efficient.

Effect is defined using the `effect` keyword.

```typescript
effect Exception<T = ()> {
  raise: (msg: String)-> Promise<T>;
}
```

You can extend an effect using the `extends` keyword.

```typescript
effect Pure extends Exception, Divergence {}
```

### Effectful function

Effects are defined order-insensitive.

```typescript
let safeDivide = (x: i32, y: i32)-> [Exception, Console] Promise<i32> {
  if (y == 0) {
    await println("Cannot divide by 0"); // handled by Console effect
    await raise("Cannot divide by 0");   // handled by Exception effect
  } else {
    resume(x / y);
  }
}
```

The following function signatures are equivalent:

```typescript
safeDivide: (x: i32, y: i32)-> [Exception, Console] Promise<i32>;
safeDivide: (x: i32, y: i32)-> [Console, Exception] Promise<i32>;
```

Function with no effect is written with `[]`, and `[]` can be suppressed in this case:

```typescript
let add = (x: i32, y: i32)-> i32 {
  // Equivalent to function add(x: i32, y: i32): [] i32
  x + y;
}
```

### Effect handler

Note: **Mo** only supports the **deep handlers**, that is a handler will handle all the effects in the scope, not just once.

```typescript
effect Exception<T> {
  raise: (msg: String)-> Promise<T>;
}

let safeDivide = (x: i32, y: i32)-> [Exception<i32>] Promise<i32> {
  if (y == 0) {
    resume(await raise("Cannot divide by 0"))
  } else {
    resume(x / y)
  }
}

let handle = ()-> {
  try {
    8 + (await safeDivide(1, 0)) + 10 // 60
  } with Exception<i32> {
    raise: (msg)-> Promise<i32> {
      resume(42)
    }
  }
}
```

### Continuation

Given the following function:

```typescript
effect Input {
  read(): Promise<String>;
}

let hello = ()-> [Input] Promise<()> {
  let name = await read();
  println("Hello, ", name);
  resume(())
}
```

#### resume

```typescript
let main = ()-> {
  try {
    await hello(); // Hello Alice
  } with Input {
    read: ()-> Promise<String> {
      resume("Alice");
    }
  }
}
```

#### abort

```typescript
let main = ()-> {
  try {
    await hello(); // Error
    println("Hello, world!"); // This line won't be executed.
  } with Input {
    read: ()-> Promise<String> {
      abort("Error")
    }
  }
}
```

#### handling `abort` with `defer!`

```typescript
let example = ()-> [Exception<()>] Promise<()> {
  let file: File = await open("file.txt", "w");

  await raise("Some exception");

  consume(file); // This line might not be executed because of the `raise` above which might abort the execution.
  // But the `file` is not consumed yet.
}
```

What we can do is to use the `defer!` to defer the execution of certain code until the abort happens:

```typescript
let example = ()-> [Exception<()>] Promise<()> {
  let file: File = await open("file.txt", "w");
  defer! {
    println("Exception caught");
    consume(file);
  }
  await raise("Some exception")

  consume(file);
  resume(());
}
```

### Tail-resumptive operation

Effect with only tail-resumptive operations is called [Linear Effect](<[LinearEffect](https://koka-lang.github.io/koka/doc/book.html#sec-linear)>).

```typescript
effect GiveInt {
  giveInt: (x: i32)-> i32
}

let handleGiveInt = ()-> i32 {
  try {
    let x = giveInt(1);
    println(x); // 2
  } with GiveInt {
    giveInt: (x)-> i32 {
      x + 1
    }
  }
}
```

### Rename effectful operation

```typescript
effect Exception<T> {
  raise(msg: String): Promise<T>;
}

let safeDivide = (x: i32, y: i32)-> [Exception<i32>{raise as newRaise}] Promise<i32> {
  if (y == 0) {
    await newRaise("Cannot divide by 0");
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
( xs: &<List<A>>,
  func: (x: &<A>)=> [*] B
)-> [*] List<B>
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

Same as the ECMAScript modules, we use the `import` and `export` keywords to import and export modules. The syntax is extended a bit.

```typescript
import { copy } from "https://github.com/mo-lang/mo/std/fs.mo";

let test = ()-> {
  println("Hello, world!");
}

export { test, copy };

// Export the enum.
export enum Option<T> {
  Some(value: T),
  None,
}

// Explicitly export the functions defined in the instance.
// The instance will be exported implicitly.
export instance Id<i32> {
  id(x: i32): i32 {
    x
  }
}
```

```typescript
// There is no `default` export.
import {*} from "./test.mo"; // Import everything from test.mo
import * as Test from "./test.mo"; // Import everything from test.mo and put it in the Test namespace
import { test } from "./test.mo"; // Import test function from test.mo
import { test as test2 } from "./test.mo"; // Import test function from test.mo and rename it to test2

import { Option } from "./test.mo"; // Import Option enum from test.mo
import { Option{Some, None} } from "./test.mo"; // Unwrap Some and None variant from Option enum from test.mo
import { Option{*} } from "./test.mo"; // Unwrap all variants from Option enum from test.mo

// All exported instances are implicitly imported.
import { id } from "./test.mo"; // Import `id` function from Id<i32> instance from test.mo
import { Id{id} } // Unwrap `id` function from Id<i32> instance from test.mo
import { Id{*} } // Unwrap all functions from Id<i32> instance from test.mo
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
let add = <T>(x: T)-> T {
  if T == i32 { // Type comparison
    x + 1
  } else if T == f32 {
    x + 1.0
  } else {
    x
  }
}

let mul = (x: i32, y: i32)-> i32 { x * y }

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

**Mo** currently compiles to C. We might support compiling to LLVM IR, JavaScript, and WebAssembly in the future.

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
