# Language Design

<!-- @import "[TOC]" {cmd="toc" depthFrom=1 depthTo=6 orderedList=false} -->

<!-- code_chunk_output -->

- [Language Design](#language-design)
  - [Hello World](#hello-world)
  - [Types](#types)
    - [Primitive Types](#primitive-types)
  - [Control Flow](#control-flow)
  - [Type](#type)
    - [Type alias](#type-alias)
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

<!-- /code_chunk_output -->

## Philosophy

Pass by reference by default, unless it's the primitive types or has `Copy` interface implemented.

## Hello World

```typescript
import { console } from "std/io";

console.log("Hello World!");
```

## Types

### Primitive Types

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
const s = String.from("Hello World!");
const hello = &s[0..5];
const world = &s[6..11];

const xs: [i32; 5] = [1, 2, 3, 4, 5];
const emptyArray: [i32; 0] = [];
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
console.log("x points to the value ", x.*);
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
function main(): Effect<()> do {
  fileContent <- fs.readFile("hello.txt");
  console.log(fileContent);
}
```
