# Language Design

**Mo** (墨) is minimal, general-purpose, compiled programming language that compiles to LLVM IR and WASM.

**Mo** aims to be a simple to learn programming language. If you are familiar with JavaScript, you should be able to pick up **Mo** in 30 minutes.

The **Mo** language is heavily inspired by:

- [TypeScript](https://www.typescriptlang.org/)
  - Syntax and semantics
- [Rust](https://www.rust-lang.org/)
  - Traits
  - Borrow checker
- [Koka](https://koka-lang.github.io/)
  - Brace elision
  - Dot notation (Uniform Function Call Syntax)
  - Perceus and reuse
  - Algebraic effects
- [Austral](https://austral-lang.org/)
  - Linear types
  - Borrowing
- [Python](https://python.org/)
  - Keyword arguments
- [Haskell](https://www.haskell.org/)
  - Type and typeclass
- [C++](https://isocpp.org/)
  - Reference
- [Scheme](https://www.scheme.com/)
  - `set!`
- [Zig](https://ziglang.org/)
  - Compile time execution

The **Mo** language has a minimal syntax design that looks like TypeScript. **Mo** is strong typed with a robust bidrectional type checker, combined with algebraic effects and an efficient type system. **Mo** has no garbage collector as it utilizes the Linear Types and implemented a strict borrow checker.

Our goal is to be a practical language that is easy to use and easy to learn.

<!-- @import "[TOC]" {cmd="toc" depthFrom=1 depthTo=6 orderedList=false} -->

<!-- code_chunk_output -->

- [Language Design](#language-design)
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
  - [Mutability](#mutability)
  - [Borrow checker](#borrow-checker)
  - [Control Flow](#control-flow)
    - [Loop](#loop)
      - [while](#while)
    - [Brace elision](#brace-elision)
      - [repeat](#repeat)
      - [for](#for)
  - [Type synonyms](#type-synonyms)
  - [Enum (Algebraic Data Types)](#enum-algebraic-data-types)
    - [Generalized Algebraic Data Types (GADTs)](#generalized-algebraic-data-types-gadts)
    - [Explicit enum variant type](#explicit-enum-variant-type)
    - [Subtyping](#subtyping)
    - [Traits](#traits)
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
    - [with `effect`](#with-effect)
    - [with `instance`](#with-instance)
  - [Effect handler](#effect-handler)
  - [Modules](#modules)
  - [Compile time execution `In Design`](#compile-time-execution-in-design)
    - [Dependent types & Refinement types](#dependent-types--refinement-types)
  - [References](#references)

<!-- /code_chunk_output -->

## Hello World

```typescript
import * as console from "std/console";

function main() {
  console.log("Hello World!");
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

A **Region** here is a code block that specifies the lifetime of values.

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
const p = Person.Person(move name, 30); // p: Person. Linear type.

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
// We use T as the type parameter name for Type. It's an abbreviation of T: Type
// We use 'R as the type parameter name for Region. It's an abbreviation of R: Region

// Effectful function
function main(): ()
with Console {
  console.log("Hello, world");
}

// Curried function
function add(x: i32)(y: i32): i32 {
  x + y
}
const addOne = add(1);
addOne(2); // 3

// Value constraint, type constraint, and effect constraint
function divide(x: i32, y: i32): i32
where y != 0 // Value constraint
{
  x / y
}
function add<T>(x: T, y: T): T
with Integral<T>
{
  x + y
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
  console.log(x);
}
function show(x: string) {
  console.log(x);
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
  let z: MutableReference<i32> = x; // Error: Cannot borrow `x` as mutable more than once at a time.
}
```

- Cannot have an immutable reference while we have a mutable one [E0502](https://doc.rust-lang.org/error_codes/E0502.html).  
  Cannot have a mutable reference while we have an immutable one [E0502](https://doc.rust-lang.org/error_codes/E0502.html).

```typescript
function main() {
  let x = 1;
  let y: MutableReference<i32> = x;
  let z: Reference<i32> = x; // Error: Cannot borrow `x` as immutable because it is also borrowed as mutable.
}
```

```typescript
function main() {
  let x = 1;
  let y: Reference<i32> = x;
  let z: MutableReference<i32> = x; // Error: Cannot borrow `x` as mutable because it is also borrowed as immutable.
}
```

- Cannot use the value while it's borrowed [E0503](https://doc.rust-lang.org/error_codes/E0503.html).

```typescript
function main() {
  let x = 1;
  let y: MutableReference<i32> = x;
  let _sum = x + 1; // Error: A value was used after it was mutably borrowed.
}
```

- Cannot consume (move) the value while it's borrowed [E0505](https://doc.rust-lang.org/error_codes/E0505.html), [E0504](https://doc.rust-lang.org/error_codes/E0503.html).

```typescript
function main() {
  const x = String.from("Hello");
  const y: Reference<String> = x;
  consume(x); // Error: A value was moved out while it was still borrowed.
}
```

```typescript
function main() {
  const x = String.from("Hello");
  const y: Reference<String> = x;

  let z = move ()=> {
    console.log(x); // Error: Cannot move `x` into closure because it is borrowed.
  }
}
```

- Cannot assign to the value while it's borrowed [E0506](https://doc.rust-lang.org/error_codes/E0506.html).

```typescript
function main() {
  let x = 1;
  const y: Reference<i32> = x;
  x = 2; // Error: An attempt was made to assign to a borrowed value
}
```

## Control Flow

```typescript
function main() {
  // If no return type, it is () unit
  const number = 3;

  if number < 5 {
    console.log("condition was true");
  } else {
    console.log("condition was false");
  }
}
```

### Loop

#### while

```typescript
function factorial(n: i32): i32 {
  let m = n;
  let result = 1;
  while m > 1 {
    result = result * m; // `=` is used to update a mutable reference
    m = m - 1;
  }
  result
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

#### for

```typescript
function print10() {
  for(1, 10) (i)=> {
    console.log(i);
  }
}

// is equalvalent to

function print10() {
  for(1, 10, (i)=> {
    console.log(i);
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

// This will translate to code similar as below,
// but like the `struct` in C:
type Option<T> =
  | {__typename: @"Some", v: T}
  | {__typename: @"None"}
trait Option<T> {
  Some(v: T): Option<T> {
    return {__typename: @"Some", v: v};
  },
  None(): Option<T> {
    return {__typename: @"None"};
  }
}

with Option<i32>; // Unwrap the enum
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

### Generalized Algebraic Data Types (GADTs)

```typescript
enum Expr<T> {
  IntExpr(i: i32): Expr<i32>,
  BoolExpr(b: boolean): Expr<boolean>,
  EqExpr(left: Expr<i32>, right: Expr<i32>): Expr<boolean>
}

function eval<T>(expr: Expr<T>): T {
  with Expr<T>;
  if expr is IntExpr(i) {
    i
  } else if expr is BoolExpr(b) {
    b
  } else if expr is EqExpr(left, right) {
    eval(left) == eval(right)
  }
}

const expr1 : Expr<boolean> = Expr<boolean>.EqExpr(IntExpr(1), IntExpr(2));
eval(expr1); // false
```

### Explicit enum variant type

```typescript
const x: Option = Some(1); // x: Option<i32>.Some
                           // .Some means the variant type is Some

function unwrap<T>(x: Option<T>.Some): T {
  x.value
}
```

### Subtyping

```typescript
enum Option<T> {
  Some(value: T),
  None
}

function printValue<T>(x: {val: T}) {
  console.log(x.val);
}

function main() {
  printValue<i32>({val: 12});

  const x = Option<i32>.Some(12);
  printValue(x); // This is allowed

  const y = Option<i32>.None;
  printValue(y); // This is not allowed as `None` does not have `val` field
}


```

### Traits

```typescript
trait Summary<T>
with Eq<T> { // Type constraint
  summarize(self: T): String;
}

trait Display<T>
with Summary<T> { // Type constraint
  display(self: T): String;
}

type NewsArticle = {
  headline: String;
  location: String;
  author: String;
  content: String;
};

// Implement the trait
instance Summary<NewsArticle> {
  summarize(self: NewsArticle): String {
    "${self.headline}, by ${self.author} (${self.location})";
  }
}

// Pass in function
function notify(item: NewsArticle)
with Summary<NewsArticle>{ summarize }; // Type constraint
                                          // require `summarize` function exists
{
  console.log("Breaking news! ", item.summarize());
}

function notify<T>(item: T)
with Display<T>; // Type constraint
 {
  console.log("Breaking news! ", item.summarize());
  console.log("Breaking news! ", item.display());
}
```

### Pattern Matching

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
    console.log("Lucky penny!");
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
  with List<T>; // Unwrap the enum
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
function main(): [Exception] {
  throw {
    message: "Something went wrong",
  };
}
```

## Recoverable Errors with Result

```typescript
enum Result<T, E> {
  Ok(T)
  Err(E)
}

import { open } from "std/fs"
function main() {
  const greetingFileResult = open("greeting.txt");

  if greetingFileResult is Ok(file) {
    console.log("The file was opened successfully");
  } else if greetingFileResult is Err(error) {
    console.log("The file could not be opened");
    throw Error({
      message: error.message
    })
  }
}
```

## `with` syntax

### with `function`

```typescript
function test() {
  with finally {
    console.log("finally");
  }
  console.log("start");
}

// Translates to

function test() {
  finally(()=> {
    console.log("finally");
  }, ()=> {
    console.log("start");
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

### with `effect`

```typescript
function catchException() {
  with Exception {
    throw(error) {
      console.log("Exception caught", error);
    }
  }
  divide(1, 0);
}
```

### with `instance`

```typescript
trait Show<T> {
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

## Effect handler

NOTE: Mo only support tail-resumptive effect handler.  
You can use the `resume` keyword to resume the execution.  
Or the return value of the effect handler will be used to resume the execution.

```typescript
effect MyConsole {
  log(message: string): () with MyConsole;
}

function useMyConsole(x: string): () with MyConsole {
  log(x);
}

function tryUseMyConsole(): () with Console {
  with MyConsole {
    log(message) {
      console.log(message);
      resume ();
    }
  }
  do useMyConsole("Hello, world!");
}
```

Async/Await

```typescript
effect MyAff {
  delay(ms: i32): () with MyAff;
}

function useMyAff(x: string): () with MyAff, Console {
  do delay(1000);
  console.log(x);
}

// or
function tryUseMyAff(): () with Console {
  with MyAff {
    delay(ms) {
      setTimeout(() => {
        resume ();
      }, ms);
    }
  }
  const task1 = useMyAff("This is task 1");
  const task2 = useMyAff("This is task 2");
  const result = do parallel([task1, task2])
  ()
}
```

## Modules

Same as the ECMAScript modules, we use the `import` and `export` keywords to import and export modules.

```typescript
import { copy } from "https://github.com/mo-lang/mo/std/fs.m";

function test() {
  console.log("Hello, world!");
}

export { test, copy };
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

### Dependent types & Refinement types

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
```

```typescript
function makeArray(size: i32): Array<i32>
where size < 10 && size > 0 {
  return new Array<i32>(size)
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
function divide(x: i32, y: i32): i32
where y != 0 {
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

## References

- [Ocaml Locality](https://blog.janestreet.com/oxidizing-ocaml-locality/)
- [Data race freedom](https://github.com/ocaml-flambda/ocaml-jst/blob/main/jane/doc/proposals/data-race-freedom.md)
- [ICFP'21 Tutorials - Programming with Effect Handlers and FBIP in Koka](https://www.youtube.com/watch?v=6OFhD_mHtKA&ab_channel=ACMSIGPLAN)
- [Simply Easy! An Implementation of a Dependently Typed Lambda Calculus](http://strictlypositive.org/Easy.pdf)
- [Reconstructing TypeScript](https://jaked.org/blog/2021-09-07-Reconstructing-TypeScript-part-0)
- [PureScript Types](https://github.com/purescript/documentation/blob/master/language/Types.md)
- [The Ultimate Conditional Syntax](https://icfp22.sigplan.org/details/mlfamilyworkshop-2022-papers/6/The-Ultimate-Conditional-Syntax)
