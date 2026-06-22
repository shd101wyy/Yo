# Derive Traits

## Problem

Yo currently requires users to manually write `impl` blocks for common traits like `Eq`, `Hash`, `Clone`, `Ord`, and `ToString` for every struct and enum type. This is tedious and error-prone, especially for structs with many fields. Rust solves this with `#[derive(Eq, Hash, Clone, ...)]`; Yo needs an equivalent — and unlike Rust, Yo should let users define their own derive rules using comptime functions without a proc-macro system.

## Status — Phase 1 Complete ✅, Phase 2 Complete ✅, TypeTag Complete ✅

Phase 1 (built-in derives + infrastructure) complete: 33 tests in `tests/derive.test.yo`, 10 in `tests/variadic_comptime.test.yo`.
Phase 2 (derive_rule with Expr-based macros) complete: 41 tests in `tests/derive.test.yo`.
TypeTag (type reflection enum) complete: 48 tests in `tests/derive.test.yo`.

### Phase 1 — What's implemented:

1. **Built-in derives** for 5 traits: Eq, Hash, Clone, Ord, ToString (structs + enums)
2. **Explicit trait args**: `derive(Point, Eq(Point))` and bare `derive(Point, Eq)` both work
3. **Variadic comptime parameters**: `...(comptime(name) : ComptimeList(T))` syntax
4. **Type reflection builtins**: 12 `__yo_type_*` builtins for compile-time type introspection
5. **`comptime_eval`**: Parse and evaluate comptime strings as Yo code
6. **User-defined derives**: Comptime functions with `fn(comptime(T) : Type) -> comptime(unit)` signature
7. **Documentation**: `docs/en-US/DERIVE_TRAITS.md` and `docs/zh-CN/DERIVE_TRAITS.md`

### Phase 1 limitations:

- Only 5 hardcoded trait names are recognized by `derive`
- User-defined traits (e.g., `MyEq`) cannot be derived unless the user passes a separate comptime function — `derive(Point, my_derive_fn)` — instead of naturally writing `derive(Point, MyEq(Point))`
- No way for a trait author to register "how to derive this trait"

---

## Phase 2: `derive_rule` — User-Registrable Derive Rules

### Goal

Allow trait authors to register derive rules for their own traits, so that `derive(Point, MyEq(Point))` works for ANY trait — not just the hardcoded 5.

### Motivating example (from `src/tests/fixme.yo`)

```rust
MyEq :: (fn(comptime(Rhs) : Type) -> comptime(Trait))(
  trait(
    eq : (fn(self : Self, other : Rhs) -> bool)
  )
);

// DeriveContext is defined in prelude:
// DeriveContext :: struct(target : Expr, forall_params : Option(Expr), where_clause : Option(Expr));
// DeriveContext has make_impl method for constructing impl Expr with forall/where.

// Register a derive rule for MyEq — fully Expr-based, handles structs and enums
derive_rule(MyEq, (fn(comptime(T) : Type, comptime(ctx) : DeriveContext, comptime(trait_params) : ComptimeList(Expr)) -> comptime(Expr)) {
  info :: Type.get_info(T);
  eq_body :: cond(
    info.is_enum() => {
      match_arms :: Type.map_variants(
        T,
        (fn(comptime(variant) : VariantInfo) -> comptime(Expr)) {
          field_eq :: cond(
            (variant.fields.len() == usize(0)) => quote(true),
            true => quote(false) // simplified — full version uses variant field matching
          );
          quote(
            .(#(variant.name.to_expr())) => match(other,
              .(#(variant.name.to_expr())) => #(field_eq),
              _ => false
            )
          )
        }
      );
      quote(match(self, ...#(match_arms)))
    },
    info.is_struct() => {
      cond(
        (Type.get_struct_fields(T).len() == usize(0)) => quote(true),
        true => Type.join_fields(
          T,
          (fn(comptime(field) : FieldInfo) -> comptime(Expr))(
            quote(self.(#(field.name.to_expr())).eq(other.(#(field.name.to_expr()))))
          ),
          quote(&&)
        )
      )
    },
    true => quote(false)
  );

  // Use ctx.make_impl to construct impl with optional forall/where
  ctx.make_impl(quote(
    MyEq(...#(trait_params))(
      eq : ((self, other) -> #(eq_body))
    )
  ))
});

// --- Concrete struct ---
Point :: struct(x : i32, y : i32);
impl(i32, MyEq(i32)(eq : ((self, other) -> (self == other))));
derive(Point, MyEq(Point));

// --- Enum ---
Shape :: enum(Circle(r : i32), Rectangle(w : i32, h : i32));
derive(Shape, MyEq(Shape));

// --- Generic struct with forall/where ---
GenericPoint :: (fn(comptime(T) : Type) -> comptime(Type))(struct(x : T, y : T));
derive(forall(T : Type), GenericPoint(T), where(T <: MyEq(T)), MyEq(GenericPoint(T)));

main :: (fn() -> unit) {
  // Concrete struct test
  p1 := Point(1, 2);
  p2 := Point(1, 2);
  assert(p1.eq(p2), "Point eq");

  // Enum test
  s1 := Shape.Circle(5);
  s2 := Shape.Circle(5);
  assert(s1.eq(s2), "Shape eq");

  // Generic struct test
  gp1 := GenericPoint(i32)(3, 4);
  gp2 := GenericPoint(i32)(3, 4);
  assert(gp1.eq(gp2), "GenericPoint eq");
};
export main;
```

### Design: `derive_rule(TraitConstructor, DeriveFn)`

#### Syntax

```rust
derive_rule(TraitConstructor, DeriveFn)
```

- **`TraitConstructor`** — The trait or trait constructor function. Can be:
  - A parameterized trait constructor: `MyEq` (which is `fn(comptime(Rhs) : Type) -> comptime(Trait)`)
  - A parameterless trait value: `Hash` (which is directly a `TraitType`)
