# 高级类型

超越结构体与枚举的类型层技巧：高阶类型、广义代数数据类型（GADTs）与类型状态。
基本数据类型见 [DATA_TYPES.md](./DATA_TYPES.md)；trait 见 [TRAITS.md](./TRAITS.md)。

## 高阶类型（Higher-Kinded Types，HKT）

Yo 通过**编译期函数类型作为 Kind**来支持高阶类型。像 `Option` 和 `Result` 这样的类型构造器已经是一等的编译期函数值——HKT 让你可以对它们进行抽象。

| Haskell Kind  | Yo 等价形式                                                    |
| ------------- | -------------------------------------------------------------- |
| `*`           | `Type`                                                         |
| `* -> *`      | `fn(comptime(T) : Type) -> comptime(Type)`                     |
| `* -> * -> *` | `fn(comptime(A) : Type, comptime(B) : Type) -> comptime(Type)` |

### HKT generic 参数

声明一个具有函数类型 Kind 的 generic 参数来接受类型构造器：

```yo
// F 是一个类型构造器（kind: Type → Type）
identity :: (
  fn(
    generic(F : (fn(comptime(T) : Type) -> comptime(Type)), A : Type),
    x : F(A)
  ) -> F(A)
)(x);

// 使用：
(x : Option(i32)) = .Some(i32(42));
result := identity(generic(Option, i32), x); // result: Option(i32)
inferred := identity(x); // 由实参得到 F = Option，A = i32
```

带种类标注的参数可以从实参的实例化推断：`x : F(A)` 接收 `Option(i32)` 时，`F` 绑定到构造器 `Option`，`A` 绑定到 `i32`，结果 `F(A)` 就是直接调用所构造的同一个 `Option(i32)`。

### HKT Trait

定义以类型构造器为参数的 Trait：

```yo
// Functor trait —— F 是一个类型构造器
Functor :: (fn(comptime(F) : (fn(comptime(T) : Type) -> comptime(Type))) -> comptime(Trait))(
  trait(
    map : (fn(generic(A : Type, B : Type), self : F(A), f : (fn(a : A) -> B)) -> F(B))
  )
);

// 为 Option 实现 Functor
impl(
  generic(A : Type),
  Option(A),
  Functor(Option)(
    map : (fn(generic(A : Type, B : Type), self : Option(A), f : (fn(a : A) -> B)) -> Option(B))(
      match(
        self,
        .Some(v) => .Some(f(v)),
        .None => .None
      )
    )
  )
);

// 使用 trait 方法
(x : Option(i32)) = .Some(i32(42));
result := x.map(generic(i32), (fn(a : i32) -> i32)(a + i32(1)));
// result = .Some(i32(43))
```

### 使用 HKT where 子句的泛型函数

```yo
do_map :: (
  fn(
    generic(F : (fn(comptime(T) : Type) -> comptime(Type)), A : Type, B : Type),
    container : F(A),
    f : (fn(a : A) -> B),
    where(F(A) <: Functor(F))
  ) -> F(B)
)(
  container.map(generic(B), f)
);

(x : Option(i32)) = .Some(i32(10));
result := do_map(generic(Option, i32, i32), x, (fn(a : i32) -> i32)(a * i32(2)));
// result = .Some(i32(20))
```

## 广义代数数据类型（GADTs）

### 概述

GADTs 扩展了 Yo 的枚举类型，允许每个构造器指定其返回的类型参数的精确实例化。这使得类型系统能够在**模式匹配时细化类型变量**，为每个匹配分支提供更精确的类型信息。

### 语法

#### 箭头语法：`-> recur(具体类型)`

每个 GADT 构造器使用 `-> recur(Type1, Type2, ...)` 在字段列表之后指定其返回类型：

```yo
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

#### 多参数 GADTs

```yo
MyPair :: (fn(comptime(A) : Type, comptime(B) : Type) -> comptime(Type))(
  enum(
    MkIntBool(x : i32, y : bool) -> recur(i32, bool),
    MkBoolInt(x : bool, y : i32) -> recur(bool, i32)
  )
);
```

#### 带自定义判别值的 GADTs

自定义判别值和 GADT 返回类型可以共存：

```yo
Tagged :: (fn(comptime(T) : Type) -> comptime(Type))(
  enum(
    (TagInt(i : i32) -> recur(i32)) = 10,
    (TagBool(b : bool) -> recur(bool)) = 20
  )
);
```

#### 混合 GADT 和普通变体

部分变体可以有 GADT 注解，其余保持无约束：

```yo
MixedVal :: (fn(comptime(T) : Type) -> comptime(Type))(
  enum(
    MInt(i : i32) -> recur(i32),
    MBool(b : bool) -> recur(bool),
    MGeneric(v : T) // 无 GADT 注解 — 无约束
  )
);
```

### 匹配中的类型细化

GADT 的核心特性：对 GADT 值进行模式匹配时，类型系统会在每个分支中细化类型变量。

```yo
eval_value :: (fn(generic(T : Type), v : Value(T)) -> T)(
  match(
    v,
    .IntVal(i) => i,
    // T 被细化为 i32，i : i32，返回 i32 ✓
    .BoolVal(b) => b,
    // T 被细化为 bool，b : bool，返回 bool ✓
    .PairVal(a, b) => a // T 被细化为 i32，a : i32，返回 i32 ✓
  )
);

