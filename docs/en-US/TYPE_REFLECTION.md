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

  // === Compound types (with metadata) ===
  Array(element : Type, length : comptime_int),
  Slice(element : Type),
  Tuple(fields : ComptimeList(TypeFieldInfo)),
  Struct(fields : ComptimeList(TypeFieldInfo), kind : StructKind),
  Enum(variants : ComptimeList(VariantInfo)),
  Union(fields : ComptimeList(TypeFieldInfo)),
  Function(info : FunctionInfo),
  Ptr(pointee : Type),
  Iso(child : Type),
  Arc(child : Type),
  Dyn(required_traits : ComptimeList(TraitInfo), negative_traits : ComptimeList(TraitInfo)),

  // === Meta types ===
  Module(fields : ComptimeList(TypeFieldInfo)),
  Trait(fields : ComptimeList(TraitFieldInfo), kind : TraitKind),
  Type(level : comptime_int),
  SomeType(name : comptime_string, required_traits : ComptimeList(TraitInfo),
           negative_traits : ComptimeList(TraitInfo), resolved_type : Type),

  // === Comptime only ===
  ComptimeInt, ComptimeFloat, ComptimeString,
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
info.is_slice()      // matches .Slice(_)
info.is_function()   // matches .Function(_)
info.is_pointer()    // matches .Ptr(_)
info.is_trait()      // matches .Trait(_, _)
info.is_module()     // matches .Module(_)
info.is_void()       // matches .Void

// Numeric guards
info.is_primitive()  // all primitive variants (Unit, Bool, integers, floats, C types, Void)
info.is_integer()    // Usize, Isize, U8..I64, Char, Short..ULongLong
info.is_float()      // F32, F64, LongDouble
info.is_numeric()    // is_integer() || is_float()
info.is_comptime()   // ComptimeInt, ComptimeFloat, ComptimeString, ComptimeList, Expr
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
  name : comptime_string,
  field_type : Type
);
```

### VariantInfo

Represents an enum variant:

```rust
VariantInfo :: struct(
  name : comptime_string,
  fields : ComptimeList(TypeFieldInfo),
  field_count : comptime_int,
  has_discriminant : bool
);
```

### StructKind

Discriminates struct flavors:

```rust
StructKind :: enum(Struct, Object, NewType);
```

- `Struct` — regular value-type struct
- `Object` — reference-counted object type (`object(...)`)
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
  name : comptime_string,
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
  name : comptime_string,
  param_type : Type
);
```

### ImplicitParamInfo

Using/effect parameter:

```rust
ImplicitParamInfo :: struct(
  name : comptime_string,
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
  name : comptime_string,
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
describe :: (fn(comptime(T) : Type) -> comptime(comptime_string))(
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

`TypeInfo` is designed to work with `derive_rule` for powerful compile-time code generation. Type reflection builtins like `__yo_type_field_count`, `__yo_type_join_fields`, etc. remain available for backward compatibility, but `TypeInfo` provides a more structured alternative:

```rust
// Using TypeInfo to check type kind in a derive rule
derive_rule(MyTrait, (fn(comptime(T) : Type, quote(target) : Expr) -> unquote(Expr)) {
  info :: Type.get_info(T);
  comptime_assert(info.is_struct(), "MyTrait can only be derived for structs");
  // ... generate impl using info
});
```

For the full derive system documentation, see [DERIVE_TRAITS.md](./DERIVE_TRAITS.md).

## Builtin Functions

| Builtin                                      | Description                                |
| -------------------------------------------- | ------------------------------------------ |
| `__yo_type_get_info(T)`                      | Returns `TypeInfo` for type `T`            |
| `__yo_are_types_compatible(A, B)`            | Checks if types `A` and `B` are compatible |
| `__yo_type_field_count(T)`                   | Number of fields in struct/enum            |
| `__yo_type_get_field_name(T, i)`             | Field name at index `i`                    |
| `__yo_type_get_field_type(T, i)`             | Field type at index `i`                    |
| `__yo_type_variant_count(T)`                 | Number of enum variants                    |
| `__yo_type_join_fields(T, mapper, combiner)` | Map and combine struct fields              |
| `__yo_type_map_variants(T, mapper)`          | Map over enum variants                     |

## Design Document

For the full design including implementation details, see [TYPE_REFLECTION.md](../../plans/TYPE_REFLECTION.md).
