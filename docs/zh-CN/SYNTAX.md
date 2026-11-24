# 语法

Yo 的表层语法：程序入口、调用与运算符、绑定、字面量、控制流、命名与格式化。
数据类型见 [DATA_TYPES.md](./DATA_TYPES.md)，函数见
[FUNCTIONS.md](./FUNCTIONS.md)，形式语法见
[GRAMMAR.md](./GRAMMAR.md)。

## Hello World

```yo
{ println } :: import("std/fmt");

main :: (fn() -> unit)({
  println("Hello, world!");
});

export(main);
```

`main` 必须返回 `unit`，编译器会拒绝其他返回类型。程序主体在一个大栈的工作线程上运行，
因此从 `main` 返回的值无处可去。请用 `std/process` 的
`exit(code)` 设置进程退出状态：

```yo
{ exit } :: import("std/process");

main :: (fn() -> unit)({
  if(!ok(), {
    exit(usize(1));
  });
});
export(main);
```

`main` 可以带一个 `io : Io` 效应参数（`main :: (fn(io : Io) -> unit)`）；返回类型必须是 `unit`，而 `Io` 是运行时唯一能提供的参数——C 包装器会把参数零初始化，其他效应记录会携带 NULL 处理器指针并在首次使用时崩溃。其他处理器请在 `main` 内部绑定（例如：`exn := Exception(throw : ((err) -> { unwind(()); }));`）。

## 调用、运算符与块

```yo
// 注释使用 `//` 或 `/* */`
/*
  支持嵌套注释
  /*
    像这样
  */
*/
// Yo 的语法受到 Lisp 的启发，因此没有关键字
// 它只使用原子和函数调用
x; // 一个原子（标识符）
func(x, y); // 带两个参数 x 和 y 的函数调用。
// 注意函数名和括号之间没有空格
// 不带括号的调用（如 func x, y）是非法的。
// 调用必须使用紧贴的括号。以下写法是非法的：
// func x, y
// func (x, y)
// Yo 区分大小写，所以 `X` 和 `x` 是不同的标识符
// 在 Yo 中，一切都是函数：`x := true;` 与 `y :: 14;` 是保留运算符
// `:=` / `::` 作用于两个参数，也可以写成前缀调用形式
// （这里绑定新名字——不允许遮蔽已有名字）：
(:=)(x2, true);
(::)(y2, 14);
// 虽然通常我们不会这么写 ^
// Yo 中没有算术优先级
// 除了 "." 不被视为运算符，但它具有最高优先级。
// "." 有自己的解析规则，例如 a.b + c.d 被解析为 .(a, b) + .(c, d)
// 每个中缀运算符接受左右两个参数。
//
// Yo 没有运算符优先级。相同运算符的链是左结合的，因此不需要括号：
3 + 4 + 5; // 解析为 (3 + 4) + 5
// 但相邻的不同运算符存在歧义，必须用显式括号消除歧义：
//
//   3 + 4 - 5; // 错误："+" 和 "-" 是不同的运算符
//
// 必须写成
3 + (4 - 5);
// 或者
(3 + 4) - 5;

// Yo 中的运算符是以下字符的组合：
// = + - * / < > @ $ ~ & % | ! ? ^ . : \\ #
// 它们可以作为中缀运算符使用，接受两个参数
// 但它们会被转换为点方法调用：
(3 + 4) * 5; // 等同于
3.(+)(4).(*)(5);

{
  // 使用分隔符 `;` 的 {...} 内容是一个 begin 块
  // 用于将多个表达式组合在一起
  (); // () 是 unit 值
  12
};
// 等同于
begin(
  (),
  12
);
```

## 变量声明

Yo 中的变量使用 `:=`（运行时）或 `::`（编译期）声明。

```yo
// "comptime" 在这里表示编译期已知
x := 5; // x: i32，运行时变量
y :: 5; // y: comptime_int，编译期变量
// 带显式类型声明
(x : i32) = 5; // x: i32，运行时变量
(comptime(y) : comptime_int) = 5; // y: comptime_int，编译期变量
// 或者
comptime(y) := 5;

