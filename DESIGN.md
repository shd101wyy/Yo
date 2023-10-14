# Language Design

<!-- @import "[TOC]" {cmd="toc" depthFrom=1 depthTo=6 orderedList=false} -->

<!-- code_chunk_output -->

- [Language Design](#language-design)
  - [Hello World](#hello-world)
  - [Types](#types)
    - [Primitive Types](#primitive-types)
  - [Control Flow](#control-flow)
  - [Struct](#struct)
    - [Struct method](#struct-method)
  - [Enum](#enum)
    - [Pattern Matching](#pattern-matching)
  - [Collections](#collections)
    - [Vector](#vector)

<!-- /code_chunk_output -->

## Hello World

```typescript
import { console } from "std/io";

function main() {
  console.log("Hello World!");
}
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

## Interface

```typescript
interface User {
  active: boolean;
  username: String;
  email: String;
  age: i32;
}

const user = User({
  active: true,
  username: String.from("johndoe"),
  email: String.from("test@gmail.com"),
});
user.email = String.from("gg");
```

### Interface method

```typescript
interface Rectangle {
  width: i32;
  height: i32;
}

implement Rectangle {
  function area(&self): i32 {
    return self.width * self.height;
  }

  static function new(width: i32, height: i32): Rectangle {
    return Rectangle({ width, height });
  }
}

function main() {
  const rect1 = Rectangle({ width: 30, height: 50 });
  console.log("The area of the rectangle is ", rect1.area());
}
```

### Trait

```typescript
trait Summary {
  summarize: (&self) => String;
}
implement Summary {
  // Default value
  function summarize(&self): String {
    return String.from("(Read more...)");
  }
}

interface NewsArticle {
  headline: String;
  location: String;
  author: String;
  content: String;
}

implement Summary for NewsArticle {
  function summarize(&self): String {
    return `${self.headline}, by ${self.author} (${self.location})`;
  }
}

// Pass in function
function notify(item: &Summary) {
  console.log("Breaking news! ", item.summarize());
}

function notify(item: &(Summary & Display)) {
  console.log("Breaking news! ", item.summarize());
  console.log("Breaking news! ", item.display());
}
```

## Enum

```typescript
enum Option<T> {
  Some(T),
  None,
}
type Some<T> = Option<T>.Some;
type None = Option<T>.None;

export {
  Option,
  Some,
  None
};

const none: Option<i32> = None;
const some: Option<i32> = Some(42);

enum IpAddr {
  V4(u8, u8, u8, u8),
  V6(String)
}

const home = IpAddrKind.V4(127, 0, 0, 1);
const loopback = IpAddr.V6(String.from("::1"))
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
  match (coin) {
    when (Coin.Penny): {
      console.log("Lucky penny!");
      return 1;
    }
    when (Coin.Nickel):
      return 5;
    when (Coin.Dime):
      return 10;
    when (Coin.Quarter):
      return 25;
    default:
      throw Error({
        message: "Not a coin" // Although this is not gonna happen
      });
  }
}
```

## Collections

### Array

```typescript
const v: Array<i32> = new Array();
const v2 = Array.from([1, 2, 3]);
const value = v2.at(0);
```

### String

```typescript
const s = new String();
const s2 = String.from("Hello World!");
```

### Map

```typescript
const m: Map<String, i32> = new Map();
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
  Ok(T),
  Err(E),
}

import { open } from "std/fs"
function main() {
  const greetingFileResult = open("greeting.txt");

  match (greetingFileResult) {
    when (Ok(file)): {
      console.log("The file was opened successfully");
    }
    when (Err(error)): {
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

## Pointers

```typescript
const x: i32 = 1234;
const xPtr = &x;
console.log("xPtr points to the value ", xPtr.*);

expectWithoutThrow(xPtr.* == x);
expectWithoutThrow(typeof(xPtr) == "const i32*");

let y: i32 = 4321;
const yPtr = &y;
console.log("yPtr points to the value ", yPtr.*);

expectWithoutThrow(yPtr.* == y);
expectWithoutThrow(typeof(yPtr) == "i32*");
```

## Smart Pointers

```typescript

```
