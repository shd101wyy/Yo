# 模块

模块：`import` 与 `export`、匿名模块、模块级可变绑定，以及模块内定义与顺序无关。
包与 `yo.toml` 依赖见 [BUILD_SYSTEM.md](./BUILD_SYSTEM.md)；模块文件的命名见
[SYNTAX.md](./SYNTAX.md#命名规范)。

## 模块的导入和导出

```yo
// module1.yo
{ println } :: import("std/fmt");

test :: (fn() -> unit)({
  println("Hello, world!");
});
export(test);

// module2.yo
// 导出类型
Maybe :: (fn(comptime(T) : Type) -> comptime(Type))(
  enum(
    Some(value : T),
    None
  )
);
export(Maybe);
```

```yo
{ ... } :: import("./module1.yo"); // 从 module1.yo 导入所有内容
test_module :: import("./module1.yo"); // 从 module1.yo 导入所有内容并放入 test_module 命名空间
{ test } :: import("./module1.yo"); // 从 module1.yo 导入 test 函数
{ test : test2 } :: import("./module1.yo"); // 从 module1.yo 导入 test 函数并重命名为 test2
{ Maybe } :: import("./module2.yo"); // 从 module2.yo 导入 Maybe 类型
```

### 同一个名字导入两次

每个导入的名字都是一个绑定，所以"禁止变量遮蔽"的规则同样适用于导入：同一个名字绑定两次是错误（`Failed to define variable "ArrayList"` … `variable shadowing is not allowed`），无论是两行都写了这个名字，还是 `{ ... }` 通配导入已经引入了它。同一路径写多行导入没有问题，只要每行绑定的名字不同；同一个名字也可以换个新名字再导入一次：

```yo
{ ArrayList } :: import("std/collections/array-list");
{ ArrayListIter } :: import("std/collections/array-list"); // 可以：名字不同
{ ArrayList : List } :: import("std/collections/array-list"); // 可以：绑定为新名字
xs := List(i32).new();
```

### trait impl 通过你的导入可见

方法调用只在你的文件通过导入（传递地）能**到达**的模块的 `impl(...)` 块里解析，再加上 prelude。
一个 impl 如果所在模块不在你的导入路径上任何模块导入过，它就不是候选——即便同一次 `yo check`
或同一个程序里的其他文件碰巧加载了它。例如整数与 `str` 的 `to_string` 来自 `std/fmt` 的 `Display`
impl，所以调用它们的模块要导入 `std/fmt`（任意一个绑定即可：`{ Display } :: import("std/fmt")`）。
这保证了一个文件单独检查和与其他文件一起检查时得到相同的结论。`YO_VISIBILITY_REPORT=1` 会把
所有只能通过调用方导入之外的 impl 才能解析的调用列出来而不是拒绝——用它来补上缺失的导入行。

### 匿名模块

匿名模块使用 `impl` 关键字后跟一个 `begin` 块来定义：

```yo
{ println } :: import("std/fmt");

my_module :: impl({
  my_function :: (fn() -> unit)({
    println("Hello from my_module!");
  });
  export(my_function);
});
```

### 模块级可变变量

Yo 支持在模块顶层（文件作用域）定义可变的运行时变量。这些变量会编译为 C 的 `static` 文件作用域变量，在 `main` 函数执行前初始化。

支持两种语法：

```yo
// := 初始化
counter := i32(0);

// 绑定模式初始化
(flag : bool) = false;
```

同一模块中定义的函数可以读写这些变量：

```yo
inc :: (fn() -> unit)({
  counter = (counter + i32(1));
});
```

**限制：**

- 模块作用域不允许仅有类型注解而无初始化的声明：
  ```yo
  a : i32; // ❌ 错误：应使用 `a := i32(0);` 或 `(a : i32) = i32(0);`
  ```
- `impl` 块内不允许可变运行时变量（`:=` 或 `(x : T) = val`）。请使用 `::` 定义编译时常量：
  ```yo ignore
  m :: impl {
    b := i32(13);  // ❌ 错误：impl 块内不允许
    b :: 13;       // ✅ 正确：编译时常量
    export(b);
  };
  ```
- 模块级可变变量**不能被导出**。只有编译时已知的值才能从模块中导出。

## 定义顺序

在同一个模块内，**`name :: <定义>` 绑定、`impl(...)` 注册与 `derive(T, ...)` 语句都与源码顺序无关**。一个定义
可以引用同一模块中的任何其他定义，不论它出现在文件的哪个位置——调用者写在被调用者
之前、函数写在它返回的类型之前、自由函数之间的相互递归、自由函数调用一个
`impl` 位于文件末尾的方法或 trait 默认实现。

```yo
{ String } :: import("std/string");

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
say_hi :: (fn(d : &Dog) -> String)(d.greet());
Dog :: struct(n : String);
Greeter :: trait(
  name : (fn(self : &Self) -> String),
  (greet : (fn(self : &Self) -> String)) ?= (self -> (`hi ` + self.name()))
);
impl(Dog, Greeter(name : (fn(self : &Self) -> String)(self.n.clone())));

// derive 位于调用其派生方法的函数之后
copy_bag :: (fn(b : &Bag) -> Bag)(b.clone());
Bag :: struct(n : i32);
derive(Bag, Clone);

// `export` 可以列出在它之后出现的定义
export(exported_later);
exported_later :: (fn() -> i32)(i32(99));
```

### 哪些语句仍然有序

其**副作用**构成模块可观察求值过程的语句保持严格的源码顺序——它们不是定义：

| 语句 | 为什么有序 |
| --- | --- |
| `{ a, b } :: import("...")`、`x :: import("...")`、`{ ... } :: import("...")` | 加载模块会注册其 impl，并把名字引入作用域 |
| `pragma(...)` | 作用于其后的代码 |
| 模块级运行期全局变量——`x := v`、`(g : T) = v` | 运行期值按顺序初始化 |
| `comptime(x) : T;` … `x = v;`（先声明、后赋值） | 声明是一条语句；赋值填充它 |
| `(comptime(x) : T) = v` | 是赋值，不是 `::` 定义 |
| `comptime_assert(...)`、裸表达式语句 | 在书写处求值 |
| `impl({ ... })` 块及其内部的绑定 | 这是一个模块*值*；其字段是块作用域的、有序的 |

被提前强制求值的定义只能看到**触发它的那个引用**之前的语句。若 `helper`（第 60 行）
用到了第 50 行 import 引入的名字，而第 30 行的 `caller` 强制求值了 `helper`，
那么此时该 import 尚未发生，检查会失败。像标准库的每个模块那样，把 import
放在文件顶部。

引用一条出现在后面的有序语句时，诊断信息会指明它：

```
forward reference to "counter" (bound at line 3) — imports, pragmas and
runtime bindings are evaluated in order (only `::` definitions and `impl`
registrations are order-independent); move that statement above this use
```

### 实现原理

模块遍历器仍然从上到下求值语句。开始之前，它先预扫描整个模块，把每个 `::` 定义、
每个 `impl(<receiver>, ...)` 和每个 `derive(T, ...)` 记录为**待定**条目（derive 是
`T` 的一个待定 impl）。随后：

1. 条目仍处于待定状态的语句在其自身位置求值，与从前完全一致。
2. 一次**未命中**的查找——环境不认识的标识符、`export` 了一个未绑定的名字、对某个
   具名类型的方法/trait 查找一无所获——会去查该标识符所属模块的待定表。待定的定义会
   被**强制求值**：它的语句就在此刻求值（作为模块级语句、在模块环境中），得到的绑定
   直接交回。receiver 头部为该类型的待定 `impl` 与 `derive` 以同样方式被强制求值，然后查找重试。
3. 遍历器之后遇到已被强制求值过的语句时直接跳过。到模块末尾一切都已绑定：惰性改变
   的是*何时*，而不是*是否*。

由于强制求值只发生在原本会报错的查找上，今天顺序正确的程序会以完全相同的顺序求值，
并生成完全相同的 C 代码。

#### 函数定义分两阶段

强制求值 `f :: (fn(...) -> R)(body)` 分两步绑定 `f`：先求值签名头部，在求值函数体
之前就**发布**一个带稳定 id 的函数值。函数体内部对 `f` 的引用（自递归），或者函数体
所强制求值的兄弟定义对它的引用（相互递归），绑定的就是这个已发布的值。只有
`(fn(...) -> R)(body)` 形式拥有可单独求值的头部；匿名 `->`/`=>` 字面量从函数体推断
类型，因此递归函数要用 `fn` 形式书写。

#### 循环

*值*依赖于自身的定义是错误，并给出完整链条：

```
cyclic definition: A (line 2) → B (line 3) → A — a definition's value depends
on itself. Function definitions may reference each other (their signatures bind
before their bodies evaluate); a constant or type definition may not name itself.
```

#### 被强制求值的定义内部出错

一个在被强制求值时失败的定义报告的是**它自己的**错误、指向它自己的位置，并附上一条
说明它为何提前运行的 note：

```
note: `second` (line 4) was evaluated here because it is referenced before its
definition in the source
```

### `impl` 块内部

同一个 `impl(...)` 块内的兄弟方法可以通过 `self.method(...)` 或 `Self.method(...)`
以任意顺序互相调用：

```yo
N :: struct(value : i32);
impl(
  N,
  is_even : (fn(n : i32) -> bool)(cond((n == i32(0)) => true, true => Self.is_odd(n - i32(1)))),
  is_odd : (fn(n : i32) -> bool)(cond((n == i32(0)) => false, true => Self.is_even(n - i32(1))))
);
```

在 impl 块内部，以裸名称引用兄弟方法（写 `callee()` 而不是 `self.callee()`）**不会**
被前向绑定：把兄弟方法绑定为局部名字会遮蔽其他方法体内的同名局部变量。模块级裸名称
属于另一个作用域，它们*是*与顺序无关的。

其机制与模块级定义相同：块内成员在块求值到它们之前处于待定状态，一次未命中的
`self.callee()` / `Self.callee()` 查找会就地强制求值 `callee` 的真实定义（其函数体在块的
作用域内被类型检查并求值一次）。兄弟方法之间的互递归通过被调用方的签名解决，与两个 `::`
函数完全一样。如果被强制求值的兄弟方法本身有错误，错误会报告在该方法自己的位置，并附带
一条说明：因为有兄弟方法引用了它，所以它被提前求值。

自由函数、泛型函数体或*另一个*类型的方法可以使用某类型任何后续 `impl` 块或 `derive`
中的方法——对该类型的一次未命中会强制求值该类型所有待定的 impl。在 `T` 的某个 `impl`
块**内部**，对某个方法的未命中只会强制求值按名字声明了该方法的后续 `impl(T, ...)` 块；
若没有这样的块，则强制求值后续的 `derive(T, ...)` 语句（derive 只有在运行之后才声明
其方法）。块内部的 trait 约束检查不会强制求值任何东西：当 `T` 的某个 impl 正在求值时，
这些未命中归属于块内兄弟方法机制。
