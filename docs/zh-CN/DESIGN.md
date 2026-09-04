# 语言设计

**Yo** 是一种多范式、通用、编译型编程语言。
Yo 追求**简洁**与**高效**（性能约为 C 语言的 0% - 15% 以内）。

**Yo** 旨在成为一门对 C 和 JavaScript (TypeScript) 程序员来说**易于学习**的编程语言 😉。

**Yo**（将会且）倾向于支持高级类型系统特性，如广义代数数据类型 (GADT)、依赖类型、细化类型 [设计中](../../plans/backlog/IN_DESIGN.md)。

我们的目标是成为一门易用且易学的实用语言。

<!-- @import "[TOC]" {cmd="toc" depthFrom=2 depthTo=6 orderedList=false} -->

<!-- code_chunk_output -->

- [设计哲学](#设计哲学)
- [灵感来源](#灵感来源)
- [Hello World](#hello-world)
- [CLI 用法](#cli-用法)
- [语法](#语法)
- [类型](#类型)
  - [Type](#type)
    - [原始类型](#原始类型)
    - [编译期已知类型：](#编译期已知类型)
    - [C 兼容类型：](#c-兼容类型)
    - [类型全域：](#类型全域)
    - [复合类型：](#复合类型)
    - [指针类型：](#指针类型)
    - [静态/动态分派类型：](#静态动态分派类型)
    - [值类型 vs 引用语义类型](#值类型-vs-引用语义类型)
  - [变量声明](#变量声明)
    - [禁止变量遮蔽](#禁止变量遮蔽)
  - [类型推断](#类型推断)
    - [未初始化变量](#未初始化变量)
- [函数声明](#函数声明)
  - [命名参数](#命名参数)
  - [默认参数值](#默认参数值)
  - [泛型函数](#泛型函数)
  - [类型约束](#类型约束)
  - [Trait 方法消歧义](#trait-方法消歧义)
  - [使用 `_` 进行偏应用（Partial Application）](#使用-_-进行偏应用partial-application)
  - [类型方法](#类型方法)
  - [recur](#recur)
  - [引用语义类型与内存管理](#引用语义类型与内存管理)
    - [引用语义类型](#引用语义类型)
    - [编译期引用计数优化](#编译期引用计数优化)
- [指针](#指针)
  - [指针操作](#指针操作)
  - [指针算术运算](#指针算术运算)
  - [指针运算符参考](#指针运算符参考)
  - [consume 函数](#consume-函数)
  - [可空指针](#可空指针)
  - [RAII（资源获取即初始化）](#raii资源获取即初始化)
- [元组](#元组)
- [数组与区间](#数组与区间)
  - [使用 `..` 的范围](#使用--的范围)
  - [数组方法](#数组方法)
    - [Array.fill](#arrayfill)
    - [Array.len](#arraylen)
  - [数组长度推断](#数组长度推断)
  - [数组赋值与复制](#数组赋值与复制)
- [控制流](#控制流)
  - [cond](#cond)
  - [if/else](#ifelse)
  - [while](#while)
  - [迭代器与 for 循环](#迭代器与-for-循环)
- [代数数据类型 (ADT)](#代数数据类型-adt)
- [高级类型系统](#高级类型系统)
  - [高阶类型（Higher-Kinded Types，HKT）](#高阶类型higher-kinded-typeshkt)
    - [HKT generic 参数](#hkt-generic-参数)
    - [HKT Trait](#hkt-trait)
    - [使用 HKT where 子句的泛型函数](#使用-hkt-where-子句的泛型函数)
  - [广义代数数据类型（GADTs）](#广义代数数据类型gadts)
    - [GADT 匹配类型细化](#gadt-匹配类型细化)
    - [GADT 穷尽性检查](#gadt-穷尽性检查)
    - [多参数 GADTs](#多参数-gadts)
    - [带自定义判别值的 GADTs](#带自定义判别值的-gadts)
    - [混合 GADT 和普通变体](#混合-gadt-和普通变体)
- [C struct](#c-struct)
- [Newtype](#newtype)
- [C union](#c-union)
- [C enum](#c-enum)
- [Traits](#traits)
- [模式匹配](#模式匹配)
- [字符串](#字符串)
  - [字符串字面量作为 `str` 或 C 字符串指针](#字符串字面量作为-str-或-c-字符串指针)
  - [String（可增长字符串）](#string可增长字符串)
    - [使用 `${}` 语法的模板字符串插值：](#使用--语法的模板字符串插值)
- [集合](#集合)
  - [ArrayList](#arraylist)
  - [HashMap](#hashmap)
  - [HashSet](#hashset)
  - [LinkedList](#linkedlist)
- [闭包](#闭包)
  - [基本闭包语法](#基本闭包语法)
  - [闭包捕获语义](#闭包捕获语义)
  - [闭包类型限制](#闭包类型限制)
  - [闭包与引用语义类型](#闭包与引用语义类型)
- [Box 和装箱](#box-和装箱)
  - [Box 类型](#box-类型)
  - [使用示例](#使用示例)
  - [Box 与赋值](#box-与赋值)
  - [Box 与引用计数](#box-与引用计数)
  - [何时使用 Box](#何时使用-box)
- [Impl 类型](#impl-类型)
  - [基本用法](#基本用法)
  - [Impl 作为返回类型](#impl-作为返回类型)
  - [Impl 与多个 Trait](#impl-与多个-trait)
- [动态分发](#动态分发)
  - [`Dyn` 和 `dyn`](#dyn-和-dyn)
  - [示例](#示例)
- [Impl 与 Dyn 的对比](#impl-与-dyn-的对比)
- [代数效应与处理器](#代数效应与处理器)
- [错误处理](#错误处理)
  - [Result 类型](#result-类型)
  - [Error Trait 和 AnyError](#error-trait-和-anyerror)
  - [Exception（不可恢复异常）](#exception不可恢复异常)
  - [ResumableException](#resumableexception)
- [异步/等待](#异步等待)
- [并行](#并行)
- [隔离类型](#隔离类型)
- [Arc 类型](#arc-类型)
- [模块的导入和导出](#模块的导入和导出)
  - [匿名模块](#匿名模块)
  - [模块级可变变量](#模块级可变变量)
- [命名规范](#命名规范)
- [测试](#测试)
  - [基本测试语法](#基本测试语法)
  - [运行测试](#运行测试)
  - [断言](#断言)
    - [运行时断言](#运行时断言)
    - [编译时断言](#编译时断言)
  - [测试预期错误](#测试预期错误)
  - [测试组织](#测试组织)
  - [使用引用语义类型进行测试](#使用引用语义类型进行测试)
  - [测试文件](#测试文件)
- [元编程](#元编程)
  - [宏函数](#宏函数)
- [派生特征（Derive Traits）](#派生特征derive-traits)
  - [内置派生](#内置派生)
  - [用户自定义派生规则（`derive_rule`）](#用户自定义派生规则derive_rule)
- [类型反射（Type Reflection）](#类型反射type-reflection)
- [编译时求值](#编译时求值)
  - [编译时变量](#编译时变量)
  - [编译时算术](#编译时算术)
  - [编译时数组](#编译时数组)
  - [编译时断言](#编译时断言-1)
  - [编译时预期错误](#编译时预期错误)
  - [编译时与运行时](#编译时与运行时)
  - [编译时求值的优势](#编译时求值的优势)
- [内联汇编](#内联汇编)
- [Index 特征](#index-特征)
- [设计中](#设计中)
- [参考文献](#参考文献)

<!-- /code_chunk_output -->

## 设计哲学

**LLM 友好地编写，人类友好地阅读。** 这两个目标是一致的：一段
LLM 无需依赖作用域链推理就能写出的代码片段，也正是人类审阅者在
diff 中能一眼读懂的代码。设计的关键杠杆是**显式性** —— 每一个
效应、参数、捕获都在调用点直接可见，所见即所运行。

**核心设计原则：**

- **受 Lisp 启发的简洁语法**（无关键字，极简设计）
- **对 LLM 友好的语法**（函数、关键字和前缀运算符调用都必须使用紧贴的括号）
- **一等类型**（类型即值）
- **编译期求值**（强大的 `comptime` 系统）
- **带所有权分析的引用计数**（消除不必要的 RC 操作）
- **基于指针的内存模型**（无引用/借用的复杂性）

**一些"不做"的设计选择：**

- **无运算符优先级**（相同运算符的链左结合；相邻的不同运算符需要显式括号）
- **无变量遮蔽**（类似 Zig）
- **无全局停顿 GC**（可选的线程局部循环收集器，仅用于引用语义类型）

## 灵感来源

**Yo** 语言受到以下编程语言的启发，并吸收了它们的一些优秀理念：

- Lisp
  - [Scheme](https://www.scheme.com/)
  - [Clojure](https://clojure.org/)
- [C](https://www.c-language.org/)/[C++](https://isocpp.org/)
- [Rust](https://www.rust-lang.org/)
- [Haskell](https://www.haskell.org/), [OCaml](https://ocaml.org/), [PureScript](https://www.purescript.org/), [Scala](https://www.scala-lang.org/)
- [JavaScript](https://developer.mozilla.org/en-US/docs/Web/JavaScript), [TypeScript](https://www.typescriptlang.org/)
- [Jai](https://github.com/Ivo-Balbaert/The_Way_to_Jai), [Zig](https://ziglang.org/), [Odin](https://odin-lang.org/)
- [Koka](https://koka-lang.github.io/), [Effekt](https://effekt-lang.org/), [Flix](https://flix.dev/)
- [Nim](https://nim-lang.org/)
- [Dafny](https://dafny.org/)
- [Austral](https://austral-lang.org/)
- [Elixir](https://elixir-lang.org/)
- [Io](https://iolanguage.org/)
- [ATS](https://www.ats-lang.org/)
- [Go](https://go.dev/)
- [Ada](https://www.adacore.com/)
- [hylo](https://www.hylo-lang.org/)
- [Lobster](https://aardappel.github.io/lobster/README_FIRST.html)
- [pony](https://www.ponylang.io/)
- [Swift](https://swift.org/)
- [Vale](https://vale.dev/)

## Hello World

```rust
{ println } :: import("std/fmt");

main :: (fn() -> unit)({
  println("Hello, world!");
});

export(main);
```

## CLI 用法

```bash
yo --help
yo --version

# 项目脚手架
yo init                     # 在当前目录创建新项目
yo init my-project          # 在 ./my-project 创建新项目
yo init my-project --name x # 将项目名设为 "x"

# 构建系统（详见 BUILD_SYSTEM.md）
yo build              # 构建所有产物（默认 "install" 步骤）
yo build run          # 构建并运行可执行文件
yo build test         # 运行测试
yo build --list-steps # 列出可用的构建步骤
yo build --cc zig     # 使用 zig 作为 C 编译器
yo build --target wasm32-unknown-emscripten  # 交叉编译为 WASM（Emscripten）

# 直接编译（单文件，无需 build.yo）
yo compile hello.yo -o hello
yo compile hello.yo --cc clang -o hello
yo compile hello.yo --target wasm32-unknown-emscripten -o hello.html

# 格式化（固定风格，2 空格缩进）
yo fmt                     # 格式化当前目录下所有 .yo 文件
yo fmt src tests           # 格式化 src 和 tests 下的 .yo 文件
yo fmt --check             # 只检查格式，不写入变更
```

完整的构建系统文档请参阅 [BUILD_SYSTEM.md](./BUILD_SYSTEM.md)。

`yo fmt` 有意不提供配置，遵循类似 `go fmt` 的理念：所有 Yo 项目共享一种紧凑、一致的风格，固定使用 2 空格缩进。

## 语法

```rust
// 注释使用 `//` 或 `/* */`
/*
  支持嵌套注释
  /*
    像这样
  */
*/

// Yo 的语法受到 Lisp 的启发，因此没有关键字
// 它只使用原子和函数调用
x // 一个原子（标识符）
func(x, y) // 带两个参数 x 和 y 的函数调用。
           // 注意函数名和括号之间没有空格
           // 不带括号的调用（如 func x, y）是非法的。

// 调用必须使用紧贴的括号。以下写法是非法的：
// func x, y
// func (x, y)

// Yo 区分大小写，所以 `X` 和 `x` 是不同的标识符

// 在 Yo 中，一切都是函数：
x := true;
y :: 14;

// 可以写成：
(:=)(x, true);
(::)(y, 14);
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

## 类型

类型可以具有以下**Kind**：

- Type
  - i32
  - bool
  - ...

### Type

#### 原始类型

- `unit`（unit 类型）
- `bool`（true 或 false）
- `u8`（8 位无符号整数）
- `u16`（16 位无符号整数）
- `u32`（32 位无符号整数）
- `u64`（64 位无符号整数）
- `i8`（8 位有符号整数）
- `i16`（16 位有符号整数）
- `i32`（32 位有符号整数）
- `i64`（64 位有符号整数）
- `f32`（32 位浮点数）
- `f64`（64 位浮点数）
- `usize`（指针大小。在 32 位系统上为 `u32`，在 64 位系统上为 `u64`）
- `isize`（有符号指针大小。在 32 位系统上为 `i32`，在 64 位系统上为 `i64`）

#### 编译期已知类型：

- `comptime_int`（编译期已知的整数类型）
- `comptime_float`（编译期已知的浮点类型）
- `comptime_str`（编译期已知的字符串类型）
- `ComptimeList`（编译期已知的列表类型）
- `Expr`（编译期已知的表达式类型，用于宏和编译期求值）

#### C 兼容类型：

- `char`（C char 类型）
- `short`（C short 类型）
- `ushort`（C unsigned short 类型）
- `int`（C int 类型）
- `uint`（C unsigned int 类型）
- `long`（C long 类型）
- `ulong`（C unsigned long 类型）
- `longlong`（C long long 类型）
- `ulonglong`（C unsigned long long 类型）
- `longdouble`（C long double 类型）
- `void`（C void 类型，主要用于指针，如 `*(void)`）

#### 类型全域：

- `Type`（所有类型的类型）

#### 复合类型：

- 用 `struct(...)` 定义的结构体
- 用 `enum(...)` 定义的枚举 / ADT
- 用 `union(...)` 定义的联合体
- 用 `ref(struct(...))` / `ref(enum(...))` 定义的引用计数引用语义类型（原子变体为 `atomic(ref(struct(...)))` / `atomic(ref(enum(...)))`）
- 固定大小数组：`Array(T, N)` 或 `[T; N]`
- 静态字符串视图：`str`（字符串字面量；只指向静态数据）
- 用 `newtype(...)` 定义的新类型
- 元组：`Tuple(T1, T2, ...)` 或 `(T1; T2; ...)`

#### 指针类型：

- `*(T)`（指向 T 的指针）

#### 静态/动态分派类型：

- `Impl(Trait)`（实现了 Trait 的静态分派类型）
- `Dyn(Trait)`（实现了 Trait 的动态分派类型）

#### 值类型 vs 引用语义类型

**值类型**（栈分配，赋值时复制）：

- 原始类型：`i32`、`bool`、`f32` 等
- 用 `struct(...)` 定义的结构体
- 用 `enum(...)` 定义的枚举 / ADT
- 用 `union(...)` 定义的联合体
- 固定大小数组：`Array(T, N)` 或 `[T; N]`
- 元组：`Tuple(T1, T2, ...)` 或 `(T1; T2; ...)`

**引用语义类型**（堆分配，引用计数）：

- 用 `ref(struct(...))` / `ref(enum(...))` 定义的类型（原子变体为 `atomic(ref(struct(...)))` / `atomic(ref(enum(...)))`）
- 自动循环检测和回收
- 线程亲和性以提升性能（对象留在创建它的线程上）

```rust
// 值类型 - 栈分配，复制语义
Point :: struct(x : i32, y : i32);
p1 := Point(3, 4);
p2 := p1;  // p2 是 p1 的副本

// 引用语义类型 - 堆分配，引用计数
MyString :: ref(struct(
  _bytes : ArrayList(u8)
));
s1 := MyString.from("Hello");
s2 := s1;  // s2 和 s1 指向同一个对象（引用计数）
```

### 变量声明

Yo 中的变量使用 `:=`（运行时）或 `::`（编译期）声明。

```rust
               // "comptime" 在这里表示编译期已知
x := 5;        // x: i32，运行时变量
y :: 5;        // y: comptime_int，编译期变量

// 带显式类型声明
(x : i32) = 5; // x: i32，运行时变量
(comptime(y) : comptime_int) = 5; // y: comptime_int，编译期变量
// 或者
comptime(y) := 5;

// 所有变量默认可变
x := 1;
x = 2;  // OK：允许重新赋值

// (:) 函数用于标注类型
// (=) 函数用于更新变量的值，或用一个值初始化变量
// (:=) 函数用于声明一个类型自动推断的运行时变量
// (::) 函数用于声明一个类型自动推断的编译期变量

x : i32;        // 定义一个运行时变量
comptime(x) : i32; // 定义一个编译期变量
// 所有变量默认可变。为了简洁，没有不可变变量。

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

所有变量默认可变。

> Yo 曾经有一个 `mut` 关键字来标注可变变量，但为了简洁已被移除。

#### 禁止变量遮蔽

Yo 不允许变量遮蔽，以避免混淆

```rust
x := 1;
x := 2; // 错误：x 已经被声明过
```

```rust
x := 1;
{
  x := 2; // 错误：x 已经被声明过
};
```

在不同的块作用域中可以使用相同的变量名：

```rust
{
  x := 1;
}
{
  x := 2; // 允许：不同的作用域
}
```

### 类型推断

```rust
// String 是一个带自动引用计数的引用语义类型
(my_string : String) = String.from("Hello, world"); // 堆分配
my_string_2 := my_string; // 两者指向同一个对象（RC 递增）

// 原始类型是复制的
my_int := 1; // 栈分配
my_int_2 := my_int; // my_int_2 是一个副本

// 固定大小数组是值类型
(my_int_array : Array(i32, 3)) = [1, 2, 3]; // 栈分配
my_int_array := [1, 2, 3]; // Array(i32, 3)

// ArrayList 是一个引用语义类型
(my_array_list : ArrayList(i32)) = ArrayList(i32).new(); // 堆分配，RC

// 枚举/ADT 可以是值类型或引用语义类型，取决于定义方式
Person :: struct(name : String, age : i32); // 值类型（但包含引用语义类型字段）
p := Person(name : String.from("Alice"), age : 30);
_(name, age) := p; // name : String, age : i32
```

#### 未初始化变量

```rust
x : i32; // x : i32，未初始化

// 编译器会阻止使用未初始化的变量。
println(x); // 编译错误：x 未初始化。

x = 1; // x : i32，已初始化
```

## 函数声明

函数使用 `::` 运算符进行编译期定义，或使用 `:=` 作为运行时值。

```rust
// 带显式类型的函数声明
// 函数类型写作 fn(args...) -> return_type
add :: (fn(x : i32, y : i32) -> i32)(
  x + y // 函数体
);
// 用函数体调用函数类型可以创建一个函数值

// 或者先定义类型，再实现
comptime(add) : (fn(x : i32, y : i32) -> i32);
add = _(x + y); // 这里的 `_` 从 `add` 推断函数类型

// 或者用匿名函数定义函数体
add = ((a, b) -> (a + b));  // 类型从用法推断。可以使用不同的参数名

// 带显式返回类型
multiply :: (fn(x : i32, y : i32) -> i32)({
  return((x * y));  // 显式返回
});

// 最后一个表达式即为返回值
divide :: (fn(x : i32, y : i32) -> i32)(x / y);

// 函数可以接受 `comptime` 参数并返回 `comptime` 值，如 Type：
Point :: (fn(comptime(T) : Type) -> comptime(Type))({
  return(struct(
    x : T,
    y : T
  ));
});
I32Point :: Point(i32);
BoolPoint :: Point(bool);

p1 := I32Point(3, 4);
p2 := BoolPoint(true, false);
```

### 命名参数

Yo 中的命名参数必须按照函数签名中定义的顺序提供：

```rust
add :: (fn(x : i32, y : i32) -> i32)
  (x + y)
;

add(3, 4);        // OK：位置参数
add(x: 3, y: 4);  // OK：正确顺序的命名参数
add(3, y: 4);     // OK：混合使用（先位置后命名）
add(y: 4, x: 3);  // 错误：命名参数必须按顺序（x 在 y 之前）
```

### 默认参数值

默认参数值可以使用 `?=` 语法定义：

```rust
create_user :: (fn(
    name: String,
    (age: i32) ?= 18,
  ) -> User)
  User(name: name, age: age)
;

create_user(name: "Alice");  // 使用默认值：age=18
create_user(name: "Bob", age: 30);  // 显式指定 age
```

> 注意：默认参数必须使用编译期已知的值。

### 泛型函数

你可以使用 `generic` 来定义泛型函数：

```rust
identity :: (fn(generic(T : Type), arg : T) -> T)
  arg
;

x := identity(12);     // 类型推断：x: i32
y := identity(true);   // 类型推断：y: bool
```

### 类型约束

你可以使用 `where` 子句在泛型参数上添加类型约束：

```rust
add :: (fn(generic(T : Type), x: T, y: T, where(T <: Add(T))) -> T)
  (x + y)
;
```

`where` 子句可以指定多个约束：

```rust
compare_and_add :: (fn(
    generic(T : Type),
    x: T,
    y: T,
    z: T,
    where(T <: (Add(T), Eq(T)))
  ) -> T)(
  cond(
    (x == y) => (x + z),
    true => (y + z)
  )
);
```

### Trait 方法消歧义

当一个类型实现了多个定义了同名方法的 trait 时，`where` 子句约束决定使用哪个 trait 的方法：

```rust
T1 :: trait(get_number : (fn(self : Self) -> i32));
T2 :: trait(get_number : (fn(self : Self) -> i32));

Point :: struct(x : i32, y : i32);
impl(Point, T1(get_number : (self -> self.x)));
impl(Point, T2(get_number : (self -> self.y)));

// 隐式分派 — where(T <: T1) 约束 self.get_number() 只使用 T1 的方法
use_t1 :: (fn(generic(T : Type), self : T, where(T <: T1)) -> i32)({
  return(self.get_number());  // 返回 self.x (10)
});

// 显式分派 — 使用 (T <: T2).method(self) 语法
use_t2 :: (fn(generic(T : Type), self : T, where(T <: T2)) -> i32)({
  return((T <: T2).get_number(self));  // 返回 self.y (20)
});

point := Point(10, 20);
use_t1(point);  // 10
use_t2(point);  // 20
```

### 使用 `_` 进行偏应用（Partial Application）

多参数类型构造器可以使用 `_` 作为占位符进行偏应用。这会创建一个参数更少的新类型构造器：

```rust
// Result 的 kind 是：(Type, Type) -> Type
// 偏应用固定一个参数：
IntResult :: Result(_, i32);    // kind: Type -> Type
StrOkResult :: Result(str, _);  // kind: Type -> Type

// 像任何类型构造器一样使用：
(r : IntResult(bool)) = .Ok(true);      // = Result(bool, i32)
(r2 : StrOkResult(i32)) = .Err(i32(404)); // = Result(str, i32)
```

偏应用**仅**适用于编译期函数（返回类型为 `comptime` 的函数），不能用于运行时函数。

```rust
// 类型构造器（返回 comptime(Type)）：
IntResult :: Result(_, i32);    // kind: Type -> Type

// 编译期值函数（返回 comptime(i32)、comptime(bool) 等）：
add :: (fn(comptime(x) : i32, comptime(y) : i32) -> comptime(i32))(x + y);
add1 :: add(i32(1), _);  // fn(comptime(y) : i32) -> comptime(i32)
result :: add1(i32(2));   // 3
```

偏应用的类型构造器可以作为 HKT generic 参数使用：

```rust
IntResult :: Result(_, i32);
// IntResult 的 kind 是 Type -> Type，所以可以传递给 F : (Type -> Type)
```

### 类型方法

Yo 支持**类型方法** —— 在类型 trait 中定义的方法。

**方法调用仅适用于：**

1. 在类型自身 trait 中定义的方法
2. 来自已实现 trait 的方法

```rust
// 定义一个带方法的类型
Point :: struct(
  x : i32,
  y : i32
);
impl(Point,
  // 类型方法在结构体 trait 中定义
  distance_from_origin : (fn(self: Self) -> f64)(
    f64(
      sqrt(
        (self.x * self.x) +
        (self.y * self.y)))
  ),

  move_by : (fn(inout(self) : Self, dx : i32, dy : i32) -> unit)({
    self.x = (self.x + dx);
    self.y = (self.y + dy);
  })
);

p := Point(3, 4);
d := p.distance_from_origin();  // 类型方法调用 - OK

p2 := Point(0, 0);
p2.move_by(5, 10);  // `inout(self)` 在 C 中降为 `Self*` — 编译器自动插入 &(p2)
// p2 现在是 Point(5, 10)
```

**`inout` 的自动指针转换：**

`inout(name) : T` 参数在 C 中降为 `T*`。在调用点，Yo 会自动取对应实参的地址，
所以调用方代码看起来就是普通的值传递语法：

```rust
Point :: struct(x : i32, y : i32);
impl(Point,
  set_x : (fn(inout(self) : Self, new_x : i32) -> unit)({
    self.x = new_x;
  })
);

p := Point(3, 4);
p.set_x(10);  // 无需写 `&(p)` — 编译器自动插入
```

### recur

使用 `recur` 来递归调用函数。
这对匿名函数很有用。
如果 `recur` 是最后一个表达式，将应用尾调用优化。

- 带尾调用优化

  ```rust
  (fn(x : u32, acc : u32) -> u32)(
    if(x == 1,
      then: acc,
      else:
        recur(x - 1, acc * x)
    )
  );
  ```

- 不带尾调用优化

  ```rust
  (fn(x : u32) -> u32)(
    if(x == 1,
      then: 1,
      else:
        x * recur(x - 1)
    )
  );
  ```

### 引用语义类型与内存管理

Yo 使用**引用语义类型**，配合[编译期引用计数与所有权和生命周期分析](./COMPILE_TIME_RC_WITH_OWNERSHIP_ANALYSIS.md)来实现安全高效的内存管理。

#### 引用语义类型

引用语义类型是堆分配的类型，带有自动引用计数：

```rust
// 定义一个引用语义类型
MyString :: ref(struct(
  _bytes : ArrayList(u8)
));
impl(MyString,
  // 方法
  from : (fn(s : str) -> Self)({
    // 实现...
  }),

  length : (fn(self : Self) -> usize)({
    // 实现...
  }),

  dispose : (fn(self : Self) -> unit)({
    // 当引用计数降为零时调用 `dispose` 函数
  })
);

// 使用
s1 := MyString.from("Hello");  // RC = 1
s2 := s1;                    // RC = 2（两者指向同一个对象）
s3 := s2;                    // RC = 3
// 当 s1、s2、s3 离开作用域时，RC 递减
// 当 RC 降为 0 时，内存被释放
// 实际上，我们通过所有权分析消除了许多 RC 操作
```

#### 编译期引用计数优化

编译器执行[所有权分析](./COMPILE_TIME_RC_WITH_OWNERSHIP_ANALYSIS.md)以消除不必要的引用计数操作。

详见 [COMPILE_TIME_RC_WITH_OWNERSHIP_ANALYSIS.md](./COMPILE_TIME_RC_WITH_OWNERSHIP_ANALYSIS.md)。

## 指针

Yo 使用指针 (`*(T)`) 进行直接内存访问，类似 C。对原始指针的解引用、算术运算等危险操作需要显式 `unsafe(...)` 包装 — 详见下文 [内存安全](#内存安全)。

```rust
// 指针类型：*(T)
x := 1;
y := 2;

swap :: (fn(a : *(i32), b : *(i32)) -> unit)(unsafe({
  tmp := a.*;  // 解引用指针
  a.* = b.*;
  b.* = tmp;
}));

swap(&(x), &(y));  // 传入 x 和 y 的指针
// 现在 x == 2, y == 1
```

日常的就地修改应优先使用 `inout(name) : T` 参数形式（见[Type Methods](#type-methods)）——它在 C 中降为相同的 `T*` ABI，但保持安全，调用方写成普通的值传递语法（`swap(x, y)`）。原始 `*(T)` 仅保留给 FFI 和本节涉及的底层场景。

### 指针操作

```rust
// 使用 & 运算符创建指针
x := 42;
ptr := &(x);  // ptr: *(i32)

// 使用 .* 解引用（需要 unsafe — 可能读取无效内存）
value := unsafe(ptr.*);  // value == 42

// 通过指针修改（需要 unsafe — 可能写入悬空指针）
unsafe(ptr.* = 100);  // x 现在是 100

// 指针算术（需要 unsafe — 可能产生越界地址）
arr := [1, 2, 3, 4, 5];
ptr := &(arr(0));  // 指向第一个元素的指针
ptr2 := unsafe(ptr.add(2));  // 指向第三个元素
value := unsafe(ptr2.*);  // value == 3

// 指针类型转换（安全 — 只修改地址的类型标签）
float_ptr := *(f32)(ptr);  // 将指针转换为 *(f32)
```

### 指针算术与比较

指针算术使用方法 — `p.add(n)`、`p.sub(n)`、`p.offset_from(q)` — 需要 `unsafe(...)` 包装；指针比较使用普通运算符（`==`、`!=`、`<`、`<=`、`>`、`>=`，经由 `*(T)` 上的 `Eq`/`Ord` impl）并保持安全 — 比较地址本身不会破坏内存安全。注意 `*(T) ==` 比较的是地址（同一性），而引用语义类型通过各自的 `Eq` impl 比较值。

```rust
test("Pointer arithmetic", {
  x := 12;
  p := &(x);

  // 加法和减法（需要 unsafe — 可能产生越界地址）
  q := unsafe(p.add(2));   // 指针前进 2 个元素
  z := unsafe(q.sub(2));   // 指针后退 2 个元素

  // 比较运算符（安全 — 地址只是数据）
  assert(q > p);  // q 在 p 之后
  assert(p < q);  // p 在 q 之前
  assert(q >= p); // 大于等于
  assert(p <= q); // 小于等于
  assert(z == p); // 相等（相同地址）
  assert(p != q); // 不相等

  // 指针差值同样需要 unsafe（假定两指针指向同一对象）
  diff := unsafe(q.offset_from(p));  // 距离：2 个元素
  assert(diff == 2);
});
```

### 指针操作参考

算术（方法，需要 `unsafe(...)`）：

- `p.add(n)` ：前进 `n` 个元素
- `p.sub(n)` ：后退 `n` 个元素
- `p.offset_from(q)` ：带符号的元素距离（`isize`）

比较（普通运算符，经由 `*(T)` 上的 `Eq`/`Ord` impl，安全）：

- `==` / `!=` ：地址相等 / 不等
- `<` / `<=` / `>` / `>=` ：地址排序

### consume 函数

`consume` 告诉编译器你正在初始化内存，而不是覆盖已有的值。这可以防止尝试 drop 未初始化的内存：

```rust
// 不使用 consume - 错误：尝试 drop 未初始化的值
ptr.* = some_value;  // 危险！

// 使用 consume - OK：初始化，不 drop
consume(ptr.* = some_value);
```

更多指针示例请参阅 [ptr.test.yo](../tests/ptr.test.yo)。

### 可空指针

Yo 使用 `Option(*(T))` 来表示可空指针：

```rust
// malloc 返回 Option(*(T))
some_ptr := malloc(sizeof(i32));
match(some_ptr,
  .Some(ptr) => {
    ptr.* = 42;
    printf("value: %d\n", ptr.*);
    free(some_ptr);
  },
  .None => printf("Allocation failed\n")
);
```

**注意**：裸指针是不安全的。请尽可能使用引用语义类型来进行安全的内存管理。

### 内存安全

面向用户的指南见 [MEMORY_SAFETY.md](MEMORY_SAFETY.md) —— 覆盖默认安全的契约、`inout(name)` 参数、`pragma(Pragma.AllowUnsafe);` opt-in、`unsafe(...)` 逐操作包装、`// SAFETY:` 注释约定、`yo unsafe-report`，以及处理有符号整数溢出的 `-fwrapv`。

Yo 的安全模型是分层的（设计计划见 [plans/MEMORY_SAFETY.md](../../plans/MEMORY_SAFETY.md)）：

- **引用语义类型**（`ref(struct(...))` / `ref(enum(...))`）通过引用计数自动释放（RC + 循环回收），从构造上保证内存安全。
- **`Iso(T)` / `Arc(T)`** 分别提供仿射所有权传递和原子 RC 共享所有权。
- **`*(T)` 原始指针**的解引用、算术运算和「穿透指针的 `consume`」操作必须显式包裹在 `unsafe(...)` 中，否则编译报错。

`unsafe(...)` 是一个普通的内建函数调用，接受一个表达式作为参数。它纯粹是编译时标记 — 在代码生成阶段会被还原为其内部表达式，没有运行时开销。

```rust
// 指针解引用需要 unsafe：
read :: (fn(p : *(i32)) -> i32)(unsafe(p.*));

// 指针算术同样：
advance :: (fn(p : *(i32), n : usize) -> *(i32))(unsafe(p.add(n)));

// 多语句 unsafe 用 begin-block 包裹（必须含分号 —
// 不带分号的 `{ ... }` 是结构体字面量，而不是块）：
write_and_read :: (fn(p : *(i32), v : i32) -> i32)(unsafe({
  p.* = v;
  p.*
}));

// 指针比较（==、< 等）和 *(T) 类型转换（如 *(u8)(p)）
// 保持安全 — 它们不解引用，因此不被门控。
```

**需要 `unsafe(...)` 的操作**：指针解引用（`.*`）、指针算术（`.add(n)`、`.sub(n)`、`.offset_from(q)`）、对指针解引用的 `consume(p.* = v)`。

**仍然安全的操作**：取地址（`&(x)`）、传递/存储/返回指针、指针比较（`<`、`==` 等）、指针类型转换（`*(u8)(p)`）、`asm(...)`（本身已经隐式不安全）。

不安全表面是可 grep 的：每个 `unsafe(` token 都标记了一处原始内存操作。文件必须在顶部声明 `pragma(Pragma.AllowUnsafe);` 才能使用 `unsafe(...)` 或执行原始指针操作。`std/`、`src/` 和 `tests/` 下的文件都显式声明了此 pragma；用户代码（`main.yo` 及项目中的其他文件）默认是安全模式，若尝试使用 `unsafe(...)` 将得到编译错误。

如需一目了然地审计，运行 `yo unsafe-report`（或 `yo unsafe-report ./std` 仅扫描标准库）。它列出每一处 `unsafe(...)` 站点、`asm(...)` 块、`extern(...)` 声明以及声明 pragma 的文件，带 `file:line:col` 跳转格式以方便编辑器查看。`--json` 标志输出机器可读格式，便于 CI 集成。

```rust
// 没有 pragma 的文件 — `unsafe(...)` 被拒绝：
main :: (fn() -> unit)({
  x := i32(42);
  v := unsafe(x);   // error: 'unsafe(...)' is not available in safe code.
                    //        To use raw pointer operations, declare at the top:
                    //            pragma(Pragma.AllowUnsafe);
});

// 在文件顶部添加 pragma 即可启用：
pragma(Pragma.AllowUnsafe);

main :: (fn() -> unit)({
  x := i32(42);
  p := &(x);
  v := unsafe(p.*);  // OK
});
```

### `inout` 参数

要在不使用原始指针的情况下实现原地修改，请使用 `inout(name) : T` 参数修饰符。该修饰符包裹参数名（与现有的 `own(name)` 平行），参数行为类似于调用方变量的绑定 — 读取访问当前值，写入更新调用方的存储。在代码生成时 `inout(name) : T` 在 C 中降低为 `T*`；调用方自动传递 `&(arg)`。

```rust
swap :: (fn(inout(a) : i32, inout(b) : i32) -> unit)({
  tmp := a;
  a = b;
  b = tmp;
});

increment :: (fn(inout(n) : i32) -> unit)({
  n = (n + i32(1));
});

main :: (fn() -> unit)({
  x := i32(1);
  y := i32(2);
  swap(x, y);              // 调用点不需要 `&()` 语法
  assert((x == i32(2)), "swapped");
  assert((y == i32(1)), "swapped");

  counter := i32(0);
  increment(counter);
  increment(counter);
  assert((counter == i32(2)), "incremented");
});
```

`inout(...)` 不能与 `own(...)`（相反的调用约定）或 `comptime`/`generic`（`inout` 是运行时专用的）组合使用。对于链式调用，将 `inout` 参数传递给另一个函数的 `inout` 参数按预期工作：

```rust
double :: (fn(inout(n) : i32) -> unit)({
  n = (n + n);
});

double_both :: (fn(inout(x) : i32, inout(y) : i32) -> unit)({
  double(x);  // 将 &x 透传给 double 的 `inout` 参数
  double(y);
});
```

### RAII（资源获取即初始化）

Yo 通过引用计数自动管理引用语义类型的内存。当对象的引用计数降为零时，它会被自动释放。

```rust
test :: (fn() -> unit)({
  x := String.from("World!");  // RC = 1
  // ... 使用 x ...
  // 作用域结束时，RC 递减
  // 如果 RC 降为 0，内存自动释放
}
```

## 元组

元组定义为不同类型元素的序列，用逗号分隔，括号包围。

```rust
my_unit := (); // my_unit: unit.

my_i32_tuple := (12);  // my_i32_tuple: i32
// 需要额外的逗号才能构成元组
my_i32_tuple := (12,); // my_i32_tuple: (i32,). Free type

(i32_tuple: (i32, i32, i32)) = (1, 2, 3); // tuple: (i32, i32, i32). Free type

mixed_tuple := (1, true, "Hello"); // mixed_tuple: (i32, bool, *u8[6,'\0']). Free type

(a, b, c) := mixed_tuple; // a: i32, b: bool, c: *u8[6,'\0']. Free type

a := mixed_tuple.0;
b := mixed_tuple.1;
c := mixed_tuple.2;

// 注意：只有 1 个元素的元组需要加逗号才能成为元组。
MyTuple := (i32)
// 等价于
MyTuple := i32;
// 要使其成为元组，需要加逗号
MyTuple := (i32,);
```

## 数组与区间

```rust
i32_array := [i32;_](1, 2, 3); // i32_array: [i32; 3]
                              // 对应 C 代码：int i32_array[3] = {1, 2, 3};
i32_array.len(); // 3，编译期已知

(i32_array2 : [i32; _]) = [1, 2, 3]; // i32_array2: [i32; 3]
```

Yo 中不存在指向堆的切片类型。可能在底层缓冲区被释放后悬空的视图从构造上就被排除了：

- **区间操作是拷贝。** 在 `ArrayList(T)` 与 `String` 上，`xs(a..b)` 和
  `xs(a..=b)` 会降低为 `slice_copy` / `slice_copy_inclusive`，产生一个
  独立持有的值，而不是源缓冲区上的窗口。
- **`str` 是唯一的内建视图**，且只指向静态字符串数据 —— `str` 上的
  `s(a..b)` 是静态字节上的零拷贝窗口，永远不会悬空。
- **元素访问只交出值，从不交出内部指针** —— `xs.get(i)` 返回元素
  （引用语义类型返回句柄，容器增长后依然有效；struct 类型返回拷贝，用
  `xs(i) = v` 写回），受流动性
  规则约束（见 [FLOWABILITY.md](./FLOWABILITY.md)）。

### 使用 `..` 的区间

```rust
list := ArrayList(i32).new();
list.push(i32(1)); list.push(i32(2)); list.push(i32(3)); list.push(i32(4));

// 元素 1..3（不含端点）的拷贝 —— 一个独立的 ArrayList(i32)
part := list(usize(1)..usize(3));   // [2, 3]

// 含端点变体
part2 := list(usize(1)..=usize(3)); // [2, 3, 4]

// 修改拷贝不影响源
part.set(usize(0), i32(99));
assert(list(usize(1)) == i32(2));
```

### 数组方法

Yo 中的数组自带一些实用方法：

#### Array.fill

创建一个用指定值填充的数组：

```rust
// 运行时填充
zeros := Array(i32, 10).fill(0);  // [0,0,0,0,0,0,0,0,0,0]

// 编译期填充
ones :: Array(i32, 5).fill(1);    // [1,1,1,1,1]
```

#### Array.len

获取数组的长度：

```rust
arr := [1, 2, 3, 4, 5];
len := arr.len();  // 5（定长数组在编译期已知）

// 适用于泛型数组
generic_len :: (fn(comptime(T) : Type, comptime(n) : usize, arr : [T; n]) -> usize)
  arr.len()  // 返回 n
;
```

### 数组长度推断

Yo 可以使用 `_` 来推断数组长度：

```rust
// 从初始化器推断长度
arr1 := Array(i32, _)(1, 2, 3);         // Array(i32, 3)
arr2 := [i32; _](10, 20, 30, 40);       // Array(i32, 4)

// 字面量语法推断长度
arr3 := [1, 2, 3];                      // Array(i32, 3)

// 空数组
empty := Array(i32, _)();               // Array(i32, 0)

// 嵌套数组推断
nested := Array(Array(i32, _), _)(
  Array(i32, _)(1, 2, 3),
  Array(i32, _)(4, 5, 6)
);                                       // Array(Array(i32, 3), 2)
```

**限制**：不能在没有初始化的变量绑定中使用 `_`：

```rust
// 错误：无法推断长度
arr : Array(i32, _);  // 不允许！
arr = [1, 2, 3];

// 正确：使用具体长度或立即初始化
arr := Array(i32, _)(1, 2, 3);  // OK
```

### 数组赋值与复制

数组是值类型，赋值时会复制：

```rust
// 创建数组
arr1 := [1, 2, 3];
arr2 := arr1;       // arr2 是 arr1 的副本

// 修改 arr2
arr2(0) = 10;

assert(arr1(0) == 1);   // arr1 未改变
assert(arr2(0) == 10);  // arr2 已修改

// 赋值返回旧值
arr3 := [5, 6, 7];
old := (arr3 = [8, 9, 10]);

assert(arr3(0) == 8);   // arr3 有了新值
assert(old(0) == 5);    // old 保存了之前的值
```

更多数组示例请参阅 [array.test.yo](../tests/array.test.yo)。

## 控制流

### cond

```rust
use_cond :: (fn(x: i32) -> unit)(
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
`plans/MACRO_POLICY.md`）：

```rust
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

```rust
factorial :: (fn(n: i32) -> i32)({
  result := 1;
  i := 1;
  while(i <= n, {
    result = (result * i);
    i = (i + 1);
  });
  result
});

factorial2 :: (fn(n: i32) -> i32)({
  result := 1;
  i := 1;
  while((i <= n), (i = (i + 1)), {
    result = (result * i);
  });
  result
});
```

### 迭代器与 for 循环

`Iterator` trait 定义了一个值序列。它有一个关联类型 `Item` 和一个 `next` 方法，返回 `Option(Self.Item)`：

```rust
Iterator :: trait(
  Item : Type,
  next : (fn(inout(self) : Self) -> Option(Self.Item))
);
```

要为一个类型实现 `Iterator`，需要提供 `Item` 类型和一个 `next` 函数：

```rust
Counter :: struct(_current : i32, _max : i32);

impl(Counter, Iterator(
  Item : i32,
  next : (self -> cond(
    (self._current >= self._max) => .None,
    true => {
      val := self._current;
      self._current = (self._current + i32(1));
      .Some(val)
    }
  ))
));
```

`IntoIterator` trait 将集合转换为迭代器。它有一个 `where` 子句，约束 `IntoIter` 关联类型必须实现具有匹配 `Item` 类型的 `Iterator`：

```rust
IntoIterator :: trait(
  Item : Type,
  IntoIter : Type,
  into_iter : (fn(self : Self) -> Self.IntoIter),
  where(Self.IntoIter <: Iterator(Item := Self.Item))
);
```

`for` 宏提供了迭代的语法糖。它在循环中调用 `.next()` 并对 `Option` 进行模式匹配：

```rust
// for 循环语法
for(iter_expr, (variable) => {
  // 循环体
});
```

`for` 宏**按值**迭代 —— `for(coll, (x) => body)` 展开为 `coll.into_iter()` 后接标准的 `next()` 循环。对引用语义元素类型，`x` 是指向元素的句柄，在循环体中变异 `x` 即就地变异元素。struct/标量元素的就地变异使用索引循环 + 索引写：

```rust
// 值形式 — 每个 `x` 按值产出。
list := ArrayList(i32).new();
list.push(i32(10));
list.push(i32(20));
for(list, (value) => {
  println(value);
});

// 引用语义元素是句柄 — 变异落在集合里。
for(names, (s) => {
  s.push_str("!");
});

// struct/标量元素：索引写就地变异。
arr := Array(i32, 3)(1, 2, 3);
i := usize(0);
while(i < usize(3), {
  arr(i) = (arr(i) * i32(10));
  i = (i + usize(1));
});
// arr 现在是 [10, 20, 30]。
```

组合器链（`coll.into_iter().map(f)`、`.filter(p)`、`.fold(init, f)` 等）保持值产出的 `Iterator` 形状；一个全覆盖的 `into_iter` 实现 `generic(I), where(I <: Iterator), I, into_iter : (fn(self) -> Self)`（恒等函数）使得 `for(combinator_chain, (x) => body)` 与 `for(coll, (x) => body)` 一致。

旧的借用形式 `for(coll, inout(x) => body)` 已移除（指向可重分配存储的内部引用已无法表达 —— 见 [FLOWABILITY.md](./FLOWABILITY.md)）；使用它会产生带迁移指引的编译错误。

字符串有专门的 `chars()`（rune 迭代）、`char_indices()`（携带每个 rune
字节偏移的 rune 迭代）和 `bytes()`（字节迭代）方法。字符串索引本身以
**字节**为单位，与 Rust 和 Go 一致：`len()` 以 O(1) 返回字节数，字符串方法
接受和返回的每个索引都是位于 UTF-8 字符边界上的字节偏移。rune 数量用
`s.chars().count()` 获得。完整契约见 [STRINGS.md](./STRINGS.md)。

## 代数数据类型 (ADT)

ADT 本质上是另一种记录类型，带有一个隐藏的 `tag` 字段来指示变体类型。

因此，当一个变体的值确定后，我们可以像访问记录字段一样访问该值的字段。

ADT 还有一些优化。例如，如果 ADT 只有一个变体，`tag` 字段将被省略。

此外，如果只有一个变体且只有一个字段，将直接使用字段类型而不是将其包装在记录中。这类似于 Haskell 中的 [newtype](https://wiki.haskell.org/Newtype)。

```rust
Option :: (fn(comptime(T) : Type) -> comptime(Type))
  enum(
    Some(value : T),
    None
  )
;

(none: Option(i32)) = .None;
(some: Option(i32)) = .Some(42);

IpAddr :: enum(
  V4(a : u8, b : u8, c : u8, d : u8),
  V6(v : String)
);

home := IpAddr.V4(127, 0, 0, 1);
loopback := IpAddr.V6(String.from("::1"));

// 使用记录作为变体
Message :: enum(
  Quit,
  Move(x : i32, y : i32),
  Write(v : String),
  ChangeColor(r : i32, g : i32, b : i32)
);

m := Message.Write(String.from("hello"));
m := Message.Move(x: 3, y: 4);
m := Message.ChangeColor(r: 1, g: 2, b: 3);
```

## 高级类型系统

### 高阶类型（Higher-Kinded Types，HKT）

Yo 通过**编译期函数类型作为 Kind**来支持高阶类型。像 `Option` 和 `Result` 这样的类型构造器已经是一等的编译期函数值——HKT 让你可以对它们进行抽象。

| Haskell Kind  | Yo 等价形式                                                    |
| ------------- | -------------------------------------------------------------- |
| `*`           | `Type`                                                         |
| `* -> *`      | `fn(comptime(T) : Type) -> comptime(Type)`                     |
| `* -> * -> *` | `fn(comptime(A) : Type, comptime(B) : Type) -> comptime(Type)` |

#### HKT generic 参数

声明一个具有函数类型 Kind 的 generic 参数来接受类型构造器：

```rust
// F 是一个类型构造器（kind: Type → Type）
identity :: (fn(
  generic(F : (fn(comptime(T) : Type) -> comptime(Type)), A : Type),
  x: F(A)
) -> F(A))(x);

// 使用：
(x : Option(i32)) = .Some(i32(42));
result := identity(generic(Option, i32), x);  // result: Option(i32)
```

#### HKT Trait

定义以类型构造器为参数的 Trait：

```rust
// Functor trait —— F 是一个类型构造器
Functor :: (fn(comptime(F) : (fn(comptime(T) : Type) -> comptime(Type))) -> comptime(Trait))(
  trait(
    map : (fn(generic(A : Type, B : Type), self: F(A), f: (fn(a : A) -> B)) -> F(B))
  )
);

// 为 Option 实现 Functor
impl(generic(A : Type), Option(A), Functor(Option)(
  map : (fn(generic(A : Type, B : Type), self: Option(A), f: (fn(a : A) -> B)) -> Option(B))(
    match(self,
      .Some(v) => .Some(f(v)),
      .None => .None
    )
  )
));

// 使用 trait 方法
(x : Option(i32)) = .Some(i32(42));
result := x.map(generic(i32), (fn(a: i32) -> i32)((a + i32(1))));
// result = .Some(i32(43))
```

#### 使用 HKT where 子句的泛型函数

```rust
do_map :: (fn(
  generic(F : (fn(comptime(T) : Type) -> comptime(Type)), A : Type, B : Type),
  container: F(A),
  f: (fn(a : A) -> B),
  where(F(A) <: Functor(F))
) -> F(B))(
  container.map(generic(B), f)
);

(x : Option(i32)) = .Some(i32(10));
result := do_map(generic(Option, i32, i32), x, (fn(a: i32) -> i32)((a * i32(2))));
// result = .Some(i32(20))
```

### 广义代数数据类型（GADTs）

GADTs 扩展了枚举类型，允许每个构造器通过 `-> recur(Type1, ...)` 指定其返回的精确类型参数实例化：

```rust
Value :: (fn(comptime(T) : Type) -> comptime(Type))(
  enum(
    IntVal(i : i32) -> recur(i32),
    BoolVal(b : bool) -> recur(bool),
    PairVal(a : i32, b : bool) -> recur(i32)
  )
);
```

#### GADT 匹配类型细化

对 GADT 值进行模式匹配时，类型系统会在每个分支中细化类型变量：

```rust
eval_value :: (fn(generic(T : Type), v : Value(T)) -> T)(
  match(v,
    .IntVal(i) => i,      // T 被细化为 i32，返回 i32 ✓
    .BoolVal(b) => b,     // T 被细化为 bool，返回 bool ✓
    .PairVal(a, b) => a   // T 被细化为 i32，返回 i32 ✓
  )
);

v := Value(i32).IntVal(i32(42));
result := eval_value(v);  // result : i32 = 42
```

#### GADT 穷尽性检查

当匹配具有具体类型的 GADT 值时，不可达的变体会从穷尽性检查中排除：

```rust
// Value(i32) 只能是 IntVal 或 PairVal
// BoolVal 不可达（它返回 Value(bool)，而不是 Value(i32)）
eval_int_only :: (fn(v : Value(i32)) -> i32)(
  match(v,
    .IntVal(i) => i,
    .PairVal(a, b) => a
    // 不需要 .BoolVal —— 对于 Value(i32) 它不可达
  )
);
```

#### 多参数 GADTs

```rust
MyPair :: (fn(comptime(A) : Type, comptime(B) : Type) -> comptime(Type))(
  enum(
    MkIntBool(x : i32, y : bool) -> recur(i32, bool),
    MkBoolInt(x : bool, y : i32) -> recur(bool, i32)
  )
);

my_fst :: (fn(generic(A : Type, B : Type), p : MyPair(A, B)) -> A)(
  match(p,
    .MkIntBool(x, y) => x,
    .MkBoolInt(x, y) => x
  )
);
```

#### 带自定义判别值的 GADTs

```rust
Tagged :: (fn(comptime(T) : Type) -> comptime(Type))(
  enum(
    (TagInt(i : i32) -> recur(i32)) = 10,
    (TagBool(b : bool) -> recur(bool)) = 20
  )
);
```

#### 混合 GADT 和普通变体

```rust
MixedVal :: (fn(comptime(T) : Type) -> comptime(Type))(
  enum(
    MInt(i : i32) -> recur(i32),
    MBool(b : bool) -> recur(bool),
    MGeneric(v : T)  // 无 GADT 注解 —— 无约束
  )
);
```

GADTs 具有与普通枚举相同的运行时表示——所有类型细化都纯粹是编译时的。完整设计文档请参阅 [GADTS.md](GADTS.md)。

## C struct

```rust
Point :: struct(x: i32, y: i32);

my_point := Point(
  x: i32(10),
  y: i32(20)
);

```

编译为 C

```c
struct Point {
  int x;
  int y;
};
```

## Newtype

`newtype` 关键字定义一个只有单个字段的结构体，同时可以在一个声明中定义方法、常量和 trait 实现。它提供零开销抽象 —— 在运行时与被包装的类型完全相同，但在编译期是一个独立的类型。这类似于 Haskell 的 `newtype`。

**核心特性：**

- 零运行时开销（无包装分配）
- 通过独立类型实现类型安全
- 内联定义方法和常量
- 定义中包含 trait 实现
- 通过字段名访问被包装的值

**语法：**

```rust
newtype(
  // 只有一个字段
  field_name : FieldType
);
```

**示例：**（见 `std/string/rune.yo`）：

```rust
rune :: newtype(
  c : u32
);
impl(rune,
  // 带验证的构造函数
  from_u32 : ((fn(value: u32) -> Option(Self))
    cond(
      ((value <= u32(0x10FFFF)) && (((value < 0xD800) || (value > 0xDFFF)))) => .Some(Self(c: value)),
      true => .None
    )
  ),

  to_u32 : ((fn(self: Self) -> u32) self.c),

  is_ascii : ((fn(self: Self) -> bool) (self.c <= 0x7F)),

  // 常量
  NUL        : Self(c: 0x00),
  TAB        : Self(c: 0x09),
  NEWLINE    : Self(c: 0x0A),
  SPACE      : Self(c: 0x20)
);
```

**使用场景：**

- 类型安全的 ID（UserId、OrderId 等）
- Unicode 字符（rune 包装 u32）
- 度量单位（Meters、Seconds、Dollars）
- 带验证的类型（Email、PhoneNumber、PositiveInt）
- 语义区分（Username vs Password）

**内存布局：**

```rust
UserId :: newtype(value : i32);
// sizeof(UserId) == sizeof(i32)
// 对应 C 代码：就是一个 i32，运行时没有结构体包装
```

## C union

```rust
MyNumber := union(
  i : i32,
  j : f32
);
(my_number : MyNumber) = MyNumber(i : 10);
my_number.j = 1.2;
```

编译为 C

```c
union MyNumber {
  int i;
  float j;
};
```

## C enum

与 ADT 相同，但所有变体都没有字段。

```rust
State := enum(
  Working,
  Failed
);
Week := enum(
  Monday, // 0
  Tuesday, // 1
  Wednesday // 2
);

day := Week.Wednesday;
printf("%d", day); // 2
```

## Traits

Trait 定义了一组可以为类型实现的函数和类型集合。它们的工作方式类似于 Rust 中的 trait。注意，`impl` 的第一个参数是接收者类型，后跟 trait 实现。

Trait 被定义为一个返回 `Trait` 类型的函数，其中包含字段定义。

```rust
// 定义一个 trait（类似于 Rust 中的 trait）
Summary :: trait(
  summarize : (fn(inout(self) : Self) -> String)
);

Display :: trait(
  display : (fn(inout(self) : Self) -> String),
  where(Self <: Summary) // 约束
);

NewsArticle :: struct(
  headline : String,
  location : String,
  author   : String,
  content  : String
);

// 为 NewsArticle 实现 Summary trait
impl(NewsArticle, Summary(
  summarize : ((self) ->
    `${self.headline}, by ${self.author} (${self.location})`
  )
));

// 为 NewsArticle 实现 Display trait
impl(NewsArticle, Display(
  display : ((self) ->
    `Headline: ${self.headline}\n`
  )
));

// 传入函数
notify :: (fn(inout(item) : NewsArticle) -> unit)({
  println(`Breaking news! ${item.summarize()}`);
});

// 带 trait 约束的泛型函数
notify2 :: (fn(generic(T : Type), inout(item) : T, where(T <: Display)) -> unit)({
  println(`Breaking news! ${item.summarize()}`);
  println(`Breaking news! ${item.display()}`);
});
```

## 模式匹配

编译器会对模式匹配进行穷尽性检查。

```rust
Coin :: enum(
  Penny,
  Nickel,
  Dime,
  Quarter
);

// 参考：
// - https://doc.rust-lang.org/book/ch06-02-match.html
// - https://github.com/tc39/proposal-pattern-matching
value_in_cents :: (fn(coin: Coin) -> u8)(
  match(coin,
    .Penny => {
      printf("Lucky penny!\n");
      1
    },
    .Nickel => 5,
    .Dime => 10,
    .Quarter => 25
  )
);

Shape :: enum(
  Circle(r : i32),
  Rectangle(w : i32 , h: i32)
);

area :: (fn(shape: Shape) -> i32)(
  match(shape,
    .Circle(r) => (i32(3) * (r * r)),
    .Rectangle(w, h) => (w * h)
  )
);
```

## 字符串

### 字符串字面量作为 `str` 或 C 字符串指针

```rust
s := "Hello"; // s : str —— 字符串字面量就是内建的静态字符串视图 `str`。
(s2 : *(u8)) = "Hi"; // 可以显式声明一个 C 字符串指针。
s3 := *(u8)("Hi"); // 或使用指针类型转换获取 C 字符串指针。
```

### String（可增长字符串）

堆分配的可增长 UTF-8 字符串，与 Rust 的 `String` 形态一致。它**不是**不可变的：
`push_str`、`push_string`、`push_byte`、`reserve` 和 `clear` 接受 `inout(self)`
并就地修改；而 `+` 之类的运算符仍然产生新字符串。

若需要不可变、使用原子引用计数、可安全跨线程共享的字符串，请参阅 `std/imm/string`
——它的所有"修改"方法都返回新值。

```rust
s := String.new();
s2 := String.from("Hello World!");
s3 := (s + s2); // 创建一个新字符串。
```

#### 使用 `${}` 语法的模板字符串插值：

模板字符串的工作方式类似于 JavaScript 的模板字面量，允许你使用 `${}` 语法在字符串中嵌入表达式。`${}` 内的值必须实现 `ToString` trait 才能被转换为 `String`。

```rust
name := "Alice";
age := 16;
greeting := `Hello, ${name}!, age: ${age}`;
// greeting: String
// 值为 "Hello, Alice!, age: 16"
```

##### 格式说明符 —— `${value:spec}`

插值可以在冒号后带一个格式说明符，语法与 Rust、Python 一致（不支持动态宽度与精度）：

```text
spec  := [[fill]align][+][#][0][width][.precision][kind]
align := "<" | ">" | "^"
kind  := "x" | "X" | "b" | "o"
```

```rust
name := `ada`;
n := i32(255);
pi := f64(3.14159);

`[${name:>8}]`    // "[     ada]"   右对齐至宽度 8
`[${name:<6}]`    // "[ada   ]"     左对齐
`[${name:^7}]`    // "[  ada  ]"    居中
`[${name:*>6}]`   // "[***ada]"     自定义填充字符
`${n:x}`          // "ff"           小写十六进制
`${n:#06x}`       // "0x00ff"       替代形式并补零
`${pi:.2}`        // "3.14"         保留两位小数
`${pi:>8.3}`      // "   3.142"     宽度在精度之后生效
```

宽度以**字符**计。数字补零时，零位于符号或进制前缀与数字之间——`${i32(-(42)):08}`
得到 `-0000042`，而非 `000-0042`。

任何实现了 `ToString` 的值都支持宽度、填充、对齐与截断；数字另外支持符号、进制与补零。

说明符与表达式之间以冒号分隔，且**冒号前不能有空格**。带空格的冒号不会被拆分，因此插值中
普通的冒号对保持原义；位于调用参数或字符串字面量内部的冒号——如 `${parts.join(":")}`
——也绝不会被误判为分隔符。

## 集合

完整的集合类型及其 API 请参阅 [std/collections](../std/collections)。

Yo 在标准库中提供了高效的、引用计数的集合类型。

### ArrayList

支持自动扩容的动态数组。

```rust
{ ArrayList } :: import("std/collections/array_list");

// 创建新的 ArrayList
list := ArrayList(i32).new();

// 添加元素
list.push(i32(42));
list.push(i32(100));
list.push(i32(200));

printf("Length: %zu\n", list.length());
printf("Capacity: %zu\n", list.capacity());

// 通过索引获取元素
first := list.get(usize(0));
match(first,
  .Some(value) => printf("First element: %d\n", value),
  .None => printf("No first element\n")
);

// 设置元素
list.set(usize(1), i32(150));

// 弹出元素
popped := list.pop();
match(popped,
  .Some(value) => printf("Popped: %d\n", value),
  .None => printf("List is empty\n")
);

// 以初始容量创建
list2 := ArrayList(i32).with_capacity(usize(10));

// 清空并收缩
list.clear();
list.shrink_to_fit();
```

### HashMap

键值对哈希映射。

```rust
{ HashMap } :: import("std/collections/hash_map");

// 创建新的 HashMap
map := HashMap(i32, i32).new();

// 插入键值对
result := map.insert(i32(1), i32(100));
match(result,
  .Ok(opt) => match(opt,
    .None => printf("Inserted new key\n"),
    .Some(old_val) => printf("Updated, old value: %d\n", old_val)
  ),
  .Error(_) => printf("Insert failed\n")
);

// 获取值
value_opt := map.get(i32(1));
match(value_opt,
  .Some(v) => printf("Value: %d\n", v),
  .None => printf("Key not found\n")
);

// 检查键是否存在
cond(
  (map.has(i32(1))) => printf("Contains key 1\n"),
  true => printf("Does not contain key 1\n")
);

// 删除键
removed := map.remove(i32(1));
match(removed,
  .Some(v) => printf("Removed value: %d\n", v),
  .None => printf("Key not found\n")
);

// 检查长度和是否为空
printf("Length: %zu\n", map.length());
cond(
  (map.is_empty()) => printf("Map is empty\n"),
  true => printf("Map is not empty\n")
);

// 清空映射
map.clear();
```

### HashSet

用于唯一值的哈希集合。

```rust
{ HashSet } :: import("std/collections/hash_set");

// 创建新的 HashSet
set := HashSet(i32).new();

// 插入元素
result := set.insert(i32(42));
match(result,
  .Ok(was_new) => cond(
    was_new => printf("Inserted new element\n"),
    true => printf("Element already exists\n")
  ),
  .Error(_) => printf("Insert failed\n")
);

// 检查是否包含
cond(
  (set.has(i32(42))) => printf("Contains 42\n"),
  true => printf("Does not contain 42\n")
);

// 删除元素
removed := set.remove(i32(42));
cond(
  removed => printf("Removed element\n"),
  true => printf("Element not found\n")
);

// 集合运算
set1 := HashSet(i32).new();
set2 := HashSet(i32).new();

set1.insert(i32(1));
set1.insert(i32(2));
set1.insert(i32(3));

set2.insert(i32(2));
set2.insert(i32(3));
set2.insert(i32(4));

// 并集
union_result := set1.union(set2);
match(union_result,
  .Ok(union_set) => printf("Union size: %zu\n", union_set.length()),
  .Error(_) => printf("Union failed\n")
);

// 交集
inter_result := set1.intersection(set2);
match(inter_result,
  .Ok(inter_set) => printf("Intersection size: %zu\n", inter_set.length()),
  .Error(_) => printf("Intersection failed\n")
);

// 子集检查
is_sub := set1.is_subset(set2);
cond(
  is_sub => printf("set1 is subset of set2\n"),
  true => printf("set1 is not subset of set2\n")
);
```

### LinkedList

双向链表。

```rust
{ LinkedList } :: import("std/collections/linked_list");

// 创建新的 LinkedList
list := LinkedList(i32).new();

// 从前端和后端添加
list.push_front(i32(1));
list.push_back(i32(2));
list.push_front(i32(0));

printf("Length: %zu\n", list.len());

// 访问前端和后端
match(list.front(),
  .Some(v) => printf("Front: %d\n", v),
  .None => printf("List is empty\n")
);

match(list.back(),
  .Some(v) => printf("Back: %d\n", v),
  .None => printf("List is empty\n")
);

// 从前端和后端弹出
match(list.pop_front(),
  .Some(v) => printf("Popped front: %d\n", v),
  .None => printf("List is empty\n")
);

match(list.pop_back(),
  .Some(v) => printf("Popped back: %d\n", v),
  .None => printf("List is empty\n")
);

// 通过索引获取
match(list.get(usize(0)),
  .Some(v) => printf("At index 0: %d\n", v),
  .None => printf("Index out of bounds\n")
);

// 在索引位置插入
match(list.set(usize(1), i32(20)),
  .Ok(_) => printf("Inserted at index 1\n"),
  .Error(err) => match(err,
    .IndexOutOfBounds => printf("Index out of bounds\n"),
    .EmptyList => printf("List is empty\n")
  )
);

// 按索引删除 —— remove(idx) 直接返回被删除的元素，索引越界会 panic
// （与 Index 实现的约定一致）；按范围删除并取回元素用
// drain(start .. end)，它返回一个全新的 ArrayList。不消耗列表的迭代用
// iter()，into_iter() 会转移列表所有权。
removed := list.remove(usize(0));
printf("Removed: %d\n", removed);
drained := list.drain(usize(1) .. usize(3));

// 检查是否包含
cond(
  (list.has(i32(20))) => printf("Contains 20\n"),
  true => printf("Does not contain 20\n")
);

// 反转链表
list.reverse();

// 清空
list.clear();
assert(list.is_empty(), "List should be empty");
```

## 闭包

Yo 支持闭包（捕获其所在环境的匿名函数）。

闭包会被编译成一个保存所捕获变量的**捕获结构体**。它如何存储与调用，取决于所标注的类型：

- **`Impl(Fn(...))` —— 静态分发，不做引用计数。** 编译器会将闭包单态化为独立函数，捕获结构体**按值传递**，并生成直接调用：没有堆分配、没有虚表、也没有引用计数。每个闭包都有各自不同的类型（参见 [Closure Type Restrictions](#closure-type-restrictions)），因此这种形式无法用同一个变量持有两个不同的闭包。
- **`Dyn(Fn(...))` —— 动态分发，进行引用计数。** 捕获结构体被装箱到堆上，其前部带有引用计数头，值本身是 `{data, vtable}` 的胖指针。当不同类型的闭包需要共享同一类型时使用它——例如存入集合、从不同分支返回，或接受任意可调用对象。在闭包外层写 `dyn(...)` 完成转换。

两种形式下，**被捕获的值**都遵循一般规则：被捕获的引用语义值由该捕获结构体持有，并在其销毁时释放。

更多闭包示例和用法请参阅 [closure.test.yo](../tests/closure.test.yo)。

### 基本闭包语法

创建闭包有两种方式：

1. **使用 `Impl(Fn(...))`** — 显式闭包类型：

```rust
test_closure :: (fn() -> unit)({
  x := 1;

  // 使用 Impl 的显式闭包类型
  (closure : Impl(Fn(y : i32) -> i32)) = ((y) => {
    x = (x + y);
    return(x);
  });

  closure(1); // x 现在是 2
  closure(1); // x 现在是 3
  result := closure(2); // x 现在是 5

  assert(result == 5);
});
```

2. **使用 `ClosureType({...})`** — 从类型创建闭包值：

```rust
test_closure :: (fn() -> unit)({
  x := 1;

  ClosureType :: Impl(Fn(y : i32) -> i32);
  closure := (ClosureType {
    x = (x + y);
    return(x);
  });

  result := closure(2);
  assert(result == 3);
});
```

### 闭包捕获语义

闭包从其环境中捕获变量：

- **值类型**（基本类型、结构体）按值捕获（复制）
- **引用语义类型**（引用计数类型）按引用捕获
- 被捕获的变量保持其可变性

```rust
test_capture :: (fn() -> unit)({
  // 值类型 — 按值捕获
  counter := 0;

  // 引用语义类型 — 按引用捕获
  data := Box(i32)(42);

  closure := ((increment : i32) => {
    counter = (counter + increment);  // 修改本地副本
    data.* = (data.* + increment);     // 修改共享对象
    return(counter);
  });

  closure(5);
  // counter 仍然是 0（闭包有自己的副本）
  // data.* 现在是 47（共享引用）
});
```

### 闭包类型限制

每个闭包都有唯一的类型，即使它们看起来完全相同：

```rust
// 这将失败 — 每个闭包都有不同的类型
test_error :: (fn() -> unit)({
  closure : Impl(Fn(y : i32) -> i32);

  cond(
    some_condition() => {
      a := 1;
      closure = ((y) => (y + a));  // 类型 1
    },
    true => {
      b := 1;
      closure = ((y) => (y + b));  // 类型 2 — 不同！
    }
  );
  // 错误：即使两个闭包完全相同，它们的类型也不同
});
```

### 闭包与引用语义类型

闭包可以与引用语义类型无缝配合使用：

```rust
MyBox :: ref(struct(
  (*) : i32
));

make_incrementer :: (fn(start : MyBox) -> Impl(Fn() -> i32))({
  return((unit) => {
    start.* = (start.* + 1);
    return(start.*);
  });
});

test :: (fn() -> unit)({
  counter := MyBox(0);
  inc := make_incrementer(counter);

  assert(inc(()) == 1);
  assert(inc(()) == 2);
  assert(counter.* == 2);
});
```

更多示例请参阅 [closure.test.yo](../tests/closure.test.yo)。

## Box 和装箱

Yo 提供了 `Box` 和 `box` 用于将值类型堆分配并自动进行引用计数。

### Box 类型

`Box(T)` 是一个泛型引用语义类型，可以包装任何值类型：

```rust
// Box 定义在 std/prelude.yo 中
Box :: (fn(comptime(V) : Type) -> comptime(Type))(
  ref(struct(
    (*) : V
  ))
);

// box 函数创建一个 Box
box :: (fn(generic(V : Type), value : V) -> Box(V))(
  Box(V)(value)
);
```

### 使用示例

```rust
// 装箱一个基本值
i := box(42);              // i: Box(i32)
assert(i.* == 42);         // 使用 .* 解引用

// 装箱一个结构体
Point :: struct(x: i32, y: i32);
p := box(Point(3, 4));     // p: Box(Point)
assert(p.*.x == 3);

// 使用显式类型的 Box
b := Box(i32)(100);        // 等同于 box(100)

// 修改装箱的值
m := box(10);
m.* = 20;
assert(m.* == 20);
```

### Box 与赋值

```rust
test("Box assignment behavior", {
  x := box(1);
  y := (x = box(2));  // y 获得旧值

  assert(x.* == 2);   // x 现在指向新的 Box
  assert(y.* == 1);   // y 持有旧的 Box
});
```

### Box 与引用计数

`Box(T)` 是引用语义类型，因此使用自动引用计数：

```rust
test("Box reference counting", {
  original := box(42);
  copy := original;        // 引用计数递增
  another := copy;         // 引用计数递增

  // 三者都指向同一个 Box
  assert(original.* == 42);
  original.* = 100;
  assert(copy.* == 100);   // 共享的！
  assert(another.* == 100);

  // 变量离开作用域时引用计数递减
});
```

### 何时使用 Box

- **堆分配**：当你需要将值类型放在堆上时
- **共享可变性**：对同一可变值的多个引用
- **动态分发**：将值类型装箱以便与 `Dyn` 一起使用
- **递归类型**：打破类型定义中的循环

```rust
// 动态分发需要引用语义类型
impl(i32, SomeTrait(...));

// 值类型必须装箱才能用于 Dyn
use_dyn :: (fn(value: Dyn(SomeTrait)) -> unit)({ ... };

// 将 i32 装箱以用于 Dyn
use_dyn(dyn box(42));
```

## Impl 类型

`Impl(TraitName)` 创建一个表示实现了指定 trait 的任意类型。这类似于 Rust 中的 `impl Trait`。

### 基本用法

```rust
// 定义一个 trait
Id :: trait(
  id : (fn(self : Self) -> Self)
);

// 接受任何实现了 Id 的类型的函数
use_id :: (fn(
  generic(T : Type),
  value : T,
  where(T <: Id)
) -> T)({
  return(value.id());
});

// 为 i32 实现 Id
impl(i32, Id(
  id : ((self) -> {
    printf("i32: %d\n", self);
    return(self);
  })
));

// 使用
result := use_id(42);  // 打印 "i32: 42"，返回 42
```

### Impl 作为返回类型

`Impl` 可以在返回类型中用于静态分发：

```rust
RetI32 :: trait(
  return_i32 : (fn(inout(self) : Self) -> i32)
);

get_value :: (fn(use_bool : bool) -> Impl(RetI32))({
  cond(
    use_bool => return(true),   // bool 实现了 RetI32
    true => return(i32(42))      // i32 实现了 RetI32
  )
});
```

**重要提示**：每个返回路径必须返回一个具体类型，而不是恰好实现了相同 trait 的不同类型。

### Impl 与多个 Trait

```rust
Speak :: trait(
  speak : (fn(self : Self) -> unit)
);

Run :: trait(
  run : (fn(self : Self) -> unit)
);

// 类型必须同时实现 Speak 和 Run
perform :: (fn(
  generic(T : Type),
  actor : T,
  where(T <: (Speak, Run))
) -> unit)({
  actor.speak();
  actor.run();
});
```

## 动态分发

详细的动态分发文档请参阅 [DYN_DESIGN.md](./DYN_DESIGN.md)，了解 `Dyn` 和 `dyn` 的完整说明。

### `Dyn` 和 `dyn`

使用 `Dyn` 定义动态分发类型，该类型可以持有任何实现了指定 trait 的对象。使用 `dyn()` 函数从对象创建 `Dyn` 实例。

Yo 中的 `Dyn` 类型是引用计数的，与其他引用语义类型一样，它们通过 trait 对象实现动态分发。闭包同样如此：`Dyn(Fn(...))` 闭包会被装箱到堆上并进行引用计数，而 `Impl(Fn(...))` 形式则被单态化、按值传递，自身不带引用计数。

**主要特性：**

- 自动引用计数
- 无需 `&` 运算符 — 它们就是对象
- 自动内存管理
- 支持多个 trait 约束

### 示例

```rust
Speak :: trait(
  speak: (fn(self : Self) -> i32)
);

Run :: trait(
  run: (fn(self : Self) -> i32)
);

// 必须是引用语义类型才能与 Dyn 配合使用
Dog :: ref(struct());

DogSpeak :: impl(Dog, Speak(
  speak: ((self: Self) -> {
    printf("Woof!\n");
    return(1);
  })
));

DogRun :: impl(Dog, Run(
  run: ((self: Self) -> {
    printf("The dog is running!\n");
    return(2);
  })
));

// Dyn 类型是引用计数的 — 不需要 &
act :: (fn(s: Dyn(Speak, Run)) -> i32)
  (s.speak() + s.run())
;

main :: (fn() -> i32)({
  dog := Dog();
  // dyn() 创建一个引用计数的 trait 对象
  result := act(dyn(dog));
  return(result);
});
```

**注意：** `Dyn` 类型内部是引用计数的对象，提供自动内存管理，无需手动处理指针。

## Impl 与 Dyn 的对比

- **Impl**：静态分发，编译时多态，无运行时开销
- **Dyn**：动态分发，运行时多态，需要引用语义类型

```rust
// Impl — 静态分发（单态化）
use_impl :: (fn(generic(T), value: T, where(T <: SomeTrait)) -> unit)({
  value.method();  // 静态分发
});

// Dyn — 动态分发（虚函数表）
use_dyn :: (fn(value: Dyn(SomeTrait)) -> unit)({
  value.method();  // 动态分发
});
```

更多示例请参阅 [impl.test.yo](../tests/impl.test.yo)。

## 代数效应与处理器

Yo 支持**代数效应** — 一次性定界续延（one-shot delimited
continuations）。处理器的类型是专门的**控制函数**类型
`ctl(args) -> ret`（与 `fn(args) -> ret` 并列），作为常规函数参数
在每次调用时显式传递。

1. **控制函数类型 (`ctl`)**：处理器值的类型是 `ctl(args) -> ret`。
   其体可以使用 `unwind(value)` 丢弃续延，或 `return(value)` 恢复
   续延。普通 `fn(args) -> ret` 体内不允许 `unwind`。
2. **效应参数是显式的**：需要效应的函数把处理器作为常规参数接收
   （`raise : Raise`）。调用方在每次调用时显式传递处理器。

效应可以与 `async`/`await` 组合使用：`io.async` 任务内部的处理器
能够正确工作。如果在异步任务中调用了 `unwind`，该 Future 会被标记
为已逃逸，等待它会导致 panic。

详细文档请参阅 [ALGEBRAIC_EFFECTS.md](./ALGEBRAIC_EFFECTS.md)。

## 错误处理

Yo 提供了两种错误处理方式：

1. **Result ADT** — 使用模式匹配的显式 `Result(T, E)` 值
2. **Exception / ResumableException** — 基于代数效应的异常式控制流

### Result 类型

`Result` 类型是一个代数数据类型，用于可能失败的函数：

```rust
// 定义一个错误类型
DivisionError :: enum(
  DivideByZero,
  Overflow
);

// 可能失败的函数
safe_div :: (fn(a: i32, b: i32) -> Result(i32, DivisionError))(
  cond(
    (b == i32(0)) => .Error(.DivideByZero),
    true => .Ok((a / b))
  )
);

// 使用模式匹配处理错误
result := safe_div(10, 2);
match(result,
  .Ok(value) => printf("Result: %d\n", value),
  .Error(error) => match(error,
    .DivideByZero => printf("Error: Cannot divide by zero\n"),
    .Overflow => printf("Error: Overflow\n")
  )
);
```

### Error Trait 和 AnyError

标准库定义了用于动态错误处理的 `Error` trait 和 `AnyError` 类型：

```rust
open(import("std/error"));

// Error trait 要求实现 ToString。自定义错误类型需同时实现两者：
MathError :: enum(
  DivisionByZero,
  NegativeSqrt
);
impl(MathError, ToString(
  to_string : ((self) -> match(self,
    .DivisionByZero => `Division by zero`,
    .NegativeSqrt => `Square root of a negative number`
  ))
));
impl(MathError, Error());

// AnyError 是 Dyn(Error) — 任何实现了 Error 的类型都可以被包装：
(err : AnyError) = dyn(MathError.DivisionByZero);

// 向下转型回具体类型：
match(downcast(err, MathError),
  .Some(math_err) => printf("Got MathError\n"),
  .None => printf("Not a MathError\n")
);
```

### Exception（不可恢复异常）

`Exception` 是用于不可恢复异常处理的效应捆绑。它的 `throw` 字段
是一个 `ctl(...) -> ret` 处理器 — 调用 `unwind(...)` 会丢弃续延，
从外围函数返回：

```rust
open(import("std/error"));

safe_divide :: (fn(x: i32, y: i32, exn : Exception) -> i32)(
  cond(
    (y == i32(0)) => exn.throw(dyn(MathError.DivisionByZero)),
    true => (x / y)
  )
);

// 安装处理器 — 注意 lambda 外层的括号（Yo 没有运算符优先级）。
(exn : Exception) = Exception(
  throw : (
    (err) -> {
      println(`Error: ${err}`);  // 打印 "Error: Division by zero"
      unwind(());                // 丢弃续延，从外围函数返回
    }
  )
);

result := safe_divide(6, 3);     // result = 2
safe_divide(10, 0, exn);         // 处理器触发，unwind — 之后的代码不会执行
```

### ResumableException

`ResumableException(ResumeType)` 用于可恢复异常处理。当处理器调用
`return` 时，它会以恢复值恢复续延：

```rust
open(import("std/error"));

safe_divide :: (fn(x: i32, y: i32, exn : ResumableException(i32)) -> i32)(
  cond(
    (y == i32(0)) => exn.throw(dyn(`division by zero`)),
    true => (x / y)
  )
);

(exn : ResumableException(i32)) = ResumableException(i32)(
  throw : (
    (err) -> {
      println(`Error: ${err}`);
      return(i32(0));  // 以恢复值 0 恢复续延
    }
  )
);

result := safe_divide(6, 3, exn);    // result = 2
result2 := safe_divide(10, 0, exn);  // 处理器以 0 恢复续延，result2 = 0
```

更多示例请参阅 [error.test.yo](../tests/error.test.yo)。

## 异步/等待

Yo 使用**基于状态机转换的 async/await** 实现高效的**单线程并发**。异步任务是**惰性的** — 它们在被显式等待或加入之前不会开始执行。

```rust
{ yield } :: import("std/async");

main :: (fn(io : Io) -> unit)({
  task1 := io.async((io : Io)=> {
    io.await(yield());
    return(i32(1));
  });
  task2 := io.async((io : Io)=> {
    io.await(yield());
    return(i32(2));
  });
  handle1 := io.spawn(task1);  // 启动 task1，返回 JoinHandle(i32)
  handle2 := io.spawn(task2);  // 启动 task2，返回 JoinHandle(i32)
  r1 := handle1.await(io);  // 等待 → Option(i32)
  r2 := handle2.await(io);
});
export(main);
```

关键特性：

- `io.async(fn)` 创建一个**冷 Future** — 函数体在被等待或启动之前不会执行
- `io.await(future)` 启动一个冷 Future 并运行至完成；可以对同一个 Future **多次调用**
- `io.spawn(future)` 启动一个冷 Future 而不等待，返回 `JoinHandle(T)`
- `handle.await(io)` 等待一个已启动的任务，返回 `Option(T)` — 逃逸（中止）时返回 `.None`
- 所有异步代码运行在**同一线程**上（无线程创建，无数据竞争）

详细文档请参阅 [ASYNC_AWAIT.md](./ASYNC_AWAIT.md)。

## 并行

关于 Yo 中的并行编程详情，请参阅 [PARALLELISM.md](./PARALLELISM.md)。

## 隔离类型

关于隔离类型的详情，请参阅 [ISOLATED.md](./ISOLATED.md)。

## Arc 类型

`Arc(T)` 提供**共享所有权**并使用原子引用计数。它不再是编译器内置类型，
而是在 `std/prelude.yo` 中被定义为一个薄包装的 `atomic(ref(struct(...)))`。
`Arc(T)` 要求 `T <: Send`，因此它只包装可安全跨线程共享的值。
当你想共享单个值时使用 `Arc(T)`；当你想定义自己的共享类型时使用
`atomic(ref(struct(...)))`。

```rust
// 使用 arc() 辅助函数创建
shared := arc(i32(42));

// 使用 .(*) 解引用（借用，只读）
val := shared.(*);          // val == 42

// 复制会递增引用计数
copy := shared;             // 引用计数：1 → 2

// 跨线程共享
{ Thread } :: import("std/thread");
shared := arc(i32(42));
t := Thread.spawn((io) => {
  assert((shared.(*) == i32(42)), "thread sees shared value");
});
t.join();
assert((shared.(*) == i32(42)), "main still sees shared value");
```

完整详情请参阅 [ARC.md](./ARC.md)。

## 模块的导入和导出

```rust
// module1.yo
test :: (fn() -> unit)({
  println("Hello, world!");
});
export(test);

// module2.yo
// 导出类型
Option :: (fn(comptime(T): Type) -> comptime(Type))(
  enum(
    Some(value : T),
    None
  )
);
export(Option);
```

```rust
open(import("./test.yo")); // 从 test.yo 导入所有内容
test_module :: import("./test.yo"); // 从 test.yo 导入所有内容并放入 Test 命名空间
{ test } :: import("./test.yo"); // 从 test.yo 导入 test 函数
{ test : test2 } :: import("./test.yo"); // 从 test.yo 导入 test 函数并重命名为 test2
{ Option } :: import("./test.yo"); // 从 test.yo 导入 Option 类型
```

### 匿名模块

匿名模块使用 `impl` 关键字后跟一个 `begin` 块来定义：

```rust
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

```rust
// := 初始化
counter := i32(0);

// 绑定模式初始化
(flag : bool) = false;
```

同一模块中定义的函数可以读写这些变量：

```rust
inc :: (fn() -> unit)({
  counter = (counter + i32(1));
});
```

**限制：**

- 模块作用域不允许仅有类型注解而无初始化的声明：
  ```rust
  a : i32;  // ❌ 错误：应使用 `a := i32(0);` 或 `(a : i32) = i32(0);`
  ```
- `impl` 块内不允许可变运行时变量（`:=` 或 `(x : T) = val`）。请使用 `::` 定义编译时常量：
  ```rust
  m :: impl {
    b := i32(13);  // ❌ 错误：impl 块内不允许
    b :: 13;       // ✅ 正确：编译时常量
    export(b);
  };
  ```
- 模块级可变变量**不能被导出**。只有编译时已知的值才能从模块中导出。

## 命名规范

使用 2 个空格进行缩进。

- `snake_case`
  - `文件名`
  - `目录名`
  - `函数`
  - `变量`
  - `模块`
- `PascalCase`
  - `trait`
  - `类型`及其变体
- `UPPER_SNAKE_CASE`
  - `常量`

## 测试

Yo 内置了通过 `test` 关键字使用的测试框架。

### 基本测试语法

```rust
test("Test description", {
  // 测试代码
  x := 1 + 1;
  assert(x == 2);
});

// Io 通过 `io` 自动注入到所有测试体中
test("With effects", {
  io.await(sleep(u64(1000)));
});
```

### 运行测试

可以使用 Yo CLI 运行测试：

```bash
# 运行文件中的所有测试
$ yo test path/to/file.test.yo

# 按模式运行特定测试
$ yo test path/to/file.test.yo --test-name-pattern "Test addition"

# 首次失败时停止
$ yo test path/to/file.test.yo --bail

# 详细输出
$ yo test path/to/file.test.yo -v
```

### 断言

#### 运行时断言

```rust
test("Runtime assertions", {
  x := 42;

  // 基本断言
  assert(x == 42);

  // 带消息的断言
  assert(x > 0, "x should be positive");

  // 复杂断言
  arr := [1, 2, 3];
  assert(arr.len() == 3, "Array should have 3 elements");
});
```

#### 编译时断言

使用 `comptime_assert` 进行编译时验证：

```rust
test("Compile-time assertions", {
  // 这些在编译期间检查
  comptime_assert((2 + 2) == 4);
  comptime_assert(Array(i32, 5).fill(0).len() == 5);
  comptime_assert(f32(3.14) > f32(3.0));

  // 类型级断言
  T :: i32;
  comptime_assert(Type.to_string(T) == "i32");
});
```

### 测试预期错误

验证某些代码会产生编译时错误：

```rust
test("Expected compile errors", {
  // 预期错误但不指定具体消息
  comptime_expect_error({
    x :: (1 / 0);  // 除以零
  });

  // 预期错误并指定具体消息
  comptime_expect_error(
    {
      arr : Array(i32, _);
      arr = [1, 2, 3];
    },
    "Cannot infer array length in binding"
  );

  // 测试某些模式是无效的
  comptime_expect_error({
    closure1 := ((x) => (x + 1));
    closure2 := ((x) => (x + 1));
    // 每个闭包都有唯一类型
    (c : typeof(closure1)) = closure2;  // 错误！
  }, "no two closures have the same type");
});
```

### 测试组织

在同一文件中组织相关测试：

```rust
// arithmetic.test.yo

test("Addition", {
  assert((1 + 1) == 2);
  assert((5 + 3) == 8);
});

test("Subtraction", {
  assert((5 - 3) == 2);
  assert((10 - 10) == 0);
});

test("Multiplication", {
  assert((2 * 3) == 6);
  assert((7 * 0) == 0);
});

test("Division", {
  assert((10 / 2) == 5);
  assert((9 / 3) == 3);
});
```

### 使用引用语义类型进行测试

测试清理和释放：

```rust
MyBox :: ref(struct(
  (*) : i32
));
impl(MyBox, Dispose(
  dispose : (self -> {
    printf("Disposing MyBox with value: %d\n", self.*);
  })
));

test("Object disposal", {
  // Box 在作用域结束时自动释放
  b := MyBox(42);
  assert(b.* == 42);
  b.* = 100;
  assert(b.* == 100);
  // 此处自动调用 dispose()
});
```

### 测试文件

Yo 测试文件通常使用 `.test.yo` 扩展名：

- `basic.test.yo` — 基本语言特性
- `array.test.yo` — 数组操作
- `closure.test.yo` — 闭包功能
- `async_await.test.yo` — 异步/等待特性
- `collections/*.test.yo` — 集合类型

完整的测试示例请参阅 [tests/](../tests/) 目录。

## 元编程

`quote` 类似于 Lisp 中的 `quasiquote`。
`unquote` 只能在 `quote` 中使用。
`unquote_splicing` 只能在 `quote` 中使用，用于将值展开到 AST 中。

```rust
x := quote(2); // comptime(x) : Expr

list := quote((1, unquote(x), 3)); // 元组 (1, 2, 3)

list2 = quote((1, x, 3)); // 元组 (1, x, 3)

quote((0, unquote_splicing(list.get_args()), 4)); // 元组 (0, 1, 2, 3, 4)
```

### 宏函数

宏函数使用 `quote` 和 `unquote` 进行代码生成。宏就是带有两个签名标记之一
（或两者）的普通 comptime 函数：`quote(name) : Expr` 参数（调用方的原始
AST 不经求值直接绑定）和 `-> unquote(Expr)` 返回类型（返回的 AST 拼接回
调用点）。实际示例请参阅 `std/prelude.yo`，例如 `if` 宏。

- `quote(...)` : 引用一个表达式
- `unquote(...)` : 在引用的表达式中取消引用
- `gensym(...)` : 生成唯一符号

`unquote` 只能在 `quote` 内部使用。

**定义宏需要在文件顶部声明 `pragma(Pragma.AllowMacroDef);`** —— 与指针
操作的 `Pragma.AllowUnsafe` 一样，定义宏是按文件粒度的显式选择（宏不
卫生、且会向调用方拼接代码，因此定义能力受门控；参见
`plans/MACRO_POLICY.md`）。*调用*宏（`if`、`for`、集合字面量）不需要该
pragma；在 comptime 函数中操作引用的 `Expr` 值（`derive_rule` 使用的机
制）同样不需要。

```rust
pragma(Pragma.AllowMacroDef);

// 自定义宏示例 —— 惰性求值 body 的 `unless`
unless :: (fn(quote(condition): Expr, quote(do): Expr) -> unquote(Expr))(
  quote(
    cond(unquote(condition) => (), true => unquote(do))
  )
);
```

prelude 的 `if` 宏是标准示例（当前编译器在解析阶段将 `if(...)` 调用脱糖
为 `cond(...)`，该定义作为规范/回退保留）：

```rust
if :: (fn(quote(condition): Expr,
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

// 用法
if(true, {
  println("true");
});
```

> std 的 `try` 宏已移除（它隐藏了调用方栈帧内的 `return`，且在概念上与
> 代数效应系统冲突）。请改用对 `Result` 的 `match`，或在
> `pragma(Pragma.AllowMacroDef);` 下在本地定义等价宏 ——
> `tests/codegen-bootstrap/try_macro_assign.yo` 保留了一个可用版本。

## 派生特征（Derive Traits）

Yo 支持类似 Rust `#[derive(...)]` 的自动特征派生，但使用函数调用语法。`derive` 函数根据类型的结构自动生成 `impl` 块。

### 内置派生

五个特征具有内置派生支持：`Eq`、`Hash`、`Clone`、`Ord` 和 `ToString`。它们适用于结构体和枚举：

```rust
Point :: struct(x : i32, y : i32);
derive(Point, Eq, Hash, Clone, Ord, ToString);

// 现在 Point 支持 ==、!=、哈希、克隆、比较和字符串转换
main :: (fn() -> unit)({
  p1 := Point(1, 2);
  p2 := Point(1, 2);
  assert((p1 == p2), "equal");
  assert((p1.to_string() == `Point(1, 2)`), "to_string");
});
export(main);
```

### 用户自定义派生规则（`derive_rule`）

特征作者可以使用 `derive_rule` 注册自定义派生规则。派生规则**不是宏** ——
它是返回 `comptime(Expr)` 的普通 comptime 函数，用 `quote`/`unquote` 构
造 `impl` 块，由 `derive` 内建函数显式求值（因此不需要
`Pragma.AllowMacroDef`）：

```rust
MyEq :: (fn(comptime(Rhs) : Type) -> comptime(Trait))(
  trait(my_eq : (fn(self : Self, other : Rhs) -> bool))
);

my_derive_eq :: (fn(comptime(T) : Type, comptime(ctx) : DeriveContext, comptime(trait_params) : ComptimeList(Expr)) -> comptime(Expr))({
  eq_body :: Type.join_fields(
    T,
    (fn(comptime(field) : FieldInfo) -> comptime(Expr))(
      quote(self.(#(field.name.to_expr())).my_eq(other.(#(field.name.to_expr()))))
    ),
    quote(&&)
  );
  ctx.make_impl(quote(
    MyEq(...#(trait_params))(
      my_eq : ((self, other) -> #(eq_body))
    )
  ))
});
derive_rule(MyEq, my_derive_eq);

Point :: struct(x : i32, y : i32);
derive(Point, MyEq(Point));  // 使用注册的 derive_rule
```

## 类型反射（Type Reflection）

Yo 通过 `TypeInfo` 枚举和 `Type.get_info()` 提供编译时类型反射。与简单的类型标签系统不同，`TypeInfo` 携带丰富的结构元数据——结构体字段、枚举变体、函数参数等。

```rust
info :: Type.get_info(i32);
comptime_assert(info.is_primitive(), "i32 is primitive");
comptime_assert(info.is_integer(), "i32 is an integer");

info2 :: Type.get_info(Point);
comptime_assert(info2.is_struct(), "Point is a struct");
```

复合变体携带可通过 `match` 提取的元数据：

```rust
// 提取数组元素类型和长度
arr_info :: Type.get_info([i32; 3]);
elem :: match(arr_info, .Array(e, _) => e, _ => unit);
len :: match(arr_info, .Array(_, l) => l, _ => 0);
comptime_assert((len == 3), "array length is 3");

// 检查结构体字段
pt_info :: Type.get_info(Point);
field_count :: match(pt_info, .Struct(f, _) => f.len(), _ => usize(0));
comptime_assert((field_count == usize(2)), "Point has 2 fields");

// 基于类型信息的 match 分发
describe :: (fn(comptime(T) : Type) -> comptime(comptime_str))(
  match(Type.get_info(T),
    .I32 => "32-bit signed integer",
    .Struct(_, _) => "struct type",
    .Enum(_) => "enum type",
    _ => "other type"
  )
);
```

`TypeInfo` 上的守卫方法：

- **结构性**：`is_struct()`、`is_enum()`、`is_union()`、`is_tuple()`、`is_array()`、`is_str()`、`is_function()`、`is_pointer()`、`is_trait()`、`is_void()`
- **数值性**：`is_primitive()`、`is_integer()`、`is_float()`、`is_numeric()`、`is_comptime()`

完整的 TypeInfo 枚举定义、元数据结构体和详细用法，请参阅 [TYPE_REFLECTION.md](./TYPE_REFLECTION.md)。

## 编译时求值

Yo 拥有强大的编译时求值能力。你可以在编译时执行计算、类型操作和代码生成。

### 编译时变量

使用 `::` 声明的变量是编译时常量：

```rust
// 编译时整数
x :: 42;                    // comptime_int
y :: (x + 10);              // comptime_int = 52

// 编译时类型
MyInt :: i32;               // comptime(Type)
value := MyInt(100);        // 运行时 i32

// 编译时计算
factorial :: (fn(comptime(n) : comptime_int) -> comptime(comptime_int))(
  cond(
    (n <= 1) => 1,
    true => (n * recur(n - 1))
  )
);
result :: factorial(5);     // 编译时计算：120
```

### 编译时算术

所有基本运算都可以在编译时执行：

```rust
// 整数运算
a :: 100;
b :: 25;
sum :: (a + b);            // 125
diff :: (a - b);           // 75
prod :: (a * b);           // 2500
quot :: (a / b);           // 4
rem :: (a % b);            // 0

// 比较运算
eq :: (a == b);            // false
lt :: (b < a);             // true
gte :: (a >= b);           // true

// 浮点运算
pi :: f32(3.14159);
radius :: f32(5.0);
area :: (pi * (radius * radius));  // ~78.54

// 布尔运算
flag1 :: true;
flag2 :: false;
and_result :: (flag1 && flag2);    // false
or_result :: (flag1 || flag2);     // true
not_result :: not(flag1);          // false
```

### 编译时数组

具有编译时已知长度的数组：

```rust
// 推断长度
arr :: [1, 2, 3, 4, 5];    // Array(i32, 5)
len :: arr.len();          // 5（编译时）

// 编译时 Array.fill
zeros :: Array(i32, 10).fill(0);  // [0,0,0,0,0,0,0,0,0,0]

// 泛型数组函数
create_array :: (fn(comptime(T) : Type, comptime(n) : usize, value : T) -> [T; n])
  Array(T, n).fill(value)
;

int_array :: create_array(i32, 5, 42);  // [42,42,42,42,42]
```

### 编译时断言

使用 `comptime_assert` 验证编译时条件：

```rust
test("Compile-time assertions", {
  // 这些在编译时检查
  comptime_assert((2 + 2) == 4);
  comptime_assert(f32(100.5) > f32(50.0));
  comptime_assert(Array(i32, 5).fill(0).len() == 5);

  // 编译时类型检查
  T :: i32;
  comptime_assert(Type.to_string(T) == "i32");
});
```

### 编译时预期错误

测试代码是否会产生编译时错误：

```rust
test("Expected compile errors", {
  // 验证此代码会产生错误
  comptime_expect_error(
    x :: (1 / 0),  // 除以零
    "Division by zero"
  );

  comptime_expect_error({
    arr : Array(i32, _);  // 无法在绑定中推断长度
    arr = [1, 2, 3];
  });
});
```

### 编译时与运行时

理解事物何时发生：

```rust
// 编译时：使用 :: 或 comptime(...) 声明
COMPT_VALUE :: 42;                // 编译时计算
ComptimeType :: i32;                 // 编译时选择类型

// 运行时：使用 := 声明
runtime_value := 42;              // 运行时计算
runtime_type := i32(100);         // 运行时创建值

// 混合：编译时类型，运行时值
(x : i32) = 42;                   // 类型在编译时已知
                                  // 值在运行时计算

// 编译时函数参数
array_fn :: (fn(comptime(n) : usize) -> Array(i32, n))
  Array(i32, n).fill(0)
;                                 // n 必须在编译时已知

// 运行时函数参数
increment :: (fn(x : i32) -> i32)
  (x + 1)
;                                 // x 是运行时值
```

### 编译时求值的优势

1. **零运行时开销**：计算在编译时一次性完成
2. **类型安全**：在执行前捕获错误
3. **泛型编程**：无运行时开销的类型级抽象
4. **元编程**：基于编译时信息生成代码

更多示例请参阅 [comptime.test.yo](../tests/comptime.test.yo)。

## 内联汇编

Yo 提供了 `asm()` 和 `global_asm()` 内置函数用于嵌入内联汇编，灵感来自 Rust 的 `asm!` 宏。特性包括：

- **操作数类型**：`in`、`out`、`inout`、`lateout`、`inlateout`、`const_val`、`sym`
- **寄存器约束**：`reg`、`imm`、`mem`、显式寄存器名（例如 `"rax"`）
- **命名操作数**：`out("result", reg, i32)` 配合模板引用 `{result}`
- **变量目标输出**：`out(reg, x)` 直接写入变量，包括未初始化的变量
- **破坏声明和选项**：`clobber("memory")`、`asm_options(volatile, noreturn)`
- **多架构支持**：x86_64 和 aarch64

````rust
```yo
// 简单示例：将立即数移入寄存器
result := asm(
  "mov {0}, #42",
  out(reg, i32)
);

// 未初始化变量输出
x : i32;
asm("mov {0}, #42", out(reg, x));
````

完整的设计、语法参考和 C 代码生成细节，请参阅 [INLINE_ASSEMBLY.md](../INLINE_ASSEMBLY.md)。

## Index 特征

Yo 提供了统一的 `Index` 特征，用于对任意类型的自定义索引。实现了 `Index(Idx)` 的类型可以使用函数调用语法 `value(index)` 进行元素访问，通过 `&(value(index))` 获取指针，以及通过调用语法赋值 `value(index) = new_value` 进行修改。

标准库为 `ArrayList`、`HashMap`、`BTreeMap`、`Deque` 和 `String` 实现了 `Index`。定长数组与 `str` 使用内置索引（相同语法）；集合上的 `..` 与 `..=` 区间产生独立持有的拷贝（`slice_copy`），而 `str` 上的区间是零拷贝的静态窗口。

完整的设计、特征定义和实现细节，请参阅 [INDEX_TRAIT.md](./INDEX_TRAIT.md)。

## 设计中

仍处于设计阶段的特性请查阅 [IN_DESIGN.md](../../plans/backlog/IN_DESIGN.md)。

## 参考文献

- [Ocaml Locality](https://blog.janestreet.com/oxidizing-ocaml-locality/)
- [Data race freedom](https://github.com/ocaml-flambda/ocaml-jst/blob/main/jane/doc/proposals/data-race-freedom.md)
- [ICFP'21 Tutorials - Programming with Effect Handlers and FBIP in Koka](https://www.youtube.com/watch?v=6OFhD_mHtKA&ab_channel=ACMSIGPLAN)
- [Simply Easy! An Implementation of a Dependently Typed Lambda Calculus](http://strictlypositive.org/Easy.pdf)
- [Reconstructing TypeScript](https://jaked.org/blog/2021-09-07-Reconstructing-TypeScript-part-0)
- [PureScript Types](https://github.com/purescript/documentation/blob/master/language/Types.md)
- [The Ultimate Conditional Syntax](https://icfp22.sigplan.org/details/mlfamilyworkshop-2022-papers/6/The-Ultimate-Conditional-Syntax)
- [Algebraic Effects for the Rest of Us](https://overreacted.io/algebraic-effects-for-the-rest-of-us/)
- [What Color is Your Function](https://journal.stuffwithstuff.com/2015/02/01/what-color-is-your-function/)
- [Implementing Algebraic Effects in C "Monads for Free in C"](https://www.microsoft.com/en-us/research/wp-content/uploads/2017/06/algeff-in-c-tr.pdf)
- [Efficient Compilation of Algebraic Effect Handlers - Ningning Xie](https://www.youtube.com/watch?v=tWLPrPfb4_U&ab_channel=ETHWSCR)
- [Generalized Evidence Passing for Effect Handlers](https://www.microsoft.com/en-us/research/uploads/prod/2021/03/multip-tr-v4.pdf)
- [Structured Asynchrony with Algebraic Effects](https://www.microsoft.com/en-us/research/wp-content/uploads/2017/05/asynceffects-msr-tr-2017-21.pdf)
- [Effects as Capabilities: Effect Handlers and Lightweight Effect Polymorphism](https://dl.acm.org/doi/pdf/10.1145/3428194)
- [A Typed Continuation-Passing Translation for Lexical Effect Handlers](https://se.cs.uni-tuebingen.de/publications/schuster22typed.pdf)
- [Zero-cost Effect Handlers](https://se.cs.uni-tuebingen.de/publications/schuster19zero.pdf)
- [Why Rust Closures are (Somewhat) Hard](https://stevedonovan.github.io/rustifications/2018/08/18/rust-closures-are-hard.html)
- [Inside Rust's Async Transformation](https://blag.nemo157.com/2018/12/09/inside-rusts-async-transform.html)
- [Coroutines: Suspending State Machines](https://medium.com/google-developer-experts/coroutines-suspending-state-machines-36b189f8aa60)
- [What's the difference between an algebraic effect, a callback function, and a coroutine](https://www.reddit.com/r/ProgrammingLanguages/comments/13v35fk/whats_the_difference_between_an_algebraic_effect/)
- [Revisiting coroutines](https://dl.acm.org/doi/abs/10.1145/1462166.1462167)
- [One-shot Algebraic Effects as Coroutines](http://logic.cs.tsukuba.ac.jp/~sat/pdf/tfp2020.pdf)
- [Implementing Co, a Small Language With Coroutines](https://abhinavsarkar.net/posts/implementing-co-3/)
- [Retrofitting Effect Handlers onto OCaml](https://arxiv.org/pdf/2104.00250.pdf)
- [Do Be Do Be Do](https://arxiv.org/pdf/1611.09259.pdf)
- [Custom Infix Operators in Haskell](<https://bugfactory.io/blog/custom-infix-operators-in-haskell/#:~:text=Precedence%20(aka%20Operator%20Binding)&text=All%20operators%20in%20Haskell%20have,6%20>).)
- [Region-Based Memory Management in Cyclone](https://www.cs.umd.edu/projects/cyclone/papers/cyclone-regions.pdf)
- [Implementation Strategies for Mutable Value Semantics](https://www.jot.fm/issues/issue_2022_02/article2.pdf)
- [Type Classes as Objects and Implicits](https://citeseerx.ist.psu.edu/document?repid=rep1&type=pdf&doi=d30d65ca9ce7891352024a5c71ebe0ae8c41f7ac)
- [Implicit Parameters: Dynamic Scoping with Static Types](https://dl.acm.org/doi/pdf/10.1145/325694.325708)
- [Scrap your type classes](https://www.haskellforall.com/2012/05/scrap-your-type-classes.html)
- [Implicit Parameters in Scala and Haskell](https://trebledj.me/posts/implicit-parameters-in-scala-and-haskell/)
- [High-level effect handlers in C](https://homepages.inf.ed.ac.uk/slindley/papers/libseff-draft-november2023.pdf)
- [Exceptions in C with longjmp and setjmp](https://web.archive.org/web/20091104065428/http://www.di.unipi.it/~nids/docs/longjump_try_trow_catch.html)
- [Continuation Passing for C](https://www.irif.fr/~jch/cpc.pdf)
- [Refinement Types for TypeScript](https://goto.ucsd.edu/~pvekris/docs/pldi16.pdf)
- [Continuations and Delimited Control](https://okmij.org/ftp/continuations/)
- [Custom allocators in Rust](https://nical.github.io/posts/rust-custom-allocators.html)
- [Ownership You Can Count On: A Hybrid Approach to Safe Explicit Memory Management](https://inko-lang.org/papers/ownership.pdf)