- **`DeriveFn`** — A comptime function: `fn(comptime(T) : Type, comptime(ctx) : DeriveContext, comptime(trait_params) : ComptimeList(Expr)) -> comptime(Expr)`
  - `comptime(T) : Type` — the target type, for type reflection (field count, field names, is_struct, etc.)
  - `comptime(ctx) : DeriveContext` — context struct containing:
    - `target : Expr` — the target type as an unevaluated Expr, for splicing into `impl(unquote(ctx.target), ...)`
    - `forall_params : Option(Expr)` — the forall clause Expr from the derive call (if any)
    - `where_clause : Option(Expr)` — the where clause Expr from the derive call (if any)
  - `comptime(trait_params) : ComptimeList(Expr)` — trait constructor arguments as Exprs. For `derive(Point, MyEq(Point))`, this is `[Point_expr]`. For `derive(Point, Hash)`, this is `[]` (empty). The derive evaluator collects the args and passes them as a single list.
  - Returns `comptime(Expr)` — the impl expression as AST. The derive evaluator evaluates the returned Expr.

**Not a macro:** The derive rule returns `comptime(Expr)` (not `unquote(Expr)`). It's a regular comptime function that constructs an Expr using `quote`/`unquote`. The `derive` evaluator explicitly evaluates the returned Expr — no macro expansion involved.

#### `DeriveContext` struct (defined in prelude.yo)

```rust
DeriveContext :: struct(
  target : Expr,
  forall_params : Option(Expr),
  where_clause : Option(Expr)
);
```

Defined as a regular struct in `std/prelude.yo`. `Option(Expr)` works in comptime context since `Option` supports comptime types.

The derive evaluator constructs `DeriveContext` from the `derive(...)` call:

- `derive(Point, MyEq(Point))` → `DeriveContext(target=quote(Point), forall_params=.None, where_clause=.None)`
- `derive(forall(A, B), Pair(A, B), where(A <: Eq(A)), MyEq(Pair(A, B)))` → `DeriveContext(target=quote(Pair(A, B)), forall_params=.Some(quote(forall(A, B))), where_clause=.Some(quote(where(A <: Eq(A)))))`

The derive rule has **full control** over how forall/where are included in the generated impl — no automatic wrapping.

#### `comptime(trait_params) : ComptimeList(Expr)` — Trait constructor arguments

The trait constructor arguments from the `derive(...)` call are collected by the derive evaluator and passed as a single `ComptimeList(Expr)`:

```rust
// derive(Point, MyEq(Point))    → trait_params = [quote(Point)]
// derive(Point, MyEq(i32))      → trait_params = [quote(i32)]
// derive(Point, Hash)           → trait_params = [] (empty — Hash has no params)
// derive(Point, Conv(A, B))     → trait_params = [quote(A), quote(B)]
```

Inside the derive rule, use `...#(trait_params)` (unquote_splicing) to reconstruct the trait application:

```rust
quote(MyEq(...#(trait_params)))  // → MyEq(Point) or MyEq(i32) etc.
```

#### Fully Expr-based — No Code-String Generation

The derive rule is a **comptime function** that builds AST using `quote`/`unquote`. Dynamic parts (field names from type reflection) are bridged via `comptime_string.to_expr()` method which converts a field name string to an identifier Expr (like a dynamic `quote`).

Key builtins:

- **`__yo_comptime_string_to_expr(code)`** — `comptime_string` → `Expr`. Exposed to users as `comptime_string.to_expr()` method via `impl` in prelude.
- **`__yo_type_join_fields(T, mapper, combiner)`** — iterates struct fields, maps each to an Expr via `mapper`, combines with `combiner` operator Expr.
- **`__yo_type_join_variants(T, mapper, combiner)`** — same for enum variants.
- **`quote(&&)`** — captures the `&&` operator as an Expr value (Lisp-style symbol quoting).

Property access with dynamic field names: `self.(unquote(field.name.to_expr()))` inside `quote(...)` — the `unquote` splices an identifier Expr into property access position, producing `self.x`, `self.y`, etc.

#### `__yo_type_join_fields(T, mapper, combiner)` — Expr-based

Maps each struct field through a comptime function, then combines with a binary operator:

```rust
__yo_type_join_fields(
  T,                                                    // Type
  (fn(comptime(field) : FieldInfo) -> comptime(Expr))(  // mapper: FieldInfo → Expr
    quote(self.(unquote(field.name.to_expr())).eq(other.(unquote(field.name.to_expr()))))
  ),
  quote(&&)                                             // combiner: binary operator Expr
)
```

- **Mapper** receives `FieldInfo` (comptime struct with `.name : comptime_string`, `.type : Type`, `.index : i32`)
- **Combiner** is an operator Expr (e.g., `quote(&&)`, `quote(||)`, `quote(+)`)
- **0 fields** → undefined behavior (caller should check `__yo_type_field_count(T)` first)
- **1 field** → returns mapper result directly (no combiner applied)
- **n fields** → returns `((f1 op f2) op f3)` (left-associative fold)

Signature: `fn(comptime(T) : Type, comptime(mapper) : (fn(comptime(FieldInfo)) -> comptime(Expr)), comptime(combiner) : Expr) -> comptime(Expr)`

#### `__yo_type_join_variants(T, mapper, combiner)` — Expr-based

Same pattern for enum variants:

```rust
__yo_type_join_variants(
  T,
  (fn(comptime(variant) : VariantInfo) -> comptime(Expr))(
    // variant.name : comptime_string, variant.field_count : i32, etc.
    quote(.unquote(variant.name.to_expr()) => ...)
  ),
  quote(,)   // or whatever combiner makes sense for match arms
)
```

**Note:** enum derive is more complex due to variant matching patterns. The exact API for enum variants will be refined during implementation.

#### `FieldInfo` and `VariantInfo` — Comptime structs

These are comptime-only struct types defined in prelude or as builtins:

```rust
// FieldInfo — passed to __yo_type_join_fields mapper
FieldInfo :: struct(
  name : comptime_string,
  type : Type,
  index : i32
);

// VariantInfo — passed to __yo_type_join_variants mapper
VariantInfo :: struct(
  name : comptime_string,
  field_count : i32,
  index : i32
);
```

These are constructed internally by the builtins and passed to the mapper function. They may be actual Yo structs (defined in prelude) or synthetic values created by the evaluator.

#### `DeriveContext.make_impl` — Helper for constructing impl Exprs

A method on `DeriveContext` that constructs the full `impl(...)` Expr with optional forall/where:

```rust
impl(DeriveContext,
  make_impl : (fn(comptime(self) : Self, comptime(trait_body) : Expr) -> comptime(Expr))(
    cond(
      (self.forall_params.is_some() && self.where_clause.is_some()) =>
        quote(impl(
          unquote(self.forall_params.comptime_unwrap()),
          unquote(self.target),
          unquote(self.where_clause.comptime_unwrap()),
          unquote(trait_body)
        )),
      self.forall_params.is_some() =>
        quote(impl(
          unquote(self.forall_params.comptime_unwrap()),
          unquote(self.target),
          unquote(trait_body)
        )),
      true =>
        quote(impl(
          unquote(self.target),
          unquote(trait_body)
        ))
    )
  )
);
```

