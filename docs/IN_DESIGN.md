# In Design

<!-- @import "[TOC]" {cmd="toc" depthFrom=2 depthTo=6 orderedList=false} -->

<!-- code_chunk_output -->

- [Function Declaration](#function-declaration)
  - [Variadic functions](#variadic-functions)
- [Advanced Types](#advanced-types)
  - [Dependent types](#dependent-types)
  - [Refinement types](#refinement-types)
  - [Higher Kinded Types](#higher-kinded-types)
  - [Generalized Algebraic Data Types (GADTs)](#generalized-algebraic-data-types-gadts)

<!-- /code_chunk_output -->

## Function Declaration

### Variadic functions

```rust
// c11 style variadic function
add_va_c11 :: ((count : c_int, ...) -> c_int) {
  args := va_start(count); // args : c_va_list Free
  mut(result) := 0;
  mut(i) := 0;
  while i < count, i = (i + 1), {
    result = (result + va_arg(args, i32));
  };
  va_end(args);
  return result;
};

// c23 style variadic function
add_va_c23 :: ((...) -> c_int) {
  args := va_start(); // no need to pass count
  c_int count = va_arg(args, c_int);
  mut(result) := 0;
  mut(i) := 0;
  while i < count, i = (i + 1), {
    result = (result + va_arg(args, i32));
  };
  va_end(args);
  return result;
};

// C variadic function
add_va_c :: ((...(args) : VarList) -> c_int) {
  // ...(arg_name) will automatically initialize "VarList" as "arg_name" for you
  // args has type "VarList" which is Linear
  c_int count = args.length(); // Get the count of variadic arguments
  mut(result) := 0;
  mut(i) := 0;
  while i < count, i = (i + 1), {
    result = (result + args.arg(i32)); // Pop the variadic argument and set it to i32
  };
  // RAII clean up the "args";
  return result;
};

// Yo variadic function
add_va_yo :: (fn(forall(count: usize), ...(args) : Array(c_int, count)) -> c_int) {
  mut(result) := 0;
  mut(i) := 0;
  while i < count, i = (i + 1), {
    result = (result + args(i));
  };
  // RAII clean up the "args";
  return result;
};

```

## Advanced Types

### Dependent types

Dependent types are types which depend on values.

```rust
Vector :: (fn(compt(N) : i32) -> compt(Type))
  Array(i32, N)
;

add_vectors :: (fn(forall(N : compt(i32)), a: Vector(N), b: Vector(N)) -> Vector(N))
  a.map((x, i) -> (x + b(i)))
;

v1 := [1, 2, 3]; // v1: Array(i32, 3), which is Vector(3)
v2 := [4, 5, 6]; // v2: Array(i32, 3), which is Vector(3)
result := add_vectors(v1, v2); // [5, 7, 9]

// The code below will not compile
v3 := [1, 2]; // v3: Array(i32, 2), which is Vector(2)
v4 := [4, 5, 6]; // v4: Array(i32, 3), which is Vector(3)
// error := add_vectors(v3, v4); // Compiler Error: Vector(2) and Vector(3) are different types.
```

### Refinement types

Refinement types consists of all values of a given type which satisfy a given predicate.

```rust
PositiveNumber :: (compt(i32) |: (@ > 0));
NonEmptyString :: (compt(String) |: (@.length() > 0));

divide :: (fn(x: PositiveNumber, y: PositiveNumber) -> PositiveNumber)
  (x / y)
;

x := 10; // Valid: x: PositiveNumber
// y := -10; // Compiler Error: -10 is not a PositiveNumber

result := divide(10, 2); // Valid
```

```rust
NaturalNumber :: (i32 |: (@ >= 0));
PositiveNumber :: (i32 |: (@ > 0));
Equal :: (fn(compt(n): i32) -> Type)
  (i32 |: (@ == n))
;
Index :: (fn(compt(T): Type, compt(a): Array(T, _)) -> Type)
  (NaturalNumber |: (@ < a.length()))
;
NotEmptyArray :: (fn(compt(T): Type) -> Type)
  (Array(T, _) |: (@.length() > 0))
;

get :: (fn(forall(T: Type, a: Array(T, _)), index: Index(T, a), array: a) -> T)
  array(index)
;

set :: (fn(forall(T: Type, a: Array(T, _)), index: Index(T, a), array: a, value: T) -> a)
  { array(index) = value; array }
;

head :: (fn(forall(T: Type), array: NotEmptyArray(T)) -> T)
  array(0)
;
```

### Higher Kinded Types

Higher Kinded Types are types that take other types as parameters.

```rust
T1 :: (fn(compt(F): (Type -> Type), compt(A): Type) -> Type)
  F(A)
;

Option :: (fn(compt(T): Type) -> Type)
  T1(Maybe, T)
;
```

### Generalized Algebraic Data Types (GADTs)

```rust
MyExpr :: (fn(compt(T): Type) -> Type)
  enum(
    IntExpr(i : i32), // MyExpr(i32)
    BoolExpr(b : bool), // MyExpr(bool)
    EqExpr(a : MyExpr(i32), b : MyExpr(i32)) // MyExpr(bool)
  )
;

eval :: (fn(forall(T: Type), expr: MyExpr(T)) -> T)
  match(expr,
    .IntExpr(i) => i,
    .BoolExpr(b) => b,
    .EqExpr(left, right) => (eval(left) == eval(right))
  )
;

expr1 := MyExpr.EqExpr(MyExpr.IntExpr(1), MyExpr.IntExpr(2)); // expr1: MyExpr(bool)
eval(expr1); // false
```
