# Derive Traits

`derive` is a compile-time builtin that automatically generates trait implementations for struct and enum types. It works similarly to Rust's `#[derive(...)]` attribute but uses function call syntax.

All six standard derivable traits (Eq, Hash, Clone, Ord, ToString, Default) are **self-hosted** — their derive rules are written in Yo using the `derive_rule` mechanism, not hardcoded in the compiler.

## Basic Usage

```rust
Point :: struct(x : i32, y : i32);
derive(Point, Eq(Point), Hash, Clone, Ord(Point), ToString, Default);

main :: (fn() -> unit) {
  p1 := Point(i32(1), i32(2));
  p2 := Point(i32(1), i32(2));
  assert((p1 == p2), "points should be equal");
};
export main;
```

`derive` accepts a type as the first argument followed by one or more trait expressions. Parameterized traits like `Eq` and `Ord` require explicit type arguments (e.g., `Eq(Point)`). Parameterless traits like `Hash`, `Clone`, and `ToString` can be passed as bare names.

## Standard Derivable Traits

### Eq

Generates structural equality comparison. Two values are equal if all their fields are equal. Requires explicit type argument: `Eq(Type)`.

```rust
Color :: struct(r : u8, g : u8, b : u8);
derive(Color, Eq(Color));

// Now you can use == and !=
assert((Color(u8(255), u8(0), u8(0)) == Color(u8(255), u8(0), u8(0))), "same color");
```

For enums, equality checks the variant tag first, then compares fields if the variants match:

```rust
Shape :: enum(Circle(radius : i32), Rect(w : i32, h : i32));
derive(Shape, Eq(Shape));

assert((.Circle(i32(5)) == .Circle(i32(5))), "same circle");
```

### Hash

Generates `hash(self, hasher)` — the Rust-style `Hash` method that feeds a value's identity into any `Hasher`. A struct feeds every field in declaration order; an enum feeds its variant index (as `u64`) and then that variant's fields. The algorithm is the hasher's business: `HashMap`/`HashSet` drive SipHash-1-3 (`std/hash`'s `DefaultHasher`), and `hash_one(value)` hashes a single value with it.

```rust
{ hash_one, DefaultHasher } :: import("std/hash");
derive(Point, Hash);
// Point now implements the Hash trait
h := hash_one(Point(i32(1), i32(2)));   // one value → u64
hasher := DefaultHasher.new();          // or stream several values into one hasher
Point(i32(1), i32(2)).hash(hasher);
Point(i32(3), i32(4)).hash(hasher);
combined := hasher.finish();
```

Equal values (by the derived `Eq`) feed identical bytes, so they hash alike under every hasher. Field types must implement `Hash`; floats deliberately do not.

### Clone

Generates a clone method that creates a deep copy by cloning each field.

```rust
derive(Point, Clone);

p := Point(i32(1), i32(2));
p2 := p.clone();
```

### Ord

Generates lexicographic ordering by comparing fields left-to-right. Requires explicit type argument: `Ord(Type)`. For enums, variants are ordered by their discriminant, then by field values.

```rust
derive(Point, Ord(Point));

p1 := Point(i32(1), i32(2));
p2 := Point(i32(1), i32(3));
assert((p1 < p2), "p1 < p2");
```

### ToString

Generates a string representation. Structs produce `TypeName(field1, field2, ...)` format. Enums produce `TypeName.Variant` or `TypeName.Variant(field1, ...)` format.

```rust
derive(Point, ToString);

p := Point(i32(1), i32(2));
// p.to_string() returns "Point(1, 2)"
```

### Default

Generates a value with every field set to its own type's default. **Structs only** — an enum has no canonical default variant, so write that impl by hand.

```rust
Config :: struct(retries : i32, verbose : bool, name : String);
derive(Config, Default);

d := (Config <: Default).default();
// Config(retries : 0, verbose : false, name : "")
```

Each field type must implement `Default`. Field types that are generic instantiations work too — `ArrayList(i32)`, `Option(T)` and so on — because the rule reaches each field's type through the struct's own field list rather than by naming it, so nothing needs to be in scope at the impl site.

Pairs with `Option.unwrap_or_default` and `Result.unwrap_or_default`.

## Multiple Traits

You can derive multiple traits in a single call using variadic comptime parameters:

```rust
derive(Point, Eq(Point), Hash, Clone, Ord(Point), ToString);
```

This is equivalent to calling `derive` separately for each trait.

## Enum Support

All standard derives work with enums, including enums with fields:

```rust
// Fieldless enum
Direction :: enum(North, South, East, West);
derive(Direction, Eq(Direction), Hash, Clone, Ord(Direction), ToString);

// Enum with fields
Shape :: enum(Circle(radius : i32), Rect(w : i32, h : i32));
derive(Shape, Eq(Shape), Clone, ToString);
```

For fieldless enums, equality and ordering are based on the variant discriminant. For enums with fields, the variant is checked first, then fields are compared.