Usage in derive rules:

```rust
// Instead of manually constructing impl with forall/where:
ctx.make_impl(quote(
  MyEq(...#(trait_params))(
    eq : ((self, other) -> unquote(eq_body))
  )
))
// → impl(forall(T:Type), GenericPoint(T), where(T<:MyEq(T)), MyEq(GenericPoint(T))(eq:...))
// → impl(Point, MyEq(Point)(eq:...))  // when no forall/where
```

#### Type methods via `impl(Type, ...)` in prelude

All type reflection builtins are exposed as methods on `Type` for readability:

```rust
impl(Type,
  field_count : (fn(comptime(self) : Type) -> comptime(i32))(
    __yo_type_field_count(self)
  ),
  is_struct : (fn(comptime(self) : Type) -> comptime(bool))(
    __yo_type_is_struct(self)
  ),
  is_enum : (fn(comptime(self) : Type) -> comptime(bool))(
    __yo_type_is_enum(self)
  ),
  get_name : (fn(comptime(self) : Type) -> comptime(comptime_string))(
    __yo_type_get_name(self)
  ),
  join_fields : (fn(comptime(self) : Type, comptime(mapper) : ..., comptime(combiner) : Expr) -> comptime(Expr))(
    __yo_type_join_fields(self, mapper, combiner)
  ),
  map_variants : (fn(comptime(self) : Type, comptime(mapper) : ...) -> comptime(ComptimeList(Expr)))(
    __yo_type_map_variants(self, mapper)
  )
  // ... etc.
);
```

Usage becomes cleaner:

```rust
n :: T.field_count();          // instead of __yo_type_field_count(T)
name :: T.get_name();          // instead of __yo_type_get_name(T)
eq_body :: T.join_fields(mapper, quote(&&));  // instead of __yo_type_join_fields(T, mapper, quote(&&))
```

#### `__yo_comptime_string_to_expr(code)` — Dynamic quote

Converts a `comptime_string` to an `Expr` value. Semantically equivalent to a dynamic `quote`:

```rust
"x".to_expr()          // same as quote(x)
"(a + b)".to_expr()    // same as quote((a + b))
```

Primary use: bridging `field.name` (comptime_string from type reflection) into Expr for use with `unquote` inside `quote(...)`.

Builtin signature: `fn(comptime(code) : comptime_string) -> comptime(Expr)`

User-facing API via `impl` in prelude:

```rust
impl(comptime_string,
  to_expr : (fn(comptime(self) : comptime_string) -> comptime(Expr))(
    __yo_comptime_string_to_expr(self)
  )
);
```

#### `quote(operator)` — Operator quoting

`quote` is extended to handle standalone operators as expressions:

```rust
quote(&&)   // Expr representing the && operator
quote(||)   // Expr representing the || operator
quote(+)    // Expr representing the + operator
quote(==)   // Expr representing the == operator
```

The parser recognizes operator tokens inside `quote(...)` and creates Expr nodes for them. These Exprs are used as combiner arguments in `__yo_type_join_fields`.

#### Storage: Derive rules live on the value

The derive rule is stored directly on the trait value:

- **Parameterized traits** (e.g., `MyEq :: (fn(...) -> Trait)`): stored on the `FunctionValue` as `deriveRule?: FunctionValue`
- **Parameterless traits** (e.g., `Hash :: trait(...)`): stored on the `TraitType` as `deriveRule?: FunctionValue`

This means **derive rules travel with imports**. When a module exports `MyEq`, any derive_rule registered on it comes along — no global registry needed.

```rust
// In my_eq.yo:
MyEq :: (fn(comptime(Rhs) : Type) -> comptime(Trait))(
  trait(eq : (fn(self : Self, other : Rhs) -> bool))
);
derive_rule(MyEq, ...);
export MyEq;

// In main.yo:
{ MyEq } :: import "./my_eq.yo";
Point :: struct(x : i32, y : i32);
derive(Point, MyEq(Point));  // derive rule comes with the import
```

#### Lookup order in `derive`

When `derive(Point, SomeTrait(args...))` processes a trait argument:

1. **Registered derive rule** — Check if the trait's `FunctionValue` or `TraitType` has a `deriveRule`. If yes, call it as a comptime function: pass `T` as comptime Type, `ctx` as DeriveContext, and `args` as `ComptimeList(Expr)`. Evaluate the returned Expr.
2. **Built-in derive** — Fall back to the hardcoded 5 (Eq, Hash, Clone, Ord, ToString).
3. **Comptime function** — If the argument is a bare comptime function (not a trait), call it as a user-defined derive (existing behavior).
4. **Error** — "Trait 'X' does not have a derive rule."

Registered rules take priority over built-ins, allowing users to override default derive behavior if desired.

### Examples

#### Example 1: Custom Eq-like trait (struct, Expr-based)

```rust
MyEq :: (fn(comptime(Rhs) : Type) -> comptime(Trait))(
  trait(eq : (fn(self : Self, other : Rhs) -> bool))
);

derive_rule(MyEq, (fn(comptime(T) : Type, comptime(ctx) : DeriveContext, comptime(trait_params) : ComptimeList(Expr)) -> comptime(Expr)) {
  n :: T.field_count();
  eq_body :: cond(
    (n == 0) => quote(true),
    true => T.join_fields(
      (fn(comptime(field) : FieldInfo) -> comptime(Expr))(
        quote(self.(unquote(field.name.to_expr())).eq(other.(unquote(field.name.to_expr()))))
      ),
      quote(&&)
    )
  );

  ctx.make_impl(quote(
    MyEq(...#(trait_params))(
      eq : ((self, other) -> unquote(eq_body))
    )
  ))
});

Point :: struct(x : i32, y : i32);
impl(i32, MyEq(i32)(eq : ((self, other) -> (self == other))));
derive(Point, MyEq(Point));
```

#### Example 2: Custom Describe trait (parameterless)

