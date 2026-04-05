# 派生特征（Derive Traits）

`derive` 是一个编译期内建函数，可以自动为结构体和枚举类型生成特征实现。它的功能类似于 Rust 的 `#[derive(...)]` 属性，但使用函数调用语法。

## 基本用法

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

`derive` 接受一个类型作为第一个参数，后面跟一个或多个特征名称。它会为每个特征生成 `impl` 代码块。

## 内建可派生特征

### Eq

生成结构化相等比较。当所有字段相等时，两个值相等。

```rust
Color :: struct(r : u8, g : u8, b : u8);
derive(Color, Eq);

// 现在可以使用 == 和 !=
assert((Color(u8(255), u8(0), u8(0)) == Color(u8(255), u8(0), u8(0))), "same color");
```

对于枚举类型，相等性先检查变体标签，然后在变体匹配时比较字段：

```rust
Shape :: enum(Circle(radius : i32), Rect(w : i32, h : i32));
derive(Shape, Eq);

assert((.Circle(i32(5)) == .Circle(i32(5))), "same circle");
```

### Hash

通过使用 `hash_combine` 组合所有字段的哈希值来生成哈希函数。对于枚举类型，变体索引也会包含在哈希中。

```rust
derive(Point, Hash);
// Point 现在实现了 Hash 特征
```

### Clone

生成克隆方法，通过克隆每个字段来创建深拷贝。

```rust
derive(Point, Clone);

p := Point(i32(1), i32(2));
p2 := p.clone();
```

### Ord

生成字典序排序，从左到右比较字段。返回 `Ordering`（`.Less`、`.Equal`、`.Greater`）。对于枚举类型，先按变体索引排序，再按字段值排序。

```rust
derive(Point, Ord);

p1 := Point(i32(1), i32(2));
p2 := Point(i32(1), i32(3));
assert((p1.compare(p2) == .Less), "p1 < p2");
```

### ToString

生成字符串表示。结构体产生 `TypeName(field1, field2, ...)` 格式。枚举产生 `TypeName.Variant(field1, ...)` 格式。

```rust
derive(Point, ToString);

p := Point(i32(1), i32(2));
// p.to_string() 返回 "Point(1, 2)"
```

## 多个特征

可以在一次调用中派生多个特征：

```rust
derive(Point, Eq, Hash, Clone, Ord, ToString);
```

这等同于为每个特征分别调用 `derive`。

## 显式特征参数

可以使用 `Trait(Type)` 语法传递显式特征类型参数：

```rust
Vec2 :: struct(x : f64, y : f64);
derive(Vec2, Eq(Vec2));
```

裸特征名称（`Eq`）和显式特征类型参数（`Eq(Vec2)`）都支持，并且可以混合使用：

```rust
derive(Vec2, Eq(Vec2), Hash, Clone);
```

## 枚举支持

所有内建派生都适用于枚举类型，包括带字段的枚举：

```rust
// 无字段枚举
Direction :: enum(North, South, East, West);
derive(Direction, Eq, Hash, Clone, Ord, ToString);

// 带字段枚举
Result :: enum(Ok(value : i32), Err(msg : str));
derive(Result, Eq, Clone, ToString);
```

对于无字段枚举，相等性和排序基于变体索引。对于带字段枚举，先检查变体，然后比较字段。

## 要求

结构体或枚举中的每个字段类型必须已经实现了要派生的特征。例如，要 `derive(Point, Eq)`，类型 `i32`（用于 `x` 和 `y`）必须实现 `Eq`。内建类型（`i32`、`u8`、`bool`、`str`、`String` 等）实现了所有标准特征。

## 类型反射内建函数

Yo 提供了编译期类型反射内建函数，由 `derive` 内部使用，也可用于用户自定义派生：

| 内建函数                                    | 描述                                   |
| ------------------------------------------- | -------------------------------------- |
| `__yo_type_is_struct(T)`                    | 如果 T 是结构体类型则返回 `true`       |
| `__yo_type_is_enum(T)`                      | 如果 T 是枚举类型则返回 `true`         |
| `__yo_type_get_name(T)`                     | 返回类型名称，类型为 `comptime_string` |
| `__yo_type_field_count(T)`                  | 返回结构体字段数量                     |
| `__yo_type_get_field_name(T, i)`            | 返回第 i 个字段的名称                  |
| `__yo_type_get_field_type(T, i)`            | 返回第 i 个字段的类型                  |
| `__yo_type_variant_count(T)`                | 返回枚举变体数量                       |
| `__yo_type_get_variant_name(T, i)`          | 返回第 i 个变体的名称                  |
| `__yo_type_get_variant_field_count(T, i)`   | 返回第 i 个变体的字段数量              |
| `__yo_type_get_variant_field_name(T, i, j)` | 返回第 i 个变体的第 j 个字段的名称     |
| `__yo_type_get_variant_field_type(T, i, j)` | 返回第 i 个变体的第 j 个字段的类型     |

所有内建函数都是编译期专用的，与 `comptime(T) : Type` 参数一起使用。

## `comptime_eval`

`comptime_eval` 内建函数在编译时将 `comptime_string` 解析并执行为 Yo 代码：

```rust
comptime_eval("derive(MyType, Eq)");
```

这是用户自定义派生函数的基础——它们使用类型反射构建代码字符串，然后用 `comptime_eval` 执行。

## 用户自定义派生

可以将自定义派生函数定义为签名为 `fn(comptime(T) : Type) -> comptime(unit)` 的编译期函数：

```rust
// 定义一个生成 `describe` 方法的自定义派生
derive_describe :: (fn(comptime(T) : Type) -> comptime(unit)) {
  name :: __yo_type_get_name(T);
  code ::
    (("impl(T, describe : (fn(self : Self) -> String)(  `" + name) + "`))");
  comptime_eval(code);
};

// 使用它
MyStruct :: struct(x : i32, y : i32);
derive(MyStruct, derive_describe);

// 现在 MyStruct 有了 .describe() 方法
s := MyStruct(i32(1), i32(2));
s.describe(); // 返回 "MyStruct"
```

### 工作原理

1. **类型反射** — 使用 `__yo_type_*` 内建函数检查类型的结构
2. **代码生成** — 使用字符串拼接构建 `impl(T, ...)` 代码字符串
3. **执行** — 调用 `comptime_eval(code)` 注入生成的 impl

生成的代码应该在 `impl` 的类型位置使用 `T`（类型参数，在作用域内），而不是类型名称。类型名称可以在字符串字面量中使用（例如用于显示目的）。

### 示例：生成感知字段的代码

```rust
// 生成 field_count 方法的派生
derive_field_count :: (fn(comptime(T) : Type) -> comptime(unit)) {
  count :: __yo_type_field_count(T);
  comptime_eval(("impl(T, field_count : (fn(self : Self) -> i32)( i32(" + count) + ")))");
};
```

## 可变参数编译期参数

`derive` 在内部使用可变参数编译期参数，允许任意数量的特征参数：

```rust
derive(Point, Eq, Hash, Clone, Ord, ToString);  // 一次调用中 5 个特征
```

此功能也可用于用户代码。详细信息请参阅可变参数编译期参数文档。
