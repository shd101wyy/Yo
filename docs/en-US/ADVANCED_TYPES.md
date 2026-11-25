# Advanced Types

Type-level techniques beyond structs and enums: higher-kinded types,
generalized algebraic data types (GADTs) and typestate. The basic data types are
in [DATA_TYPES.md](./DATA_TYPES.md); traits are in [TRAITS.md](./TRAITS.md).

## Higher-Kinded Types (HKT)

Yo supports higher-kinded types through **comptime function types as kinds**. Type constructors like `Option` and `Result` are already first-class comptime function values — HKT lets you abstract over them.

| Haskell Kind  | Yo Equivalent                                                  |
| ------------- | -------------------------------------------------------------- |
| `*`           | `Type`                                                         |
| `* -> *`      | `fn(comptime(T) : Type) -> comptime(Type)`                     |
| `* -> * -> *` | `fn(comptime(A) : Type, comptime(B) : Type) -> comptime(Type)` |

### HKT generic parameters

Declare a generic parameter with a function-type kind to accept type constructors:

```yo
// F is a type constructor (kind: Type → Type)
identity :: (
  fn(
    generic(F : (fn(comptime(T) : Type) -> comptime(Type)), A : Type),
    x : F(A)
  ) -> F(A)
)(x);

// Usage:
(x : Option(i32)) = .Some(i32(42));
result := identity(generic(Option, i32), x); // result: Option(i32)
inferred := identity(x); // F = Option, A = i32 from the argument
```

A kind-annotated parameter is inferred from an argument's instantiation: `x : F(A)` given an
`Option(i32)` binds `F` to the constructor `Option` and `A` to `i32`, and a result `F(A)` is
then the same `Option(i32)` a direct call would build.

### HKT traits

Define traits parameterized by type constructors:

```yo
// Functor trait — F is a type constructor
Functor :: (fn(comptime(F) : (fn(comptime(T) : Type) -> comptime(Type))) -> comptime(Trait))(
  trait(
    map : (fn(generic(A : Type, B : Type), self : F(A), f : (fn(a : A) -> B)) -> F(B))
  )
);

// Implement Functor for Option
impl(
  generic(A : Type),
  Option(A),
  Functor(Option)(
    map : (fn(generic(A : Type, B : Type), self : Option(A), f : (fn(a : A) -> B)) -> Option(B))(
      match(
        self,
        .Some(v) => .Some(f(v)),
        .None => .None
      )
    )
  )
);

// Use the trait method
(x : Option(i32)) = .Some(i32(42));
result := x.map(generic(i32), (fn(a : i32) -> i32)(a + i32(1)));
// result = .Some(i32(43))
```

### Generic functions with HKT where clauses

```yo
do_map :: (
  fn(
    generic(F : (fn(comptime(T) : Type) -> comptime(Type)), A : Type, B : Type),
    container : F(A),
    f : (fn(a : A) -> B),
    where(F(A) <: Functor(F))
  ) -> F(B)
)(
  container.map(generic(B), f)
);

(x : Option(i32)) = .Some(i32(10));
result := do_map(generic(Option, i32, i32), x, (fn(a : i32) -> i32)(a * i32(2)));
// result = .Some(i32(20))
```

## Generalized Algebraic Data Types (GADTs)

### Overview

GADTs extend Yo's enum types by allowing each constructor to specify the exact instantiation of the type parameter it returns. This enables the type system to **refine type variables during pattern matching**, giving each match branch more precise type information.

### Syntax

#### Arrow syntax: `-> recur(ConcreteType)`

Each GADT constructor specifies its return type using `-> recur(Type1, Type2, ...)` after the field list:

```yo
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

#### Multi-parameter GADTs

```yo
MyPair :: (fn(comptime(A) : Type, comptime(B) : Type) -> comptime(Type))(
  enum(
    MkIntBool(x : i32, y : bool) -> recur(i32, bool),
    MkBoolInt(x : bool, y : i32) -> recur(bool, i32)
  )
);
```

#### GADTs with custom discriminants

Custom discriminants and GADT return types coexist:

```yo
Tagged :: (fn(comptime(T) : Type) -> comptime(Type))(
  enum(
    (TagInt(i : i32) -> recur(i32)) = 10,
    (TagBool(b : bool) -> recur(bool)) = 20
  )
);
```

#### Mixed GADT and regular variants

Some variants can have GADT annotations while others remain unconstrained:

```yo
MixedVal :: (fn(comptime(T) : Type) -> comptime(Type))(
  enum(
    MInt(i : i32) -> recur(i32),
    MBool(b : bool) -> recur(bool),
    MGeneric(v : T) // no GADT annotation — unconstrained
  )
);
```

### Type Refinement in Match

The core GADT feature: when pattern matching on a GADT value, the type system refines type variables in each branch.

```yo
eval_value :: (fn(generic(T : Type), v : Value(T)) -> T)(
  match(
    v,
    .IntVal(i) => i,
    // T refined to i32, so i : i32 and return i32 ✓
    .BoolVal(b) => b,
    // T refined to bool, so b : bool and return bool ✓
    .PairVal(a, b) => a // T refined to i32, so a : i32 and return i32 ✓
  )
);

