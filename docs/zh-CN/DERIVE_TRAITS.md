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

可以在一次调用中使用可变编译期参数派生多个特征：

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

## `derive_rule` — 用户注册的派生规则

`derive_rule` 允许特征作者注册其特征的派生方式。注册后，`derive(Type, MyTrait)` 就像内建特征一样工作。

### 定义派生规则

派生规则是一个编译期函数，签名为：

```rust
fn(comptime(T) : Type, comptime(ctx) : DeriveContext, comptime(trait_params) : ComptimeList(Expr)) -> comptime(Expr)
```

- `T` — 正在派生的目标类型
- `ctx` — `DeriveContext` 结构体，包含 `target`（Expr）、`forall_params`、`where_clause`
- `trait_params` — 特征构造函数参数的 Expr 列表

函数返回一个 `Expr`（通过 `quote`），表示要生成的 `impl` 代码块。

### 示例：结构体相等性

```rust
// 定义自定义相等特征
MyEq :: (fn(comptime(Rhs) : Type) -> comptime(Trait))(
  trait(
    my_eq : (fn(self : Self, other : Rhs) -> bool)
  )
);

// 提供基础实现
impl(i32, MyEq(i32)(my_eq : ((self, other) -> (self == other))));
impl(bool, MyEq(bool)(my_eq : ((self, other) -> (self == other))));

// 注册 MyEq 的派生规则
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

// 现在 derive 可以用于任何结构体
Point :: struct(x : i32, y : i32);
derive(Point, MyEq(Point));
// p1.my_eq(p2) 可以使用！
```

### DeriveContext

`DeriveContext`（定义在 `std/prelude.yo` 中）提供：

- `target : Expr` — 用于拼接的原始目标类型表达式
- `forall_params : Option(Expr)` — 来自 derive 调用的可选 forall 子句
- `where_clause : Option(Expr)` — 可选 where 子句
- `make_impl(trait_body : Expr) -> Expr` — 构造完整的 `impl(...)` 表达式，自动包含 forall/where

### 枚举的派生规则

对于无字段枚举，使用 `__yo_type_map_variants` 生成 match 分支：

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

### 泛型 derive 与 forall/where

派生规则支持使用 `forall` 和 `where` 的泛型类型：

```rust
Pair :: (fn(comptime(A) : Type, comptime(B) : Type) -> comptime(Type))(
  struct(first : A, second : B)
);

derive(forall(T1, T2), Pair(T1, T2), where((T1 <: MyEq(T1)), (T2 <: MyEq(T2))), MyEq(Pair(T1, T2)));
```

`DeriveContext.make_impl` 方法会自动在生成的 impl 中包含 forall/where 子句。

### 规则查找顺序

当调用 `derive(Type, Trait)` 时：

1. **已注册的派生规则**（通过 `derive_rule`）— 首先检查
2. **内建派生**（Eq、Hash、Clone、Ord、ToString）— 后备
3. **编译期函数** — 如果特征名称解析为编译期函数
4. **错误** — 如果以上都不匹配

已注册的规则始终优先于内建派生。

## 类型反射

派生规则可以使用 `Type.get_info(T)` 和 `__yo_type_*` 内建函数在编译期检查类型。完整文档请参阅 [TYPE_REFLECTION.md](./TYPE_REFLECTION.md)。

## 用户自定义派生（旧方式）

在 `derive_rule` 出现之前，可以将自定义派生函数定义为签名为 `fn(comptime(T) : Type) -> comptime(unit)` 的编译期函数：

```rust
derive_describe :: (fn(comptime(T) : Type) -> comptime(unit)) {
  name :: __yo_type_get_name(T);
  code ::
    (("impl(T, describe : (fn(self : Self) -> String)(  `" + name) + "`))");
  comptime_eval(code);
};

MyStruct :: struct(x : i32, y : i32);
derive(MyStruct, derive_describe);
```

这种方式可以工作，但不如 `derive_rule` 结构化。新代码建议使用 `derive_rule`。

## 设计文档

完整的设计文档（包含实现细节）请参阅 [DERIVE_TRAITS.md](../../plans/DERIVE_TRAITS.md)。
