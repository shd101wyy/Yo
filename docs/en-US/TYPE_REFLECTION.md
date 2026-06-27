# Type Reflection

Yo provides compile-time type reflection through the `TypeInfo` enum and `Type.get_info()`. Unlike simple type tag systems, `TypeInfo` carries rich structural metadata — struct fields, enum variants, function parameters, and more — enabling powerful metaprogramming at compile time.

## Basic Usage

```rust
info :: Type.get_info(i32);
comptime_assert(info.is_primitive(), "i32 is primitive");
comptime_assert(info.is_integer(), "i32 is an integer");

Point :: struct(x : i32, y : i32);
info2 :: Type.get_info(Point);
comptime_assert(info2.is_struct(), "Point is a struct");
```

`Type.get_info(T)` returns a `comptime(TypeInfo)` value. All operations are compile-time only — there is no runtime cost.

## TypeInfo Enum

`TypeInfo` is a compile-time enum with both fieldless and compound variants:

```rust
TypeInfo :: enum(
  // === Primitives (fieldless) ===
  Unit, Bool,
  Usize, Isize,
  U8, I8, U16, I16, U32, I32, U64, I64,
  F32, F64,

  // === C-compatible primitives (fieldless) ===
  Char, Short, UShort, Int, UInt,
  Long, ULong, LongLong, ULongLong, LongDouble,
  Void,
  Str,

  // === Compound types (with metadata) ===
  Array(element : Type, length : comptime_int),
  Tuple(fields : ComptimeList(TypeFieldInfo)),
  Struct(fields : ComptimeList(TypeFieldInfo), kind : StructKind),
  Enum(variants : ComptimeList(VariantInfo)),
  Union(fields : ComptimeList(TypeFieldInfo)),
  Function(info : FunctionInfo),
  Ptr(pointee : Type),
  Iso(child : Type),
  Dyn(required_traits : ComptimeList(TraitInfo), negative_traits : ComptimeList(TraitInfo)),

  // === Meta types ===
  Trait(fields : ComptimeList(TraitFieldInfo), kind : TraitKind),
  Type(level : comptime_int),
  Some(name : comptime_str, required_traits : ComptimeList(TraitInfo),
       negative_traits : ComptimeList(TraitInfo), resolved_type : Type),

  // === Comptime only ===
  ComptimeInt, ComptimeFloat, ComptimeStr,
  ComptimeList(element : Type),

  // === Metaprogramming (fieldless) ===
  Expr, EffectsRow, TypeApplication
);
```

## Guard Methods

`TypeInfo` provides guard methods for type classification:

```rust
info :: Type.get_info(i32);

// Structural guards
info.is_struct()     // matches .Struct(_, _)
info.is_enum()       // matches .Enum(_)
info.is_union()      // matches .Union(_)
info.is_tuple()      // matches .Tuple(_)
info.is_array()      // matches .Array(_, _)
info.is_str()        // matches .Str
info.is_function()   // matches .Function(_)
info.is_pointer()    // matches .Ptr(_)
info.is_trait()      // matches .Trait(_, _)
info.is_void()       // matches .Void

// Numeric guards
info.is_primitive()  // all primitive variants (Bool, integers, floats, C types, Str)
info.is_integer()    // Usize, Isize, U8..I64, Char, Short..ULongLong
info.is_float()      // F32, F64, LongDouble
info.is_numeric()    // is_integer() || is_float()
info.is_comptime()   // ComptimeInt, ComptimeFloat, ComptimeStr, ComptimeList, Expr
```

## Extracting Compound Data

Use `match` to extract metadata from compound variants:

### Array

```rust
Arr3 :: [i32; 3];
info :: Type.get_info(Arr3);

elem :: match(info, .Array(e, _) => e, _ => unit);
comptime_assert(__yo_are_types_compatible(elem, i32), "element is i32");

len :: match(info, .Array(_, l) => l, _ => 0);
comptime_assert((len == 3), "length is 3");
```

### Struct