// Usage:
v := Value(i32).IntVal(i32(42));
result := eval_value(v); // result : i32 = 42
```

Each branch can return a different concrete type — the type checker verifies each branch's return type matches the GADT-refined type parameter.

### Exhaustiveness Checking

When matching a GADT value with a concrete type, the type system filters out unreachable variants:

```yo
// Value(i32) can only be IntVal or PairVal
// BoolVal is unreachable (it returns Value(bool), not Value(i32))
eval_int_only :: (fn(v : Value(i32)) -> i32)(
  match(
    v,
    .IntVal(i) => i,
    .PairVal(a, b) => a
    // No .BoolVal needed — it's unreachable for Value(i32)
  )
);
```

An arm for an excluded variant is an error (E0608): no `Value(i32)` holds a
`.BoolVal`. In a generic function over `Value(T)` every variant's arm is
needed, because each instantiation excludes different ones.

### Type Identity and Construction

The type arguments of a GADT (or any generic enum) are part of its type, even when no variant
payload mentions them. `Value(i32)` and `Value(bool)` have identical payload shapes, and are still
two different types:

```yo
x := Value(i32).IntVal(i32(77));
(y : Value(bool)) = x; // error[E0601]: Incompatible types (Value(bool) vs Value(i32))
```

A variant constructs only the instantiation its `-> recur(...)` index names. Naming it through a
different instantiation is a type error, both spelled out and as a shorthand:

```yo
Value(i32).BoolVal(true); // error[E0601]: GADT variant "BoolVal" is declared
// `-> recur(bool)`, so it cannot construct a Value(i32)
(v : Value(i32)) = .BoolVal(true); // same error
(w : Value(bool)) = .BoolVal(true); // OK
```

This is what makes the exhaustiveness filtering above sound: a `Value(i32)` can never hold a
`BoolVal`, so a match that omits that arm cannot fall off.

### Runtime Representation

GADTs have the **same C representation as regular enums**. All type refinement is purely compile-time — at runtime, a GADT is just a tagged union. No special codegen is needed.

### Design Rationale

- `->` mirrors function return type syntax — each constructor is conceptually a function producing a specific type instantiation
- `recur` reuses the existing keyword for self-reference — just as `recur(args)` calls the enclosing function, `recur(i32)` applies the enclosing type constructor
- Functions consuming GADTs require explicit `generic` type annotations (already standard in Yo)

### Interaction with Other Features

- **HKT**: Orthogonal. A GADT can be used as an HKT type constructor.
- **Partial application**: Works unchanged with `_` placeholder.
- **Algebraic effects**: No interaction — effects operate at function call level.

### Limitations

- **No existential types**: Constructors cannot introduce new type variables not in the enum's parameters. `Box(Dyn(Trait))` is the supported way to hide a type; see [TRAIT_OBJECTS.md § Existential Types](./TRAIT_OBJECTS.md#existential-types) for the three forms Yo has and the one it does not.
- Type refinement only applies in `match` expressions, not in `cond`.
- Every arm is checked under its refinement at definition, even in a `generic` function nothing
  calls: an ill-typed `.BoolVal(b) => i32(7)` arm is an error at `yo check`, because a mismatch
  between two concrete types cannot be fixed by any instantiation
  (`issues/fixed/gadt-arm-is-type-checked-only-when-its-index-is-instantiated.md`).

Nested patterns work on GADT values like on any enum (`.Wrap(.PairVal(a, true))`), and the
exhaustiveness filter applies at every level.

## Typestate

A protocol state can live in a type, as in ATS's indexed resources
(`FILEptr(mode)`): a phantom comptime parameter that no field mentions, and
functions that accept only the state they need. A wrong-state call is a type
error (E0601).

```yo
Open :: struct();
Closed :: struct();
Handle :: (fn(comptime(S) : Type) -> comptime(Type))(struct(fd : i32));

open_h :: (fn(fd : i32) -> Handle(Open))(Handle(Open)(fd : fd));
read_h :: (fn(h : Handle(Open)) -> i32)(h.fd);
close_h :: (fn(sink(h) : Handle(Open)) -> Handle(Closed))(Handle(Closed)(fd : h.fd));

main :: (fn() -> unit)({
  h := open_h(i32(3));
  c := close_h(h);
  // read_h(c);   // E0601: expected Handle(Open), given Handle(Closed)
  // read_h(h);   // E0901: use of moved value `h`
});
export(main);
```

The pattern is only sound when the old state CANNOT be used after a
transition, so two rules apply:

- **The handle is move-only and the transition takes it with `sink(...)`.**
  The move makes the old name unusable (E0901). A handle type that derives
  `Copy` is COPIED into the call, so the closed handle and its `Open` copy
  would both stay usable.
- **No other alias keeps the old state.** A handle cloned into a second name
  before the transition still has the old type. Keep a typestate handle in
  one name.

std's `File` and sockets keep their state at run time instead.