// (:) 函数用于标注类型
// (=) 函数用于更新变量的值，或用一个值初始化变量
// (:=) 函数用于声明一个类型自动推断的运行时变量
// (::) 函数用于声明一个类型自动推断的编译期变量
x : i32; // 定义一个运行时变量
comptime(x) : i32; // 定义一个编译期变量
// 初始化变量
(comptime(x) : comptime_int) = 12;
(y : i32) = 14;
(z : i32) = 16;

// 可以写成：
(=)((:)(comptime(x), comptime_int), 12);
(=)((:)(y, i32), 14);
(=)((:)(z, i32), 16);

// 它们等价于：
x :: 12;
y := 14;
z := 16;
```

### 绑定默认不可变，除非声明为 `mut(name)`

绑定在定义之后不能被写入，除非它的名字被包在 `mut(...)` 中，相当于 Rust 的
`let mut`。该标记在每个绑定位置都包住名字：

```yo
x := 0; // 不可变
mut(n) := 0; // 可变
n = (n + 1); // OK
(mut(t) : i32) = 0;
mut(c) :: 12; // 编译期可变
comptime(mut(d)) := 12; // 可变的编译期变量
r := match(
  opt,
  .Some(mut(v)) => {
    v = (v + 1);
    v
  },
  .None => 0
);
{ a, mut(b) } := pair; // 解构中按名字标记
```

`mut` 管控对绑定及其下每个位置的四种写入：

- 重新赋值（`x = v`）；
- 写入字段或元素（`p.x = v`、`a(i) = v`）；
- 以 `&mut` 借出（`f(&mut x)`、`y := &mut x.f`、`match(&mut x, …)`、`&mut x` 捕获）；
- 调用 `&mut self` 方法（在 `String` 上调用 `s.push_str("!")`）。

对没有该标记的绑定做其中任何一种写入都是错误 E0917。共享句柄之后的“门”经由自己的方法写入：
`RefCell.with_mut` 接收 `&self` 并写入载荷，因此 `RefCell` 绑定改变它所持有的内容不需要标记；
重新赋值该绑定仍然需要。借用（`x : &mut T`、`y := &mut place`）
是被“透过”写入，而不是被写入。没有初值声明的绑定（`(x : T);`）的第一次赋值是它的初始化。

参数不接受 `mut`：参数保持不可变。
需要修改按值实参的函数体应重新绑定它：`mut(y) := x;`，对拥有所有权的值这是一次移动；
需要修改调用方的值则改用 `x : &mut T`。模块级绑定遵循同一规则：未标记的相当于 Rust 的
`static`，`mut(G) := v` 相当于 `static mut`（且永远不能借给调用，E0916）。在编译期被重新赋值的
编译期绑定声明为 `mut(x) :: v`（或 `comptime(mut(x)) := v`），在块中和模块级都一样。`for` 的元素
绑定和闭包捕获列表中的条目同样不接受 `mut`；需要修改它们的函数体应重新绑定。

`yo fix <path>` 会为一次写入插入它需要的标记，每轮一处。

> `mut` 是保留字：它包住绑定的名字（`mut(x) := v`），或出现在 `&` 之后（位置中的 `&mut T`，调用点的 `&mut x`）；名为 `mut` 的绑定或参数是错误。

### 禁止变量遮蔽

Yo 不允许变量遮蔽，以避免混淆

```yo
x := 1;
x := 2; // 错误：x 已经被声明过
```

```yo
x := 1;
{
  x := 2; // 错误：x 已经被声明过
};
```

在不同的块作用域中可以使用相同的变量名：

```yo
{
  x := 1;
};
{
  x := 2; // 允许：不同的作用域
};
```

### 丢弃调用结果

当调用函数只是为了副作用、不需要返回值时，请直接写成裸表达式语句，不要绑定到丢弃名：

```yo
// 推荐：
unsafe(unistd.close(fd));

