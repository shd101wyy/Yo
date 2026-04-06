# 类型反射（Type Reflection）

Yo 通过 `TypeInfo` 枚举和 `Type.get_info()` 提供编译时类型反射。与简单的类型标签系统不同，`TypeInfo` 携带丰富的结构元数据——结构体字段、枚举变体、函数参数等——在编译时实现强大的元编程。

## 基本用法

```rust
info :: Type.get_info(i32);
comptime_assert(info.is_primitive(), "i32 is primitive");
comptime_assert(info.is_integer(), "i32 is an integer");

Point :: struct(x : i32, y : i32);
info2 :: Type.get_info(Point);
comptime_assert(info2.is_struct(), "Point is a struct");
```

`Type.get_info(T)` 返回 `comptime(TypeInfo)` 值。所有操作都是编译时的——没有运行时开销。

## TypeInfo 枚举

`TypeInfo` 是一个编译时枚举，包含无字段变体和复合变体：

```rust
TypeInfo :: enum(
  // === 原始类型（无字段）===
  Unit, Bool,
  Usize, Isize,
  U8, I8, U16, I16, U32, I32, U64, I64,
  F32, F64,

  // === C 兼容原始类型（无字段）===
  Char, Short, UShort, Int, UInt,
  Long, ULong, LongLong, ULongLong, LongDouble,
  Void,

  // === 复合类型（带元数据）===
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

  // === 元类型 ===
  Module(fields : ComptimeList(TypeFieldInfo)),
  Trait(fields : ComptimeList(TraitFieldInfo), kind : TraitKind),
  Type(level : comptime_int),
  SomeType(name : comptime_string, required_traits : ComptimeList(TraitInfo),
           negative_traits : ComptimeList(TraitInfo), resolved_type : Type),

  // === 仅编译时 ===
  ComptimeInt, ComptimeFloat, ComptimeString,
  ComptimeList(element : Type),

  // === 元编程（无字段）===
  Expr, EffectsRow, TypeApplication
);
```

## 守卫方法

`TypeInfo` 提供类型分类的守卫方法：

```rust
info :: Type.get_info(i32);

// 结构守卫
info.is_struct()     // 匹配 .Struct(_, _)
info.is_enum()       // 匹配 .Enum(_)
info.is_union()      // 匹配 .Union(_)
info.is_tuple()      // 匹配 .Tuple(_)
info.is_array()      // 匹配 .Array(_, _)
info.is_slice()      // 匹配 .Slice(_)
info.is_function()   // 匹配 .Function(_)
info.is_pointer()    // 匹配 .Ptr(_)
info.is_trait()      // 匹配 .Trait(_, _)
info.is_module()     // 匹配 .Module(_)
info.is_void()       // 匹配 .Void

// 数值守卫
info.is_primitive()  // 所有原始变体
info.is_integer()    // Usize, Isize, U8..I64, Char, Short..ULongLong
info.is_float()      // F32, F64, LongDouble
info.is_numeric()    // is_integer() || is_float()
info.is_comptime()   // ComptimeInt, ComptimeFloat, ComptimeString, ComptimeList, Expr
```

## 提取复合数据

使用 `match` 从复合变体中提取元数据：

### 数组

```rust
Arr3 :: [i32; 3];
info :: Type.get_info(Arr3);

elem :: match(info, .Array(e, _) => e, _ => unit);
comptime_assert(__yo_are_types_compatible(elem, i32), "element is i32");

len :: match(info, .Array(_, l) => l, _ => 0);
comptime_assert((len == 3), "length is 3");
```

### 结构体

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

### 枚举

```rust
Color :: enum(Red, Green, Blue);
info :: Type.get_info(Color);

variant_count :: match(info, .Enum(v) => v.len(), _ => usize(0));
comptime_assert((variant_count == usize(3)), "Color has 3 variants");
```

### 函数

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

### 指针

```rust
PtrI32 :: *(i32);
info :: Type.get_info(PtrI32);

pointee :: match(info, .Ptr(p) => p, _ => unit);
comptime_assert(__yo_are_types_compatible(pointee, i32), "pointee is i32");
```

## 元数据结构体

### TypeFieldInfo

表示结构体、联合体、元组或模块中的字段：

```rust
TypeFieldInfo :: struct(
  name : comptime_string,
  field_type : Type
);
```

### VariantInfo

表示枚举变体：

```rust
VariantInfo :: struct(
  name : comptime_string,
  fields : ComptimeList(TypeFieldInfo),
  field_count : comptime_int,
  has_discriminant : bool
);
```

### StructKind

区分结构体类型：

```rust
StructKind :: enum(Struct, Object, NewType);
```

- `Struct` — 普通值类型结构体
- `Object` — 引用计数对象类型（`object(...)`）
- `NewType` — 单字段包装类型（`newtype(...)`）

### FunctionInfo

丰富的函数类型元数据：

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

函数参数元数据：

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

Forall 类型参数：