```rust
Describe :: trait(
  describe : (fn(self : Self) -> String)
);

derive_rule(Describe, (fn(comptime(T) : Type, comptime(ctx) : DeriveContext, comptime(trait_params) : ComptimeList(Expr)) -> comptime(Expr)) {
  name :: T.get_name();
  body :: (("`" + name) + "`").to_expr();

  ctx.make_impl(quote(
    Describe(
      describe : (fn(self : Self) -> String)(unquote(body))
    )
  ))
});

Point :: struct(x : i32, y : i32);
derive(Point, Describe);
// Point(1, 2).describe() → "Point"
```

#### Example 3: Simpler approach using only comptime_eval (no derive_rule)

For users who prefer the existing comptime function approach without `derive_rule`:

```rust
derive_describe :: (fn(comptime(T) : Type) -> comptime(unit)) {
  name :: T.get_name();
  code :: (("impl(T, Describe(describe : (fn(self : Self) -> String)(  `" + name) + "`)))");
  comptime_eval(code);
};

derive(Point, derive_describe);  // pass as comptime fn, not via derive_rule
```

#### Example 4: Overriding a built-in derive

```rust
derive_rule(Eq, (fn(comptime(T) : Type, comptime(ctx) : DeriveContext, comptime(trait_params) : ComptimeList(Expr)) -> comptime(Expr)) {
  n :: T.field_count();
  eq_body :: cond(
    (n == 0) => quote(false),  // custom: empty structs not equal
    true => T.join_fields(
      (fn(comptime(field) : FieldInfo) -> comptime(Expr))(
        quote((self.(unquote(field.name.to_expr())) == other.(unquote(field.name.to_expr()))))
      ),
      quote(&&)
    )
  );

  ctx.make_impl(quote(
    Eq(...#(trait_params))(
      (==) : ((lhs, rhs) -> unquote(eq_body)),
      (!=) : ((lhs, rhs) -> !(unquote(eq_body)))
    )
  ))
});
```

#### Example 5: Generic type with forall/where

```rust
Pair :: (fn(comptime(T) : Type) -> comptime(Type))(struct(first : T, second : T));

// The derive rule receives forall/where in DeriveContext.
// ctx.make_impl automatically wraps with forall/where:
derive(forall(A : Type, B : Type), Pair(A, B),
  where(A <: MyEq(A), B <: MyEq(B)),
  MyEq(Pair(A, B)));

// ctx.make_impl generates:
// impl(forall(A : Type, B : Type), Pair(A, B), where(A <: MyEq(A), B <: MyEq(B)),
//   MyEq(Pair(A, B))(eq : ...))
//
// The derive rule just calls ctx.make_impl(trait_body) — no manual forall/where handling needed.
```

### Implementation Steps

#### Step 1: Add `deriveRule` field to `FunctionValue` and `TraitType`

```typescript
// In src/function-value.ts — add to FunctionValue type:
deriveRule?: FunctionValue;

// In src/types/definitions.ts — add to TraitType interface:
deriveRule?: FunctionValue;
```

#### Step 1b: Define `DeriveContext` in prelude

```rust
// In std/prelude.yo:
DeriveContext :: struct(
  target : Expr,
  forall_params : Option(Expr),
  where_clause : Option(Expr)
);

impl(DeriveContext,
  make_impl : (fn(comptime(self) : Self, comptime(trait_body) : Expr) -> comptime(Expr))(
    cond(
      (self.forall_params.is_some() && self.where_clause.is_some()) =>
        quote(impl(
          unquote(self.forall_params.comptime_unwrap()),
          unquote(self.target),
          unquote(self.where_clause.comptime_unwrap()),
          unquote(trait_body)
        )),
      self.forall_params.is_some() =>
        quote(impl(
          unquote(self.forall_params.comptime_unwrap()),
          unquote(self.target),
          unquote(trait_body)
        )),
      true =>
        quote(impl(
          unquote(self.target),
          unquote(trait_body)
        ))
    )
  )
);
```

#### Step 2: Implement `__yo_comptime_string_to_expr` builtin + `to_expr()` method

Add `__yo_comptime_string_to_expr` to `BuiltinFunctions` in `expr.ts` and implement in `type-fns.ts`:

```typescript
// __yo_comptime_string_to_expr(code : comptime_string) -> comptime(Expr)
// Uses generateExprFromCode to parse the string into an Expr
// Returns ExprValue
// "x".to_expr() ≡ quote(x) — dynamic quoting
```

Add `impl(comptime_string, to_expr : ...)` in prelude.yo that calls the builtin.

#### Step 3: Extend `quote` to support operator quoting

Parser change: inside `quote(...)`, recognize standalone operator tokens (`&&`, `||`, `+`, `==`, etc.) and create Expr nodes for them.

#### Step 4: Implement `.(unquote(...))` in quote context

Parser change: inside `quote(...)`, after `.`, allow `(unquote(...))` or `#(...)` to splice an identifier Expr into property access position.

#### Step 5: Implement `__yo_type_join_fields` and `__yo_type_map_variants` builtins

Expr-based API:

```typescript
// __yo_type_join_fields(T, mapperFn, combinerExpr) -> Expr
// - Iterates struct fields (or variant fields via VariantInfo.join_fields)
// - Calls mapperFn(FieldInfo) for each field → gets Expr
// - Combines with combinerExpr as binary operator (left-associative)
// Handle SomeType: return UnknownValue(Expr)

// __yo_type_map_variants(T, mapperFn) -> ComptimeList(Expr)
// - Iterates enum variants
// - Calls mapperFn(VariantInfo) for each variant → gets Expr
// - Returns ComptimeList(Expr) for use with unquote_splicing
```

#### Step 5b: Add `impl(Type, ...)` in prelude

Expose type reflection builtins as methods on `Type`:

```rust
impl(Type,
  field_count : ...,   // wraps __yo_type_field_count
  is_struct : ...,     // wraps __yo_type_is_struct
  is_enum : ...,       // wraps __yo_type_is_enum
  get_name : ...,      // wraps __yo_type_get_name
  join_fields : ...,   // wraps __yo_type_join_fields
  map_variants : ...,  // wraps __yo_type_map_variants
);
```

#### Step 6: Implement `derive_rule` builtin

```typescript
function evaluateDeriveRule({ expr, env, context }) {
  // 1. Evaluate first arg — must be FunctionValue (trait constructor) or TraitType
  // 2. Evaluate second arg — must be FunctionValue (the derive fn)
  //    Validate signature: (comptime(T) : Type, comptime(ctx) : DeriveContext, comptime(trait_params) : ComptimeList(Expr)) -> comptime(Expr)
  // 3. Store: firstArg.deriveRule = secondArg
  // 4. Return unit
}
```

