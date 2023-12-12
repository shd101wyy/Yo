# Language Design

**Mo** (墨) is minimal, general-purpose, functional (not pure), compiled programming language that compiles to LLVM IR and WASM.

**Mo** aims to be a simple to learn programming language. If you are familiar with TypeScript, you should be able to pick up **Mo** in 1 hour 😉.

**Mo** has a minimal syntax design that looks like TypeScript, and uses uniform call syntax (dot notation), brace elison to make the code more concise.

**Mo** is strong typed with a robust bidrectional type checker. **Mo** supports typeclass and instances, combined with algebraic effects and an efficient type system.

**Mo** supports advanced type system features such as generalized algebraic data types (GADT), dependent types, refinement types.

**Mo** has no garbage collector as it utilizes the [Linear Types](https://en.wikipedia.org/wiki/Substructural_type_system#:~:text=Linear%20types%20corresponds%20to%20linear,transitioned%20to%20a%20different%20state.) and implemented a strict borrow checker. The **Mo** compiler helps you eliminate potential errors before the code is executed.

Our goal is to be a practical language that is easy to use and easy to learn.

<!-- @import "[TOC]" {cmd="toc" depthFrom=1 depthTo=6 orderedList=false} -->

<!-- code_chunk_output -->

- [Language Design](#language-design)
  - [Inspiration](#inspiration)
  - [Hello World](#hello-world)
  - [CLI Usage](#cli-usage)
  - [Types](#types)
    - [Type](#type)
      - [`Free` Types](#free-types)
      - [`Linear` Types.](#linear-types)
    - [Region](#region)
    - [Variable Declaration](#variable-declaration)
    - [Type inference](#type-inference)
    - [Reference and Dereference](#reference-and-dereference)
  - [Function Declaration](#function-declaration)
    - [Uniform Function Call Syntax](#uniform-function-call-syntax)
    - [Function Overloading](#function-overloading)
    - [Dependent types `In Design`](#dependent-types-in-design)
    - [Refinement types `In Design`](#refinement-types-in-design)
  - [Mutability](#mutability)
  - [Borrow checker](#borrow-checker)
  - [Control Flow](#control-flow)
    - [Brace elision](#brace-elision)
      - [repeat](#repeat)
      - [while](#while)
      - [for](#for)
  - [Type synonyms](#type-synonyms)
  - [Enum (Algebraic Data Types)](#enum-algebraic-data-types)
    - [Generalized Algebraic Data Types (GADTs) `In Design`](#generalized-algebraic-data-types-gadts-in-design)
    - [Explicit enum variant type](#explicit-enum-variant-type)
    - [Subtyping](#subtyping)
  - [Typeclass](#typeclass)
    - [Implicit `drop` function on `Linear` types](#implicit-drop-function-on-linear-types)
  - [Pattern Matching](#pattern-matching)
  - [Collections](#collections)
    - [Array](#array)
    - [String](#string)
    - [Map](#map)
  - [Slice](#slice)
  - [Error handling](#error-handling)
  - [Recoverable Errors with Result](#recoverable-errors-with-result)
  - [`with` syntax](#with-syntax)
    - [with `function`](#with-function)
    - [with `enum`](#with-enum)
    - [with `variable`](#with-variable)
    - [with `record`](#with-record)
    - [with `effect` handler](#with-effect-handler)
    - [with `instance`](#with-instance)
  - [Algebraic effects](#algebraic-effects)
    - [Effect handler](#effect-handler)
      - [Matching on the Returned Value](#matching-on-the-returned-value)
      - [Resume Zero Times](#resume-zero-times)
      - [Resume Multiple Times](#resume-multiple-times)
      - [Multiple Effects](#multiple-effects)
    - [The `do` notation](#the-do-notation)
  - [Modules](#modules)
  - [Compile time execution `In Design`](#compile-time-execution-in-design)
  - [References](#references)

<!-- /code_chunk_output -->

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

## Hello World

```typescript
function main() {
  println("Hello World!");
}
```

## CLI Usage

```bash
moc hello.mo -o hello
moc hello.mo -arch wasm -o hello.wasm
```

## Types

A type can have the following **Kind**:

- Type
  - Free
  - Linear
- Region
- Effect

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

Linear types are types that can only be used once. For example, a `String` is a linear type as it can only be used once.  
The [Austral language](https://austral-lang.org/) has a very good explanation on the incentive of using [Linear Types](https://austral-lang.org/tutorial/linear-types).

### Region

A **Region** here is a block that specifies the lifetime of values.

Block `{...}` and function call `func(...)` create new regions.

**Mo** is explicit about the regions and lifetime of values.

```typescript
function factorial(x: i32): i32 { // Region 1
  let result = 1;

  while x > 1 { // Region 2
    result = result * x;
    x = x - 1;
  }

  result
}

function test(flag: boolean) { // Region 1
  if flag { // Region 2
    add()   // Region 3 for calling `add`
  } else {  // Region 4
    sub()   // Region 5 for calling `sub`

    {       // Region 6
      mul() // Region 7 for calling `mul`
    }
  }
}
```

### Variable Declaration

```typescript
const y = 5; // y: i32, immutable
let x = 5; // x: i32, mutable
```

### Type inference

```typescript
const mySymbol = @"Hi"; // Symbol. Free type

const myStrSlice: char[] = "Hello, world"; // Stored on stack. Free type

const myString: String = String.from("Hello, world"); // Stored on heap. Linear type.
const myString2 = myString; // myString2: String. Linear type. myString is moved and consumed. myString2 now takes the ownership.
const myString3 = myString; // Error: myString is already consumed.
const myString4: Reference<String> = myString2; // myString4: Reference<String, R> for some region R. Free type
const myString5 = myString4; // myString5: Reference<String, R> for some region R. Free type

const myInt = 1; // Stored on stack. Free type
const myInt2 = myInt; // myInt2: i32, Free type
const myInt3: Reference<i32> = myInt; // myInt3: Reference<i32, R> for some region R. Free type
const myInt4 = myInt3; // myInt4: Reference<i32, R> for some region R. Free type
const myInt5: i32 = myInt3; // myInt5: i32, Free type. We can automatically dereference the reference for Free type.
                                        // We can also cast type using `:`.
const myInt6 = (myInt: Reference<i32>); // myInt6: Reference<i32, R> for some region R. Free type.

const myIntSlice: int[] = [1, 2, 3]; // Stored on stack, with size 3. Free type
const myIntSlice: int[100] = [1, 2, 3]; // Stored on stack, with size 100. Free type
const myArray: Array<int> = Array.from([1, 2, 3]); // Stored on heap. Linear type.

const mySet: Set<int> = Set.from([1, 2, 3]); // Stored on heap. Linear type.
const myMap: Map<string, int> = Map.from([
  ["one", 1],
  ["two", 2],
]); // Stored on heap. Linear type.

enum Person { // Linear type.
  Person(name: String, age: i32)
}
const p = Person.Person(String.from("Alice"), 30); // p: Person. Linear type.
const { name, age } = p; // name: Reference<String, R> for some region R. Free type.
                       // age: Reference<i32, R>. Free type.
const name = p.name; // name: Reference<String, R> for some region R. Free type.
const name = (p.name: String); // Error: Cannot cast a linear type to a free type.

const age = p.age;   // age: Reference<i32, R>. Free type.
const age2: i32 = p.age; // age2: i32, Free type.
const age3 = (p.age: i32); // age3: i32, Free type.
```

### Reference and Dereference

A **reference** is a `Free` pointer to a `Linear` or `Free` value. References have a number of restrictions that preserve the linearity guarantees. There are two kinds of references:

- **Read references** allow you to read data from a linear value.
- **Read-write** or **mutable** references allow you to read from and write to a linear value.

```typescript
type Reference<T: Type, R: Region>;
// Or written as &<T, R> for short

type MutableReference<T: Type, R: Region>;
// Or written as &mut<T, R> for short
```

We can only dereference the free type.

```typescript
const name = String.from("Alice");
const p = Person.Person(name, 30); // p: Person. Linear type.

{
  const name = p.name; // name: Reference<String, R> for some region R. Free type.
  // Field of a linear type automatically becomes a reference.
  const name2: String = p.name; // Error: Cannot dereference a linear type.
  // const unwrapName = *name; // Error: Cannot dereference a linear type.

  const age = p.age; // Reference<i32, R> for some region R. Free type.
}
{
  const pRef = p; // pRef: Reference<Person, R> for some region R. Free type.
  const name = pRef.name; // name: Reference<String, R> for some region R. Free type.
  const name2: String = pRef.name; // Error: Cannot dereference a linear type.
  // const unwrapName = *name; // Error: Cannot dereference a linear type.

  const age = pRef.age; // Reference<i32, R> for some region R. Free type.
}
```

```typescript
let x = [1, 2, 3, 4, 5]; // x: i32[5]. Free type
let y = x; // y: i32[5]. Free type. x is copied to y, not moved.

let first = x[0]; // first: &mut<i32, R> for some region R. Free type
first = 10;

// x: [10, 2, 3, 4, 5]
// y: [1, 2, 3, 4, 5]
```

## Function Declaration

```typescript
function add(x: i32, y: i32): i32 {
  x + y
}

// Default parameter values
function add(x: i32 = 1, y: i32 = 2): i32 {
  x + y
}


// Arrow function
const add = (x: i32, y: i32): i32 => {
  x + y
};

// Generic function
function identity<T>(arg: T): T {
  arg
}

// Effectful function
function main(): () with Console {
  println("Hello, world");
}

// Curried function
function add(x: i32)(y: i32): i32 {
  x + y
}
const addOne = add(1);
addOne(2); // 3

// Value constraint, type constraint, and effect constraint
function divide(x: i32, y: i32 where y != 0): i32 {
  x / y
}
function add<T: Type>(x: T, y: T): T
with Console, Integral<T> {
  println(x + y)
}
```

### Uniform Function Call Syntax

```typescript
function addOne(x: i32): i32 {
  x + 1;
}

(12).addOne(); // 13
// is equalvalent to
addOne(12); // 13
```

### Function Overloading

**Mo** allows function overloading by checking the first argument type.

For example, below is allowed:

```typescript
function show(x: i32) {
  println(x);
}
function show(x: string) {
  println(x);
}
```

### Dependent types `In Design`

Dependent types are types which depend on values.

```typescript
function dependOnBoolean(b: boolean): i32
where b == true
{
  1
}
function dependOnBoolean(b: boolean): f32
where b == false
{
  1.0
}

dependOnBoolean(true); // 1
dependOnBoolean(false); // 1.0
dependOnBoolean(returnBoolean()); // Compiler Error: value constraint not satisfied for both `dependOnBoolean` functions
```

```typescript
function divide(x: i32, y: i32): i32
where y != 0
{
  x / y
}

function main() {
  const x = readInt();
  const y = readInt();
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
function makeArray(size: i32): Array<i32>
where size < 10 && size > 0 {
  return Array<i32>.new(size)
}

function main() {
  const size = readInt()
  if size < 10 && size > 0 {
    const arr = makeArray(size) // The function is guaranteed to return an array of size between 1 and 9
  } else {
    makeArray(size) // Compiler Error: size is not between 1 and 9
  }
}
```

```typescript
function inBetween(x: i32, min: i32, max: i32): boolean
where min < max && x >= min
{
  true
}
function main() {
  const x = readInt();
  const min = readInt();
  const max = readInt();
  if min < max && x >= min {
    inBetween(x, min, max);
  } else {
    inBetween(x, min, max); // Compiler Error: Predicate not satisfied.  
  }
}
```

## Mutability

The builtin `=` function is used to update a `MutableReference`, with the following signature:

```typescript
function (=)<T>(ref: MutableReference<T, R>, value: T): T;
x = x + 1
```

Below is an example of updating a field of a linear type:

```typescript
enum Person { // Linear type.
  Person(name: String, age: i32)
}
let p = Person.Person(String.from("Alice"), 30); // p: Person. Linear type.

// Update the field
const oldName = (p.name = String.from("Bob"));
// oldName is the `value` moved out.
// oldName == String.from("Alice")

let myInt = 1;
let myInt2: Reference<i32> = myInt;
const myInt3: i32 = myInt2;
myInt = 2;
// myInt == 2
// myInt2 == 2
// myInt3 == 1
```

## Borrow checker

> This is similar to the borrow checker in Rust, but stricter.

First, any borrow must last for a scope no greater than that of the owner. Second, you may have one or the other of these two kinds of borrows, but not both at the same time:

- One or more references (`&<T>`) to a resource.
- Exactly one mutable reference (`&mut<T>`).

Example:

- Cannot have two mutable references to the same value [E0499](https://doc.rust-lang.org/error_codes/E0499.html).

```typescript
function main() {
  let x = 1;
  let y: MutableReference<i32> = x;
  let z: MutableReference<i32> = x; // Compiler Error: Cannot borrow `x` as mutable more than once at a time.
}
```

- Cannot have an immutable reference while we have a mutable one [E0502](https://doc.rust-lang.org/error_codes/E0502.html).  
  Cannot have a mutable reference while we have an immutable one [E0502](https://doc.rust-lang.org/error_codes/E0502.html).

```typescript
function main() {
  let x = 1;
  let y: MutableReference<i32> = x;
  let z: Reference<i32> = x; // Compiler Error: Cannot borrow `x` as immutable because it is also borrowed as mutable.
}
```

```typescript
function main() {
  let x = 1;
  let y: Reference<i32> = x;
  let z: MutableReference<i32> = x; // Compiler Error: Cannot borrow `x` as mutable because it is also borrowed as immutable.
}
```

- Cannot use the value while it's borrowed [E0503](https://doc.rust-lang.org/error_codes/E0503.html).

```typescript
function main() {
  let x = 1;
  let y: MutableReference<i32> = x;
  let _sum = x + 1; // Compiler Error: A value was used after it was mutably borrowed.
}
```

- Cannot consume (move) the value while it's borrowed [E0505](https://doc.rust-lang.org/error_codes/E0505.html), [E0504](https://doc.rust-lang.org/error_codes/E0503.html).

```typescript
function main() {
  const x = String.from("Hello");
  const y: Reference<String> = x;
  consume(x); // Compiler Error: A value was moved out while it was still borrowed.
}
```

```typescript
function main() {
  const x = String.from("Hello");
  const y: Reference<String> = x;

  let z = move ()=> {
    println(x); // Compiler Error: Cannot move `x` into closure because it is borrowed.
  }
}
```

- Cannot assign to the value while it's borrowed [E0506](https://doc.rust-lang.org/error_codes/E0506.html).

```typescript
function main() {
  let x = 1;
  const y: Reference<i32> = x;
  x = 2; // Compiler Error: An attempt was made to assign to a borrowed value
}
```

## Control Flow

```typescript
function main() {
  // If no return type, it is () unit
  const number = 3;

  if number < 5 {
    println("condition was true");
  } else {
    println("condition was false");
  }
}
```

### Brace elision

#### repeat

```typescript
function factorial(n: i32): i32 {
  let result = 1;
  repeat (n) (i)=> {
    result = result * i;
  }
  return result;
}

// is equalvalent to
function factorial(n: i32): i32 {
  let result = 1;
  repeat(n, (i)=> {
    result = result * i
  })
  return result;
}
```

#### while

```typescript
function factorial(n: i32): i32 {
  let m = n;
  let result = 1;
  while {m > 1} {
    result = result * m; // `=` is used to update a mutable reference
    m = m - 1;
  }
  result
}

// is equavalent to

function factorial(n: i32): i32 {
  let m = n;
  let result = 1;
  while(()=> {
    m > 1
  }, ()=> {
    result = result * m; // `=` is used to update a mutable reference
    m = m - 1;
  })
  result
}
```

#### for

```typescript
function print10() {
  for(1, 10) (i)=> {
    println(i);
  }
}

// is equalvalent to

function print10() {
  for(1, 10, (i)=> {
    println(i);
  })
}
```

## Type synonyms

```typescript
// Record
@derive([Show])
type User = {
  active: boolean;
  username: String;
  email: String;
  age: i32;
};

type string = char[];

const user: User = {
  active: true,
  username: String.from("johndoe"),
  email: String.from("test@gmail.com"),
  age: 13
};
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

## Enum (Algebraic Data Types)

```typescript
enum Option<T> {
  Some(value: T),
  None
}

const none: Option<i32> = None;
const some: Option<i32> = Some(42);

enum IpAddr {
  V4(v0: u8 = 255, v1: u8 = 255, v2: u8 = 255, v3: u8 = 255),
  V6(v: String)
}


const home = V4(127, 0, 0, 1);
const anotherHome = V4(v3 = 200);
const loopback = V6(String.from("::1"))
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
  if expr is IntExpr(i) {
    i
  } else if expr is BoolExpr(b) {
    b
  } else if expr is EqExpr(left, right) {
    eval(left) == eval(right)
  }
}

const expr1 : Expr<boolean> = EqExpr(IntExpr(1), IntExpr(2));
eval(expr1); // false
```

### Explicit enum variant type

```typescript
const x: Option = Some(1); // x: Option<i32>.Some
                           // .Some means the variant type is Some

function unwrap<T>(x: Option<T>.Some): T {
  x.value
}
unwrap(x); // 1
unwrap(None); // Won't compile. None is not a Some variant.
```

### Subtyping

```typescript
enum Option<T> {
  Some(value: T),
  None
}

function printValue<T>(x: {value: T}) {
  println(x.value);
}

function main() {
  printValue<i32>({value: 12});

  const x = Some(12);
  printValue(x); // This is allowed

  const y = None;
  printValue(y); // This is not allowed as `None` does not have `value` field
}


```

## Typeclass

```typescript
class Summary<T> with Eq<T> { // Type constraint
  summarize(self: T): String;
}

class Display<T> with Summary<T> { // Type constraint
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
function notify(item: NewsArticle) {
  println("Breaking news! ", item.summarize());
}

function notify<T>(item: T) with Display<T> {
  println("Breaking news! ", item.summarize());
  println("Breaking news! ", item.display());
}
```

### Implicit `drop` function on `Linear` types

```typescript
class Drop<T: Linear> {
  drop(self: T): ();
}

function main() {
  const x = String.from("Hello");

  // If `x` is not consumed, it will be dropped at the end of the scope implicitly.
  // drop(x); // This will be called implicitly.
}
```

## Pattern Matching

Pattern matching using `is` keyword.

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
function valueInCents(coin: Coin): u8 {
  if coin is Coin.Penny {
    println("Lucky penny!");
    return 1;
  } else if coin is Coin.Nickel {
    return 5;
  } else if coin is Coin.Dime {
    return 10;
  } else if coin is Coin.Quarter {
    return 25;
  } else {
    throw Error({
      message: "Not a coin", // Although this is not gonna happen
    });
  }
}

enum List<T> {
  Nil,
  Cons(head: T, tail: Box<List<T>>),
}

/*
function ListLength<T>(list: List<T>): i32 {
  with List<T>; // Unwrap the enum
  if list is Nil {
    0
  } else if list is Cons(_, tail) {
    1 + ListLength(tail);
  }
}

// or

function ListLength<T>(list: List<T>): i32 {
  with List<T>; // Unwrap the enum
  if list is Nil {
    0
  } else if list is Cons {tail} {
    1 + ListLength(tail);
  }
}

// or
*/

function ListLength<T>(list: List<T>): i32 {
  // with List<T>; // Unwrap the enum
  if list is Nil {
    0
  } else if list is Cons {
    1 + ListLength(list.tail);
  }
}
```

## Collections

### Array

```typescript
const v: Array<i32> = Array.new();
const v2 = Array.from([1, 2, 3]);
const value = v2.at(0);
```

### String

```typescript
const s = String.new();
const s2 = String.from("Hello World!");
```

### Map

```typescript
const m: Map<String, i32> = Map.new();
const m2 = Map.from([
  [String.from("one"), 1],
  [String.from("two"), 2],
  [String.from("three"), 3],
]);

m.set(String.from("one"), 1);
```

## Slice

```typescript
const x: string = "Hello, world";
const xs: i32[5] = [1, 2, 3, 4, 5];
const emptyArray: i32[0] = [];
```

## Error handling

```typescript
function main(): () with Exception {
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
function main() {
  const greetingFileResult = open("greeting.txt");

  if greetingFileResult is Ok(file) {
    println("The file was opened successfully");
  } else if greetingFileResult is Err(error) {
    println("The file could not be opened: ${error}");
  }

  drop(greetingFileResult);
}
```

## `with` syntax

### with `function`

```typescript
function test() {
  with finally {
    println("finally");
  }
  println("start");
}

// Translates to

function test() {
  finally(()=> {
    println("finally");
  }, ()=> {
    println("start");
  });
}
```

### with `enum`

```typescript
enum Coin {
  Penny,
  Nickel,
  Dime,
  Quarter,
}
// without `with`
function test() {
  if coin is Coin.Penny {
    1
  } else if coin is Coin.Nickel {
    5
  } else if coin is Coin.Dime {
    10
  } else if coin is Coin.Quarter {
    25
  }
}

// with `with`
function test() {
  with Coin;
  if coin is Penny {
    1
  } else if coin is Nickel {
    5
  } else if coin is Dime {
    10
  } else if coin is Quarter {
    25
  }
}
```

### with `variable`

Moreover, a `with` statement can also bind a variable parameter as:

```typescript
function test() {
  with
    x <- 1
    y <- 2
  x + y
}

// Translate to
function test() {
  f(1, 2, (x, y)=> {
    x + y
  })
}
```

### with `record`

`with` can also be used to destruct a record:

```typescript
function test() {
  with { x: 1, y: 2 }
  x + y
}
```

### with `effect` handler

```typescript
function catchException() {
  with handler Exception {
    throw(error) {
      println("Exception caught", error);
    }
  }
  divide(1, 0);
}
```

### with `instance`

```typescript
class Show<T> {
  show(x: T): string;
}

instance Show<i32> {
  show(i32): string {
    x.toString()
  }
}

function testShow<T>(x: T) {
  with Show<T>;
  x.show();
}

function main() {
  testShow<i32>(12);
}
```

## Algebraic effects

Algebraic effect is defined using the `effect` keyword.

```typescript
effect Raise {
  raise(msg: String): ();
}
```

### Effect handler

The `resume` is only available in the effect handler.
You can use the `resume` keyword in effect handler to resume the execution.

```typescript
effect Raise<T> {
  raise(msg: String): T;
}

function safeDivide(x: i32, y: i32): i32 with Raise {
  if y == 0 {
    raise("Cannot divide by 0");
  } else {
    x / y
  }
}

function handle() {
  with handler Raise {
    raise(msg) {
      resume(42)
    }
  }
  8 + do safeDivide(1, 0) + 10 // 60
}
```

#### Matching on the Returned Value

```typescript
function handle(): boolean {
  with handler Raise {
    raise(msg) {
      resume(42)
    },
    return(value) {
      value == 42
    }
  }
  do safeDivide(1, 0) // true
}
```

#### Resume Zero Times

The effect handler may also choose not to resume at all, simply by not calling `resume`:

```typescript
function handle() {
  with handler Raise {
    raise(msg) {
      42
    }
  }
  8 + do safeDivide(1, 0) + 10 // 42
}
```

#### Resume Multiple Times

> Aka, Multishot delimited continuations.

```typescript
effect Choice {
  choice(): boolean;
}

function xor(): boolean with Choice {
  const p = choice();
  const q = choice();
  if p then !q else q
}

function choiceAll(action: ()=> boolean with Choice): List<boolean> {
  with handler Choice {
    return(x): {
      [x]
    },
    choice() {
      resume(false) ++ resume(true)
    }
  }
  do action()
}

choiceAll(xor) // [false, true, true, false]

// (a = choice(); b = choice(); if a then !b else b)
// (a = false; b = choice(); if false then !b else b)
// (a = false; b = false; if false then !b else b)
// (a = false; b = false; b)
// (a = false; false)
// (false)
// (a = false; b = choice(); if false then !b else b)
// (a = false; b = true; if false then !b else b)
// (a = false; b = true; b)
// (a = false; true)
// (true)
// (a = choice(); b = choice(); if a then !b else b)
// (a = true; b = choice(); if true then !b else b)
// (a = true; b = false; if true then !b else b)
// (a = true; b = false; !b)
// (a = true; true)
// (true)
// (a = choice(); b = choice(); if a then !b else b)
// (a = true; b = choice(); if true then !b else b)
// (a = true; b = true; if true then !b else b)
// (a = true; b = true; !b)
// (a = true; false)
// (false)
// [false, true, true, false]
```

```typescript
effect GiveInt {
  giveInt(i: i32): i32
}

function useEffect(): i32 with GiveInt {
  giveInt(2) + giveInt(4)
}

function handle(): i32 with Console {
  with handler GiveInt {
    giveInt(i: i32) {
      println("give-int ${i}")
      resume(i) + resume(i)
    }
  }
  do useEffect() // 4
}
```

#### Multiple Effects

```typescript
effect GiveInt {
  giveInt(i: i32): i32
}
effect GiveBool {
  giveBoolean(b: boolean): i32
}
function useEffects(): i32 with GiveInt, GiveBool {
  giveInt(2) + giveBoolean(true)
}
function handleMultipleEffects(): i32 with Console {
  with handler GiveInt { // Outer handler will `return` after
    return(i) {
      println("return give-int ${i}")
      i + 3
    }
    giveInt(i) {
      resume(i)
    }
  }
  with handler GiveBool { // Inner handler will `return` first
    return(b) {
      println("return give-bool ${b}")
      b + 4
    }
    giveBoolean(b) {
      if b { resume(1) } else { resume(0) }
    }
  }
  do useEffects()
}
// return give-bool 3
// return give-int 7
// 10

```

### The `do` notation

The `do` notation is used to apply the effect handler to the effectful function. Check [./koka/do.md](./koka/do.md).

For example:

```typescript
function handle() {
  with handler Raise {
    return(x) { x }
    raise(msg, /* resume */) {
      resume(42)
    }
  }

  8 + do safeDivide(1, 0) + 10 // 60

  // is equavalent to:

  (({raise, return}: Raise as raiseRandler )=> {
    safeDivide(1, 0, raiseHandler, (x) => {
      return(8 + x + 10)
    })
  })(handler Raise {
    return(x) { x }
    raise(msg, /* resume */) {
      resume(42)
    }
  })
}
```

## Modules

Same as the ECMAScript modules, we use the `import` and `export` keywords to import and export modules. The syntax is extended a bit.

```typescript
import { copy } from "https://github.com/mo-lang/mo/std/fs.mo";

function test() {
  println("Hello, world!");
}

export { test, copy };

export enum Option<T> {
  Some(value: T),
  None,
}

export instance Id<i32> {
  id(x: i32): i32 {
    x
  }
}
```

```typescript
// There is no `default` export.
import "./test.mo"; // Import everything from test.mo
import * as Test from "./test.mo"; // Import everything from test.mo and put it in the Test namespace
import { test } from "./test.mo"; // Import test function from test.mo
import { test as test2 } from "./test.mo"; // Import test function from test.mo and rename it to test2

import { Option } from "./test.mo"; // Import Option enum from test.mo
import { Option{Some, None} } from "./test.mo"; // Unwrap Some and None variant from Option enum from test.mo
import { Option{*} } from "./test.mo"; // Unwrap all variants from Option enum from test.mo

// All exported instances are implicitly imported.
import { id } from "./test.mo"; // Import `id` function from Id<i32> instance from test.mo
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
function add<T>(x: T): T {
  if T == i32 { // Type comparison
    x + 1
  } else if T == f32 {
    x + 1.0
  } else {
    x
  }
}

function mul(x: i32, y: i32): i32 { x * y }

const x: i32[#mul(2, 3)] = 6;
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
