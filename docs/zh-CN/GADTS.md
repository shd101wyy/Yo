# 广义代数数据类型（GADTs）

## 概述

GADTs 扩展了 Yo 的枚举类型，允许每个构造器指定其返回的类型参数的精确实例化。这使得类型系统能够在**模式匹配时细化类型变量**，为每个匹配分支提供更精确的类型信息。

## 语法

### 箭头语法：`-> recur(具体类型)`

每个 GADT 构造器使用 `-> recur(Type1, Type2, ...)` 在字段列表之后指定其返回类型：

```rust
Value :: (fn(comptime(T) : Type) -> comptime(Type))(
  enum(
    IntVal(i : i32) -> recur(i32),
    BoolVal(b : bool) -> recur(bool),
    PairVal(a : i32, b : bool) -> recur(i32)
  )
);
```

- `-> recur(i32)` 表示 `IntVal` 构造一个 `Value(i32)`
- `-> recur(bool)` 表示 `BoolVal` 构造一个 `Value(bool)`
- 省略 `-> recur(...)` 时，默认为无约束情况（与普通枚举行为相同）

### 多参数 GADTs

```rust
MyPair :: (fn(comptime(A) : Type, comptime(B) : Type) -> comptime(Type))(
  enum(
    MkIntBool(x : i32, y : bool) -> recur(i32, bool),
    MkBoolInt(x : bool, y : i32) -> recur(bool, i32)
  )
);
```

### 带自定义判别值的 GADTs

自定义判别值和 GADT 返回类型可以共存：

```rust
Tagged :: (fn(comptime(T) : Type) -> comptime(Type))(
  enum(
    (TagInt(i : i32) -> recur(i32)) = 10,
    (TagBool(b : bool) -> recur(bool)) = 20
  )
);
```

### 混合 GADT 和普通变体

部分变体可以有 GADT 注解，其余保持无约束：

```rust
MixedVal :: (fn(comptime(T) : Type) -> comptime(Type))(
  enum(
    MInt(i : i32) -> recur(i32),
    MBool(b : bool) -> recur(bool),
    MGeneric(v : T)  // 无 GADT 注解 — 无约束
  )
);
```

## 匹配中的类型细化

GADT 的核心特性：对 GADT 值进行模式匹配时，类型系统会在每个分支中细化类型变量。

```rust
eval_value :: (fn(generic(T : Type), v : Value(T)) -> T)(
  match(v,
    .IntVal(i) => i,      // T 被细化为 i32，i : i32，返回 i32 ✓
    .BoolVal(b) => b,     // T 被细化为 bool，b : bool，返回 bool ✓
    .PairVal(a, b) => a   // T 被细化为 i32，a : i32，返回 i32 ✓
  )
);

// 使用：
v := Value(i32).IntVal(i32(42));
result := eval_value(v);  // result : i32 = 42
```

每个分支可以返回不同的具体类型 — 类型检查器会验证每个分支的返回类型是否匹配 GADT 细化后的类型参数。

## 穷尽性检查

当匹配具有具体类型的 GADT 值时，类型系统会过滤掉不可达的变体：

```rust
// Value(i32) 只能是 IntVal 或 PairVal
// BoolVal 不可达（它返回 Value(bool)，而不是 Value(i32)）
eval_int_only :: (fn(v : Value(i32)) -> i32)(
  match(v,
    .IntVal(i) => i,
    .PairVal(a, b) => a
    // 不需要 .BoolVal — 对于 Value(i32) 它不可达
  )
);
```

## 类型标识与构造

GADT（以及任何泛型枚举）的类型参数属于其类型本身，即使没有任何变体负载提到它们。`Value(i32)` 与
`Value(bool)` 的负载形状完全相同，但仍是两个不同的类型：

```rust
x := Value(i32).IntVal(i32(77));
(y : Value(bool)) = x;  // error[E0601]: Incompatible types（Value(bool) 与 Value(i32)）
```

一个变体只能构造其 `-> recur(...)` 索引所指的实例。通过其他实例来构造它是类型错误，无论是完整写法还是简写：

```rust
Value(i32).BoolVal(true);         // error[E0601]: GADT variant "BoolVal" is declared
                                  // `-> recur(bool)`, so it cannot construct a Value(i32)
(v : Value(i32)) = .BoolVal(true); // 同样的错误
(w : Value(bool)) = .BoolVal(true); // 正确
```

这正是上面穷尽性过滤成立的前提：`Value(i32)` 永远不可能持有 `BoolVal`，因此省略该分支的 match 不会落空。

## 运行时表示

GADTs 具有**与普通枚举相同的 C 表示**。所有类型细化都纯粹是编译时的 — 在运行时，GADT 只是一个标签联合体。不需要特殊的代码生成。

## 设计理由

- `->` 模仿函数返回类型语法 — 每个构造器在概念上是一个产生特定类型实例化的函数
- `recur` 复用现有的自引用关键字 — 正如 `recur(args)` 调用外层函数，`recur(i32)` 应用外层类型构造器
- 消费 GADTs 的函数需要显式的 `generic` 类型注解（这在 Yo 中已是标准做法）

## 与其他特性的交互

- **HKT**：正交关系。GADT 可以用作 HKT 类型构造器。
- **部分应用**：使用 `_` 占位符正常工作。
- **代数效果**：无交互 — 效果在函数调用层面操作。

## 限制

- **不支持存在类型**：构造器不能引入不在枚举参数中的新类型变量。
- 类型细化仅适用于 `match` 表达式，不适用于 `cond`。
- `generic` 函数的函数体在被调用时才做类型检查，因此某个分支只有在某个调用方实例化了该分支的索引后，才会按其细化类型被检查：
  一个类型错误的 `.BoolVal(b) => i32(7)` 分支在有调用方传入 `Value(bool)` 之前都能通过 `yo check`
  （`issues/gadt-arm-is-type-checked-only-when-its-index-is-instantiated.md`）。

嵌套模式在 GADT 值上与普通枚举一样可用（`.Wrap(.PairVal(a, true))`），穷尽性过滤在每一层都生效。