#### Step 7: Modify `processTraitArg` in `derive.ts`

```typescript
// Check registered derive rule first
const deriveRule = getDeriveRule(traitType);
if (deriveRule) {
  return callRegisteredDeriveRule({
    deriveRule, targetType, targetExpr,
    forallExpr, whereExpr,   // from derive call parsing
    traitArgs,               // the args passed to the trait constructor
    env, context, ...
  });
}
// Fall back to built-in derives
```

`callRegisteredDeriveRule`:

1. Construct `DeriveContext` struct value with target Expr, optional forall/where Exprs
2. Collect trait constructor args as ExprValues into a `ComptimeList(Expr)`
3. Call the derive rule comptime function with `(T, ctx, traitParamsList)`
4. Get back a comptime(Expr) value
5. Evaluate the returned Expr in the current env

#### Step 8: Tests

- Test `"x".to_expr()` / `__yo_comptime_string_to_expr` builtin
- Test `quote(&&)` operator quoting
- Test `self.(unquote(...))` property access splicing
- Test `__yo_type_join_fields` with mapper function
- Test `derive_rule` with parameterized trait (MyEq) — struct
- Test `derive_rule` with parameterized trait (MyEq) — enum
- Test `derive_rule` with parameterless trait (Describe)
- Test `derive_rule` override of built-in trait
- Test `derive_rule` with forall/where generic types — DeriveContext.forall_params and where_clause
- Test `derive_rule` imported from another module
- Test trait params via `ComptimeList(Expr)` with `...#(trait_params)`
- Test error cases
- Update fixme.yo

#### Step 9: Documentation

Update `docs/en-US/DERIVE_TRAITS.md` and `docs/zh-CN/DERIVE_TRAITS.md`.

### Future Work

- **`__yo_type_join_variant_fields(T, variant_idx, template, sep)`** — join fields within a specific enum variant
- **Auto-inferred `forall`/`where`** — `derive(Pair, MyEq)` could automatically detect type parameters and generate constraints
- **Migrate built-in derives to Yo** — Rewrite the 5 hardcoded derives as `derive_rule` registrations in the prelude, dogfooding the feature
- **`derive_rule` with trait type parameter** — Pass the fully applied TraitType to the derive function for traits where Rhs ≠ T

## Syntax

```rust
// Basic derive — traits passed explicitly as trait values:
Point :: struct(x : i32, y : i32);
derive(Point, Eq(Point), Ord(Point), Hash, Clone, ToString);

// Eq and Ord take a type parameter (the Rhs type):
derive(Point, Eq(Point));   // Eq(Point) returns TraitType

// Hash, Clone, ToString are already traits (no params):
derive(Point, Hash);         // Hash is TraitType directly

// Generic type with forall/where (same positions as impl):
Pair :: (fn(comptime(T) : Type) -> comptime(Type))(struct(first: T, second: T));
derive(forall(T), Pair(T), where(T <: Eq(T)), Eq(Pair(T)));

// User-defined derive function:
derive_Default :: (fn(comptime(T) : Type) -> comptime(unit))({
  // Use type reflection + comptime_eval to generate impl
});
derive(Point, Eq(Point), derive_Default);  // Mix built-in and user-defined
```

## Design Decisions

### 1. Explicit trait arguments (not by name)

In Yo, `Eq` is a function `fn(comptime(Rhs) : Type) -> comptime(Trait)`, NOT a trait value. Only `Eq(Point)` produces the actual TraitType. This is fundamentally different from Rust where `Eq` is a trait directly.

Therefore, derive arguments must be **evaluated trait values**, not bare names:

```rust
// CORRECT — each argument evaluates to a TraitType or a derive function:
derive(Point, Eq(Point), Hash, Clone);

// WRONG — Eq is a function, not a trait:
derive(Point, Eq);
```

This is consistent with how `impl` works: `impl(Point, Eq(Point)(...))`.

**Dispatch for built-in derives**: After evaluating the argument to a TraitType, the derive builtin checks `traitType.typeName` to find the matching built-in strategy:

- `"Eq"` → `generateStructEq` / `generateEnumEq`
- `"Ord"` → `generateStructOrd` / `generateEnumOrd`
- `"Hash"`, `"Clone"`, `"ToString"` → corresponding generators

For traits without a built-in derive AND that are not comptime functions, derive reports an error: `"Trait 'X' does not have a built-in derive. Provide a derive function instead."`

### 2. `derive` returns `unit`

`derive` returns `unit`, consistent with how `impl` works (which returns the trait value, not the receiver type). Derive is a statement-like expression:

```rust
Point :: struct(x : i32, y : i32);
derive(Point, Eq(Point), Hash, Clone);  // returns unit, ignored
```

### 3. `forall`/`where` supported (like `impl`)

`derive` supports the same `forall`/`where` structure as `impl`, because derive is conceptually "`impl` but auto-generates the method bodies":

```rust
// Concrete type (no forall/where needed):
derive(Point, Eq(Point), Hash, Clone);

// Generic type (same syntax as impl):
derive(forall(T), Pair(T), Eq(Pair(T)), Hash, Clone, where(T <: Eq(T), T <: Hash, T <: Clone));
```

**Argument order** matches `impl`:

1. `forall(...)` (optional, must be first)
2. `where(...)` (optional, before OR after target type — same flexibility as `impl`)
3. Target type
4. One or more traits

Two valid positions for `where`:

```rust
// where before target type:
derive(forall(T), where(T <: Eq(T)), Pair(T), Eq(Pair(T)), Hash, Clone);

// where after target type:
derive(forall(T), Pair(T), where(T <: Eq(T)), Eq(Pair(T)), Hash, Clone);
```

**Validation with forall**: When `forall` is present, field-level trait validation is skipped. The `where` constraints ensure fields implement the required traits. If constraints are insufficient, the generated `impl` will fail at the `impl` evaluation step — which already has proper error handling.

**Generated code**: Each trait gets its own `impl` with the full `forall`/`where` forwarded:

```rust
derive(forall(T), Pair(T), where(T <: Eq(T), T <: Hash), Eq(Pair(T)), Hash)
// generates TWO impls:
// impl(forall(T), Pair(T), where(T <: Eq(T), T <: Hash), Eq(Pair(T))(...))
// impl(forall(T), Pair(T), where(T <: Eq(T), T <: Hash), Hash(...))
```

