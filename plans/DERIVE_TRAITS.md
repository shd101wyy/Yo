# Derive Traits

## Problem

Yo currently requires users to manually write `impl` blocks for common traits like `Eq`, `Hash`, `Clone`, `Ord`, and `ToString` for every struct and enum type. This is tedious and error-prone, especially for structs with many fields. Rust solves this with `#[derive(Eq, Hash, Clone, ...)]`; Yo needs an equivalent — and unlike Rust, Yo should let users define their own derive rules using comptime functions without a proc-macro system.

## Status — Complete ✅

All phases implemented. 33 tests passing in `tests/derive.test.yo`, 10 in `tests/variadic_comptime.test.yo`.

### What's implemented:

1. **Built-in derives** for 5 traits: Eq, Hash, Clone, Ord, ToString (structs + enums)
2. **Explicit trait args**: `derive(Point, Eq(Point))` and bare `derive(Point, Eq)` both work
3. **Variadic comptime parameters**: `...(comptime(name) : ComptimeList(T))` syntax
4. **Type reflection builtins**: 12 `__yo_type_*` builtins for compile-time type introspection
5. **`comptime_eval`**: Parse and evaluate comptime strings as Yo code
6. **User-defined derives**: Comptime functions with `fn(comptime(T) : Type) -> comptime(unit)` signature
7. **Documentation**: `docs/en-US/DERIVE_TRAITS.md` and `docs/zh-CN/DERIVE_TRAITS.md`

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

### Phase 4: Type Reflection Builtins

Implement `__yo_type_*` builtins for compile-time type inspection.

**Already registered** in `src/expr.ts` `BuiltinFunctions` (12 entries).

**Implementation file**: `src/evaluator/builtins/type-reflection.ts`

#### TypeTag enum in prelude.yo

```rust
// Mirror of src/types/tags.ts
TypeTag :: enum(
  // Primitives
  Unit, Bool,
  Usize, Isize,
  U8, I8, U16, I16, U32, I32, U64, I64,
  F32, F64,

  // Compile-time types
  ComptimeInt, ComptimeFloat, ComptimeString,

  // C compatible types
  Char, Short, UShort, Int, UInt,
  Long, ULong, LongLong, ULongLong, LongDouble,

  // Void
  Void,

  // Type universe
  Type,

  // Compound types
  Array, Tuple, Struct, Enum, Union, Function,

  // SomeType (generic placeholder)
  SomeType,

  // Slice
  Slice,

  // Module & Trait
  Module, Trait,

  // Pointer types
  Ptr, Iso, Arc,

  // Dynamic dispatch
  Dyn,

  // Metaprogramming
  Expr, ComptimeList,

  // Effects
  EffectsRow,

  // HKT
  TypeApplication
);
export TypeTag;
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
| `__yo_type_get_tag(T)`               | Return `TypeTag` enum variant matching `type.tag`                          |
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

| Builtin                            | Returns           | Purpose                |
| ---------------------------------- | ----------------- | ---------------------- |
| `__yo_type_get_name(T)`            | `comptime_string` | Type name for code gen |
| `__yo_type_is_struct(T)`           | `comptime(bool)`  | Validation             |
| `__yo_type_is_enum(T)`             | `comptime(bool)`  | Validation             |
| `__yo_type_field_count(T)`         | `comptime_int`    | Iteration bounds       |
| `__yo_type_get_field_name(T, i)`   | `comptime_string` | Field access in code   |
| `__yo_type_get_field_type(T, i)`   | `comptime(Type)`  | Type checking          |
| `__yo_type_variant_count(T)`       | `comptime_int`    | Enum iteration         |
| `__yo_type_get_variant_name(T, i)` | `comptime_string` | Variant matching       |

**Prelude additions:**

- `TypeTag` enum (mirror of `src/types/tags.ts`)
- `FieldInfo` struct, `VariantInfo` struct
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
