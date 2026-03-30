# In Design

<!-- @import "[TOC]" {cmd="toc" depthFrom=2 depthTo=6 orderedList=false} -->

<!-- code_chunk_output -->

- [Function Declaration](#function-declaration)
  - [Variadic functions](#variadic-functions)
- [Advanced Types](#advanced-types)
  - [Dependent types](#dependent-types)
  - [Refinement types](#refinement-types)
  - [Existential types](#existential-types)

<!-- /code_chunk_output -->

> **Implemented features** (moved to DESIGN.md):
>
> - **Higher-Kinded Types (HKT)** — see [Advanced Type System](../docs/en-US/DESIGN.md#advanced-type-system)
> - **Generalized Algebraic Data Types (GADTs)** — see [Advanced Type System](../docs/en-US/DESIGN.md#generalized-algebraic-data-types-gadts)
> - **Partial Application with `_`** — see [Function Declaration](../docs/en-US/DESIGN.md#partial-application-with-_)

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
Vector :: (fn(comptime(N) : i32) -> comptime(Type))
  Array(i32, N)
;

add_vectors :: (fn(forall(N : comptime(i32)), a: Vector(N), b: Vector(N)) -> Vector(N))
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
PositiveNumber :: (comptime(i32) |: (@ > 0));
NonEmptyString :: (comptime(String) |: (@.length() > 0));

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
Equal :: (fn(comptime(n): i32) -> Type)
  (i32 |: (@ == n))
;
Index :: (fn(comptime(T): Type, comptime(a): Array(T, _)) -> Type)
  (NaturalNumber |: (@ < a.length()))
;
NotEmptyArray :: (fn(comptime(T): Type) -> Type)
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

### Existential types

Existential types allow constructors to introduce type variables that are hidden from the outside — the consumer only knows the type satisfies certain constraints, not its concrete identity.

```rust
// Hypothetical syntax — a constructor with forall introduces an existential
Showable :: enum(
  Wrap(forall(T : Type), value : T, show : (fn(v : T) -> String), where(T <: ToString))
);

// Construction: the concrete type (i32) is known here
s := Showable.Wrap(i32(42), ToString(i32).to_string);

// Consumption: T is hidden — can only use the provided show function
match(s,
  .Wrap(value, show) => show(value)  // returns String, T is skolemized
);
```

**Status: Low priority.** Not planned for near-term implementation for these reasons:

1. **`Dyn`/`dyn` already covers the primary use case.** Type erasure behind a trait interface — the main motivation for existentials — is handled by Yo's existing dynamic dispatch:

   ```rust
   (s : Dyn(ToString)) = dyn(i32(42));  // type erased, only trait interface remains
   ```

2. **High implementation complexity.** Existential types require skolemization in the type checker (preventing the hidden type variable from "escaping" its scope), which significantly complicates the evaluator and type inference.

3. **GADTs cover the more useful half.** GADTs provide type refinement on _deconstruction_ (pattern matching). Existentials provide type hiding on _construction_. In practice, the GADT half delivers more value for type-safe DSLs and expression evaluators.

4. **Additive if needed later.** Existentials could be added via `forall` in enum constructors without breaking existing code, so deferring has no cost.

If Yo eventually needs heterogeneous collections beyond what `Dyn` provides, or first-class type-hiding for module boundaries, existential types would be the natural extension.