// 也能编译，但绑定本身是多余的：
_ := unsafe(unistd.close(fd));
```

`_ := expr` 会声明一个在作用域结束时丢弃的一次性绑定（`_` 可以在同一作用域内重复；`___` 不行）。只有在绑定本身有意义时才使用它——比如通过 `ref_count(...)` 统计释放次数的测试，或者需要强制求值路径的编译期报错用例。

## 类型推断

```yo
// String 是值类型，独占堆上的字节
(my_string : String) = String.from("Hello, world"); // 字节在堆上分配
my_string_2 := my_string.clone(); // 独立的副本；`my_string_2 := my_string` 则会移动它
// 原始类型是复制的
my_int := 1; // 栈分配
my_int_2 := my_int; // my_int_2 是一个副本
// 固定大小数组是值类型
(my_int_array : Array(i32, 3)) = [1, 2, 3]; // 栈分配
my_int_array := [1, 2, 3]; // Array(i32, 3)
// ArrayList 也是值类型：独占自己的堆缓冲区
(my_array_list : ArrayList(i32)) = ArrayList(i32).new(); // 缓冲区在堆上分配，只有一个所有者
Person :: struct(name : String, age : i32); // 值类型（其 String 字段也是值）
p := Person(name : String.from("Alice"), age : 30);
_(name, age) := p; // name : String, age : i32
```

### 未初始化变量

```yo
x : i32; // x : i32，未初始化
// 编译器会阻止使用未初始化的变量。
println(x); // 编译错误：x 未初始化。
x = 1; // x : i32，已初始化
```

### 整数字面量与编译期整数

整数字面量、`::` 常量和折叠后的常量表达式的类型是 `comptime_int`，它没有位宽上限。只有进入某个定宽类型的“槽位”——
带类型的绑定、赋值、实参、结构体或枚举字段、返回值、`cond`/`match` 汇合后的分支，或 `T(x)` 转换——时，它才取得该类型，
并且其值必须放得下：

```yo
(a : u8) = 255; // 正确
(b : u8) = 300; // error[E1102]: the literal 300 does not fit in u8 (0..=255)
(c : i8) = -128; // 正确
(d : u8) = (200 + 100); // error[E1102]: the compile-time value 300 does not fit in u8
k :: 3;
(e : u8) = k; // 正确：comptime_int 常量取得槽位的类型
f := u8(300); // error[E1102]
g := u8(i32(300)); // 正确：两个带类型整数之间的转换按定义截断（g == 44）
```

没有槽位时，`comptime_int` 在成为运行时值时默认取 `i32`（`comptime_float` 取 `f64`）。在 `cond` 或 `match` 中，
comptime 分支无论顺序如何都会在其具体兄弟分支的类型处汇合：`cond(c => 1, true => i64(2))` 的类型是 `i64`。

## 算术与失败语义

安全的 Yo 程序从不执行未定义行为。运行时操作的每一种失败方式都属于以下三个层级之一：

| 层级 | 机制 | 示例 |
| --- | --- | --- |
| 证明 | 由验证器结算的契约 | 调用点上的 `requires(i < self.len())` |
| 类型 | 失败体现在返回类型中，调用方必须处理 | `list.get(i) -> Option(T)`、`checked_add`、`Result` |
| 陷阱 | 带 `file:line:col` 的确定性中止 | 下表各行 |

| 操作 | 行为 |
| --- | --- |
| `+`、`-`、`*` 溢出；`-MIN` | 中止：`integer addition overflow (at …)`。适用于所有整数宽度，有符号与无符号皆然 |
| `/` 或 `%` 除以零；`MIN / -1` | 中止：`integer division or remainder by zero (at …)` |
| 移位位数 ≥ 位宽 | 中止：`shift count out of range: 64 not in [0, 64) (at …)` |
| `Array(T, N)` / `str.bytes(i)` 下标越界 | 中止：`index out of bounds: i not in [0, n) (at …)` |
| 浮点 → 整数转换 | 饱和到目标类型的 MIN/MAX；`NaN` 变为 `0` |
| 整数 → 更窄整数转换 | 截断 |
| 浮点 `/` 与 `%` | IEEE 结果（`inf`、`nan`）；从不中止 |

该行为在所有 `--optimize` 级别下完全一致。它也与编译期保持一致：对常量的同样表达式是编译错误，而到达 panic 的编译期函数也是编译错误，并携带其消息。按设计需要回绕的算术请调用 `wrapping_add`、`wrapping_sub` 或 `wrapping_mul`。完整规则（包括 `unwrap` 禁令）见 [MEMORY_SAFETY.md](MEMORY_SAFETY.md)。

## 控制流

### cond

```yo
use_cond :: (fn(x : i32) -> unit)(
  cond(
    (x == 1) => println("x is 1"),
    (x == 2) => println("x is 2"),
    true => println("x is not 1 or 2")
  )
);
```

> 注意：最后一个条件必须是编译期已知的值 `true`，以充当默认分支。

### if/else

`if(condition, then, else)`

`if` 是 `cond` 的语法糖：编译器在解析阶段将每个 `if(...)` 调用脱糖为
`cond(condition => then, true => else)`，因此后续所有编译阶段（包括
async 状态机）看到的是真正的 `cond` 节点。prelude 中仍保留等价的宏定义，
作为语义规范以及动态构造 AST 的回退路径（参见 `std/prelude.yo` 与
`plans/reference/MACRO_POLICY.md`）：

```yo ignore
// prelude.yo 中的定义（规范/回退 —— 正常情况下在解析阶段脱糖）
if :: (fn(
        quote(condition): Expr,
        quote(then): Expr,
        (quote(else): Expr) ?= quote(())
      ) -> unquote(Expr))(
  quote(
    cond(
      unquote(condition) => unquote(then),
      true => unquote(else)
    )
  )
);

