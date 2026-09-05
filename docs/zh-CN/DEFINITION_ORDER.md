# 定义顺序

在同一个模块内，**`name :: <定义>` 绑定与 `impl(...)` 注册与源码顺序无关**。一个定义
可以引用同一模块中的任何其他定义，不论它出现在文件的哪个位置——调用者写在被调用者
之前、函数写在它返回的类型之前、自由函数之间的相互递归、自由函数调用一个
`impl` 位于文件末尾的方法或 trait 默认实现。

```rust
// 调用者在被调用者之前
call_later :: (fn(n : i32) -> i32)(later_helper(n) * i32(2));
later_helper :: (fn(n : i32) -> i32)(n + i32(1));

// 通过函数自己的名字自递归（`recur` 依然可用）
fact :: (fn(n : i32) -> i32)(
  cond((n <= i32(1)) => i32(1), true => (n * fact(n - i32(1))))
);

// 自由函数之间的相互递归
is_even :: (fn(n : i32) -> bool)(cond((n == i32(0)) => true, true => is_odd(n - i32(1))));
is_odd :: (fn(n : i32) -> bool)(cond((n == i32(0)) => false, true => is_even(n - i32(1))));

// 在定义之前使用类型与常量
make_point :: (fn(x : i32) -> Point)(Point(x : x, y : (x * SCALE)));
Point :: struct(x : i32, y : i32);
SCALE :: i32(7);

// impl 位于使用它的自由函数之后——包括 trait 默认方法
say_hi :: (fn(d : Dog) -> String)(d.greet());
Dog :: struct(n : String);
impl(Dog, Greeter(name : (fn(self : Self) -> String)(self.n.clone())));

// `export` 可以列出在它之后出现的定义
export(exported_later);
exported_later :: (fn() -> i32)(i32(99));
```

## 哪些语句仍然有序

其**副作用**构成模块可观察求值过程的语句保持严格的源码顺序——它们不是定义：

| 语句 | 为什么有序 |
| --- | --- |
| `{ a, b } :: import("...")`、`x :: import("...")`、`open(import("..."))` | 加载模块会注册其 impl，并把名字引入作用域 |
| `pragma(...)` | 作用于其后的代码 |
| 模块级运行期全局变量——`x := v`、`(g : T) = v` | 运行期值按顺序初始化 |
| `comptime(x) : T;` … `x = v;`（先声明、后赋值） | 声明是一条语句；赋值填充它 |
| `(comptime(x) : T) = v` | 是赋值，不是 `::` 定义 |
| `comptime_assert(...)`、裸表达式语句 | 在书写处求值 |
| `impl({ ... })` 块及其内部的绑定 | 这是一个模块*值*；其字段是块作用域的、有序的 |

被提前强制求值的定义只能看到**触发它的那个引用**之前的语句。若 `helper`（第 60 行）
用到了第 50 行 `open(import(...))` 引入的名字，而第 30 行的 `caller` 强制求值了
`helper`，那么此时 open 尚未发生，检查会失败。像标准库的每个模块那样，把 import
与 open 放在文件顶部。

引用一条出现在后面的有序语句时，诊断信息会指明它：

```
forward reference to "counter" (bound at line 3) — imports, opens, pragmas and
runtime bindings are evaluated in order (only `::` definitions and `impl`
registrations are order-independent); move that statement above this use
```

## 实现原理

模块遍历器仍然从上到下求值语句。开始之前，它先预扫描整个模块，把每个 `::` 定义和
每个 `impl(<receiver>, ...)` 记录为**待定**条目。随后：

1. 条目仍处于待定状态的语句在其自身位置求值，与从前完全一致。
2. 一次**未命中**的查找——环境不认识的标识符、`export` 了一个未绑定的名字、对某个
   具名类型的方法/trait 查找一无所获——会去查该标识符所属模块的待定表。待定的定义会
   被**强制求值**：它的语句就在此刻求值（作为模块级语句、在模块环境中），得到的绑定
   直接交回。receiver 头部为该类型的待定 `impl` 以同样方式被强制求值，然后查找重试。
3. 遍历器之后遇到已被强制求值过的语句时直接跳过。到模块末尾一切都已绑定：惰性改变
   的是*何时*，而不是*是否*。

由于强制求值只发生在原本会报错的查找上，今天顺序正确的程序会以完全相同的顺序求值，
并生成完全相同的 C 代码。

### 函数定义分两阶段

强制求值 `f :: (fn(...) -> R)(body)` 分两步绑定 `f`：先求值签名头部，在求值函数体
之前就**发布**一个带稳定 id 的函数值。函数体内部对 `f` 的引用（自递归），或者函数体
所强制求值的兄弟定义对它的引用（相互递归），绑定的就是这个已发布的值。只有
`(fn(...) -> R)(body)` 形式拥有可单独求值的头部；匿名 `->`/`=>` 字面量从函数体推断
类型，因此递归函数要用 `fn` 形式书写。

### 循环

*值*依赖于自身的定义是错误，并给出完整链条：

```
cyclic definition: A (line 2) → B (line 3) → A — a definition's value depends
on itself. Function definitions may reference each other (their signatures bind
before their bodies evaluate); a constant or type definition may not name itself.
```

### 被强制求值的定义内部出错

一个在被强制求值时失败的定义报告的是**它自己的**错误、指向它自己的位置，并附上一条
说明它为何提前运行的 note：

```
note: `second` (line 4) was evaluated here because it is referenced before its
definition in the source
```

## `impl` 块内部

同一个 `impl(...)` 块内的兄弟方法可以通过 `self.method(...)` 或 `Self.method(...)`
以任意顺序互相调用：

```rust
N :: struct(value : i32);
impl(N,
  is_even : (fn(n : i32) -> bool)(cond((n == i32(0)) => true, true => Self.is_odd(n - i32(1)))),
  is_odd : (fn(n : i32) -> bool)(cond((n == i32(0)) => false, true => Self.is_even(n - i32(1))))
);
```

在 impl 块内部，以裸名称引用兄弟方法（写 `callee()` 而不是 `self.callee()`）**不会**
被前向绑定：把兄弟方法绑定为局部名字会遮蔽其他方法体内的同名局部变量。模块级裸名称
属于另一个作用域，它们*是*与顺序无关的。

自由函数、泛型函数体或*另一个*类型的方法可以使用某类型任何后续 `impl` 块中的方法——对
该类型的一次未命中会强制求值该类型所有待定的 impl。但在 `T` 的某个 `impl` 块**内部**，
不会强制求值后面的 `impl(T, ...)` 块中的方法：当 `T` 的某个 impl 正在求值时，对 `T`
的未命中归属于块内兄弟方法机制。请把互相调用的方法放在同一个块中，或调整块的顺序。