```rust
Point :: struct(x : i32, y : i32);
info :: Type.get_info(Point);

field_count :: match(info, .Struct(f, _) => f.len(), _ => usize(0));
comptime_assert((field_count == usize(2)), "Point has 2 fields");

is_struct_kind :: match(info,
  .Struct(_, k) => match(k, .Struct => true, _ => false),
  _ => false
);
comptime_assert(is_struct_kind, "Point is a regular struct");
```

### Enum

```rust
Color :: enum(Red, Green, Blue);
info :: Type.get_info(Color);

variant_count :: match(info, .Enum(v) => v.len(), _ => usize(0));
comptime_assert((variant_count == usize(3)), "Color has 3 variants");
```

### Function

```rust
FnType :: (fn(x : i32, y : i32) -> bool);
info :: Type.get_info(FnType);

param_count :: match(info, .Function(fi) => fi.params.len(), _ => usize(0));
comptime_assert((param_count == usize(2)), "2 parameters");

ret_is_bool :: match(info,
  .Function(fi) => __yo_are_types_compatible(fi.return_type, bool),
  _ => false
);
comptime_assert(ret_is_bool, "returns bool");
```

### Pointer

```rust
PtrI32 :: *(i32);
info :: Type.get_info(PtrI32);

pointee :: match(info, .Ptr(p) => p, _ => unit);
comptime_assert(__yo_are_types_compatible(pointee, i32), "pointee is i32");
```

## Metadata Structs

### TypeFieldInfo

Represents a field in a struct, union, tuple, or module:

```rust
TypeFieldInfo :: struct(
  name : comptime_str,
  field_type : Type
);
```

### VariantInfo

Represents an enum variant:

```rust
VariantInfo :: struct(
  name : comptime_str,
  fields : ComptimeList(TypeFieldInfo),
  _enum_type : Type,        // internal: parent enum type
  _variant_index : usize  // internal: variant index
);
```

The `fields` list contains `TypeFieldInfo` entries for each variant field. Use `v.fields.len()` to get the field count.

### StructKind

Discriminates struct flavors:

```rust
StructKind :: enum(Struct, Object, AtomicObject, NewType);
```

- `Struct` — regular value-type struct
- `Object` — reference-counted reference-semantics type (`ref(struct(...))`)
- `AtomicObject` — atomic reference-counted reference-semantics type (`atomic(ref(struct(...)))`)
- `NewType` — single-field wrapper type (`newtype(...)`)

### FunctionInfo

Rich function type metadata:

```rust
FunctionInfo :: struct(
  params : ComptimeList(ParamInfo),
  return_type : Type,
  forall_params : ComptimeList(ForallParamInfo),
  implicit_params : ComptimeList(ImplicitParamInfo),
  is_closure : bool
);
```

### ParamInfo

Function parameter metadata:

```rust
ParamInfo :: struct(
  name : comptime_str,
  param_type : Type,
  is_comptime : bool,
  is_quote : bool,
  is_variadic : bool
);
```

### ForallParamInfo

Forall type parameter:

```rust
ForallParamInfo :: struct(
  name : comptime_str,
  param_type : Type
);
```

### ImplicitParamInfo

Using/effect parameter:

```rust
ImplicitParamInfo :: struct(
  name : comptime_str,
  param_type : Type
);
```

### TraitInfo

Lightweight trait reference:

```rust
TraitInfo :: struct(
  trait_type : Type
);
```

### TraitFieldInfo

Trait field metadata:

```rust
TraitFieldInfo :: struct(
  name : comptime_str,
  field_type : Type,
  is_associated_type : bool
);
```

### TraitKind

Discriminates trait flavors:

```rust
TraitKind :: enum(
  Future(child : Type, effects : ComptimeList(TraitInfo)),
  Fn(call : FunctionInfo),
  Normal
);
```

## Match Dispatch

Use `match` on `TypeInfo` for compile-time type dispatch:

