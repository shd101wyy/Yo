# `impl` 块中的前向引用

Yo 支持 **同一个 `impl(...)` 块内兄弟字段之间的前向引用**。无论源代码顺序如何，
同一个 `impl` 块内的方法都可以互相调用，从而无需"holder"绕路即可实现相互递归。

## 示例

```rust
P :: struct(x : i32, y : i32);

impl(P,
  // `caller` 引用稍后定义的 `callee`。
  caller : (fn(inout(self) : Self) -> i32)(
    self.callee()
  ),
  callee : (fn(inout(self) : Self) -> i32)(
    self.x
  )
);
```

两个方法之间的相互递归同样可行：

```rust
N :: struct(value : i32);

impl(N,
  is_even : (fn(inout(self) : Self, n : i32) -> bool)(
    cond(
      (n == i32(0)) => true,
      true => self.is_odd((n - i32(1)))
    )
  ),
  is_odd : (fn(inout(self) : Self, n : i32) -> bool)(
    cond(
      (n == i32(0)) => false,
      true => self.is_even((n - i32(1)))
    )
  )
);
```

## 前向引用的适用范围

当前支持前向引用的情形：

- **方法形式的字段**，使用规范形态 `name : (fn(<sig>) -> R)(<body>)`
  —— 标准库中所有 `impl` 都使用这种形式。
- **匿名 trait impl 与命名 trait impl 都支持**。`impl(T, SomeTrait( ... ))`
  内部的方法也可以以任意顺序互相调用。
- **`self.method(...)` 与 `Self.method(...)` 两种调用都支持**。无论是实例风格
  （`self.X`）还是类型风格（`Self.X`），都能解析前向引用。裸名称引用不支持
  （见下文）。

不适用的情形：

- **以裸名称引用兄弟方法**（例如直接写 `callee()` 而不是 `self.callee()` 或
  `Self.callee()`）。裸名称不会被前向绑定 —— 请使用 `self.X` 或 `Self.X`。
  这样可以避免与兄弟方法体内的局部变量发生命名冲突。
- **跨 `impl` 块的前向引用**。两个独立的 `impl(P, ...)` 块之间不能互相前向引用。
  请合并到同一个 `impl` 块。
- **顶层 `name :: value` 定义**。顶层自由绑定之间暂不支持前向引用。
  自 2026-09-02 的编译器起，在更早的定义中引用它们（包括在 `io.async`
  闭包体内）会得到**编译期报错** —— `forward reference to "X" (defined
  at line N) — Yo evaluates definitions in order; move the definition above
  this use` —— 而不是旧行为那样静默地把函数体求值为空、直到运行期才暴露。
- **非方法形式的字段值**。Lambda 函数体、`Impl(Fn(...))(...)` 包装以及直接值
  绑定都不会被生成前向声明。

## 实现原理

`evaluateImplFieldList` 分两遍执行：

1. **预处理遍**——对于每个方法形式的字段，仅对 `fn(<sig>) -> R` 头部求值，得到
   完整的 `FunctionType`（含 `using`/effect 参数）。然后分配一个真正的
   `FunctionValue` "壳"，附带未求值的 body 和稳定的 `funcId`，并把这个壳注册到
   receiver 类型的 trait 中，使 `self.method(...)` 查询能够命中。
2. **主遍**——对每个方法的 body 求值。当 body 通过 `self.X` 或 `Self.X` 引用
   兄弟方法时，查询会命中预处理产生的壳。求值完成后，**就地** 填充该壳（保留它
   的 `funcId`、`funcName`，以及兄弟方法 body 求值过程中已经创建的所有特化结
   果）。

由于预处理遍生成的是带有真实类型与原始 body 的真壳，兄弟方法 body 求值过程中
触发的特化能够正常工作 —— 壳里已经包含了克隆和特化所需的全部信息。

预处理遍会主动跳过：

- 非方法字段（例如 `Item : Type` 这样的关联类型）。
- 值不是 `(fn(...) -> R)(body)` 字面量的字段。
- `fn(...)` 头部求值失败（如引用了尚未定义的符号）的字段。这些字段会落入主遍，
  并由主遍报告恰当的错误。

## 为什么不支持裸名称前向引用？

如果把预处理产生的壳绑定为局部变量，会与兄弟方法 body 内部的局部变量同名时发生
冲突。例如：

```rust
impl(MyType,
  len : (fn(inout(self) : Self) -> usize) self.items.len(),
  // 下面这个 body 内部声明的局部 `len` 就会与同名的兄弟字段冲突
  trim : (fn(inout(self) : Self) -> Self) {
    len := usize(0); // 会遮蔽兄弟字段
    // ...
  }
);
```

为了避免这种隐患，兄弟方法之间的引用必须通过 receiver trait，使用
`self.method(...)` 或 `Self.method(...)`。这也让分派显式化，并与标准库中所有
代码的写法保持一致。

## 示例：`Self.method`（类型风格分派）

```rust
N :: struct(value : i32);

impl(N,
  is_even : (fn(n : i32) -> bool)(
    cond(
      (n == i32(0)) => true,
      true => Self.is_odd((n - i32(1)))
    )
  ),
  is_odd : (fn(n : i32) -> bool)(
    cond(
      (n == i32(0)) => false,
      true => Self.is_even((n - i32(1)))
    )
  )
);

// 调用点使用类型名：
N.is_even(i32(10)) // true
```