```rust
ForallParamInfo :: struct(
  name : comptime_string,
  param_type : Type
);
```

### ImplicitParamInfo

Using/效果参数：

```rust
ImplicitParamInfo :: struct(
  name : comptime_string,
  param_type : Type
);
```

### TraitInfo

轻量级特征引用：

```rust
TraitInfo :: struct(
  trait_type : Type
);
```

### TraitFieldInfo

特征字段元数据：

```rust
TraitFieldInfo :: struct(
  name : comptime_string,
  field_type : Type,
  is_associated_type : bool
);
```

### TraitKind

区分特征类型：

```rust
TraitKind :: enum(
  Future(child : Type, effects : ComptimeList(TraitInfo)),
  Fn(call : FunctionInfo),
  Normal
);
```

## 匹配分发

使用 `match` 对 `TypeInfo` 进行编译时类型分发：

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

## 与 derive_rule 配合使用

`TypeInfo` 专为 `derive_rule` 设计，实现强大的编译时代码生成。类型反射内建函数如 `__yo_type_field_count`、`__yo_type_join_fields` 等仍可用于向后兼容，但 `TypeInfo` 提供了更结构化的替代方案：

```rust
// 在 derive 规则中使用 TypeInfo 检查类型种类
derive_rule(MyTrait, (fn(comptime(T) : Type, quote(target) : Expr) -> unquote(Expr)) {
  info :: Type.get_info(T);
  comptime_assert(info.is_struct(), "MyTrait can only be derived for structs");
  // ... 使用 info 生成 impl
});
```

完整的 derive 系统文档，请参阅 [DERIVE_TRAITS.md](./DERIVE_TRAITS.md)。

## Type 方法

`Type` 类型提供用于编译时类型分析的静态方法：

| 方法                            | 描述                                     |
| ------------------------------- | ---------------------------------------- |
| `Type.get_info(T)`              | 返回类型 `T` 的 `TypeInfo` 枚举          |
| `Type.eq(A, B)`                 | 精确类型相等（名义类型——需要相同的定义） |
| `Type.neq(A, B)`                | 类型不等（`Type.eq` 的取反）             |
| `Type.is_compatible_with(A, B)` | 宽松类型兼容性（允许隐式转换）           |
| `Type.impls(T, Marker)`         | 检查类型 `T` 是否实现了标记 trait        |
| `Type.contains_rc_type(T)`      | 检查类型是否包含引用计数字段             |
| `Type.can_form_rc_cycle(T)`     | 检查类型是否可能形成引用计数循环         |

### 类型相等 vs 类型兼容

```rust
// Type.eq — 精确匹配，名义类型
comptime_assert(Type.eq(i32, i32), "same type");

A :: struct(x : i32);
B :: struct(x : i32);
comptime_assert(Type.neq(A, B), "different definitions, not equal");

// Type.is_compatible_with — 允许隐式转换
// comptime_int 与 i32 兼容，但它们不相等
```

`Type.eq` 使用 `__yo_are_types_equal`（精确匹配，不允许隐式转换）。`Type.is_compatible_with` 使用 `__yo_are_types_compatible`（允许 `comptime_int` → `i32` 等隐式转换）。

## 内建函数

| 内建函数                                     | 描述                                     |
| -------------------------------------------- | ---------------------------------------- |
| `__yo_type_get_info(T)`                      | 返回类型 `T` 的 `TypeInfo`               |
| `__yo_are_types_compatible(A, B)`            | 宽松类型兼容性（允许隐式转换）           |
| `__yo_are_types_equal(A, B)`                 | 精确类型相等（不允许隐式转换，名义类型） |
| `__yo_type_is_struct(T)`                     | 检查 `T` 是否为结构体                    |
| `__yo_type_is_enum(T)`                       | 检查 `T` 是否为枚举                      |
| `__yo_type_field_count(T)`                   | 结构体/枚举的字段数                      |
| `__yo_type_get_name(T)`                      | 类型名作为 `comptime_string`             |
| `__yo_type_get_field_name(T, i)`             | 索引 `i` 处的字段名                      |
| `__yo_type_get_field_type(T, i)`             | 索引 `i` 处的字段类型                    |
| `__yo_type_variant_count(T)`                 | 枚举变体数                               |
| `__yo_type_get_variant_name(T, i)`           | 索引 `i` 处的变体名                      |
| `__yo_type_get_variant_field_count(T, i)`    | 变体 `i` 的字段数                        |
| `__yo_type_get_variant_field_name(T, i, j)`  | 变体 `i` 中字段 `j` 的名称               |
| `__yo_type_get_variant_field_type(T, i, j)`  | 变体 `i` 中字段 `j` 的类型               |
| `__yo_type_join_fields(T, mapper, combiner)` | 映射并组合结构体字段                     |
| `__yo_type_map_variants(T, mapper)`          | 映射枚举变体                             |

## 设计文档

完整设计包括实现细节，请参阅 [TYPE_REFLECTION.md](../../plans/TYPE_REFLECTION.md)。