// 使用
main :: (fn() -> unit)({
  // 如果没有返回类型，则为 unit
  number := 3;

  if number < 5, then: {
    println("condition was true");
  },
  else: {
    println("condition was false");
  };

  if(number < 5, println("condition was true"), println("condition was false"));
});
```

### while

`while(condition, do: body)` 或
`while(condition, steps, do: body)`

```yo
factorial :: (fn(n : i32) -> i32)({
  result := 1;
  i := 1;
  while(i <= n, {
    result = (result * i);
    i = (i + 1);
  });
  result
});

factorial2 :: (fn(n : i32) -> i32)({
  result := 1;
  i := 1;
  while(i <= n, i = (i + 1), {
    result = (result * i);
  });
  result
});
```

### 迭代器与 for 循环

`Iterator` trait 定义了一个值序列。它有一个关联类型 `Item` 和一个 `next` 方法，返回 `Option(Self.Item)`：

```yo
Iterator :: trait(
  Item : Type,
  next : (fn(self : &mut Self) -> Option(Self.Item))
);
```

要为一个类型实现 `Iterator`，需要提供 `Item` 类型和一个 `next` 函数：

```yo
Counter :: struct(_current : i32, _max : i32);

impl(
  Counter,
  Iterator(
    Item : i32,
    next : (
      self -> cond(
        (self._current >= self._max) => .None,
        true => {
          val := self._current;
          self._current = (self._current + i32(1));
          .Some(val)
        }
      )
    )
  )
);
```

`IntoIterator` trait 将集合转换为迭代器。它有一个 `where` 子句，约束 `IntoIter` 关联类型必须实现具有匹配 `Item` 类型的 `Iterator`：

```yo
IntoIterator :: trait(
  Item : Type,
  IntoIter : Type,
  into_iter : (fn(self : Self) -> Self.IntoIter),
  where(Self.IntoIter <: Iterator(Item := Self.Item))
);
```

`for` 宏提供了迭代的语法糖。它在循环中调用 `.next()` 并对 `Option` 进行模式匹配：

```yo
// for 循环语法
for(iter_expr, variable => .{
  // 循环体
});
```

`for` 宏**按值**迭代 —— `for(coll, (x) => body)` 展开为 `coll.into_iter()` 后接标准的 `next()` 循环。`into_iter` 按值接收集合，所以值形式会**消耗** `coll`：迭代器拥有它。循环之后还要读取的集合，用下文的 `for(&coll, x => body)` 就地遍历，或迭代一份副本 `for(coll.clone(), x => body)`。其他持有源的迭代器同理：`String` 的 `chars()`、`bytes()`、`char_indices()` 与 `lines()`，映射的 `keys()` 与 `values()`，列表的 `chunks(n)` 与 `windows(n)`。集合与 `String` 都是值类型，因此之后再使用被循环消耗的那一个是 E0901。集合的 `iter()` 产出指向其存储的裸指针，持有的是存储而非集合本身：它只用于 `pragma(Pragma.AllowUnsafe)` 代码，且集合必须比遍历活得更久。值类型的元素是借用的：通过 `x` 写入其中的引用计数数据（`String` 元素、结构体元素的 `String` 字段）是 E0908。值类型元素的就地变异使用下文的借用形式 `for(&mut coll, x => body)`，或索引循环 + 索引写：

```yo
// 值形式 — 每个 `x` 按值产出。
mut(list) := ArrayList(i32).new();
list.push(i32(10));
list.push(i32(20));
for(list, value => {
  println(&value);
});

