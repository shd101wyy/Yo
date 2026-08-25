# 派生特征（Derive Traits）

`derive` 是一个编译期内建函数，可以自动为结构体和枚举类型生成特征实现。它的功能类似于 Rust 的 `#[derive(...)]` 属性，但使用函数调用语法。

所有六个标准可派生特征（Eq、Hash、Clone、Ord、ToString、Default）都是**自宿主的**——它们的派生规则使用 `derive_rule` 机制直接在 Yo 中编写，而非在编译器中硬编码。

## 基本用法

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

`derive` 接受一个类型作为第一个参数，后面跟一个或多个特征表达式。参数化特征如 `Eq` 和 `Ord` 需要显式类型参数（例如 `Eq(Point)`）。无参数特征如 `Hash`、`Clone` 和 `ToString` 可以直接使用名称。

## 标准可派生特征

### Eq

生成结构化相等比较。当所有字段相等时，两个值相等。需要显式类型参数：`Eq(Type)`。

```rust
Color :: struct(r : u8, g : u8, b : u8);
derive(Color, Eq(Color));

// 现在可以使用 == 和 !=
assert((Color(u8(255), u8(0), u8(0)) == Color(u8(255), u8(0), u8(0))), "same color");
```

对于枚举类型，相等性先检查变体标签，然后在变体匹配时比较字段：

```rust
Shape :: enum(Circle(radius : i32), Rect(w : i32, h : i32));
derive(Shape, Eq(Shape));

assert((.Circle(i32(5)) == .Circle(i32(5))), "same circle");
```

### Hash

通过使用 FNV 风格哈希组合（`h * 31 + field_hash`）组合所有字段的哈希值来生成哈希函数。对于枚举类型，变体索引也会包含在哈希中。

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

生成字典序排序，从左到右比较字段。需要显式类型参数：`Ord(Type)`。对于枚举类型，先按判别值排序，再按字段值排序。

```rust
derive(Point, Ord(Point));

p1 := Point(i32(1), i32(2));
p2 := Point(i32(1), i32(3));
assert((p1 < p2), "p1 < p2");
```

### ToString

生成字符串表示。结构体产生 `TypeName(field1, field2, ...)` 格式。枚举产生 `TypeName.Variant` 或 `TypeName.Variant(field1, ...)` 格式。

```rust
derive(Point, ToString);

p := Point(i32(1), i32(2));
// p.to_string() 返回 "Point(1, 2)"
```

### Default

生成一个各字段均取其自身类型默认值的值。**仅支持结构体**——枚举没有公认的默认变体，这种实现需要手写。

```rust
Config :: struct(retries : i32, verbose : bool, name : String);
derive(Config, Default);

d := (Config <: Default).default();
// Config(retries : 0, verbose : false, name : "")
```

每个字段类型都必须实现 `Default`。字段类型为泛型实例化（如 `ArrayList(i32)`、`Option(T)`）同样可用：派生规则通过结构体自身的字段列表取得字段类型，而非按名称引用，因此实现处无需任何额外的作用域引入。

与 `Option.unwrap_or_default`、`Result.unwrap_or_default` 配合使用。

## 多个特征

可以在一次调用中使用可变编译期参数派生多个特征：

```rust
derive(Point, Eq(Point), Hash, Clone, Ord(Point), ToString);
```

这等同于为每个特征分别调用 `derive`。

## 枚举支持

所有标准派生都适用于枚举类型，包括带字段的枚举：

```rust
// 无字段枚举
Direction :: enum(North, South, East, West);
derive(Direction, Eq(Direction), Hash, Clone, Ord(Direction), ToString);

// 带字段枚举
Shape :: enum(Circle(radius : i32), Rect(w : i32, h : i32));
derive(Shape, Eq(Shape), Clone, ToString);
```

对于无字段枚举，相等性和排序基于变体判别值。对于带字段枚举，先检查变体，然后比较字段。

## 要求

结构体或枚举中的每个字段类型必须已经实现了要派生的特征。例如，要 `derive(Point, Eq(Point))`，类型 `i32`（用于 `x` 和 `y`）必须实现 `Eq`。内建类型（`i32`、`u8`、`bool`、`str`、`String` 等）实现了所有标准特征。

## `derive_rule` — 用户注册的派生规则

`derive_rule` 允许特征作者注册其特征的派生方式。注册后，`derive(Type, MyTrait(Type))` 就像标准特征一样工作。

### 定义派生规则

派生规则是一个编译期函数，签名为：

```rust
fn(comptime(T) : Type, comptime(ctx) : DeriveContext, comptime(trait_params) : ComptimeList(Expr)) -> comptime(Expr)
```

- `T` — 正在派生的目标类型
- `ctx` — `DeriveContext` 结构体，包含 `target`（Expr）、`forall_params`、`where_clause`
- `trait_params` — 特征构造函数参数的 Expr 列表

函数返回一个 `Expr`（通过 `quote` 或 `.to_expr()`），表示要生成的 `impl` 代码块。

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

// 现在 derive 可以用于任何结构体
Point :: struct(x : i32, y : i32);
derive(Point, MyEq(Point));
// p1.my_eq(p2) 可以使用！
```

### DeriveContext

`DeriveContext`（定义在 `std/prelude.yo` 中）提供：

- `target : Expr` — 用于拼接的原始目标类型表达式
- `forall_params : Option(Expr)` — 来自 derive 调用的可选 generic 子句
- `where_clause : Option(Expr)` — 可选 where 子句
- `make_impl(trait_body : Expr) -> Expr` — 构造完整的 `impl(...)` 表达式，自动包含 generic/where

### 枚举的派生规则

对于无字段枚举，使用 `Type.map_variants` 生成 match 分支：

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

### 泛型 derive 与 generic/where

派生规则支持使用 `generic` 和 `where` 的泛型类型：

```rust
Pair :: (fn(comptime(A) : Type, comptime(B) : Type) -> comptime(Type))(
  struct(first : A, second : B)
);

derive(generic(T1, T2), Pair(T1, T2), where((T1 <: MyEq(T1)), (T2 <: MyEq(T2))), MyEq(Pair(T1, T2)));
```

`DeriveContext.make_impl` 方法会自动在生成的 impl 中包含 generic/where 子句。

### 规则查找顺序

当调用 `derive(Type, Trait)` 时：

1. **已注册的派生规则**（通过 `derive_rule`）— 在特征类型或其构造函数上首先检查
2. **编译期函数** — 如果特征参数解析为编译期函数
3. **错误** — 如果以上都不匹配

### 自宿主标准派生

所有六个标准特征都使用相同的 `derive_rule` 机制：

- **Eq、Clone、Hash、Ord、Default** — 派生规则定义在 `std/prelude.yo` 中
- **ToString** — 派生规则定义在 `std/fmt/to_string.yo` 中（ToString 特征定义所在）

这些实现使用基于字符串的代码生成，通过 `comptime_str` 和 `.to_expr()` 在编译期构建 impl 代码块。

## 类型反射

派生规则可以使用 `Type.get_info(T)` 和 `__yo_type_*` 内建函数在编译期检查类型。完整文档请参阅 [TYPE_REFLECTION.md](./TYPE_REFLECTION.md)。

## 设计文档

完整的设计文档（包含实现细节）请参阅 [DERIVE_TRAITS.md](../../plans/DERIVE_TRAITS.md)。
