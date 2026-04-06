# Derive Traits

`derive` is a compile-time builtin that automatically generates trait implementations for struct and enum types. It works similarly to Rust's `#[derive(...)]` attribute but uses function call syntax.

## Basic Usage

```rust
Point :: struct(x : i32, y : i32);
derive(Point, Eq, Hash, Clone);

main :: (fn() -> unit) {
  p1 := Point(i32(1), i32(2));
  p2 := Point(i32(1), i32(2));
  assert((p1 == p2), "points should be equal");
};
export main;
```

`derive` accepts a type as the first argument followed by one or more trait names. It generates `impl` blocks for each trait.

## Built-in Derivable Traits

### Eq

Generates structural equality comparison. Two values are equal if all their fields are equal.

```rust
Color :: struct(r : u8, g : u8, b : u8);
derive(Color, Eq);

// Now you can use == and !=
assert((Color(u8(255), u8(0), u8(0)) == Color(u8(255), u8(0), u8(0))), "same color");
```

For enums, equality checks the variant tag first, then compares fields if the variants match:

```rust
Shape :: enum(Circle(radius : i32), Rect(w : i32, h : i32));
derive(Shape, Eq);

assert((.Circle(i32(5)) == .Circle(i32(5))), "same circle");
```

### Hash

Generates a hash function by combining the hashes of all fields using `hash_combine`. For enums, the variant index is included in the hash.

```rust
derive(Point, Hash);
// Point now implements the Hash trait
```

### Clone

Generates a clone method that creates a deep copy by cloning each field.

```rust
derive(Point, Clone);

p := Point(i32(1), i32(2));
p2 := p.clone();
```

### Ord

Generates lexicographic ordering by comparing fields left-to-right. Returns `Ordering` (`.Less`, `.Equal`, `.Greater`). For enums, variants are ordered by their index, then by field values.

```rust
derive(Point, Ord);

p1 := Point(i32(1), i32(2));
p2 := Point(i32(1), i32(3));
assert((p1.compare(p2) == .Less), "p1 < p2");
```

### ToString

Generates a string representation. Structs produce `TypeName(field1, field2, ...)` format. Enums produce `TypeName.Variant(field1, ...)` format.

```rust
derive(Point, ToString);

p := Point(i32(1), i32(2));
// p.to_string() returns "Point(1, 2)"
```

## Multiple Traits

You can derive multiple traits in a single call using variadic comptime parameters:

```rust
derive(Point, Eq, Hash, Clone, Ord, ToString);
```

This is equivalent to calling `derive` separately for each trait.

## Explicit Trait Arguments

You can pass explicit trait type arguments using `Trait(Type)` syntax:

```rust
Vec2 :: struct(x : f64, y : f64);
derive(Vec2, Eq(Vec2));
```

Both bare trait names (`Eq`) and explicit trait type arguments (`Eq(Vec2)`) are supported and can be mixed:

```rust
derive(Vec2, Eq(Vec2), Hash, Clone);
```

## Enum Support

All built-in derives work with enums, including enums with fields:

```rust
// Fieldless enum
Direction :: enum(North, South, East, West);
derive(Direction, Eq, Hash, Clone, Ord, ToString);

// Enum with fields
Result :: enum(Ok(value : i32), Err(msg : str));
derive(Result, Eq, Clone, ToString);
```

For fieldless enums, equality and ordering are based on the variant index. For enums with fields, the variant is checked first, then fields are compared.

## Requirements

Each field type in the struct or enum must already implement the trait being derived. For example, to `derive(Point, Eq)`, the types `i32` (used for `x` and `y`) must implement `Eq`. Built-in types (`i32`, `u8`, `bool`, `str`, `String`, etc.) implement all standard traits.

## `derive_rule` — User-Registrable Derive Rules

`derive_rule` lets trait authors register how their traits should be derived. Once registered, `derive(Type, MyTrait)` works exactly like the built-in traits.

### Defining a Derive Rule

A derive rule is a comptime function with signature:

```rust
fn(comptime(T) : Type, comptime(ctx) : DeriveContext, comptime(trait_params) : ComptimeList(Expr)) -> comptime(Expr)
```

- `T` — the target type being derived for
- `ctx` — a `DeriveContext` struct with `target` (Expr), `forall_params`, `where_clause`
- `trait_params` — trait constructor arguments as a list of Exprs

The function returns an `Expr` (via `quote`) representing the `impl` block to generate.

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
    eq_body :: cond(
      __yo_type_is_struct(T) => cond(
        (__yo_type_field_count(T) == 0) => quote(true),
        true => __yo_type_join_fields(
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
- `forall_params : Option(Expr)` — optional forall clause from the derive call
- `where_clause : Option(Expr)` — optional where clause
- `make_impl(trait_body : Expr) -> Expr` — constructs the complete `impl(...)` expression with proper forall/where wrapping

### Enum Derive Rules

For fieldless enums, use `__yo_type_map_variants` to generate match branches:

```rust
__yo_type_is_enum(T) => {
  match_branches :: __yo_type_map_variants(
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

### Generic Derive with forall/where

Derive rules work with generic types using `forall` and `where`:

```rust
Pair :: (fn(comptime(A) : Type, comptime(B) : Type) -> comptime(Type))(
  struct(first : A, second : B)
);

derive(forall(T1, T2), Pair(T1, T2), where((T1 <: MyEq(T1)), (T2 <: MyEq(T2))), MyEq(Pair(T1, T2)));
```

The `DeriveContext.make_impl` method automatically includes the forall/where clauses in the generated impl.

### Rule Lookup Order

When `derive(Type, Trait)` is called:

1. **Registered derive rule** (via `derive_rule`) — checked first
2. **Built-in derive** (Eq, Hash, Clone, Ord, ToString) — fallback
3. **Comptime function** — if the trait name resolves to a comptime fn
4. **Error** — if none of the above match

Registered rules always take priority over built-in derives.

## Type Reflection

Derive rules can inspect types at compile time using `Type.get_info(T)` and the `__yo_type_*` builtins. See [TYPE_REFLECTION.md](./TYPE_REFLECTION.md) for the full documentation.

## Design Document

For the full design including implementation details, see [DERIVE_TRAITS.md](../../plans/DERIVE_TRAITS.md).