// 借用式 `for` 以 `&mut` 借出每个元素 — 变异落在集合里。
Counter :: struct(n : i32);
mut(counters) := ArrayList(Counter).new();
counters.push(Counter(n : i32(1)));
for(&mut counters, c => {
  c.n = (c.n + i32(1));
});

// struct/标量元素：索引写就地变异。
mut(arr) := Array(i32, 3)(1, 2, 3);
i := usize(0);
while(i < usize(3), {
  arr(i) = (arr(i) * i32(10));
  i = (i + usize(1));
});
// arr 现在是 [10, 20, 30]。
```

组合器链（`coll.into_iter().map(f)`、`.filter(p)`、`.fold(init, f)` 等）保持值产出的 `Iterator` 形状；一个全覆盖的 `into_iter` 实现 `generic(I), where(I <: Iterator), I, into_iter : (fn(self) -> Self)`（恒等函数）使得 `for(combinator_chain, (x) => body)` 与 `for(coll, (x) => body)` 一致。

借用形式 `for(&mut coll, x => body)` 把每个元素原地交给循环体：写 `x.* = …` 即写入该元素。借用符号写在来源上，元素的模式随之而定。对映射，`for(&mut m, (k, v) => body)` 借出每个值（键为只读）。循环是基于 `(&mut coll).into_iter()` 的值形式：`impl(&mut C, IntoIterator)` 返回的游标在整个循环期间持有对集合的借出，因此循环体只能通过 `x` 触及集合：在循环体中提到集合本身是 E0911。只读遍历 `for(&coll, x => body)`（映射为 `for(&m, (k, v) => body)`）同样作用于 `(&coll).into_iter()`，并把每个元素绑定为只读的 `&` 引用：不复制任何东西，经由 `x` 写入是 E0908，循环体可以读取集合但不能写入它（E0911）。每个 std 集合都支持只读遍历；`HashSet` 与 `PriorityQueue` 没有原地遍历，`String` 两者都没有（请遍历 `s.chars()`）。若要在遍历列表时读取或扩充它，请遍历它的位置：`for(xs.indices(), i => …)` 配合 `xs(i)`。经由 `Rc` 触及的来源写成 `for(&xs.*, …)`（见 [OWNERSHIP_AND_BORROWING.md](./OWNERSHIP_AND_BORROWING.md#迭代)）。

```yo
mut(xs) := ArrayList(i32).new();
xs.push(i32(1));
for(&mut xs, x => {
  x = (x + i32(10));
});
// 现在 xs(usize(0)) 为 11。
```

字符串有专门的 `chars()`（rune 迭代）、`char_indices()`（携带每个 rune
字节偏移的 rune 迭代）和 `bytes()`（字节迭代）方法。字符串索引本身以
**字节**为单位，与 Rust 和 Go 一致：`len()` 以 O(1) 返回字节数，字符串方法
接受和返回的每个索引都是位于 UTF-8 字符边界上的字节偏移。rune 数量用
`s.chars().count()` 获得。完整契约见 [STRINGS.md](./STRINGS.md)。

## 命名规范

使用 2 个空格进行缩进。

- `snake_case`
  - `函数`
  - `变量`
  - 持有整个模块的绑定（`array_list :: import("std/collections/array-list");`）
- `PascalCase`
  - `trait`
  - `类型`及其变体
- `UPPER_SNAKE_CASE`
  - `常量`
- `kebab-case`：所有只作为字符串、从不作为标识符的名字
  - `包名`（`yo.toml` 的 `[package] name` 与依赖键，例如 `markdown-yo`）
  - `.yo` 文件名（`array-list.yo`、`hash-map.test.yo`）
  - `目录名`
  - `[modules]` 键

模块路径只是 `import(...)` 的字符串：没有任何东西从它推导出标识符，因此整条路径使用同一种分隔符（`import("markdown-yo/block-parser")`）。`-` 与 `_` 是不同的名字，不会被互相规范化；名字可以包含 `[A-Za-z0-9_-]`，且不能以 `-` 开头或结尾（`yo check -foo.yo` 会被读成选项）。`check` 与 `compile` 会对名字含 `_` 或大写字母的项目本地模块文件或目录给出警告，`yo fix <path> --module-names` 会重命名它们，并改写指向它们的每个 import、`[modules]` 条目与 `build.yo` 的 root（`ERROR_DIAGNOSTICS.md`）。

## 用 `yo fmt` 格式化

`yo fmt` 有意不提供配置，遵循类似 `go fmt` 的理念：所有 Yo 项目共享一种紧凑、一致的风格，固定使用 2 空格缩进。

当 `yo fmt` 将要改写某个文件时，会先解析原文：解析失败会像词法错误一样报告（直接输出诊断信息并以退出码 1 结束），文件保持原样，因此一次格式化永远不会改写——或掩盖——解析器拒绝的代码。格式已规范的文件不会被解析；解析是否通过仍由 `yo check` 把关。

`yo fmt` 会省略可被证明冗余的括号（省略后必须重新解析出相同的语法树，分组不可能改变才会去掉），并保留所有承载分组的括号。这包括同一运算符链上冗余的左侧括号——无论操作数个数——`(((20 - 5) - 4) - 3)` 会被格式化为 `20 - 5 - 4 - 3`；而显式加括号的右操作数永远保留：`20 - (5 - 4) - 3` 原样不动。

同一条规则还会去掉另外两类括号：包住整个调用参数的括号（`f((a + b))` 变为 `f(a + b)`，因为调用自身的括号已经完成了分组），以及包住单个前缀运算符操作数的括号（`-(x)` 变为 `-x`，`!(done)` 变为 `!done`）。以下括号会保留：加括号的右操作数（`a + (b + c)`）、前缀运算符的复合操作数（`-(x + x)`、`!(a > b)`）、分隔两个不同运算符的括号（`(a * b) + c`），以及 `:=` 或 `=` 右侧二元表达式外的括号——E0003 要求必须有它。`yo fmt` 从不添加括号，所以 E0003 需要的括号要自己写。格式化前后对比：

```yo ignore
// 格式化前
s1 := (((a - b) - c) - x);
s2 := (a + (b + c));
s3 := f((a + b));
s4 := -(x);
s5 := -(x + x);
s6 := ((a * b) + c);
ok := !(done);

// `yo fmt` 之后
s1 := (a - b - c - x);
s2 := (a + (b + c));
s3 := f(a + b);
s4 := -x;
s5 := -(x + x);
s6 := ((a * b) + c);
ok := !done;
```
