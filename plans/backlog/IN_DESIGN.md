# In Design

<!-- @import "[TOC]" {cmd="toc" depthFrom=2 depthTo=6 orderedList=false} -->

<!-- code_chunk_output -->

- [Function Declaration](#function-declaration)
  - [Variadic functions](#variadic-functions)
- [Advanced Types](#advanced-types)
  - [Existential types](#existential-types)

<!-- /code_chunk_output -->

> **Implemented features** (moved to DESIGN.md):
>
> - **Higher-Kinded Types (HKT)** — see [Advanced Type System](../../docs/en-US/DESIGN.md#advanced-type-system)
> - **Generalized Algebraic Data Types (GADTs)** — see [Advanced Type System](../../docs/en-US/DESIGN.md#generalized-algebraic-data-types-gadts)
> - **Partial Application with `_`** — see [Function Declaration](../../docs/en-US/DESIGN.md#partial-application-with-_)

> **Decided non-goals** (see [DEPENDENT_TYPES_POSITION.md](DEPENDENT_TYPES_POSITION.md), decided 2026-07-24):
>
> - **Runtime dependent types** — types computed from runtime values are a permanent non-goal. Types may already depend on compile-time-known values (the comptime layer: `Array(T, N)`, GADT indices, phantom parameters); properties of runtime values (bounds, sortedness, length relationships) belong to the verifier's `requires`/`ensures` clauses ([FORMAL_VERIFICATION.md](FORMAL_VERIFICATION.md)), not the type system.
> - **Type-system refinement types** (a `T |: predicate` type former) — rejected for the same reason: refinement is discharged by an SMT solver over signatures, keeping type checking decidable. These two sections were removed from this page when the position was decided.

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