**Future: auto-inference** — A later enhancement could make `derive(Pair, Eq)` auto-detect type parameters and generate `where` constraints from field types. This would eliminate the need for manual `forall`/`where` in the common case.

### 4. User-defined derive via comptime functions

A derive argument can be:

- **A TraitType value** → dispatch to built-in derive (matched by `traitType.typeName`)
- **A comptime function** of type `fn(comptime(T) : Type) -> comptime(unit)` → called with the target type

Resolution:

1. Evaluate the argument
2. If it's a TraitType: look up built-in derive by name. If none, error.
3. If it's a FunctionValue (comptime): call it with the target type
4. Otherwise: error

User-defined derive functions use:

- **Type reflection builtins** (`__yo_type_get_name`, `__yo_type_field_count`, etc.) to inspect the type
- **`comptime_eval(code_string)`** to evaluate generated impl code
- Standard comptime string concatenation to build code

This leverages Yo's Zig-like comptime system — no proc-macro complexity needed.

### 5. Variadic comptime parameters (language feature)

`derive` motivates a general language feature: `...(comptime(name) : ComptimeList(ParamType))` variadic comptime parameters.

The infrastructure already exists — quote-based variadic params (`...(quote(rest))`) collect into `ComptimeList(Expr)`. We extend this to support `...(comptime(name) : ComptimeList(ParamType))` which collects evaluated comptime values.

This is a standalone language feature useful beyond derive.

## Approach: Layered Architecture

```
  derive(Point, Eq(Point), my_derive_fn)
       ↓
  ┌────────────────────────┐
  │   derive builtin       │  ← evaluates each arg
  │   (src/evaluator/      │
  │    builtins/derive.ts)  │
  └─────┬──────────┬───────┘
        │          │
  ┌─────▼─────┐ ┌─▼──────────────────┐
  │ Built-in  │ │ User-defined        │
  │ derives   │ │ comptime fn         │
  │           │ │                     │
  │ Matches   │ │ Uses:               │
  │ traitType │ │ - Type reflection   │
  │ .typeName │ │   builtins          │
  │           │ │ - comptime_eval()   │
  │ TypeScript│ │ - comptime string   │
  │ code gen  │ │   concatenation     │
  └─────┬─────┘ └─────────┬──────────┘
        │                  │
        ▼                  ▼
  ┌──────────────────────────┐
  │  impl evaluation         │
  │  (generateExprFromCode   │
  │   + evaluateExpression)  │
  └──────────────────────────┘
```

## Supported Built-in Traits

### 1. `Eq(T)` (and by extension `!=`)

**Strategy**: Field-wise equality using `==` on each field, combined with `&&`.

```rust
// derive(Point, Eq(Point)) generates equivalent of:
impl(Point, Eq(Point)(
  (==) : (fn(lhs: Self, rhs: Self) -> bool)
    ((lhs.x == rhs.x) && (lhs.y == rhs.y)),
  (!=) : (fn(lhs: Self, rhs: Self) -> bool)
    ((lhs.x != rhs.x) || (lhs.y != rhs.y))
))
```

**Precondition**: All fields must implement `Eq(FieldType)`.

For enums: compare discriminant first, then field-wise for each variant.

### 2. `Hash`

**Strategy**: Hash each field and combine with `hash = ((hash * 31) + field.hash())`.

**Precondition**: All fields must implement `Hash`.

### 3. `Clone`

**Strategy**: Clone each field and construct a new instance.

**Precondition**: All fields must implement `Clone`.

### 4. `Ord(T)`

**Strategy**: Lexicographic ordering — compare fields left to right, return as soon as one differs.

**Precondition**: All fields must implement `Ord(FieldType)` and `Eq(FieldType)`.

### 5. `ToString`

**Strategy**: Format as `TypeName(field1, field2, ...)` using String concatenation.

**Precondition**: All fields must implement `ToString`.

## Implementation Plan

### Phase 0: Variadic Comptime Parameters

**New feature**: Support `...(comptime(name) : ComptimeList(T))` syntax for variadic comptime parameters.

**Syntax**:

```rust
// Function that accepts a Type and variadic Trait arguments:
derive : (fn(comptime(T) : Type, ...(comptime(traits) : ComptimeList(Trait))) -> comptime(unit))

// Call site — trailing args are collected into ComptimeList:
derive(Point, Eq, Hash, Clone);
// Inside body: traits is ComptimeList(Trait) = [Eq, Hash, Clone]
```

**Design**:

- `...(comptime(name) : ComptimeList(ElementType))` — parentheses required around the spread
- Each trailing argument at the call site is evaluated as `comptime` and type-checked against `ElementType`
- The collected values are stored as a `ComptimeList(ElementType)` in the callee environment
- This is compile-time only — no runtime variadic support needed

**Existing infrastructure** (in `src/evaluator/calls/helper.ts:1469–1540`):

- `variadicParameter` field on `FunctionType` already exists
- Quote-based variadic params (`...(quote(rest))`) already collect into `ComptimeList(Expr)`
- Need to extend: when `variadicParameter.isCompileTimeOnly && !variadicParameter.isQuote`, collect evaluated comptime values into `ComptimeList(paramType.elementType)`

**Files to modify**:

- `src/evaluator/types/function.ts` — parse `...(comptime(name) : ComptimeList(T))` syntax
- `src/evaluator/calls/helper.ts` — handle comptime variadic arg collection (extend the existing variadic handling at lines 1469–1540)
- Possibly `src/parser.ts` if the `...(comptime(...))` syntax needs parser changes

### Phase 1: Explicit Trait Arguments + forall/where

Change derive to accept evaluated trait values and support `forall`/`where`.

**Changes in `derive.ts`:**

- Remove `resolveTraitName` (name-based matching)
- Add `forall`/`where` parsing: detect `forall(...)` as first arg, `where(...)` as last arg (reuse same detection pattern as `impl` in `src/evaluator/values/impl.ts:2170-2227`)
- Evaluate each trait arg → if TraitType, dispatch by `traitType.typeName`; if FunctionValue, call as user-defined derive (Phase 3)
- When generating impl code strings, wrap with `forall(...)` prefix and `where(...)` suffix if present
- When `forall` is present, skip field-level trait validation (where constraints handle it)
- For parameterized traits (`Eq(Point)`, `Ord(Point)`): in non-forall mode, validate trait parameter matches target type