## Requirements

Each field type in the struct or enum must already implement the trait being derived. For example, to `derive(Point, Eq(Point))`, the types `i32` (used for `x` and `y`) must implement `Eq`. Built-in types (`i32`, `u8`, `bool`, `str`, `String`, etc.) implement all standard traits.

## `derive_rule` — User-Registrable Derive Rules

`derive_rule` lets trait authors register how their traits should be derived. Once registered, `derive(Type, MyTrait(Type))` works exactly like the standard traits.

### Defining a Derive Rule

A derive rule is a comptime function with signature:

```rust
fn(comptime(T) : Type, comptime(ctx) : DeriveContext, comptime(trait_params) : ComptimeList(Expr)) -> comptime(Expr)
```

- `T` — the target type being derived for
- `ctx` — a `DeriveContext` struct with `target` (Expr), `forall_params`, `where_clause`
- `trait_params` — trait constructor arguments as a list of Exprs

The function returns an `Expr` (via `quote` or `.to_expr()`) representing the `impl` block to generate.

### Example: Struct Equality

```rust
// Define a custom equality trait
MyEq :: (fn(comptime(Rhs) : Type) -> comptime(Trait))(
  trait(
    my_eq : (fn(self : Self, other : Rhs) -> bool)
  )
);

// Provide base impls
impl(i32, MyEq(i32)(my_eq : ((self, other) -> (self == other))));
impl(bool, MyEq(bool)(my_eq : ((self, other) -> (self == other))));

// Register derive rule for MyEq
my_derive_eq :: (fn(comptime(T) : Type, comptime(ctx) : DeriveContext, comptime(trait_params) : ComptimeList(Expr)) -> comptime(Expr))(
  {
    info :: Type.get_info(T);
    eq_body :: cond(
      info.is_struct() => cond(
        (Type.get_struct_fields(T).len() == usize(0)) => quote(true),
        true => Type.join_fields(
          T,
          (fn(comptime(field) : FieldInfo) -> comptime(Expr))(
            quote(self.(#(field.name.to_expr())).my_eq(other.(#(field.name.to_expr()))))
          ),
          quote(&&)
        )
      ),
      true => quote(false)
    );
    ctx.make_impl(quote(
      MyEq(...#(trait_params))(
        my_eq : ((self, other) -> #(eq_body))
      )
    ))
  }
);

derive_rule(MyEq, my_derive_eq);

// Now derive works for any struct
Point :: struct(x : i32, y : i32);
derive(Point, MyEq(Point));
// p1.my_eq(p2) works!
```

### DeriveContext

`DeriveContext` (defined in `std/prelude.yo`) provides:

- `target : Expr` — the raw target type expression for splicing
- `forall_params : Option(Expr)` — optional generic clause from the derive call
- `where_clause : Option(Expr)` — optional where clause
- `make_impl(trait_body : Expr) -> Expr` — constructs the complete `impl(...)` expression with proper generic/where wrapping

### Enum Derive Rules

For fieldless enums, use `Type.map_variants` to generate match branches:

```rust
info.is_enum() => {
  match_branches :: Type.map_variants(
    T,
    (fn(comptime(variant) : VariantInfo) -> comptime(Expr))(
      quote(
        .(#(variant.name.to_expr())) => match(other,
          .(#(variant.name.to_expr())) => true,
          _ => false
        )
      )
    )
  );
  quote(match(self, ...#(match_branches)))
}
```

### Generic Derive with generic/where

Derive rules work with generic types using `generic` and `where`:

```rust
Pair :: (fn(comptime(A) : Type, comptime(B) : Type) -> comptime(Type))(
  struct(first : A, second : B)
);

derive(generic(T1, T2), Pair(T1, T2), where((T1 <: MyEq(T1)), (T2 <: MyEq(T2))), MyEq(Pair(T1, T2)));
```

The `DeriveContext.make_impl` method automatically includes the generic/where clauses in the generated impl.

### Rule Lookup Order

When `derive(Type, Trait)` is called:

1. **Registered derive rule** (via `derive_rule`) — checked first on the trait type or its constructor function
2. **Comptime function** — if the trait argument evaluates to a comptime function
3. **Error** — if none of the above match

### Self-Hosted Standard Derives

All six standard traits use the same `derive_rule` mechanism:

- **Eq, Clone, Hash, Ord, Default** — derive rules defined in `std/prelude.yo`
- **ToString** — derive rule defined in `std/fmt/to_string.yo` (where the ToString trait is defined)

These implementations use string-based code generation with `comptime_str` and `.to_expr()` to build impl blocks at compile time.

## Type Reflection

Derive rules can inspect types at compile time using `Type.get_info(T)` and the `__yo_type_*` builtins. See [TYPE_REFLECTION.md](./TYPE_REFLECTION.md) for the full documentation.

## Design Document

For the full design including implementation details, see [DERIVE_TRAITS.md](../../plans/DERIVE_TRAITS.md).
