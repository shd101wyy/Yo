# Language Design

A multi-paradigm, general-purpose, compiled programming language that compiles to LLVM IR.

**Mo** language is has TypeScript-like syntax, combined with algebraic effects.

<!-- @import "[TOC]" {cmd="toc" depthFrom=1 depthTo=6 orderedList=false} -->

<!-- code_chunk_output -->

- [Language Design](#language-design)
  - [Philosophy](#philosophy)
  - [Hello World](#hello-world)
  - [CLI Usage](#cli-usage)
  - [Types](#types)
    - [Primitive Types (aka, Value Types), stored on stack](#primitive-types-aka-value-types-stored-on-stack)
    - [Variable Declaration](#variable-declaration)
    - [Reference Types, stored on heap](#reference-types-stored-on-heap)
  - [Mutability](#mutability)
  - [Ownership](#ownership)
    - [Ownership Operators](#ownership-operators)
      - [`read`/`write`](#readwrite)
      - [`move`](#move)
    - [Rust Examples of Ownership Operators](#rust-examples-of-ownership-operators)
  - [Lifetimes](#lifetimes)
  - [Control Flow](#control-flow)
  - [Type synonyms](#type-synonyms)
  - [Enum](#enum)
    - [Method](#method)
    - [Interface (Typeclass)](#interface-typeclass)
    - [Pattern Matching](#pattern-matching)
  - [Collections](#collections)
    - [Array](#array)
    - [String](#string)
    - [Map](#map)
  - [Slice](#slice)
  - [Error handling](#error-handling)
  - [Recoverable Errors with Result](#recoverable-errors-with-result)
  - [Test](#test)
  - [Reference](#reference)
  - [Raw Pointers (Dangerous)](#raw-pointers-dangerous)
  - [Smart Pointers](#smart-pointers)
  - [C Language FFI](#c-language-ffi)
  - [Do Notation](#do-notation)
  - [Error handling](#error-handling-1)
    - [Use `error`](#use-error)
    - [Use Exceptions](#use-exceptions)
  - [References](#references)

<!-- /code_chunk_output -->

## Philosophy

Pass by reference by default, unless it's the primitive types or has `Copy` interface implemented.

## Hello World

```typescript
import { console } from "std/io";

function main() {
  console.log("Hello World!");
}
```

## CLI Usage

```bash
moc hello.mo -o hello
```

## Types

### Primitive Types (aka, Value Types), stored on stack

- `boolean`
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

### Variable Declaration

```typescript
let x = 5; // x: i32, mutable
const y = 5; // y: i32, immutable
```

### Reference Types, stored on heap

```typescript
const myString: string = "Hello, world"; // Stored on stack
const myString: String = String.from("Hello, world"); // Stored on heap

const myArray: int[] = [1, 2, 3]; // Stored on stack
const myArray: Array<int> = Array.from([1, 2, 3]); // Stored on heap

const mySet: Set<int> = Set.from([1, 2, 3]); // Stored on heap
const myMap: Map<string, int> = Map.from([
  ["one", 1],
  ["two", 2],
]); // Stored on heap
```

## Mutability

```typescript
const foo: string = "Hello, world"; // Immutable
let bar = foo; // move the value from immutable to mutable

// console.log(foo); // error, as move occurred
console.log(bar); // "Hello, world"
```

## Ownership

```typescript
function main() {
  const foo = "Hello, world"; // "foo" is the owner of the value
} // "foo" is dropped here
```

Ownership can be borrowed to other scopes following either of the following rules:

- one ore more `read` references to a resource.
- exactly one `write` reference to a resource.

And we don't allow changes to the resource while it is borrowed.

### Ownership Operators

#### `read`/`write`

```typescript
function readFoo(foo: read String) {
  console.log(foo);
}
function writeFoo(foo: write String) {
  foo.push(", world");
}

function main() {
  let foo = String.from("Hello"); // "foo" is the owner of the value

  readFoo(foo); // "foo" is borrowed as read. 1/infinite read borrow
  // "foo" has 0/infinite read borrow

  writeFoo(foo); // "foo" is borrowed as write. 1/1 write borrow
  // "foo" has 0/1 write borrow

} // "foo" is dropped here
```

#### `move`

```typescript
function moveFoo(foo: String) {
  console.log(foo);
}

function main() {
  let foo = String.from("Hello"); // "foo" is the owner of the value

  moveFoo(foo); // "foo" is moved here
  // "foo" is dropped here

  // console.log(foo); // error, as move occurred
}
```

### Rust Examples of Ownership Operators

- `read`
  - mo
    ```typescript
    function read_foo(foo: read String) {
      console.log(foo);
    }
    ```
  - rust
    ```rust
    fn read_foo(foo: &String) {
      println!("{}", foo);
    }
    ```
- `write`
  - mo
    ```typescript
    function write_foo(foo: write String) {
      foo.push(", world");
    }
    ```
  - rust
    ```rust
    fn write_foo(foo: &mut String) {
      foo.push_str(", world");
    }
    ```
- `move`
  - mo
    ```typescript
    function move_foo(foo: String) {
      console.log(foo);
    }
    ```
  - rust
    ```rust
    fn move_foo(foo: String) {
      println!("{}", foo);
    }
    ```

## Lifetimes

```typescript
function longest[A](x: read[A] string, y: read[A] string): read[A] string {
  if (x.length > y.length) {
    x
  } else {
    y
  }
}

function main() {
  let string1 = String.from("abcd");
  {
    let string2 = "xyz";
    let result = longest(string1.asStr(), string2);
    console.log("The longest string is ", result);
  }
}

```

## Control Flow

```typescript
function main() {
  // If no return type, it is () unit
  const number = 3;

  if (number < 5) {
    console.log("condition was true");
  } else {
    console.log("condition was false");
  }
}
```

```typescript
function factorial(n: i32): i32 {
  let result = 1;
  for (let i = 1; i <= n; i++) {
    result *= i;
  }
  return result;
}
```

```typescript
function factorial(n: i32): i32 {
  let result = 1;
  while (n > 1) {
    result *= n;
    n -= 1;
  }
  return result;
}
```

## Type synonyms

```typescript
// Record
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
};
user.email = String.from("gg");

// NOTE:
// User({...}) is different from User({...}, )
```

## Enum

```typescript
// Typed
enum Option<T> {
  Some(T),
  None
}

export {
  Option(..)
};

const none: Option<i32> = None;
const some: Option<i32> = Some(42);

enum IpAddr {
  V4(u8, u8, u8, u8),
  V6(String)
}

const home = IpAddr.V4(127, 0, 0, 1);
const loopback = IpAddr.V6(String.from("::1"))
```

### Method

```typescript
type Rectangle = {
  width: i32;
  height: i32;
}

implement Rectangle {
  // `&self` is sugar for `self: &Self`, where `Self` is the type of the
  // caller object. In this case `Self` = `Rectangle`
  function area(): i32 {
    return this.width * this.height;
  }

  // If the first parameter is not `&self`, it is a static method
  static function new(): Rectangle {
    return Rectangle({
      width: 0,
      height: 0,
    });
  }
}

export {
  Rectangle
}

function main() {
  const rect1: Rectangle = { width: 30, height: 50 };
  console.log("The area of the rectangle is ", rect1.area());
}
```

### Interface (Typeclass)

```typescript
interface<T:Eq> Summary<T> {
  summarize: () => String;
}
implement Summary {
  // Default value
  function summarize(): String {
    return String.from("(Read more...)");
  }
}

type NewsArticle = {
  headline: String;
  location: String;
  author: String;
  content: String;
}

implement Summary<NewsArticle> for NewsArticle {
  function summarize(): String {
    return `${this.headline}, by ${this.author} (${this.location})`;
  }
}

// Pass in function
function notify(item: Summary) {
  console.log("Breaking news! ", item.summarize());
}

function notify(item: Summary & Display) {
  console.log("Breaking news! ", item.summarize());
  console.log("Breaking news! ", item.display());
}
```

### Pattern Matching

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
  switch (coin) {
    case Coin.Penny: {
      console.log("Lucky penny!");
      return 1;
    }
    case Coin.Nickel:
      return 5;
    case Coin.Dime:
      return 10;
    case Coin.Quarter:
      return 25;
    default:
      throw Error({
        message: "Not a coin", // Although this is not gonna happen
      });
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
function main() {
  throw Error({
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

import { open } from "std/fs"
function main() {
  const greetingFileResult = open("greeting.txt");

  switch (greetingFileResult) {
    case Ok(file): {
      console.log("The file was opened successfully");
    }
    case Err(error): {
      console.log("The file could not be opened");
      throw Error({
        message: error.message
      })
    }
  }
}
```

## Test

```typescript
import { expect, expectWithoutThrow } from "std/testing";
```

## Reference

> Use references wherever you can, and pointers wherever you must.

```typescript
const x: i32 = 1234;
const xRef: &const i32 = &x;

console.log("xRef points to the value ", xRef);
```

## Raw Pointers (Dangerous)

> Use references wherever you can, and pointers wherever you must.

```typescript
enum Ptr<T>{
  Ptr(T),
  NullPtr
}

const x: i32 = 1234;
const xPtr: Ptr<*i32> = Ptr(&x);
switch (xPtr) {
  case NullPtr: {
    console.log("xPtr is null");
  }
  case Ptr(x): {
    console.log("xPtr points to the value ", *x); // 1234
    *x = *x + 1;
    console.log("xPtr points to the value ", *x); // 1235
  }
}
```

## Smart Pointers

```typescript
const x = Box.new<i32>(1234);
console.log("x points to the value ", x);
```

## C Language FFI

```c
// cfuncs.c
#include "cfuncs.h"

int numAddTen(int v) {
  return v + 10;
}
```

```c
// cfuncs.h
#ifndef C_FUNCS_H
#define C_FUNCS_H

extern int numAddTen(int v);

#endif
```

```typescript
import { cImport } from "std/c";
const cFunctions = cImport("cfuncs.h", "cfuncs.c");

function main() {
  console.log(cFunctions.numAddTen(10));
}
```

## Do Notation

This is like the `async` and `await` in JavaScript.

```typescript
function main(): IO<()> do {
  fileContent <- fs.readFile("hello.txt");
  console.log(fileContent);
}

// equals to
function main(): IO<()> {
  fs.readFile("hello.text") >>= (fileContent) => console.log(fileContent);
}
```

```typescript
function main(): IO<()> do {
  result <- all([
    fs.readFile("hello.txt"),
    fs.readFile("world.txt"),
  ]);
  console.log(result);
}
```

## Error handling

> http://www.randomhacks.net/2007/03/10/haskell-8-ways-to-report-errors/  
> https://wiki.haskell.org/Handling_errors_in_Haskell

### Use `error`

```typescript

// error :: string -> a
function myDiv(x: i32, y: i32): i32 {
  if (y == 0) {
    error("Division by zero");
  } else {
    x / y;
  }
}

function example(x: i32, y: i32): IO<()> {
  putStrLn(show(myDiv(x, y))) `catch` (error) => {
    console.log("Caught error: ", error);
  }
}
```

### Use Exceptions

```typescript
enum MyError {
  DivisionByZero,
}
implement Exception for MyError {} // Use the default methods

function myDiv(x: i32, y: i32): i32 {
  if (y == 0) {
    throw(MyError.DivisionByZero);
  } else {
    x / y;
  }
}

function myDivIO(x: i32, y: i32): IO<i32> do {
  if (y == 0) {
    throwIO(MyError.DivisionByZero);
  } else {
    return x / y;
  }
}

function main(): IO<()> do {
  result <- try(myDivIO(10, 0));

  // or

  result <- try(evaluate(myDiv(10, 0)));

  switch (result) {
    case Ok(value): {
      console.log("The result is ", value);
    }
    case Err(error): {
      console.log("Caught error: ", error);
    }
  }
}
```

## References

- [Ocaml Locality](https://blog.janestreet.com/oxidizing-ocaml-locality/)
- [Data race freedom](https://github.com/ocaml-flambda/ocaml-jst/blob/main/jane/doc/proposals/data-race-freedom.md)
- [ICFP'21 Tutorials - Programming with Effect Handlers and FBIP in Koka](https://www.youtube.com/watch?v=6OFhD_mHtKA&ab_channel=ACMSIGPLAN)