**Tests:**

- Update all existing tests from `derive(Point, Eq)` → `derive(Point, Eq(Point))`
- Add test: `derive(forall(T), Pair(T), Eq(Pair(T)), where(T <: Eq(T)))`
- Test multiple traits with forall/where

### Phase 2: Variadic Comptime Parameters

Enable `...(comptime(name))` in function type parsing. General language feature.

**Changes in `src/evaluator/types/function.ts`:**

- Remove the error at lines 2051-2054 (`"...(comptime(param_name)) is not supported yet."`)
- Set `parameterType` to the element type (each variadic arg's type)
- `isCompileTimeOnly = true` already set (line 2035)

**Changes in `src/evaluator/calls/helper.ts`:**

- Extend variadic arg collection (lines 1469-1540)
- When `variadicParameter.isCompileTimeOnly && !variadicParameter.isQuote`:
  - Evaluate each trailing arg as a comptime value
  - Collect into a `ComptimeList` value
  - Bind to the variadic parameter name in the callee env

**Tests:**

- General variadic comptime tests

### Phase 3: User-Defined Derive + comptime_eval

Allow comptime functions as derive arguments.

**Changes in `derive.ts`:**

- After TraitType dispatch, check if arg is a FunctionValue
- Validate: must be comptime fn taking `comptime(T) : Type` and returning `comptime(unit)`
- Call the function with the target type
- Clear errors if signature doesn't match

**New builtin: `comptime_eval`**

- Add `comptime_eval` to `BuiltinFunctions` in `src/expr.ts`
- Create handler in `src/evaluator/builtins/comptime-eval.ts`
- Takes a `comptime_string`, parses via `generateExprFromCode`, evaluates in the caller's env
- Returns `unit` (side-effect: registers impls, defines variables, etc.)
- Primary code generation tool for user-defined derives

**Example:**

```rust
Default :: trait(default : (fn() -> Self));

derive_Default :: (fn(comptime(T) : Type) -> comptime(unit))({
  name :: __yo_type_get_name(T);
  count :: __yo_type_field_count(T);
  comptime_assert((count == 0), "derive_Default only works on empty structs");
  comptime_eval("impl(" + name + ", Default(default : (() -> " + name + "())))");
});

Empty :: struct();
derive(Empty, derive_Default);
e :: Empty.default();
```

### Phase 4: Type Reflection — TypeTag Enum ✅

Implement user-facing `TypeTag` enum for compile-time type identification, plus `__yo_type_*` builtins for type inspection.

**Implementation files**: `src/evaluator/builtins/type-fns.ts`, `std/prelude.yo`

#### TypeTag enum in prelude.yo

The `TypeTag` enum mirrors the compiler's internal `TypeTag` 1:1 (40+ variants), giving users precise type identification:

```rust
TypeTag :: enum(
  Unit, Bool, Usize, Isize,
  U8, I8, U16, I16, U32, I32, U64, I64, F32, F64,
  ComptimeInt, ComptimeFloat, ComptimeString,
  Char, Short, UShort, Int, UInt,
  Long, ULong, LongLong, ULongLong, LongDouble,
  Void, Type,
  Array, Tuple, Struct, Enum, Union, Function,
  SomeType, Slice, Module, Trait,
  Ptr, Iso, Arc, Dyn,
  Expr, ComptimeList, EffectsRow, TypeApplication
);
```

Guard methods are implemented via `impl(TypeTag, ...)`:

- **Structural**: `is_struct()`, `is_enum()`, `is_union()`, `is_tuple()`, `is_array()`, `is_slice()`, `is_function()`, `is_pointer()`, `is_trait()`, `is_module()`, `is_void()`
- **Numeric**: `is_primitive()` (all numeric + bool + C types), `is_integer()`, `is_float()`, `is_numeric()`, `is_comptime()`

`Type.get_tag(T)` static method:

```rust
impl(Type,
  get_tag : (fn(comptime(self) : Type) -> comptime(TypeTag))({
    return __yo_type_get_tag(self);
  })
);
```

#### Usage in derive_rule

```rust
derive_rule(MyTrait, (fn(comptime(T) : Type, quote(target) : Expr) -> unquote(Expr)) {
  tag :: Type.get_tag(T);
  cond(
    tag.is_struct() => { /* struct derive logic */ },
    tag.is_enum() => { /* enum derive logic */ },
    true => comptime_assert(false, "MyTrait can only be derived for struct or enum types")
  );
});

// Exact tag matching:
match(Type.get_tag(T),
  .I32 => "32-bit signed integer",
  .Struct => "struct type",
  _ => "other"
);
```

#### FieldInfo struct for field reflection

```rust
// Compile-time struct describing a single struct/enum field
FieldInfo :: struct(
  name : comptime_string,
  field_type : Type,
  has_default : bool
);
```

#### VariantInfo struct for enum reflection

```rust
// Compile-time struct describing an enum variant
VariantInfo :: struct(
  name : comptime_string,
  fields : ComptimeList(FieldInfo),
  field_count : comptime_int,
  has_discriminant : bool
);
```

#### Builtin declarations

```rust
extern "Yo",
  // === Type kind queries ===
  __yo_type_get_tag : (fn(comptime(T) : Type) -> comptime(TypeTag)),
  __yo_type_is_struct : (fn(comptime(T) : Type) -> comptime(bool)),
  __yo_type_is_enum : (fn(comptime(T) : Type) -> comptime(bool)),
  __yo_type_is_union : (fn(comptime(T) : Type) -> comptime(bool)),
  __yo_type_is_tuple : (fn(comptime(T) : Type) -> comptime(bool)),
  __yo_type_is_function : (fn(comptime(T) : Type) -> comptime(bool)),
  __yo_type_is_ptr : (fn(comptime(T) : Type) -> comptime(bool)),
  __yo_type_is_slice : (fn(comptime(T) : Type) -> comptime(bool)),
  __yo_type_is_array : (fn(comptime(T) : Type) -> comptime(bool)),
  __yo_type_is_module : (fn(comptime(T) : Type) -> comptime(bool)),
  __yo_type_is_trait : (fn(comptime(T) : Type) -> comptime(bool)),
  __yo_type_is_primitive : (fn(comptime(T) : Type) -> comptime(bool)),

  // === Type metadata ===
  __yo_type_get_name : (fn(comptime(T) : Type) -> comptime(comptime_string)),

  // === Struct reflection ===
  __yo_type_get_fields : (fn(comptime(T) : Type) -> comptime(ComptimeList(FieldInfo))),
  __yo_type_field_count : (fn(comptime(T) : Type) -> comptime(comptime_int)),
  __yo_type_get_field_name : (fn(comptime(T) : Type, comptime(index) : comptime_int) -> comptime(comptime_string)),
  __yo_type_get_field_type : (fn(comptime(T) : Type, comptime(index) : comptime_int) -> comptime(Type)),

  // === Enum reflection ===
  __yo_type_get_variants : (fn(comptime(T) : Type) -> comptime(ComptimeList(VariantInfo))),
  __yo_type_variant_count : (fn(comptime(T) : Type) -> comptime(comptime_int)),
  __yo_type_get_variant_name : (fn(comptime(T) : Type, comptime(index) : comptime_int) -> comptime(comptime_string)),
  __yo_type_get_variant_fields : (fn(comptime(T) : Type, comptime(index) : comptime_int) -> comptime(ComptimeList(FieldInfo))),

  // === Trait queries (already exists: __yo_type_impls) ===
  // __yo_type_impls : (fn(comptime(T) : Type, comptime(Tr) : Trait) -> comptime(bool))

  // === Code evaluation ===
  comptime_eval : (fn(comptime(code) : comptime_string) -> comptime(unit))
;
```

#### Mapping to TypeScript internals

| Yo Builtin                           | TypeScript Implementation                                                  |
| ------------------------------------ | -------------------------------------------------------------------------- |
| `__yo_type_get_tag(T)`               | Maps `type.tag` to `TypeTag` enum variant via `typeTagToVariantName` (1:1) |
| `__yo_type_is_struct(T)`             | `isStructType(type)` from `src/types/guards.ts`                            |
| `__yo_type_is_enum(T)`               | `isEnumType(type)`                                                         |
| `__yo_type_get_name(T)`              | `type.typeName` or `typeToString(type)`                                    |
| `__yo_type_get_fields(T)`            | `structType.fields.map(f => FieldInfo(f.label, f.type, !!f.defaultValue))` |
| `__yo_type_field_count(T)`           | `structType.fields.length`                                                 |
| `__yo_type_get_field_name(T, i)`     | `structType.fields[i].label`                                               |
| `__yo_type_get_field_type(T, i)`     | `structType.fields[i].type`                                                |
| `__yo_type_get_variants(T)`          | `enumType.variants.map(v => VariantInfo(v.name, v.fields, ...))`           |
| `__yo_type_variant_count(T)`         | `enumType.variants.length`                                                 |
| `__yo_type_get_variant_name(T, i)`   | `enumType.variants[i].name`                                                |
| `__yo_type_get_variant_fields(T, i)` | `enumType.variants[i].fields`                                              |
| `comptime_eval(code)`                | `generateExprFromCode(code)` + `evaluateExpression`                        |

| Builtin                            | Returns             | Purpose                |
| ---------------------------------- | ------------------- | ---------------------- |
| `Type.get_tag(T)`                  | `comptime(TypeTag)` | Type identification    |
| `__yo_type_get_name(T)`            | `comptime_string`   | Type name for code gen |
| `__yo_type_is_struct(T)`           | `comptime(bool)`    | Validation             |
| `__yo_type_is_enum(T)`             | `comptime(bool)`    | Validation             |
| `__yo_type_field_count(T)`         | `comptime_int`      | Iteration bounds       |
| `__yo_type_get_field_name(T, i)`   | `comptime_string`   | Field access in code   |
| `__yo_type_get_field_type(T, i)`   | `comptime(Type)`    | Type checking          |
| `__yo_type_variant_count(T)`       | `comptime_int`      | Enum iteration         |
| `__yo_type_get_variant_name(T, i)` | `comptime_string`   | Variant matching       |

**Prelude additions:**

- `TypeTag` enum (1:1 mirror of compiler's internal `TypeTag`, 40+ variants)
- `FieldInfo` struct, `VariantInfo` struct
- `Type.get_tag(T)` static method
- Guard methods on `TypeTag` (is_struct, is_enum, is_integer, is_float, is_numeric, etc.)
- `extern "Yo"` declarations for all builtins

### Phase 5: Testing

Extend `tests/derive.test.yo`:

- Explicit trait args: `derive(Point, Eq(Point))`
- User-defined derive functions
- Type reflection builtins with `comptime_assert`
- Mixed built-in + user-defined in one call
- Error cases (wrong trait param type, invalid derive fn signature)

### Phase 6: Documentation

- `docs/en-US/DERIVE.md` — full guide with examples
- `docs/zh-CN/DERIVE.md` — Chinese translation

## Future Enhancements

### Auto-Constraint Inference for Generic Types

```rust
// Dream syntax — no forall/where needed:
derive(Pair, Eq);
// Auto-analyzes Pair(T)'s fields, generates:
// impl(forall(T), Pair(T), Eq(Pair(T))(...), where(T <: Eq(T)))
```

### Comptime Iteration

Comptime for/while loops for more powerful user-defined derives.

### Derive for Newtype

Delegates all trait operations to the wrapped inner type.

## Key Files

| File                                        | Role                                        |
| ------------------------------------------- | ------------------------------------------- |
| `src/evaluator/builtins/derive.ts`          | Main derive implementation                  |
| `src/evaluator/builtins/type-reflection.ts` | Type reflection builtins (to create)        |
| `src/evaluator/builtins/comptime-eval.ts`   | `comptime_eval` builtin (to create)         |
| `src/expr.ts`                               | BuiltinFunctions registration               |
| `src/evaluator/exprs/_expr.ts`              | Builtin dispatch                            |
| `src/evaluator/types/function.ts:2048-2054` | Variadic comptime params (to enable)        |
| `src/evaluator/calls/helper.ts:1469-1540`   | Variadic arg collection                     |
| `std/prelude.yo`                            | TypeTag, FieldInfo, VariantInfo definitions |
| `tests/derive.test.yo`                      | Integration tests                           |

## References

- `src/evaluator/types/utils.ts:149` — `parseAndEvaluateExprCode` pattern
- `src/evaluator/values/impl.ts:2170-2227` — impl forall/where detection
- `std/prelude.yo:588-698` — Eq, Ord, Hash, Clone trait definitions
- `std/fmt/to_string.yo:14-16` — ToString trait definition
