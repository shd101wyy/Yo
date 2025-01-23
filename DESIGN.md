# Language Design

**Mo** 墨 🐼 is minimal, general-purpose, compiled programming language that incorporates the Linear Types.

**Mo** aims to be a simple to learn programming language. If you are familiar with TypeScript, you should be able to pick up **Mo** in 1 hour 😉.

**Mo** has a minimal syntax design that looks like TypeScript, and uses uniform call syntax (dot notation)~~, brace elison~~ to make the code more concise.

**Mo** (will &) tend to support advanced type system features such as generalized algebraic data types (GADT), dependent types, refinement types. `In Design`

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
  - [Contextual parameters, aka implicit parameters](#contextual-parameters-aka-implicit-parameters)
    - [Compiletime](#compiletime)
    - [Runtime](#runtime)
    - [Algebraic effects `In Design`](#algebraic-effects-in-design)
  - [Uniform Function Call Syntax](#uniform-function-call-syntax)
  - [`defer`](#defer)
  - [`recur` `In Design`](#recur-in-design)
  - [Custom Operators](#custom-operators)
  - [Mulitple Return Values `In Design`](#mulitple-return-values-in-design)
- [Duck Typing `In Design`](#duck-typing-in-design)
- [Array & Slice](#array--slice)
- [Closure `In Design`](#closure-in-design)
- [Mutability `To be updated`](#mutability-to-be-updated)
- [Generic](#generic)
  - [Type parameters](#type-parameters)
  - [Type constraints](#type-constraints)
- [Control Flow](#control-flow)
  - [if/else](#ifelse)
  - [while](#while)
  - [for](#for)
- [Type synonyms](#type-synonyms)
- [Enum (Algebraic Data Types)](#enum-algebraic-data-types)
  - [Generalized Algebraic Data Types (GADTs) `In Design`](#generalized-algebraic-data-types-gadts-in-design)
- [Advanced Types `In Design`](#advanced-types-in-design)
  - [Dependent types `In Design`](#dependent-types-in-design)
  - [Refinement types `In Design`](#refinement-types-in-design)
- [Typeclass](#typeclass)
- [Pattern Matching](#pattern-matching)
  - [Using Range in `case`](#using-range-in-case)
- [Collections](#collections)
  - [Array](#array)
  - [String](#string)
  - [Map](#map)
- [Error handling](#error-handling)
- [Type casting](#type-casting)
- [async/await](#asyncawait)
- [Modules](#modules)
- [Compilation `In Design`](#compilation-in-design)
- [Meta-programming `In Design`](#meta-programming-in-design)
- [References](#references)

<!-- /code_chunk_output -->

## Philosophy

Just another "C", with a little bit of functional programming.  
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
const main = () => {
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
- `usize` (pointer size. It's `u32` on 32-bit system, `u64` on 64-bit system)
- `()` (unit)

#### `Linear` Types.

Linear types are types that can only be used exactly once. For example, a `String` is a linear type as it can only be used once.  
The [Austral language](https://austral-lang.org/) has a very good explanation on the incentive of using [Linear Types](https://austral-lang.org/tutorial/linear-types).

- Linear values must be consumed once.
- A Linear value cannot be consumed when there is a pointer or alias to it.

### Variable Declaration

Like `rust`, **Mo** has two kinds of variables:

```typescript
const y = 5; // y: i32, immutable
var x = 5; // x: i32, mutable

const example = (x: i32, y: i32) => {
  x = 1; // Error: x is immutable
  y = 2; // Error: y is immutable
};
```

### Type inference

```typescript
const mySymbol = "Hi"; // *const u8[2,'\0']. Free type

const myString: String = String.from("Hello, world"); // Stored on heap. Linear type.
const myString2 = myString; // myString2: String. Linear type. myString is moved and consumed. myString2 now takes the ownership.
const myString3 = myString; // Error: myString is already consumed.
const myString4: *const String = &myString2; // myString4: *const String. Free type
const myString5 = myString4; // myString5: &String. Free type

const myInt = 1; // Stored on stack. Free type
const myInt2 = myInt; // myInt2: i32, Free type
const myInt3: *const i32 = &myInt; // myInt3: *const. Free type
const myInt4 = myInt3; // myInt4: *const i32. Free type

const myIntSlice: int[] = [1, 2, 3]; // Stored on stack, with size 3. Free type
const myIntSlice: int[100] = [1, 2, 3]; // Stored on stack, with size 100. Free type
const myArray: Array<int> = Array.from([1, 2, 3]); // Stored on heap. Linear type.

const mySet: Set<int> = Set.from([1, 2, 3]); // Stored on heap. Linear type.
const myMap: Map<const* str, int> = Map.from([
  ["one", 1],
  ["two", 2],
]); // Stored on heap. Linear type.

enum Person { // Linear type, as it contains a linear type.
  Person(name: String, age: i32)
}
const p = Person(String.from("Alice"), 30); // p: Person. Linear type.
```

#### Uninitialized variable `In Design`

```typescript
var x: i32; // x: i32, uninitialized

// Compiler prevents using uninitialized variable.
println(x); // Compiler Error: x is uninitialized.

x = 1; // x: i32, initialized

const y: i32; // y: i32, uninitialized
y = 12; // Compiler Error: cannot assign to constant.
```

### Transfer ownership

Linear types can only be used once. When a linear type is transferred, it is consumed and cannot be used again.

```typescript
const x = String.from("Hello"); // x: String. Linear type
const y = x; // y: String. Linear type. x is moved and consumed.
const z = x; // Compiler Error: x is already consumed.
```

### immutable and mutable references

```typescript
// Immutable reference, using `*` or `^`
{
  const some_i = malloc(sizeof<i32>()); // i: Option<^i32> Linear type
  const i = some_i.unwrap(); // i: ^i32. Linear type

  const p1: *i32 = i; // p: *i32. Free type

  const p2: *const i32 = i; // p: *const i32. Free type

  const p2_2: *i32 = p2; // Compiler Error: Cannot assign a `*const i32` to a `*i32`.

  const p3 = i; // p: ^i32. Linear type, ownership is transferred.
  free(p3);

  println(*p1); // Compile Error: The value it points to is consumed.
}
```

```typescript
{
  var x = 1; // x: copied i32. Free type
  const p1: *i32 = &x; // r: *i32. Free type
  const p2: *const i32 = &x; // p: *const i32. Free type.
  *p1 = 2;
  // x == 2
  // *p1 == 2
  // *p2 == 2
}
```

A longer example:

```typescript
extern "C" {
  length: (x: *const String)=> i32;
  push: (x: *String, value: String)=> ;
  drop: (x: String)=> ;
}

const main = ()=> {
  var x = String.from("Hello, world"); // x: String. mutable
  const y: *String = &x; // y: *String   // mutable reference
  const z: *const String = &x; // z: *const String   // immutable reference

  length(x);  // not allowed
  length(y);  // allowed
  length(z);  // allowed
  x.length(); // allowed, implicit conversion to *const

  const t = x;                           // transfer ownership

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
const name = String.from("Alice");
const p = Person(name, 30); // p: Person. Linear type.

{
  const name = p.name; // name: String, Linear type. The `p` variable is consumed
                       // when you extract a linear field from it.
                       // NOTE: If `p` has more than one linear field, then when you destructure, you have to consume all the linear fields, otherwise it will be a compiler error.

  const age = p.age; // Compiler Error: `p` is consumed already.
}

{
  const { name, var age } = p;
}

{
  var { name, age } = p;
}

{
  const age = p.age; // age: i32, Free type. The `p` variable is not consumed
                    // when you extract a free field from it.

  const name = p.name; // name: String, Linear type. The `p` variable is consumed
}

{
  const { name } = p; // name: String, Linear type. The `p` variable is consumed
                    // when you destructure any linear type values from it.
}

{
  const { age } = p;  // age: i32, Free type. The `p` variable is not consumed
                    // when you destructure only free fields from it.
}

{
  // Creating references will not consume `p`:
  const name: *const String = &p.name; // name: *const String. Free type.
  const age = &p.age; // age: *const i32. Free type.
}
{
  const p_ref = &p; // p_ref: *const Person. Free type.
  const name = &p_ref.name; // name: *const String. Free type.
  const age = &p_ref.age; // age: *const i32. Free type.

  some_function(*p_ref); // Derference a reference of linear type is not allowed.
}
{
  var p = Person(String.from("Alice"), 30); // p: Person. Linear type.
  const p_ref = &p; // p_ref: *const Person. Free type.
  const old_name = (p_ref.name = String.from("Bob")); // old_name: String. Linear type. Take the value out.
  // old_name == String.from("Alice")
}
```

```typescript
const name = String.from("Alice");
const p = Person(name, 30); // p: Person. Linear type.

const { name, age } = p; // p is consumed.

p = Person(name, 30); // This is allowed. We restored a consumed value.
```

```typescript
var x = [1, 2, 3, 4, 5]; // x: i32[5]. Free type
var y = x; // y: i32[5]. Free type. x is copied to y, not moved.

{
  const ref = &x; // ref: *i32[]. Free type
  const first = ref[0]; // i32. Free type
}
{
  const firstRef = &x[0]; // *i32. Free type
  *firstRef = 10;
}

// x: [10, 2, 3, 4, 5]
// y: [1, 2, 3, 4, 5]
```

```typescript
var x = [String.from("Hi"), String.from("World")];

{
  const s = x[0]; // Compiler Error: Cannot move linear type out of a slice.
}

{
  const s = &x[1]; // s: *String. Free type
  const old = (*s = String.from("Earth"));
  // old: String. Linear type. old == String.from("World")
}

// x: [String.from("Hi"), String.from("Earth")]
```

### Unique Pointer `In Design`

We use the `^` to denote the pointer, same as in Pascal.

```typescript
const some_int_ptr = malloc(sizeof<i32>()); // int_ptr: Option<^i32>. Linear type
match int_ptr {
  case Some: {
    const int_ptr = some_int_ptr.value; // int_ptr: ^i32. Linear type.
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
const x = String.from("Hi"); // x: String. Linear type
const y = cast_to_free(x); // y: String. Free type
```

## Function Declaration

Function parameters are immutable by default.

```typescript
// Top level function.
// Type after `=>` is the return type. If it's not specified, it's `void`.
const add = (x: i32, y: i32)=> i32 {
  return x + y;
}

// Or abbreviated form: `Not adopted yet`
const add(x: i32, y: i32)=> i32 {
  return x + y;
}

// Default parameter values
const add = (x: i32 = 1, y: i32 = 2)=> i32 {
  return x + y;
}

// Generic function
const identity = <T>(arg: T)=> T {
  return arg;
}

// Dependency injection
const main = (?raise: (error: *const str)=> i32)=> void {
  const x: i32 = raise("Hello, world");
}

// Value constraint `In Design`
type NotZero = i32 where _ != 0;
const divide = (x: i32, y: NotZero)=> i32 {
  return x / y;
}

// Type constraint
const add = <T: Type, Integral<T>>(x: T, y: T)=> T {
  return x + y;
}

// Closure
const add = [{y: 0}](x: i32)=> i32 {
  y = x + y
};
add(1); // {y: 1}
add(1); // {y: 2}
// add.y == 2

// Curried function `In Design` `Hard` to support`
const add = (x: i32)=> (y: i32)=> i32 {
  x + y
}
const add_one = add(1);
add_one(2); // 3
```

### Contextual parameters, aka implicit parameters

The contextual parameters are passed implicitly to the function.  
**Mo** looks for the closest value that matches the contextual parameter by the **type**, not by **name**.

#### Compiletime

```typescript
// id.mo
export class Id<T> {
  id: (x: T)=> T;
};

// main.mo
import {Id, id} from "./id.mo";
const useId = <T, Id<T>>(x: T)=> T {
  id(x)
}
```

#### Runtime

```typescript
const add = (x: i32, ?y: i32)=> i32 {
  return x + y;
}

const main = ()=> {
  {
    add(3); // error: missing implicit parameter y
  }
  {
    const ?y = 4;
    add(3); // ok, 7
  }
  {
    const ?a = 4;
    const ?b = 5;
    add(3); // will pick the closest value, which is ?b, so it's 8
  }
  {
    add(3, 4); // ok, 7
  }
  {
    const ?y = 4;
    const ?y = 5;
    add(3); // ok, 8
  }
}
```

The arguments are provided in lexical scope, not dynamic scope.

```typescript
const test = (x: i32, ?id: (x: i32)=> i32) {
  print(id(x))
}

const ?id = (x: i32)=> x;
const useTest = ()=> {
  test(3); // print 3

  const ?id = (x: i32)=> x + 1;
  test(3); // print 4
}

const main = ()=> {
  const ?id = (x: i32)=> x + 2; // This will not affect the `test` function calls in `useTest`
  useTest();  // print 3
              // print 4
}
```


### Uniform Function Call Syntax

```typescript
const add_one = (x: i32)=> i32 {
  return x + 1;
}

(12).add_one(); // 13
// is equalvalent to
add_one(12); // 13

const s = String.from("Hello, world");
s.length(); // 12
// is equalvalent to
length(&s); // 12
// We will automatically convert to reference when needed.
```

### `defer`

`defer` will execute an expression at the end of the current scope.

```typescript
const test = ()=> {
  const x = String.from("World!");
  defer {
    println(x);
    drop(x);
  }

  const y = String.from("Hello, ");
  defer {
    println(y);
    drop(y);
  }
}

test(); // Hello, World!
```

```typescript
const deferExample = ()=> {
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
    if (x == 1) {
      return 1;
    } else {
      return recur(x - 1, acc * x);
    }
  };
  ```

- Without tail-call optimization

  ```typescript
  (x: u32) => {
    if (x == 1) {
      return 1;
    } else {
      return x * recur(x - 1);
    }
  };
  ```

### Custom Operators

```typescript
const (|>) = <T, U>(x: T, f: (value: T)=> U)=> U {
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

### Mulitple Return Values `In Design`

REASON: Necessary for returning multiple references.

```typescript
const vals = ()=> (i32, i32) {
  return 1, 2;
}

const main = ()=> {
  const a, b = vals();
}
```

## Duck Typing `In Design`

```typescript
// This function can take any type that has a `length: i32` property.
const printLength = (x: *const { length: i32 })=> {
  println(x.length);
};

const main = ()=> {
  const s = String.from("Hello, world");
  printLength(&s);
  // ^ This works as the compiler converts it to below from the background:
  printLength(&{ length: s.length })
}
```

## Array & Slice

```typescript
var i32_array = [1, 2, 3, 4, 5]; // i32_array: i32[5]. Free type
i32_array.length; // 5, compile-time known

const i32_array_ptr = &i32_array; // i32_array_ptr: *(i32[5]). Free type
i32_array_ptr.length; // 5, compile-time known
i32_array_ptr[0] = 8; // automatically dereference
// i32_array: [8, 2, 3, 4, 5]

const i32_ptr = &i32_array[0]; // i32_ptr: *i32. Free type
*i32_ptr = 9;
// i32_array: [9, 2, 3, 4, 5]


const i32_slice = i32_array[0:3]; // i32_slice: i32[?]. Compiler Error: Size of array i32[] is unknown at compile time.
const i32_slice = i32_array[0:some_func_return_usize()]; // i32_slice: i32[?]. Compiler Error: Size of array i32[] is unknown at compile time.

const i32_slice = &i32_array[0:3]; // i32_slice: *(i32[]). Free type. & is required here.
i32_slice.length; // 3, runtime known
i32_slice[0] = 10;
// i32_array: [10, 2, 3, 4, 5]


const set_value = (arr: *i32[], index: usize, value: i32)=> {
  if (index < arr.length) { // arr.length is runtime known
    arr[index] = value;
  }
}
set_value(i32_array, 0, 11);
// i32_array: [11, 2, 3, 4, 5]
// i32_slice: [11, 2, 3]

// Compiler error: Size of the array i32[] is unknown at compile time, please use `&` to coerce it to slice type &i32[]
const set_value_2 = (arr: i32[], index: usize, value: i32)=> {
  // ...
}
// This is allowed as the size of the array is known at compile time.
const set_value_3 = (arr: i32[3], index: usize, value: i32)=> {
  // ...
}
```

```typescript
type str = u8[,'\0'];

const constant_str = "Hello"; // str: *const u8[5,'\0']
                     // ['H', 'e', 'l', 'l', 'o', '\0']
constant_str.length; // 5 (excluding '\0'), compile-time known

var str = *"Hello"; // str: u8[5,'\0'], convert to mutable array
                     // ['H', 'e', 'l', 'l', 'o', '\0']
str.length; // 5 (excluding '\0'), compile-time known

const slice_1 = &str[0:2]; // slice_1: *u8[]
                           // ['H', 'e']
slice_1.length; // 2, runtime known
slice_1[0] = 'h';

// str: ['h', 'e', 'l', 'l', 'o', '\0']
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
  [*]<type parameters>(parameters)=> return_type { body }
  ```

A closure can be defined using the following syntax:

```
[{captures}]<type parameters>(paramters)=> return_type { body }
```

Examples:

```typescript
const test = ()=> {
  var x = 1;

  const increment: [*](a: i32)=> void = [{x: &x}](a: i32)=> {
    // const {x} = increment;
    *x = *x + a;
  }
  increment(1);
  increment(2);

  // x == 4
}
```

```typescript
const test = ()=> {
  var x: Data = malloc(); // Some `Fake` Data.

  var increment: [^]()=> void; = [{x: x}]()=> {
    // const {x} = increment;
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
const set! = <T: Type>(ref: *T, value: T)=> T;

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
const oldName = (p.name = String.from("Bob"));
// oldName is the `value` moved out.
// oldName == String.from("Alice")
```

## Generic

### Type parameters

Type parameters are defined inside `<...>`

```typescript
const id = <T: Type>(x: T)=> T {
  x
}

// or
const id = <T>(x: T)=> T { // T will be inferred as `Type` kind
  x
}
```

### Type constraints

Type constraints are achieved using the implicit parameters.

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
import { show, Show } from "./show.mo";
export const show = <T, Show<T>>(x: Array<T>)=> String {
  // ...
}

import { show, Show } from "./show.mo";
const less_than = <T: Type, Ord<T>, Show<T>>(x: T, y: T)=> boolean {
  println(show(x));
  return x < y;
}
```

## Control Flow

### if/else

```typescript
const main = () => {
  // If no return type, it is () unit
  const number = 3;

  if (number < 5) {
    println("condition was true");
  } else {
    println("condition was false");
  }
};
```

### while

```typescript
const factorial = (n: i32)=> i32 {
  var result = 1;
  var i = 1;
  while (i <= n) {
    result *= i;
    i += 1;
  }
  return result;
}
```

### for

```typescript
const factorial = (n: i32)=> i32 {
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

const user: User = User {
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
const user: User = User {
  name: String.from("johndoe"),
  age: 12
}

{
  const {age} = user; // Compiler Error: `user` is consumed while `name` is not moved out.
}

{
  const {name, age} = user;
  // name: String, linear type
  // age: i32. Free type
}

{
  // Rename the field with `as`
  // Specify the type with `:`
  const {name as username, age} = user;
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

const none: Option<i32> = None;
const some: Option<i32> = Some(42);

// Access the field:
some.value;
const {value} = some;

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

const eval = <T>(expr: Expr<T>)=> T {
  // with Expr<T>;
  match(expr) {
    case IntExpr: expr.i,
    case BoolExpr: expr.b,
    case EqExpr: eval(expr.left) == eval(expr.right)
  }
}

const expr1 : Expr<boolean> = EqExpr(IntExpr(1), IntExpr(2));
eval(expr1); // false
```

## Advanced Types `In Design`

### Dependent types `In Design`

Dependent types are types which depend on values.

```typescript
type Vector<N: i32> = Array<i32, N>;

const add_vectors = <N: i32>(a: Vector<N>, b: Vector<N>)=> Vector<N> {
  return a.map((x, i)=> x + b[i]);
}

const v1: Vector<3> = [1, 2, 3];
const v2: Vector<3> = [4, 5, 6];
const result = add_vectors(v1, v2); // [5, 7, 9];

// The code below will not compile
const v3: Vector<2> = [1, 2];
const v4: Vector<3> = [4, 5, 6];
// const error = add_vectors(v3, v4); // Compiler Error: Vector<2> and Vector<3> are different types.
```

### Refinement types `In Design`

Refinement types consists of all values of a given type which satisfy a given predicate.

```typescript
type PositiveNumber = i32 where _ > 0;
type NonEmptyString = String where _.length > 0;

const divide = (x: PositiveNumber, y: PositiveNumber)=> PositiveNumber {
  x / y
}

const x: PositiveNumber = 10; // Valid
const y: PositiveNumber = -10; // Compiler Error: -10 is not a PositiveNumber

const result = divide(10, 2); // Valid
```

```typescript
type NaturalNumber = i32 where _ >= 0;
type PositiveNumber = i32 where _ > 0;
type Equal<n: i32> = i32 where _ == n;
type Index<T: Type, a: T[]> = NatureNumber where _ < a.length();
type NotEmptyArray<T> = T[] where _.length() > 0;

const get = <T, a: T[]>(index: Index<T, a>, array: a)=> T {
  array[index]
}

const set = <T, a: T[]>(index: Index<T, a>, array: a, value: T)=> void {
  array[index] = value;
}

const head = <T>(array: NotEmptyArray<T>)=> T {
  return array[0];
}

```

## Typeclass

```typescript
class Summary<T> {
  summarize: (self: *const T)=> String;
};

class Display<T, Summary<T>> {
  display: (self: *const T)=> String;
};

type NewsArticle = {
  headline: String;
  location: String;
  author: String;
  content: String;
};

instance Summary<NewsArticle> {
  summarize: (self: *const NewsArticle)=> String {
    return "${self.headline}, by ${self.author} (${self.location})";
  }
}

// Pass in function
const notify = (item: *const NewsArticle)=>  {
  println("Breaking news! ", summarize(item));
}

const notify = <T, Display<T>>(
  item: *const T
)=>  {
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
const value_in_cents = (coin: Coin)=> u8 {
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


const list_length = <T>(list: &List<T>)=> i32 {
  match (list) {
    case Nil: 0,
    case Cons: {
      const {tail} = list;
      1 + list_length(tail)
    }
  }
}
```

### Using Range in `case`

```typescript
const check_int = (x: i32)=> {
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
const check_int = (x: i32)=> {
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

This is the dynamic array.

QUESTION: Should we name it `ArrayList` instead of `Array`?

```typescript
const v: Array<i32> = Array.new();
const v2 = Array.from([1, 2, 3]);
const value = v2.at(0);
```

### String

UTF-8 encoded string.

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

## Error handling

```typescript
type MyError = {message: char[]};
const main = (?throw: Exception<MyError>)=>  {
  throw({
    message: "Something went wrong",
  });
}
```

## Type casting

```typescript
const x: i32 = 1;
const y: f32 = x as f32;
```

## Algebraic effects `In Design`

We support the one-shot delimited continuation.

### Effectful function

Effectful function defined using `control` keyword can `resume` to continue the continuation:

`resume` can only be called once (?). It's like a closure of linear type.

```typescript
const safe_divide = (x: i32, y: i32,
  // raise is an effectful function
  raise: control (msg: const* str)=> i32)=> {
  if (y == 0) {
    return raise("Division by zero");
  }
  return x / y;
}

// `resume`
const handle = ()=> i32 {
  // Effect handler
  const raise = control (msg: const* str)=> i32 {
    resume(10);
  }
  return 1 + safe_divide(3, 0, raise) + 2; // 13
}

// `abort`
const handle2 = ()=> i32 {
  // Effect handler
  const raise = control (msg: const* str)=> i32 {
    return 10; // abort the continuation without resume
               // its return type must match the return type of the parent function.
  }
  return 1 + safe_divide(3, 0, raise) + 2; // 10
                                           // continuation aborted.
}
```

## async/await

Similar to JavaScript, **Mo** supports async/await.

```typescript
const wait_for_seconds = (seconds: u32)=> Promise<void> {
  return Promise.new((resolve, reject)=> {
    set_timeout(resolve, seconds * 1000);
  });
}

const main = async ()=> {
  println("Start");
  await wait_for_seconds(1);
  println("End");
}
```

## Modules

Similar to the ECMAScript modules, we use the `import` and `export` keywords to import and export modules. The syntax is changed and extended a bit.

QUESTION: Should we allow to `export` a linear type value?

```typescript
import { copy } from "https://github.com/mo-lang/mo/std/fs.mo";

const test = ()=> {
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
export "C" const x = 1;
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

const x = 1;
const y = add(x + 1); // 3
// The above code is equal to
const y = ((x + 1) + 1);
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
- [Refinement Types for TypeScript](https://goto.ucsd.edu/~pvekris/docs/pldi16.pdf)
