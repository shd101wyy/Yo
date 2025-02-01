# Language Design

**Mo** 墨 🐼 is minimal, general-purpose, compiled programming language that incorporates the Linear Types and Algebraic Effects.

**Mo** aims to be a simple to learn programming language. If you are familiar with TypeScript, you should be able to pick up **Mo** in 1 hour 😉.

**Mo** has a minimal syntax design that looks like TypeScript, and uses uniform call syntax (dot notation)~~, brace elison~~ to make the code more concise.

**Mo** (will &) tend to support advanced type system features such as generalized algebraic data types (GADT), dependent types, refinement types `In Design`.

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
  - [Named arguments](#named-arguments)
  - [Contextual parameters, aka implicit parameters](#contextual-parameters-aka-implicit-parameters)
    - [Compiletime](#compiletime)
    - [Runtime](#runtime)
  - [Uniform Function Call Syntax](#uniform-function-call-syntax)
  - [`defer`](#defer)
  - [`recur` `In Design`](#recur-in-design)
  - [Custom Operators](#custom-operators)
  - [Mulitple Return Values `In Design`](#mulitple-return-values-in-design)
- [Duck Typing `In Design`](#duck-typing-in-design)
- [Tuple](#tuple)
- [Array & Slice](#array--slice)
- [Closure `In Design`](#closure-in-design)
- [Mutability `To be updated`](#mutability-to-be-updated)
- [Generic](#generic)
  - [Type parameters](#type-parameters)
  - [Type constraints](#type-constraints)
- [Control Flow](#control-flow)
  - [if/else](#ifelse)
  - [while `Might be removed`](#while-might-be-removed)
  - [for `Might be removed`](#for-might-be-removed)
- [Type synonyms](#type-synonyms)
- [Enum (Algebraic Data Types)](#enum-algebraic-data-types)
- [Advanced Types `In Design`](#advanced-types-in-design)
  - [Dependent types `In Design`](#dependent-types-in-design)
  - [Refinement types `In Design`](#refinement-types-in-design)
  - [Generalized Algebraic Data Types (GADTs) `In Design`](#generalized-algebraic-data-types-gadts-in-design)
- [Typeclass](#typeclass)
- [Pattern Matching](#pattern-matching)
  - [Using Range in `case`](#using-range-in-case)
- [Collections](#collections)
  - [ArrayList](#arraylist)
  - [String](#string)
  - [Map](#map)
- [Error handling](#error-handling)
- [Type casting](#type-casting)
- [Algebraic Effects `In Design`](#algebraic-effects-in-design)
  - [Effectful function](#effectful-function)
  - [Run multiple continuations `In Design`](#run-multiple-continuations-in-design)
- [Modules](#modules)
- [Compilation `In Design`](#compilation-in-design)
- [Meta-programming `In Design`](#meta-programming-in-design)
  - [Macro](#macro)
- [References](#references)

<!-- /code_chunk_output -->

## Philosophy

Static typed "Lisp" that compiles to "C".  
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

```clj
(fn main []
  (println "Hello World!"))
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

- `boolean` (true or false)
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
- `symbol` (a unique identifier)

#### `Linear` Types.

Linear types are types that can only be used exactly once. For example, a `String` is a linear type as it can only be used once.  
The [Austral language](https://austral-lang.org/) has a very good explanation on the incentive of using [Linear Types](https://austral-lang.org/tutorial/linear-types).

- Linear values must be consumed once.
- A Linear value cannot be consumed when there is a pointer or alias to it.

### Variable Declaration

Like `rust`, **Mo** has two kinds of variables:

```clj
(let y 5)  ;; y :: i32, immutable
(var x 5)  ;; x :: i32, mutable

(fn example [x y]
  (set! x 1)  ;; Error: x is immutable
  (set! y 2)) ;; Error: y is immutable
```

### Type inference

```clj
(let my-symbol 'hi)  ;; my-symbol :: symbol

(let my-string (String.from "Hello, world")) ;; my-string :: String // Stored on heap. Linear type.
(let my-string-2 my-string)  ;; my-string-2 :: String // Linear type. my-string is moved and consumed. my-string-2 now takes the ownership.
(let my-string-3 my-string)  ;; Error: my-string is already consumed.
(let my-string-4 &my-string-2)  ;; my-string-4 :: *String // Free type

(let my-int 1)  ;; my-int :: i32 // Stored on stack. Free type
(let my-int-2 my-int)  ;; my-int-2 :: i32 // Free type
(let my-int-3 &my-int)  ;; my-int-3 :: *i32 // Free type
(let my-int-4 my-int-3)  ;; my-int-4 :: *i32 // Free type

(let my-int-array [1 2 3])  ;; my-int-array :: i32[3] // Free type

(::  my-int-array (Array i32 100))
(let my-int-array [1 2 3])  ;; my-int-array :: i32[100] // Free type

(let my-array-list (ArrayList.from [1 2 3]))  ;; my-array-list :: (ArrayList i32) // Stored on heap. Linear type.

(let my-set (Set.from [1 2 3]))  ;; my-set :: (Set i32) // Stored on heap. Linear type.
(let my-map (Map.from [
  ("one" 1)
  ("two" 2)
]))  ;; my-map :: (Map *u8[] i32) // Stored on heap. Linear type.

(data Person ;; Linear type, as it contains a linear type.
  (Person
    String :label name
    i32    :label age
  ))
(let p (Person (String.from "Alice") 30))  ;; p :: Person // Linear type.
```

#### Uninitialized variable `In Design`

```clj
(::  x i32)
(var x)     ;; x :: i32, uninitialized

;; Compiler prevents using uninitialized variable.
(println x) ;; Compiler Error: x is uninitialized.

(set! x 1)     ;; x :: i32, initialized

(::  y i32)
(let y)      ;; y :: i32, uninitialized
(set! y 12)    ;; Error: cannot assign to constant.
```

### Transfer ownership

Linear types can only be used once. When a linear type is transferred, it is consumed and cannot be used again.

```clj
(let x (String.from "Hello"))  ;; x :: String, Linear type
(let y x)  ;; y :: String, Linear type. x is moved and consumed.
(let z x)  ;; Error: x is already consumed.
```

### immutable and mutable references

```clj
;; Immutable reference, using `*` or `^`
(let some-i (malloc (sizeof i32)))  ;; some-i :: (Option ^i32), Linear type
(let i (unwrap some-i))  ;; i :: ^i32, Linear type

(::  p1 (*mut i32))
(let p1 i)  ;; p1 :: *mut i32, Free type

(::  p2 *i32)
(let p2 i)  ;; p2 :: *i32, Free type

(::  p2-2 *i32)
(let p2-2 p2)  ;; Error: Cannot assign a `*const i32` to a `*i32`.

(::  p3 ^i32)
(let p3 i)  ;; p3 :: ^i32, Linear type, ownership is transferred.

(free p3)

(println *p1)  ;; Compile Error: The value it points to is consumed.
```

```clj
(var x 1)    ;; x :: i32, Free type

(::  p1 (*mut i32))
(let p1 &x)  ;; p1 :: *mut i32, Free type

(::  p2 *i32)
(let p2 &x)  ;; p2 :: *i32, Free type

(set! *p1 2)
;; x == 2
;; *p1 == 2
;; *p2 == 2
```

A longer example:

```clj
(extern "C" {
  :length [*String -> i32]
  :push   [*String *String -> ()]
  :drop   [String -> ()]
})

(fn main [] (do
  (var x (String.from "Hello, world")) ;; x :: String, mutable

  (::  y (*mut String))
  (let y &x) ;; y :: *mut String, Free type

  (::  z *String)
  (let z &x) ;; z :: *String, Free type

  (length x)  ;; not allowed
  (length y)  ;; allowed
  (length z)  ;; allowed

  (let t x) ;; transfer ownership

  (length x)  ;; error: cannot access `x` because `x` is consumed.
  (length y)  ;; allowed
  (length z)  ;; allowed

  (drop t) ;; consume `t`

  (length x)  ;; error: cannot access `x` because `x` is consumed.
  (length y)  ;; error: cannot access `y` because `t` is consumed.
  (length z)  ;; error: cannot access `z` because `t` is consumed.
))
```

We can only dereference the free type.

```clj
(data Person ;; Linear type, as it contains a linear type.
  (Person
    String :label name
    i32    :label age
  ))
(let name (String.from "Alice"))
(let p (Person name 30))  ;; p :: Person, Linear type

(do
  (let name p.name)  ;; name :: String, Linear type. The `p` variable is consumed
  (let age p.age)  ;; Error: `p` is consumed already.
  )

(do
  (let { name :name age :age } p)
)

(do
  (let age p.age)  ;; age :: i32, Free type. The `p` variable is not consumed
  (let name p.name)  ;; name :: String, Linear type. The `p` variable is consumed
)

(do
  (let { another-name :name } p)  ;; another-name :: String, Linear type. The `p` variable is consumed
                          ;; when you destructure a linear field from it.
)

(do
  (let { age :age } p)  ;; age :: i32, Free type. The `p` variable is not consumed
                        ;; when you destructure only free fields from it.
)

(do
  ;; Creating references will not consume `p`:
  (let name &p.name)  ;; name :: *String, Free type.
  (let age &p.age)  ;; age :: *i32, Free type.
)

(do
  (let p-ref &p)  ;; p-ref :: *Person, Free type.
  (let name &p-ref.name)  ;; name :: *String, Free type.
  (let age &p-ref.age)  ;; age :: *i32, Free type.

  (some-function *p-ref)  ;; Derference a reference of linear type is not allowed.
)

(do
  (var p (Person (String.from "Alice") 30))  ;; p :: Person, Linear type.
  (let p-ref &p)  ;; p-ref :: *Person, Free type.
  (let old-name
    (set! p-ref.name (String.from "Bob")))  ;; old-name :: String, Linear type. Take the value out.
  ;; old-name == String.from "Alice"
)
```

```clj
(let name (String.from "Alice"))  ;; name :: String, Linear type
(let p (Person name 30))  ;; p :: Person, Linear type

(let { name age } p)  ;; name :: String, Linear type. The `p` variable is consumed

(set! p (Person name 30))  ;; This is allowed. We restored a consumed value.
```

```clj
(var x [1 2 3 4 5])  ;; x :: i32[5], Free type
(var y x)  ;; y :: i32[5], Free type. x is copied to y, not moved.

(do
  (let ref &x)  ;; ref :: *i32[], Free type
  (let first ref[0])  ;; i32, Free type
)
(do
  (let first-ref &x[0])  ;; first-ref :: *i32, Free type
  (set! *first-ref 10)
)

;; x == [10 2 3 4 5]
;; y == [1 2 3 4 5]
```

```clj
(var x [
  (String.from "Hi")
  (String.from "World")
])

(do
  (let s x[0]) ;; Compiler Error: Cannot move linear type out of a slice.
)

(do
  (let s &x[1]) ;; s :: *String, Free type
  (let old (set! *s (String.from "Earth")))
  ;; old :: String, Linear type. old == String.from "World"
)

;; x == [(String.from "Hi"), (String.from "Earth")]
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

```clj
(let some-int-ptr (malloc (sizeof i32)))  ;; some-int-ptr :: (Option ^i32), Linear type
(match some-int-ptr
  (Some int-ptr) (do
    ;; (let int-ptr some-int-ptr.value)  ;; int-ptr :: ^i32, Linear type
    (set! *int-ptr 10)
    (free int-ptr))

  :default (do
    ;; handle error
  ))
```

### Cast Linear to Free

NOTE: This is unsafe and should be avoided.

```clj
(let x (String.from "Hi"))  ;; x :: String, Linear type
(let y (cast-to-free! x))  ;; y :: String, Free type
```

## Function Declaration

Function parameters are immutable by default.

```clj
;; Top level function.
(:: add [i32 i32 -> i32])
(fn add [x y] (+ x y))

(:: last-unit-expr [i32 i32 -> ()])
(fn last-unit-expr [x y] (
  do (+ x y)
  ()
))

;; Default parameter values
(:: add [ i32 :label x :default 1
          i32 :label y :default 2
          -> i32])
(fn add [x y] (+ x y))
(add) ;; 3
(add :y 3) ;; 4
(add 2 3) ;; 5

;; Generic function
(:: identity (forall [T] [T -> T]))
(fn identity [arg] arg)

;; Dependency injection
(:: main [[*u8[] -> i32] :implicit true
          -> ()])
(fn main [?raise]
  (?raise "Hello, world"))

;; Value constraint `In Design`
(type NotZero i32 :where (!= _ 0))
(:: divide [i32 NotZero -> i32])
(fn divide [x y] (/ x y))

;; Type constraints
(:: add
  (forall [T]
    :require [(Integral T)]
    [T T -> T]))
(fn add [x y] (+ x y))

;; Closure
(::  add (closure* [i32 -> i32]))
(let add (closure [{:y 0}] [x] (do
  (set! y (+ y x))
  y
)))
(add 1) ;; 1
(add 2) ;; 3
```

### Named arguments

```clj
(:: add [ i32 :label x
          i32 :label y
          -> i32])
(fn add [x y] (+ x y))

(add :y 2 :x 1) ;; 3
(add :x 1 :y 2) ;; 3
```

### Contextual parameters, aka implicit parameters

The contextual parameters are passed implicitly to the function.  
**Mo** looks for the closest value that matches the contextual parameter by the **type**, not by **name**.

#### Compiletime

```clj
;; id.mo
(class (Id T)
  id :: [T -> T])
(export Id)

;; main.mo
(import "./id.mo" :only { Id, id })
(:: use-id
  (forall [T]
    :require [(Id T)]
    [T -> T]))
(fn use-id [x] (id x))
```

#### Runtime

```clj
(:: add [ i32
          i32 :implicit true
          -> i32])
(fn add [x ?y] (+ x ?y))

(fn main [] (do
  (do
    (add 3) ;; Error: missing implicit parameter y
  )
  (do
    (let ?y 4)
    (add 3)) ;; 7
  )
  (do
    (let ?a 4)
    (let ?b 5)
    (add 3)) ;; will pick the closest value, which is ?b, so it's 8
  (do
    (add 3 4)) ;; ok, 7
  (do
    (let ?y 4)
    (let ?y 5)
    (add 3)) ;; ok, 8
)
```

The arguments are provided in lexical scope, not dynamic scope.

```clj
(:: test [i32
          i32 :implicit true
          -> i32])
(fn test [x ?id] (println (?id x)))

(:: ?id [i32 -> i32])
(fn ?id [x] x)

(fn use-test [] (do
  (test 3) ;; print 3

  (let ?id (fn [x] (+ x 1))
  (test 3)) ;; print 4
))

(fn main [] (do
  (let ?id (fn [x] (+ x 2))) ;; This will not affect the `test` function calls in `use-test`
  (use-test)  ;; print 3
              ;; print 4
))
```

### `defer`

`defer` will execute an expression at the end of the current scope.

```clj
(:: test [-> ()])
(fn test [] (do
  (let x (String.from "World!"))
  (defer (do
    (println x)
    (drop x)))

  (let y (String.from "Hello, "))
  (defer (do
    (println y)
    (drop y))))
)

(test) ;; Hello, World!
```

```clj
(:: defer-example [-> i32])
(fn defer-example [] (do
  (var a 1)

  (do
    (defer (set! a 2))
    (set! a 1))

  (println a) ;; 2
  a))
```

### `recur` `In Design`

Use the `recur` to call the function recursively.  
This is useful for anonymous function.  
If `recur` is the last expression, tail-call optimization will be applied.

- With tail-call optimization

  ```typescript
  (x: u32, acc: u32 = 1) => {
    if x == 1 {
      acc
    } else {
      recur(x - 1, acc * x)
    }
  };
  ```

  ```clj
  (::
    (fn  [x acc] (do
      (if (= x 1)
        acc
        (recur (- x 1) (* acc x)))))
    [u32 u32 :default 1 -> u32])
  ```

- Without tail-call optimization

  ```clj
  (::
    (fn  [x] (do
      (if (= x 1)
        1
        (* x (recur (- x 1)))))
    [u32 -> u32]))
  ```

## Tuple

Tuple is defined as a sequence of elements of different types, separated by commas and enclosed in parentheses.

```clj
(let unit '()) ;; unit :: (), Free type
(let i32-tuple '(1 2 3)) ;; i32-tuple :: (i32 i32 i32), Free type
(let mixed-tuple '(1 true "Hello")) ;; mixed-tuple :: (i32 boolean *u8[]), Free type
;; or
(let mixed-tuple (Tuple 1 true "Hello"))

(let (a b c) mixed-tuple) ;; a :: i32, b :: boolean, c :: *u8[], Free type
```

## Array & Slice

```clj
(var i32-array [1 2 3 4 5])  ;; i32-array :: i32[5], Free type
i32-array.length  ;; 5, compile-time known

(let i32-array-ptr &i32-array)  ;; i32-array-ptr :: *i32[5], Free type
i32-array-ptr.length  ;; 5, compile-time known
(set! i32-array-ptr[0] 8)  ;; automatically dereference
;; i32-array == [8 2 3 4 5]

(let i32-ptr &i32-array[0])  ;; i32-ptr :: *mut i32, Free type
(set! *i32-ptr 9)
;; i32-array == [9 2 3 4 5]

(let i32-slice i32-array[0:3])  ;; i32_slice: i32[?]. Compiler Error: Size of array i32[] is unknown at compile time.
(let i32-slice i32-array[0:some-func-return-usize()])  ;; i32_slice: i32[?]. Compiler Error: Size of array i32[] is unknown at compile time.

(let i32-slice &i32-array[0:3])  ;; i32-slice :: *i32[], Free type. & is required here.
i32-slice.length  ;; 3, runtime known
(set! i32-slice[0] 10)
;; i32-array == [10 2 3 4 5]

(:: set-value [(*mut i32[]) usize i32 -> ()])
(fn set-value [arr index value] (do
  (if (< index arr.length)  ;; arr.length is runtime known
    (set! (arr index) value))))
(set-value &i32-array 0 11)
;; i32-array == [11 2 3 4 5]
;; i32-slice == [11 2 3]

(:: set-value-2 [i32[] usize i32 -> ()])
;; Compiler error: Size of the array i32[] is unknown at compile time, please use `&` to coerce it to slice type &i32[]

(:: set-value-3 [i32[3] usize i32 -> ()])
;; This is allowed as the size of the array is known at compile time.
```

```clj
(type str u8[,'\0'])

(let constant-str "Hello") ;; constant-str :: *const u8[5,'\0']
                     ;; ['H', 'e', 'l', 'l', 'o', '\0']
constant-str.length  ;; 5 (excluding '\0'), compile-time known

(var mutable-str *"Hello") ;; mutable-str :: u8[5,'\0'], convert to mutable array
                     ;; ['H', 'e', 'l', 'l', 'o', '\0']
mutable-str.length  ;; 5 (excluding '\0'), compile-time known

(let slice-1 &mutable-str[0:2]) ;; slice-1 :: *u8[]
                           ;; ['H', 'e']
slice-1.length  ;; 2, runtime known
(set! slice-1[0] 'h')

;; mutable-str: ['h', 'e', 'l', 'l', 'o', '\0']
;; slice-1: ['h', 'e']
```

## Mutability `To be updated`

Same as scheme, we use `set!` to change the value of a variable.

```clj
(let p (Person (String.from "Alice") 30))  ;; p :: Person, Linear type

;; Update the field
(let old-name (set! p.name (String.from "Bob")))  ;; old-name :: String, Linear type
;; old-name == String.from "Alice", the value moved out.
```

## Generic

### Type parameters

Use `forall` to define a generic function.

```clj
(:: id (forall [T] [T -> T]))
(fn id [x] x)
```

### Type constraints

Type constraints are achieved using the `require` keyword list.

```clj
;; show.mo
(class (Show T)
  show :: [T -> String])

(instance (Show i32)
  show (fn [] (do ...))
)

(instance (Show String)
  show (fn [] (do ...))
)

;; main.mo
(import "./show.mo" :only { Show, show })

(:: show (forall [T]
          :require [(Show T)]
          [Array T -> String]))
(fn show [x] (do ...))
```

## Control Flow

### cond

```clj
(cond
  (== x 1) (println "x is 1")
  (== x 2) (println "x is 2")
  :else    (println "x is not 1 or 2")
)
```

### if/else

```clj
(if (== x 1)
  :then (println "x is 1")
  :else (println "x is not 1"))
```

## Type synonyms

```clj
;; Record
(type (User :: Linear)
  {
    active :: boolean
    username :: String
    email :: String
    age   :: i32
  })

(type str u8[,'\0'])

(let user (User {
  :active true
  :username (String.from "johndoe")
  :email (String.from "test@gmail.com")
  :age 13
}))

;; Define an extern type
(type (Pointer T))
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

const set = <T, a: T[]>(index: Index<T, a>, array: a, value: T)=> () {
  array[index] = value;
}

const head = <T>(array: NotEmptyArray<T>)=> T {
  return array[0];
}
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
  match expr {
    case IntExpr: expr.i,
    case BoolExpr: expr.b,
    case EqExpr: eval(expr.left) == eval(expr.right)
  }
}

const expr1 : Expr<boolean> = EqExpr(IntExpr(1), IntExpr(2));
eval(expr1); // false
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
  match coin {
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
  match list {
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
  match x {
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
  match x {
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

### ArrayList

This is the dynamic array.

```typescript
const v: ArrayList<i32> = ArrayList.new();
const v2 = ArrayList.from([1, 2, 3]);
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

## Algebraic Effects `In Design`

**Mo** supports the one-shot delimited continuation.

### Effectful function

An effectful function is defined with the `effect` keyword.

The continuation `k` will be exposed to the effectful function.  
`k` is linear, and it must be consumed once.  
Either `resume` or `abort` function can be called with the continuation `k`.

The `do` keyword is used to call the effectful function.  
The `do` keyword decides where to `resume` the continuation.

The `return` keyword is not allowed in the continuation function.

```typescript
const safe_divide = (x: i32, y: i32, raise: effect (msg: *const u8[])=> i32
)=> i32 {
  if y == 0 {
    do raise("Division by zero")
  } else {
    x / y
  }
}

// `resume`
const handle_resume = ()=> i32 {
  const raise = effect (msg: *const u8[])=> i32 {
    resume(10, /* k */);
  }
  return 1 + safe_divide(3, 0, raise) + 2; // 13
}

// `abort`
const handle_abort = ()=> i32 {
  const raise = effect (msg: *const u8[])=> i32 {
    abort(10, /* k */);
  }
  return 1 + do safe_divide(3, 0, raise) + 2; // 10
}
```

```typescript
const main = ()=> () {
  const wait_for_seconds = effect (seconds: u32)=> i32 {
    set_timeout(()=> {
      println("Done");
      resume(12);
    }, seconds * 1000);
  }

  println("Before timeout");
  const result = do wait_for_seconds(1);
  println("After timeout");
  println(result); // 12
}
```

### Run multiple continuations `In Design`

```typescript
const main = ()=> () {
  const wait_for_seconds = effect (sec: u32)=> i32 {
    set_timeout(()=> {
      println(sec);
      resume(sec);
    }, sec * 1000);
  }

  print("before waits");
  const [wait1, wait2, wait3] = do [
    wait_for_seconds(1),
    wait_for_seconds(2),
    wait_for_seconds(3),
  ];
  print("after wraits");
}
```

## Modules

Similar to the ECMAScript modules, we use the `import` and `export` keywords to import and export modules. The syntax is changed and extended a bit.

QUESTION: Should we allow to `export` a linear type value?

```typescript
import "https://github.com/mo-lang/mo/std/fs.mo", only: { copy };

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
import "./test.mo"; // Import everything from test.mo
import "./test.mo", as: Test; // Import everything from test.mo and put it in the Test namespace

import "./test.mo", only: { test }; // Import test function from test.mo
import "./test.mo", only: { test as test2 }; // Import test function from test.mo and rename it to test2

import "./test.mo", only: { Option }; // Import Option enum from test.mo

/*
// BELOW ARE IN DESIGN
import { Option:{Some, None} } from "./test.mo"; // Unwrap Some and None variant from Option enum from test.mo
import { Option:* } from "./test.mo"; // Unwrap all variants from Option enum from test.mo
import { Option as AnotherOption:* } from "./test.mo"; // Unwrap all variants from Option enum, and rename 'Option' to 'AnotherOption' from test.mo
*/

// All exported instances are implicitly imported.
import "./test.mo", only: { id }; // Import `id` function defined in `Id` interface from test.mo
import "./test.mo", only: { Id }; // Import `Id` interface from test.mo
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

`quote` is similar to the `quasiquote` in Lisp.  
`unquote` can only be used in `quote`.  
`unquote_splicing` can only be used in `quote` to splice the values into the AST.

```typescript
const x = 1;

const list = quote([0, unquote(x), 2]); // [0, 1, 2]

const list2 = quote([0, x, 2]); // [0, [:variable, :x], 2]

quote([0, unquote_splicing(list), 4]); // [0, 1, 2, 3, 4]
```

### Macro

Use the `macro` keyword to define a macro.

```typescript
export macro my_if(condition, then) {
  quote {
    if unquote(condition) unquote(then)
  }
}

my_if true, {
  println("true");
}

export macro my_if(condition, then: then_clause, else: else_clause) {
  quote {
    match unquote(condition) {
      case true: unquote(then_clause),
      default: unquote(else_clause)
    }
  }
}

my_if true, then: {
  println("true");
}, else: {
  println("false");
}

export macro unless(condition, do) {
  quote {
    my_if (!unquote(condition), do: unquote(do))
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