```rust
describe :: (fn(comptime(T) : Type) -> comptime(comptime_str))(
  match(Type.get_info(T),
    .I32 => "32-bit signed integer",
    .Struct(_, _) => "struct type",
    .Enum(_) => "enum type",
    .Array(_, _) => "array type",
    .Function(_) => "function type",
    _ => "other type"
  )
);

comptime_assert((describe(i32) == "32-bit signed integer"), "i32 description");
comptime_assert((describe(Point) == "struct type"), "Point description");
```

## Using with derive_rule

`TypeInfo` is designed to work with `derive_rule` for powerful compile-time code generation:

```rust
// Using TypeInfo to check type kind in a derive rule
derive_rule(MyTrait, (fn(comptime(T) : Type, quote(target) : Expr) -> unquote(Expr)) {
  info :: Type.get_info(T);
  comptime_assert(info.is_struct(), "MyTrait can only be derived for structs");
  // ... generate impl using info
});
```

For the full derive system documentation, see [DERIVE_TRAITS.md](./DERIVE_TRAITS.md).

## Type Methods

The `Type` type provides static methods for compile-time type analysis:

| Method                            | Description                                              |
| --------------------------------- | -------------------------------------------------------- |
| `Type.get_info(T)`                | Returns `TypeInfo` enum for type `T`                     |
| `Type.get_struct_fields(T)`       | Returns `ComptimeList(TypeFieldInfo)` for struct `T`     |
| `Type.get_enum_variants(T)`       | Returns `ComptimeList(VariantInfo)` for enum `T`         |
| `Type.to_comptime_string(T)`      | Returns type name as `comptime_str`                   |
| `Type.join_fields(T, mapper, op)` | Map struct fields to `Expr` and combine with binary op   |
| `Type.map_variants(T, mapper)`    | Map enum variants to `ComptimeList(Expr)`                |
| `Type.eq(A, B)`                   | Exact type equality (nominal — same definition required) |
| `Type.neq(A, B)`                  | Type inequality (negation of `Type.eq`)                  |
| `Type.is_compatible_with(A, B)`   | Loose type compatibility (allows coercion)               |
| `Type.impls(T, Marker)`           | Checks if type `T` implements a marker trait             |
| `Type.contains_rc_type(T)`        | Checks if type contains reference-counted fields         |
| `Type.can_form_rc_cycle(T)`       | Checks if type can form reference counting cycles        |

### Type Equality vs Compatibility

```rust
// Type.eq — exact match, nominal typing
comptime_assert(Type.eq(i32, i32), "same type");

A :: struct(x : i32);
B :: struct(x : i32);
comptime_assert(Type.neq(A, B), "different definitions, not equal");

// Type.is_compatible_with — allows coercion
// comptime_int is compatible with i32, but they are not equal
```

`Type.eq` uses exact match with no coercion. `Type.is_compatible_with` allows implicit coercion like `comptime_int` → `i32`.

### Type.join_fields

Map each field of a struct to an `Expr` and combine them with a binary operator:

```rust
// Example: generate equality check for all fields
eq_body :: Type.join_fields(
  Point,
  (fn(comptime(field) : FieldInfo) -> comptime(Expr))(
    quote(self.(#(field.name.to_expr())).eq(other.(#(field.name.to_expr()))))
  ),
  quote(&&)
);
```

### Type.map_variants

Map each variant of an enum to an `Expr`, returning `ComptimeList(Expr)`:

```rust
branches :: Type.map_variants(
  Color,
  (fn(comptime(variant) : VariantInfo) -> comptime(Expr))(
    quote(.(#(variant.name.to_expr())) => true)
  )
);
```

## FieldInfo Methods

| Method                 | Description                                            |
| ---------------------- | ------------------------------------------------------ |
| `field.name`           | Field name as `comptime_str`                        |
| `field.field_type`     | Field type as `Type`                                   |
| `field.name.to_expr()` | Convert field name to `Expr` (via `FieldInfo.to_expr`) |

## Design Document

For the full design including implementation details, see [TYPE_REFLECTION.md](../../plans/TYPE_REFLECTION.md).
