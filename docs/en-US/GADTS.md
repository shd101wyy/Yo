# Generalized Algebraic Data Types (GADTs)

## Overview

GADTs extend Yo's enum types by allowing each constructor to specify the exact instantiation of the type parameter it returns. This enables the type system to **refine type variables during pattern matching**, giving each match branch more precise type information.

## Syntax

### Arrow syntax: `-> recur(ConcreteType)`

Each GADT constructor specifies its return type using `-> recur(Type1, Type2, ...)` after the field list:

```rust
Value :: (fn(comptime(T) : Type) -> comptime(Type))(
  enum(
    IntVal(i : i32) -> recur(i32),
    BoolVal(b : bool) -> recur(bool),
    PairVal(a : i32, b : bool) -> recur(i32)
  )
);
```

- `-> recur(i32)` means `IntVal` constructs a `Value(i32)`
- `-> recur(bool)` means `BoolVal` constructs a `Value(bool)`
- When `-> recur(...)` is omitted, it defaults to the unconstrained case (same as regular enum behavior)

### Multi-parameter GADTs

```rust
MyPair :: (fn(comptime(A) : Type, comptime(B) : Type) -> comptime(Type))(
  enum(
    MkIntBool(x : i32, y : bool) -> recur(i32, bool),
    MkBoolInt(x : bool, y : i32) -> recur(bool, i32)
  )
);
```

### GADTs with custom discriminants

Custom discriminants and GADT return types coexist:

```rust
Tagged :: (fn(comptime(T) : Type) -> comptime(Type))(
  enum(
    (TagInt(i : i32) -> recur(i32)) = 10,
    (TagBool(b : bool) -> recur(bool)) = 20
  )
);
```

### Mixed GADT and regular variants

Some variants can have GADT annotations while others remain unconstrained:

```rust
MixedVal :: (fn(comptime(T) : Type) -> comptime(Type))(
  enum(
    MInt(i : i32) -> recur(i32),
    MBool(b : bool) -> recur(bool),
    MGeneric(v : T)  // no GADT annotation — unconstrained
  )
);
```

## Type Refinement in Match

The core GADT feature: when pattern matching on a GADT value, the type system refines type variables in each branch.

```rust
eval_value :: (fn(generic(T : Type), v : Value(T)) -> T)(
  match(v,
    .IntVal(i) => i,      // T refined to i32, so i : i32 and return i32 ✓
    .BoolVal(b) => b,     // T refined to bool, so b : bool and return bool ✓
    .PairVal(a, b) => a   // T refined to i32, so a : i32 and return i32 ✓
  )
);

// Usage:
v := Value(i32).IntVal(i32(42));
result := eval_value(v);  // result : i32 = 42
```

Each branch can return a different concrete type — the type checker verifies each branch's return type matches the GADT-refined type parameter.

## Exhaustiveness Checking

When matching a GADT value with a concrete type, the type system filters out unreachable variants:

```rust
// Value(i32) can only be IntVal or PairVal
// BoolVal is unreachable (it returns Value(bool), not Value(i32))
eval_int_only :: (fn(v : Value(i32)) -> i32)(
  match(v,
    .IntVal(i) => i,
    .PairVal(a, b) => a
    // No .BoolVal needed — it's unreachable for Value(i32)
  )
);
```

## Runtime Representation

GADTs have the **same C representation as regular enums**. All type refinement is purely compile-time — at runtime, a GADT is just a tagged union. No special codegen is needed.

## Design Rationale

- `->` mirrors function return type syntax — each constructor is conceptually a function producing a specific type instantiation
- `recur` reuses the existing keyword for self-reference — just as `recur(args)` calls the enclosing function, `recur(i32)` applies the enclosing type constructor
- Functions consuming GADTs require explicit `generic` type annotations (already standard in Yo)

## Interaction with Other Features

- **HKT**: Orthogonal. A GADT can be used as an HKT type constructor.
- **Partial application**: Works unchanged with `_` placeholder.
- **Algebraic effects**: No interaction — effects operate at function call level.

## Limitations

- **No existential types**: Constructors cannot introduce new type variables not in the enum's parameters.
- **No nested destructuring**: Use multi-level matching as with regular enums.
- Type refinement only applies in `match` expressions, not in `cond`.