// 使用：
v := Value(i32).IntVal(i32(42));
result := eval_value(v); // result : i32 = 42
```

每个分支可以返回不同的具体类型 — 类型检查器会验证每个分支的返回类型是否匹配 GADT 细化后的类型参数。

### 穷尽性检查

当匹配具有具体类型的 GADT 值时，类型系统会过滤掉不可达的变体：

```yo
// Value(i32) 只能是 IntVal 或 PairVal
// BoolVal 不可达（它返回 Value(bool)，而不是 Value(i32)）
eval_int_only :: (fn(v : Value(i32)) -> i32)(
  match(
    v,
    .IntVal(i) => i,
    .PairVal(a, b) => a
    // 不需要 .BoolVal — 对于 Value(i32) 它不可达
  )
);
```

为被排除的变体编写分支是错误（E0608）：没有任何 `Value(i32)` 持有 `.BoolVal`。在针对 `Value(T)` 的泛型函数中，每个变体的分支都是需要的，因为不同的实例化会排除不同的变体。

### 类型标识与构造

GADT（以及任何泛型枚举）的类型参数属于其类型本身，即使没有任何变体负载提到它们。`Value(i32)` 与
`Value(bool)` 的负载形状完全相同，但仍是两个不同的类型：

```yo
x := Value(i32).IntVal(i32(77));
(y : Value(bool)) = x; // error[E0601]: Incompatible types（Value(bool) 与 Value(i32)）
```

一个变体只能构造其 `-> recur(...)` 索引所指的实例。通过其他实例来构造它是类型错误，无论是完整写法还是简写：

```yo
Value(i32).BoolVal(true); // error[E0601]: GADT variant "BoolVal" is declared
// `-> recur(bool)`, so it cannot construct a Value(i32)
(v : Value(i32)) = .BoolVal(true); // 同样的错误
(w : Value(bool)) = .BoolVal(true); // 正确
```

这正是上面穷尽性过滤成立的前提：`Value(i32)` 永远不可能持有 `BoolVal`，因此省略该分支的 match 不会落空。

### 运行时表示

GADTs 具有**与普通枚举相同的 C 表示**。所有类型细化都纯粹是编译时的 — 在运行时，GADT 只是一个标签联合体。不需要特殊的代码生成。

### 设计理由

- `->` 模仿函数返回类型语法 — 每个构造器在概念上是一个产生特定类型实例化的函数
- `recur` 复用现有的自引用关键字 — 正如 `recur(args)` 调用外层函数，`recur(i32)` 应用外层类型构造器
- 消费 GADTs 的函数需要显式的 `generic` 类型注解（这在 Yo 中已是标准做法）

### 与其他特性的交互

- **HKT**：正交关系。GADT 可以用作 HKT 类型构造器。
- **部分应用**：使用 `_` 占位符正常工作。
- **代数效果**：无交互 — 效果在函数调用层面操作。

### 限制

- **不支持存在类型**：构造器不能引入不在枚举参数中的新类型变量。隐藏类型的受支持方式是 `Box(Dyn(Trait))`；Yo 拥有的三种形式与不拥有的那一种见 [TRAIT_OBJECTS.md § 存在类型](./TRAIT_OBJECTS.md#存在类型)。
- 类型细化仅适用于 `match` 表达式，不适用于 `cond`。
- 每个分支都会在定义时按其细化类型检查，即使它位于没有任何调用方的 `generic` 函数中：类型错误的 `.BoolVal(b) => i32(7)`
  分支会在 `yo check` 时报错，因为两个具体类型之间的不匹配无法通过任何实例化消除
  （`issues/fixed/gadt-arm-is-type-checked-only-when-its-index-is-instantiated.md`）。

嵌套模式在 GADT 值上与普通枚举一样可用（`.Wrap(.PairVal(a, true))`），穷尽性过滤在每一层都生效。

## 类型状态（Typestate）

协议状态可以放进类型里，就像 ATS 的带索引资源（`FILEptr(mode)`）：用一个没有
字段引用的幻影 comptime 参数，再让函数只接受它需要的状态。状态不对的调用是类型
错误（E0601）。

```yo
Open :: struct();
Closed :: struct();
Handle :: (fn(comptime(S) : Type) -> comptime(Type))(struct(fd : i32));

open_h :: (fn(fd : i32) -> Handle(Open))(Handle(Open)(fd : fd));
read_h :: (fn(h : Handle(Open)) -> i32)(h.fd);
close_h :: (fn(sink(h) : Handle(Open)) -> Handle(Closed))(Handle(Closed)(fd : h.fd));

main :: (fn() -> unit)({
  h := open_h(i32(3));
  c := close_h(h);
  // read_h(c);   // E0601：期望 Handle(Open)，实际为 Handle(Closed)
  // read_h(h);   // E0901：使用已移动的值 `h`
});
export(main);
```

只有当状态转换之后旧状态**无法**再被使用时，这个模式才是可靠的，因此有两条规则：

- **句柄是只能移动的，状态转换用 `sink(...)` 接收它。** 移动使旧名字不可再用
  （E0901）。派生了 `Copy` 的句柄类型会被**复制**进调用，于是已关闭的句柄和它的
  `Open` 副本都仍然可用。
- **没有其他别名保留旧状态。** 在转换之前被克隆到另一个名字的句柄仍然
  带着旧类型。把类型状态句柄只保存在一个名字里。

std 的 `File` 与套接字则在运行时保存状态。
