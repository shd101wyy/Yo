# 语言设计

**Yo** 是一种多范式、通用、编译型编程语言。
Yo 追求**简洁**与**高效**：它编译为 C11，目标是与 C 相当的速度。实测差距见
`plans/backlog/CODEGEN_PERFORMANCE.md`。

**Yo** 旨在成为一门对 C 和 JavaScript (TypeScript) 程序员来说**易于学习**的编程语言 😉。

我们的目标是成为一门易用且易学的实用语言。

语法、数据类型、函数、闭包与模式匹配各有专页：[SYNTAX.md](./SYNTAX.md)、
[DATA_TYPES.md](./DATA_TYPES.md)、[FUNCTIONS.md](./FUNCTIONS.md)、
[CLOSURES.md](./CLOSURES.md) 和 [PATTERN_MATCHING.md](./PATTERN_MATCHING.md)。[INDEX.md](./INDEX.md) 列出全部手册。

<!-- @import "[TOC]" {cmd="toc" depthFrom=2 depthTo=6 orderedList=false} -->

<!-- code_chunk_output -->

- [设计哲学](#设计哲学)
- [灵感来源](#灵感来源)
- [CLI 用法](#cli-用法)
- [共享单元与内存管理](#共享单元与内存管理)
  - [引用计数单元](#引用计数单元)
  - [选择值、借用还是共享单元](#选择值借用还是共享单元)
  - [读取计数](#读取计数)
  - [显式分配器](#显式分配器)
  - [Copy](#copy)
  - [只能移动的值](#只能移动的值)
  - [std 的资源是只能移动的](#std-的资源是只能移动的)
  - [析构函数：`Drop`](#析构函数drop)
- [指针](#指针)
  - [指针操作](#指针操作)
  - [指针算术与比较](#指针算术与比较)
  - [指针操作参考](#指针操作参考)
  - [consume 函数](#consume-函数)
  - [可空指针](#可空指针)
  - [句柄的 `Option` 就是一个指针](#句柄的-option-就是一个指针)
  - [内存安全](#内存安全)
  - [`&mut` 参数](#mut-参数)
  - [RAII（资源获取即初始化）](#raii资源获取即初始化)
- [高级类型系统](#高级类型系统)
  - [高阶类型（Higher-Kinded Types，HKT）](#高阶类型higher-kinded-typeshkt)
    - [HKT generic 参数](#hkt-generic-参数)
    - [HKT Trait](#hkt-trait)
    - [使用 HKT where 子句的泛型函数](#使用-hkt-where-子句的泛型函数)
  - [广义代数数据类型（GADTs）](#广义代数数据类型gadts)
    - [GADT 匹配类型细化](#gadt-匹配类型细化)
    - [GADT 穷尽性检查](#gadt-穷尽性检查)
    - [GADT 索引属于类型本身](#gadt-索引属于类型本身)
    - [多参数 GADTs](#多参数-gadts)
    - [带自定义判别值的 GADTs](#带自定义判别值的-gadts)
    - [混合 GADT 和普通变体](#混合-gadt-和普通变体)
- [类型状态（Typestate）](#类型状态typestate)
- [Traits](#traits)
  - [静态 trait 方法](#静态-trait-方法)
  - [trait 的 `where` 子句与关联类型](#trait-的-where-子句与关联类型)
  - [一致性：每个类型对每个 trait 只有一个 impl](#一致性每个类型对每个-trait-只有一个-impl)
  - [Trait 方法消歧义](#trait-方法消歧义)
- [字符串](#字符串)
  - [字符串字面量作为 `str` 或 C 字符串指针](#字符串字面量作为-str-或-c-字符串指针)
  - [String（可增长字符串）](#string可增长字符串)
    - [通过 `String` 的副本写入](#通过-string-的副本写入)
    - [使用 `${}` 语法的模板字符串插值：](#使用--语法的模板字符串插值)
      - [格式说明符 —— `${value:spec}`](#格式说明符--valuespec)
- [Box：唯一所有的单元](#box唯一所有的单元)
- [Rc 和引用计数单元](#rc-和引用计数单元)
  - [Rc 类型](#rc-类型)
  - [使用示例](#使用示例)
  - [自动解引用](#自动解引用)
  - [Rc 与赋值](#rc-与赋值)
  - [Rc 与引用计数](#rc-与引用计数)
  - [修改共享载荷：`RefCell`、`Rc.get_mut`、`Rc.make_mut`、`Rc.try_unwrap`](#修改共享载荷refcellrcget_mutrcmake_mutrctry_unwrap)
  - [Weak：不拥有的句柄](#weak不拥有的句柄)
  - [何时使用 Rc](#何时使用-rc)
- [Impl 类型](#impl-类型)
  - [基本用法](#基本用法)
  - [Impl 作为返回类型](#impl-作为返回类型)
  - [Impl 与多个 Trait](#impl-与多个-trait)
- [动态分发](#动态分发)
  - [`Dyn` 和 `dyn`](#dyn-和-dyn)
  - [示例](#示例)
- [存在类型](#存在类型)
  - [打包形式：`Dyn(Trait)`](#打包形式dyntrait)
  - [不透明形式：`Impl(Trait)` 与闭包](#不透明形式impltrait-与闭包)
    - [裸函数类型中不能出现 `Impl(Fn(...))`](#裸函数类型中不能出现-implfn)
  - [不支持：存在型枚举构造器](#不支持存在型枚举构造器)
- [Impl 与 Dyn 的对比](#impl-与-dyn-的对比)
- [代数效应与处理器](#代数效应与处理器)
- [错误处理](#错误处理)
  - [Result 类型](#result-类型)
  - [Error Trait 和 AnyError](#error-trait-和-anyerror)
  - [Exception（不可恢复异常）](#exception不可恢复异常)
  - [ResumableException](#resumableexception)
- [异步/等待](#异步等待)
- [并行](#并行)
- [Arc 类型](#arc-类型)
- [模块的导入和导出](#模块的导入和导出)
    - [同一个名字导入两次](#同一个名字导入两次)
    - [trait impl 通过你的导入可见](#trait-impl-通过你的导入可见)
  - [匿名模块](#匿名模块)
  - [模块级可变变量](#模块级可变变量)
- [测试](#测试)
  - [基本测试语法](#基本测试语法)
  - [运行测试](#运行测试)
  - [断言](#断言)
    - [运行时断言](#运行时断言)
    - [编译时断言](#编译时断言)
  - [测试预期错误](#测试预期错误)
  - [测试组织](#测试组织)
  - [测试 Drop](#测试-drop)
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
- **没有垃圾回收器**（引用计数在最后一个句柄处释放每个单元；引用环会泄漏，除非用 `Weak` 打破，与 Rust 相同）

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

## 共享单元与内存管理

Yo 使用**引用计数单元**（`Rc`、`Arc`）实现共享所有权。`Rc(T)` 以非原子方式对句柄计数，`Arc(T)` 以原子方式计数。非原子计数是可靠的，因为 `Rc` 不是 `Send`：它从不离开自己的线程，所以只有一个线程会访问它的计数（[PARALLELISM.md](./PARALLELISM.md)）。跨线程共享请用 `Arc`（[ARC.md](./ARC.md)）。

### 引用计数单元

`Rc(T)` 与 `Arc(T)` 是带有自动引用计数的堆单元。句柄就是新的所有者，所以第二个句柄写作 `Rc.clone(h)`：

```yo
// 一个共享单元：`Rc(T)` 对指向同一个堆单元的句柄计数。
Resource :: struct(id : i32);
impl(
  Resource,
  Drop(
    drop : (fn(self : &mut Self) -> unit)({
      // 当引用计数降为零时运行 `drop`
    })
  )
);

// 使用
s1 := Rc.new(Resource(id : i32(1))); // RC = 1
s2 := Rc.clone(s1); // RC = 2（两个句柄指向同一个单元）
s3 := Rc.clone(s2); // RC = 3
// 当 s1、s2、s3 离开作用域时，RC 递减
// 当 RC 降为零时，载荷的 `drop` 运行并释放单元
```

### 选择值、借用还是共享单元

两个问题决定了一个持有状态的类型的形态：

1. 构造之后它会被写入吗？
2. 它是否被两个所有者需要，而这两个所有者的生存期超出彼此的调用？

都不是：普通 `struct`，按 `&` 传入、按值返回。是、否：一个拥有所有权的值，写入处以
`&mut` 借出，只读处以 `&` 借出。都是：`Rc(RefCell(S))`。

std 的类型展示了方法的形态，每个方法只有一种形态：

- 构建器消耗并返回：链式写 `Command.new(p).arg(a).arg(b)`，或在 `mut(cmd)` 绑定上写
  `cmd = cmd.arg(a);`。`HttpRequest`/`HttpResponse` 的 `.header`/`.with_body` 以及
  `FetchOptions.with_*` 也是如此。
- 修改器借出：`mut(u) := Url.parse(&s).unwrap(); u.set_path(&p);`。`ArgParser.add_*`、
  `Rng` 的取数方法与 `Interval.tick` 也是如此。
- 终结方法消耗：哈希器的 `update(&mut self)` 喂入数据，`finish(self)` 结束它，所以第二次
  `finish` 是移动后使用（E0901）。
- `HttpServer` 是共享的那一个：它的 `serve` future 拥有一个 `server.clone()`，保留下来的
  克隆在处理函数或另一个任务中调用 `stop`。

### 读取计数

内建函数 `ref_count(x)` 以 `usize` 返回 `x` 所持单元的句柄数；`Arc(T)` 以原子加载读取。对值类型（普通 `struct`、整数）它总是 `1`，在编译期已知。`Box` 没有计数，所以 `ref_count(b)` 是编译错误。计数用于唯一性检查（写时复制）和测试，不用于程序逻辑。

```yo
a := Rc.new(i32(42));
b := Rc.clone(a);
assert(ref_count(b) == usize(2), "两个句柄，一个单元");
```

### 显式分配器

引用计数决定对象何时释放，显式分配器决定它放在哪里。不带分配器参数的创建使用全局分配器；放置是创建处的一个参数：`Box.new`、`Rc.new`、`Arc.new` 以及容器的 `new` / `with_capacity` 都用 `alloc : .Some(a)`：

```yo
{ ArrayList } :: import("std/collections/array-list");
Point :: struct(x : i32, y : i32);

// `a` 是任意 `Allocator` 值，例如 `Allocator.global()`。
p := Rc.new(Point(x : i32(3), y : i32(4)), alloc : .Some(a)); // 放在 `a` 里
p2 := Rc.new(Point(x : i32(1), y : i32(2))); // 没有参数：全局分配器
xs := ArrayList(i32).new(alloc : .Some(a)); // 缓冲区在 `a` 里
```

不需要新关键字，也没有分配作用域：一个调用做什么从不取决于它的调用者。每个内存块在 16 字节前缀中记录自己的所有者，所以释放总是回到分配它的分配器，无论在哪个线程。安全规则见 [MEMORY_SAFETY.md](./MEMORY_SAFETY.md#显式分配器)；完整指南见 [EXPLICIT_ALLOCATORS.md](./EXPLICIT_ALLOCATORS.md)。

### Copy

`Copy` 是 prelude 中的标记 trait，表示一个值的复制就是按位复制。它要求 `Clone`，与 Rust 的 `Copy: Clone` 一样：这个 trait 声明为 `Copy :: trait(where(Self <: Clone))`，所以每个 `Copy` impl 旁边都需要一个 `Clone` impl，而 `where(T <: Copy)` 让泛型函数体可以调用 `x.clone()`。整数、浮点数、`bool`、`char`、`unit`、`str` 视图和裸指针两者都实现；`Option(T)` 与 `Result(T, E)` 在载荷实现它们时也实现。具名类型通过 `derive(T, Copy, Clone)` 选择加入，泛型类型则加上 `where` 约束：

```yo
Point :: struct(x : i32, y : i32);
derive(Point, Copy, Clone);

Pair :: (fn(comptime(T) : Type) -> comptime(Type))(struct(a : T, b : T));
derive(generic(T : Type), where(T <: Clone), Pair(T), Clone);
derive(generic(T : Type), where(T <: Copy), Pair(T), Copy);

main :: (fn() -> unit)({
  p := Point(x : i32(1), y : i32(2));
  q := p; // 复制：`p` 仍然可用
  r := p.clone(); // 派生的 clone；对 Copy 类型来说就是复制
});
export(main);
```

这个 impl 会被检查。必须有一个覆盖相同实例化的 `Clone` impl，而编译器从不替你写：单独的 `derive(T, Copy)` 是错误，错误信息会给出 `derive(T, Copy, Clone)`。每个字段和变体载荷都必须是 `Copy`，错误信息会指出第一个不是的部分（`String` 字段：`holds a move-only value in its field \`name\``）。实现了 `Drop` 的类型不能是 `Copy`（无论两个 impl 的先后顺序），引用类型也不能。`derive(T, Clone)` 总是允许的（对 `Copy` 字段逐字段克隆就是按位复制），这也是只在约束下才是 `Copy` 的类型在每个实例化上获得 `clone()` 的写法：`derive(generic(T : Type), where(T <: Clone), Pair(T), Clone)`——派生的 clone 会对字段调用 `.clone()`，所以需要这个约束——再加上 `derive(generic(T : Type), where(T <: Copy), Pair(T), Copy)`，使 `Pair(i32)` 被隐式复制，`Pair(String)` 被显式克隆。只有在 impl 服务的每个实例化都是 `Copy` 的类型上（例如具体的 `Copy` 类型），手写的 `Clone` impl 才是错误；同时服务于非 `Copy` 类型的泛型 impl（例如 prelude 中 `Option(T)` 的）是允许的。元组、`Array(T, N)`、匿名记录、闭包和 `fn` 指针没有可以标注的声明，所以它们在所有组成部分都是 `Copy`（`Clone`）时才是 `Copy`（`Clone`）。当它是 `Copy` 时，`x.clone()` 就是复制，所以对 `fn` 指针可以写 `f.clone()`；是 `Clone` 但不是 `Copy` 的记录或闭包按字段克隆：`Copy` 的部分被复制，其余部分被克隆。闭包的组成部分就是它的捕获记录，与 Rust 相同：按值捕获按其自身类型计算（列出的 `{ s }`，以及隐式捕获——绑定到名字的闭包拥有它捕获的东西），`&` 捕获是指针，因此是 `Copy`，`&mut` 捕获使闭包既不是 `Copy` 也不是 `Clone`。所以拥有 `String` 的闭包是 `Clone` 而不是 `Copy`：`d := c` 会移动它，`c.clone()` 则得到持有自己 `String` 的第二个闭包。`Rc`、`Arc`、`String`、各种集合和 `Dyn` 永远不是。裸指针的 `p.clone()` 复制的是指针本身，而不是它指向的值；如果被指向类型的字段与指针自身的方法同名（`clone`、`add`、`sub`、`offset_from`），`p.m(...)` 是错误，错误信息会给出指向字段的写法 `p.*.m(...)`，对指针的 clone 则给出复制写法 `q := p`。

`Copy` 是规则。不是 `Copy` 的纯数据类型只能显式复制：`q := p` 会移动一个没有 `Copy` 的 `Point`，之后再使用 `p` 就是 E0901，其提示会给出 `derive(Point, Copy, Clone)` 和 `p.clone()`。`&T` 参数或 `match` 绑定只是借用这样的值，所以在那里存储或返回它也是 E0901；要拥有它，请按值接受参数（`p : Point`，不写 `&`）。仅编译期类型、`Exception` 之类绑定控制流的记录、union、C 不透明类型，以及 `Copy` 类型的精化类型，仍然隐式复制。

### 只能移动的值

资源（文件描述符、锁、套接字）是不能被复制的值：两份副本会把它释放两次。实现了 `Drop` 的值类型（`struct`、`enum`、`newtype`）是**只能移动的**（move-only），既不是 `Copy` 也不是 `Clone` 的纯值类型也是（必须保持唯一的令牌不需要 `Drop`：两者都不声明即可），包含这种值的每个值也是：结构体字段、枚举载荷、元组或数组元素、闭包捕获。`Option(Fd)` 和 `Tuple(Fd, i32)` 都是只能移动的。计数句柄（`Rc`、`Arc`）无论包含什么都不是，因为它的副本共享同一个单元；其载荷的 `Drop` 在计数归零时运行一次。

```yo
{ println } :: import("std/fmt");
Fd :: struct(n : i32);
impl(
  Fd,
  Drop(
    drop : (fn(self : &mut Self) -> unit)(println(`closing ${self.n}`)) // 真实的实现会关闭这个描述符
  )
);

peek :: (fn(f : &Fd) -> i32)(f.n); // `&T` 参数是借用：不复制
keep :: (fn(f : Fd) -> unit)(()); // 按值参数把值移动进来

main :: (fn() -> unit)({
  a := Fd(n : i32(3));
  n := peek(&a); // 借用；`a` 仍可使用
  b := a; // 把 `a` 移动到 `b`
  // a.n           // E0901：使用了被移动的值：`a`
  keep(b); // 移动 `b`；`keep` 返回时把它 drop
});
export(main);
```

每个复制点都会移动只能移动的值：`:=`、`=`、`sink` 实参、字段或元素写入、构造器实参、返回以及闭包捕获。移动之后再使用就是 E0901，其说明会指出该类型为什么只能移动。只能移动的值也不能从并不拥有它的存储中复制出来：`&T` 参数以及 `match`/`for` 绑定只是借用它，字段属于其持有者（没有部分移动），模块级绑定永远不会被移动。在 `cond`/`match` 的部分分支中被移动的值，会在每个保留它的分支末尾被 drop，所以在各分支汇合处它在每条路径上都已不存在，之后再使用就是 E0901（这是 Rust drop 标志的静态形式：分支是结构化的，不需要运行时标志）。在循环的各个出口汇合处，值仍然必须要么在所有出口上都被移动，要么都不被移动（E0907）。赋值语句（`x = y;`、`h.f = y;`、`xs(i) = y;`）会在写入后立即 drop 旧值，与 Rust 一致；`old := (x = y)` 则把旧值保存在 `old` 中。它唯一的所有者在 drop 它时恰好运行一次 `drop`，然后 drop 它的字段。实现了 `Clone` 的类型用 `x.clone()` 显式复制；要共享一个值，请把它放在引用类型之后。

要把字段从一个仍然存活的持有者中移出，请使用 `std/mem`（即 Rust 的 `std::mem`）：`replace(&mut h.f, v)` 写入 `v` 并返回旧值，`take(&mut h.f)` 写入 `T` 的默认值（`where(T <: Default)`）并返回旧值，`swap(&mut a, &mut b)` 交换两个位置的值。它们都按位移动，因此只能移动的值既不会被复制，也不会被 drop 两次。它们位于独立的模块而不是 prelude 中，所以这些名字仍可用于你自己的定义：`{ replace, take, swap } :: import("std/mem");`。

泛型函数在每次实例化时检查：`ArrayList(Fd).get(i)` 会把元素复制出来，所以这个实例化是 E0901，报告在调用处。集合元素改为按位置访问：`xs(i)` 原地读取元素，`xs.with(i, (v) => …)` 以 `&mut` 借用元素运行一段代码并返回其结果，`xs.take(i)` 把元素移出并留下 `T` 的默认值，`xs.swap(i, j)` 交换两个元素，`std/mem` 的 `replace(&mut xs(i), v)` 移入新值并移出旧值。每个会复制的访问器都有一个用于实现了 `Clone` 的元素的克隆版本：`ArrayList` 的 `get_cloned`、`first_cloned` 和 `last_cloned`；`Deque` 的 `get_cloned`、`front_cloned` 和 `back_cloned`；各种映射的 `get_cloned`，以及 `get_key_value_cloned`（`HashMap`）、`get_index_cloned`（`OrderedMap`）和 `first_entry_cloned`/`last_entry_cloned`（`BTreeMap`）；`PriorityQueue` 的 `peek_cloned`。`xs.extend(ys)` 会消耗 `ys`；`xs.extend_cloned(&ys)` 追加克隆并保留它。`Option` 和 `Result` 的 `unwrap`、`expect`、`unwrap_or`、`unwrap_or_else`、`unwrap_or_default`、`unwrap_err` 和 `expect_err` 会消耗接收者，因此 `make().unwrap()` 能把只能移动的载荷移出。

### std 的资源是只能移动的

`std/` 中的资源是只能移动的值：`File`、`TempDir`、`TempFile`、`Watcher`、`TcpStream`、`TcpListener`、`UdpSocket`、`UnixStream`、`UnixListener`、`TlsStream`、`HttpClient`、`Child` 及其管道句柄（`ChildStdin`、`ChildStdout`、`ChildStderr`）、`Thread`，以及拥有其中之一的 `BufReader`/`BufWriter`。每个都是状态存放在 `Box` 里的结构体，因此句柄可以移动，而 future 或运行时仍持有状态的地址。丢弃句柄即释放资源：描述符被关闭、临时文件被删除、监视被停止、线程被分离。`std/sync` 原语（`Mutex`、`RawMutex`、`RwLock`、`Cond`、`Barrier`、`Semaphore`、`WaitGroup`、`Once`、`OnceCell` 以及 `Atomic*` 类型）同样是只能移动的值，跨线程时以 `Arc(Mutex(T))` 的形式共享；`Channel(T)` 是持有队列 `Arc` 的值，`ch.clone()` 是该队列上的另一个句柄。

- **复制是 E0901。** `g := f` 移动文件，之后再使用 `f` 是 E0901（使用已移动的值）。把一个句柄存两次、或在两个闭包中捕获它，同样是 E0901。在这次改动之前，`File` 是引用句柄，副本共享它的描述符和位置。
- **借出它。** 每个方法都取 `self : &Self`，所以 `f.read_to_string(io)` 借用 `f`。只使用资源的函数取 `&File`。
- **通过引用类型共享。** 在单个线程内，`Rc.new(f)` 得到 `Rc(File)`，它的所有句柄都指向同一个文件（`h.*.read_to_string(io)`）。跨线程时用 `Arc(Mutex(TcpStream))`；这要求资源是 `Send` 的：各种套接字、`File`、临时文件、`Child` 及其管道和 `Thread`（`File`、临时文件和 `UnixListener` 持有 `String` 路径，自 B8 起它是值类型）。`Watcher`、`TlsStream` 和 `HttpClient` 留在自己的线程上。持有资源的 `ref` 结构体出于同样的原因把它存为 `Rc` 字段，就像 `HttpServer` 持有它的监听器那样。
- **把它移出来。** `Option(T).unwrap` 通过借用读取，不能把只能移动的载荷移出来。改用消耗型 match：`f := match(opt, .Some(x) => x, .None => …)`。
- **交出所有权。** `BufReader(File).new(f)` 和 `TcpListener.incoming()` 取得所有权（`sink`）；`get_ref()` 和 `Incoming.listener()` 把它借回来，`BufReader.into_inner()` / `BufWriter.into_parts()` 按值把它交还。要在派生的任务中服务一个套接字，把它移入该任务。
- **丢弃即释放。** 未经 `wait()` 就被丢弃的 `Child` 会关闭它仍持有的管道端（但不等待进程）。

每个 I/O 方法的 future 都借用资源直到完成，因为它使用的描述符会在资源被丢弃时关闭。这包括上述资源上的所有读、写、`close`、`flush`、`set_len`、`metadata`、`accept`、`connect`（UDP）、`send`/`recv`、`shutdown` 和套接字选项，`BufReader.read_line`，`Child.wait` 及其管道读写，`HttpClient.fetch`，`Watcher.next`，`Reader`/`Writer` 的默认方法（`read_to_end`、`read_to_string`、`write_all`），以及基于它们的自由函数（`io.copy`、`read_http_message`）。借用型 future 遵守 §3.13 A2 的规则：

- 在创建它的地方 await。它不能被绑定到名字、被 spawn 或被返回（E0909）。
- 它的 effect bundle 必须是一个位置。写成 `b := IoExn(io : io, exn : exn); io.await(f.read_to_string(io), b)`；在 `io.await` 里内联 `IoExn(...)` 是 E0910。
- 被借用的资源不能位于 `Rc` 载荷之内或指针解引用之后（E0909）：改为借出句柄。

出于同样的原因，没有 `Dyn(Reader)` 和 `Dyn(Writer)`。这两个 trait 的默认方法（`read_to_end`、`read_to_string`、`write_all`）返回借用 reader 或 writer 的 future，而 vtable 的 future 类型不携带借用，因此对任何实现者，把 `dyn(r)` 当作这两种 trait 对象都是 E0909。请改用泛型 `Impl(Reader)` / `Impl(Writer)` 参数。

### 析构函数：`Drop`

`Drop` 是析构 trait，其方法 `drop` 采用 Rust 的语义：析构函数会自动运行且恰好运行一次——在所有者 drop 该值时，或在最后一个 `Rc`/`Arc` 引用消失时；实现它的值类型是只能移动的。它的接收者与 Rust 的 `drop(&mut self)` 一致：`drop : (fn(self : &mut Self) -> unit)`，因此析构函数可以在字段被 drop 之前把某个字段取出或重置（`self.f = .None`），而声明为 `self : &Self` 的 impl 不符合该 trait。

手动调用析构函数是错误 E0915，与 Rust 相同：`x.drop()`、`Fd.drop(&x)` 和 `(Fd <: Drop).drop(&x)` 会在值仍然存活时再运行一次析构函数。把它当作值读取（`f := Fd.drop`）也是 E0915，因为通过 `f` 调用会造成同样的结果。其他 trait 中恰好名为 `drop` 的方法是普通方法，可以直接调用，也可以通过 `Dyn` 调用。析构函数也不调用其字段的析构函数：字段会在它返回后自行 drop。要提前结束一个值，请把它传给 prelude 的 `drop(x)`：它把值移入，并在调用返回时 drop 它；之后再使用 `x` 是 E0901。

```yo
{ println } :: import("std/fmt");
Fd :: struct(n : i32);
impl(Fd, Drop(drop : (fn(self : &mut Self) -> unit)(println(`closing ${self.n}`))));

main :: (fn() -> unit)({
  a := Fd(n : i32(3));
  drop(a); // 现在打印 "closing 3"
  // a.drop()      // E0915：显式调用析构函数
  // a.n           // E0901：使用已移动的值 `a`
});
export(main);
```

必须在其他引用可能仍然存活时就释放的资源，提供一个普通方法供析构函数委托，例如 `TcpStream.close_sync()`。

## 指针

Yo 使用指针 (`*(T)`) 进行直接内存访问，类似 C。对原始指针的解引用、算术运算等危险操作需要显式 `unsafe(...)` 包装 — 详见下文 [内存安全](#内存安全)。

```yo
// 指针类型：*(T)
x := 1;
y := 2;

swap :: (fn(a : *i32, b : *i32) -> unit)(
  unsafe({
    tmp := a.*; // 解引用指针
    a.* = b.*;
    b.* = tmp;
  })
);

swap(addr_of(x), addr_of(y)); // 传入 x 和 y 的指针
// 现在 x == 2, y == 1
```

日常的就地修改应优先使用 `name : &mut T` 参数形式（见[Type Methods](./FUNCTIONS.md#类型方法)）——它在 C 中降为相同的 `T*` ABI，但保持安全，调用方用 `&mut` 借出位置（`swap(&mut x, &mut y)`），而不是取裸地址。原始 `*(T)` 仅保留给 FFI 和本节涉及的底层场景。

当 `x` 是 `&T` 参数或其中的位置（`addr_of(x.field)`）时，`addr_of(x)` 是错误 E0921：`&T` 参数作为调用方值的副本传入，因此它的地址是被调用方的副本，调用返回后即悬空。需要调用方地址的代码应接受 `x : *T` 并由调用方传入 `addr_of(place)`，或接受按指针传递的 `x : &mut T`。投影（返回 `&T` 或 `&mut T` 的函数）的 `&T` 参数按指针传递，保留 `addr_of`；prelude 中 `Array` 的 `Index` 实现正是这样取得元素的。

### 指针操作

```yo
// 使用 addr_of 创建指针
x := 42;
ptr := addr_of(x); // ptr: *(i32)
// 使用 .* 解引用（需要 unsafe — 可能读取无效内存）
value := unsafe(ptr.*); // value == 42
// 通过指针修改（需要 unsafe — 可能写入悬空指针）
unsafe(ptr.* = 100); // x 现在是 100
// 指针算术（需要 unsafe — 可能产生越界地址）
arr := [1, 2, 3, 4, 5];
ptr := addr_of(arr(0)); // 指向第一个元素的指针
ptr2 := unsafe(ptr.add(2)); // 指向第三个元素
value := unsafe(ptr2.*); // value == 3
// 指针类型转换（安全 — 只修改地址的类型标签）
float_ptr := (*f32)(ptr); // 将指针转换为 *(f32)
```

### 指针算术与比较

指针算术使用方法 — `p.add(n)`、`p.sub(n)`、`p.offset_from(q)` — 需要 `unsafe(...)` 包装；指针比较使用普通运算符（`==`、`!=`、`<`、`<=`、`>`、`>=`，经由 `*(T)` 上的 `Eq`/`Ord` impl）并保持安全 — 比较地址本身不会破坏内存安全。注意 `*(T) ==` 比较的是地址（同一性），而 `Rc(T)` 这样的句柄通过自己的 `Eq` impl 比较值。

```yo
pragma(Pragma.AllowUnsafe); // 原始指针需要 unsafe 能力的 pragma
{ assert } :: import("std/assert");

test("Pointer arithmetic", {
  x := 12;
  p := addr_of(x);

  // 加法和减法（需要 unsafe — 可能产生越界地址）
  q := unsafe(p.add(2)); // 指针前进 2 个元素
  z := unsafe(q.sub(2)); // 指针后退 2 个元素
  // 比较运算符（安全 — 地址只是数据）
  assert(q > p); // q 在 p 之后
  assert(p < q); // p 在 q 之前
  assert(q >= p); // 大于等于
  assert(p <= q); // 小于等于
  assert(z == p); // 相等（相同地址）
  assert(p != q); // 不相等
  // 指针差值同样需要 unsafe（假定两指针指向同一对象）
  diff := unsafe(q.offset_from(p)); // 距离：2 个元素
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

```yo
// 不使用 consume - 错误：尝试 drop 未初始化的值
ptr.* = some_value; // 危险！
// 使用 consume - OK：初始化，不 drop
consume(ptr.* = some_value);
```

对其他任何参数，`consume(x)` 会移动 `x`（之后再使用会报 "use of moved value"）；由于它返回 `unit`，它就是该值的最后一个所有者：被拥有的值在 consume 处释放，与 `drop(x)` 的释放完全相同。不拥有其值的绑定（`&T` 借用）只会被标记为已移动。

更多指针示例请参阅 `tests/ptr.test.yo`。

### 可空指针

Yo 使用 `Option(*(T))` 来表示可空指针：

```yo
// malloc 返回 Option(*(T))
some_ptr := malloc(size_of(i32));
match(
  some_ptr,
  .Some(ptr) => {
    ptr.* = 42;
    printf("value: %d\n", ptr.*);
    free(some_ptr);
  },
  .None => printf("Allocation failed\n")
);
```

**注意**：裸指针是不安全的。请尽可能使用 `Rc`、`Arc`、`Box` 和拥有所有权的集合来进行安全的内存管理。

### 句柄的 `Option` 就是一个指针

当 `T` 是裸指针**或**计数或装箱的句柄（`Rc`、`Arc`、`Box`）时，`Option(T)` 直接编译为裸指针，用 `NULL` 表示 `.None`。同样的 niche 优化也适用于「一个无字段变体 + 一个单字段句柄载荷」的二变体枚举。没有 tag 字、没有额外填充：`size_of` 就是指针本身的大小，对这类值的 `match` 编译为一次 NULL 判断。

```yo
pragma(Pragma.AllowUnsafe); // 仅为让 size_of 能写出指针类型

sz_opt :: size_of(Option(*i32)); // == size_of(*i32) —— 就是指针本身
sz_str :: size_of(String); // == size_of(*u8)   —— 就是句柄本身
Tree :: enum(Empty, Node(child : Rc(Self)));
sz_tree :: size_of(Tree); // == size_of(*u8)   —— NULL 即 Empty
```

### 内存安全

面向用户的指南见 [MEMORY_SAFETY.md](MEMORY_SAFETY.md) —— 覆盖默认安全的契约、`&mut T` 参数、`pragma(Pragma.AllowUnsafe);` opt-in、`unsafe(...)` 逐操作包装、`// SAFETY:` 注释约定、`yo unsafe-report`、`unwrap` 禁令，以及整数算术规则（溢出、除以零和越界移位都会中止程序）。

所有权、移动与拷贝、`&T`/`&mut T` 引用及其来源，以及编译器检查的借用规则，见 [OWNERSHIP_AND_BORROWING.md](OWNERSHIP_AND_BORROWING.md)。

Yo 的安全模型是分层的（设计计划见 [plans/reference/MEMORY_SAFETY.md](../../plans/reference/MEMORY_SAFETY.md)）：

- **`Rc(T)`** 是引用计数的单元，在最后一个句柄处自动释放（环会泄漏，除非用 `Weak` 打破），从构造上保证内存安全。
- **`Arc(T)`** 提供跨线程的原子 RC 共享所有权；`Send` 值通过移动转移到另一个线程。
- **`*(T)` 原始指针**的解引用、算术运算和「穿透指针的 `consume`」操作必须显式包裹在 `unsafe(...)` 中，否则编译报错。

`unsafe(...)` 是一个普通的内建函数调用，接受一个表达式作为参数。它纯粹是编译时标记 — 在代码生成阶段会被还原为其内部表达式，没有运行时开销。

```yo
// 指针解引用需要 unsafe：
read :: (fn(p : *i32) -> i32)(unsafe(p.*));

// 指针算术同样：
advance :: (fn(p : *i32, n : usize) -> *i32)(unsafe(p.add(n)));

// 使用块的多语句 unsafe：
write_and_read :: (fn(p : *i32, v : i32) -> i32)(
  unsafe({
    p.* = v;
    p.*
  })
);

// 指针比较（==、< 等）和 *(T) 类型转换（如 (*u8)(p)）
// 保持安全 — 它们不解引用，因此不被门控。
```

**需要 `unsafe(...)` 的操作**：指针解引用（`.*`）、指针算术（`.add(n)`、`.sub(n)`、`.offset_from(q)`）、对指针解引用的 `consume(p.* = v)`。

**仍然安全的操作**：取地址（`addr_of(x)`）、传递/存储/返回指针、指针比较（`<`、`==` 等）、指针类型转换（`(*u8)(p)`）、`asm(...)`（本身已经隐式不安全）。

不安全表面是可 grep 的：每个 `unsafe(` token 都标记了一处原始内存操作。文件必须在顶部声明 `pragma(Pragma.AllowUnsafe);` 才能使用 `unsafe(...)` 或执行原始指针操作。`std/`、`src/` 和 `tests/` 下的文件都显式声明了此 pragma；用户代码（`main.yo` 及项目中的其他文件）默认是安全模式，若尝试使用 `unsafe(...)` 将得到编译错误。

如需一目了然地审计，运行 `yo unsafe-report`（或 `yo unsafe-report ./std` 仅扫描标准库）。它列出每一处 `unsafe(...)` 站点、`asm(...)` 块、`extern(...)` 声明以及声明 pragma 的文件，带 `file:line:col` 跳转格式以方便编辑器查看。`--json` 标志输出机器可读格式，便于 CI 集成。

```yo ignore
// 没有 pragma 的文件 — `unsafe(...)` 被拒绝：
main :: (fn() -> unit)({
  x := i32(42);
  v := unsafe(x); // error: 'unsafe(...)' is not available in safe code.
  //        To use raw pointer operations, declare at the top:
  //            pragma(Pragma.AllowUnsafe);
});
```

```yo
// 在文件顶部添加 pragma 即可启用：
pragma(Pragma.AllowUnsafe);

main :: (fn() -> unit)({
  x := i32(42);
  p := addr_of(x);
  v := unsafe(p.*); // OK
});
```

### `&mut` 参数

要在不使用原始指针的情况下实现原地修改，请使用 `name : &mut T` 参数。`&mut` 加在参数类型之前，参数行为类似于调用方变量的绑定 — 读取访问当前值，写入更新调用方的存储。在代码生成时 `name : &mut T` 在 C 中降低为 `T*`；调用方用 `&mut x` 借出该位置，编译器传递它的地址。

```yo
{ assert } :: import("std/assert");

swap :: (fn(a : &mut i32, b : &mut i32) -> unit)({
  tmp := a.*;
  a.* = b.*;
  b.* = tmp;
});

increment :: (fn(n : &mut i32) -> unit)({
  n.* = (n.* + i32(1));
});

main :: (fn() -> unit)({
  mut(x) := i32(1);
  mut(y) := i32(2);
  swap(&mut x, &mut y); // 调用点用 `&mut` 借出每个位置
  assert(x == i32(2), "swapped");
  assert(y == i32(1), "swapped");

  mut(counter) := i32(0);
  increment(&mut counter);
  increment(&mut counter);
  assert(counter == i32(2), "incremented");
});
```

`&mut T` 参数不能与 `sink(...)`（相反的调用约定）或 `generic(...)` 组合使用；编译期参数把模式写在类型上（`comptime(x) : &mut T`）。对于链式调用，将 `&mut T` 参数传递给另一个函数的 `&mut T` 参数按预期工作（该参数本身已持有借用，所以直接书写）：

```yo
double :: (fn(n : &mut i32) -> unit)({
  n.* = (n.* + n.*);
});

double_both :: (fn(x : &mut i32, y : &mut i32) -> unit)({
  double(x); // 将借用透传给 double 的 `&mut` 参数
  double(y);
});
```

### RAII（资源获取即初始化）

Yo 自动管理内存：拥有所有权的值在其所有者的作用域结束时被 drop，计数单元（`Rc`、`Arc`）在引用计数降为零时被释放。

```yo
test :: (fn() -> unit)({
  x := String.from("World!"); // RC = 1
  // ... 使用 x ...
  // 作用域结束时，RC 递减
  // 如果 RC 降为 0，内存自动释放
});
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

#### HKT Trait

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

#### 使用 HKT where 子句的泛型函数

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

### 广义代数数据类型（GADTs）

GADTs 扩展了枚举类型，允许每个构造器通过 `-> recur(Type1, ...)` 指定其返回的精确类型参数实例化：

```yo
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

```yo
eval_value :: (fn(generic(T : Type), v : Value(T)) -> T)(
  match(
    v,
    .IntVal(i) => i,
    // T 被细化为 i32，返回 i32 ✓
    .BoolVal(b) => b,
    // T 被细化为 bool，返回 bool ✓
    .PairVal(a, b) => a // T 被细化为 i32，返回 i32 ✓
  )
);

v := Value(i32).IntVal(i32(42));
result := eval_value(v); // result : i32 = 42
```

#### GADT 穷尽性检查

当匹配具有具体类型的 GADT 值时，不可达的变体会从穷尽性检查中排除：

```yo
// Value(i32) 只能是 IntVal 或 PairVal
// BoolVal 不可达（它返回 Value(bool)，而不是 Value(i32)）
eval_int_only :: (fn(v : Value(i32)) -> i32)(
  match(
    v,
    .IntVal(i) => i,
    .PairVal(a, b) => a
    // 不需要 .BoolVal —— 对于 Value(i32) 它不可达
  )
);
```

为被排除的变体编写分支是错误（E0608）：没有任何 `Value(i32)` 持有 `.BoolVal`。在针对 `Value(T)` 的泛型函数中，每个变体的分支都是需要的，因为不同的实例化会排除不同的变体。

#### GADT 索引属于类型本身

`Value(i32)` 与 `Value(bool)` 是不同的类型，即使它们的负载形状相同；一个变体只能构造其 `-> recur(...)` 索引所指的实例：
`Value(i32).BoolVal(true)` 与 `(v : Value(i32)) = .BoolVal(true)` 都是 E0601 错误。详见 [GADTS.md](GADTS.md)。

#### 多参数 GADTs

```yo
MyPair :: (fn(comptime(A) : Type, comptime(B) : Type) -> comptime(Type))(
  enum(
    MkIntBool(x : i32, y : bool) -> recur(i32, bool),
    MkBoolInt(x : bool, y : i32) -> recur(bool, i32)
  )
);

my_fst :: (fn(generic(A : Type, B : Type), p : MyPair(A, B)) -> A)(
  match(
    p,
    .MkIntBool(x, y) => x,
    .MkBoolInt(x, y) => x
  )
);
```

#### 带自定义判别值的 GADTs

```yo
Tagged :: (fn(comptime(T) : Type) -> comptime(Type))(
  enum(
    (TagInt(i : i32) -> recur(i32)) = 10,
    (TagBool(b : bool) -> recur(bool)) = 20
  )
);
```

#### 混合 GADT 和普通变体

```yo
MixedVal :: (fn(comptime(T) : Type) -> comptime(Type))(
  enum(
    MInt(i : i32) -> recur(i32),
    MBool(b : bool) -> recur(bool),
    MGeneric(v : T) // 无 GADT 注解 —— 无约束
  )
);
```

GADTs 具有与普通枚举相同的运行时表示——所有类型细化都纯粹是编译时的。完整设计文档请参阅 [GADTS.md](GADTS.md)。

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

## Traits

Trait 定义了一组可以为类型实现的函数和类型集合。它们的工作方式类似于 Rust 中的 trait。注意，`impl` 的第一个参数是接收者类型，后跟 trait 实现。

Trait 被定义为一个返回 `Trait` 类型的函数，其中包含字段定义。

```yo
// 定义一个 trait（类似于 Rust 中的 trait）
Summary :: trait(
  summarize : (fn(self : &mut Self) -> String)
);

Display :: trait(
  display : (fn(self : &mut Self) -> String),
  where(Self <: Summary) // 约束
);

NewsArticle :: struct(
  headline : String,
  location : String,
  author : String,
  content : String
);

// 为 NewsArticle 实现 Summary trait
impl(
  NewsArticle,
  Summary(
    summarize : (
      self ->
        `${self.headline}, by ${self.author} (${self.location})`
    )
  )
);

// 为 NewsArticle 实现 Display trait
impl(
  NewsArticle,
  Display(
    display : (
      self ->
        `Headline: ${self.headline}\n`
    )
  )
);

// 传入函数
notify :: (fn(item : &mut NewsArticle) -> unit)({
  println(`Breaking news! ${item.summarize()}`);
});

// 带 trait 约束的泛型函数
notify2 :: (fn(generic(T : Type), item : &mut T, where(T <: Display)) -> unit)({
  println(`Breaking news! ${item.summarize()}`);
  println(`Breaking news! ${item.display()}`);
});
```

### 静态 trait 方法

没有 `self` 参数的 trait 方法就是静态方法。可以在实现了该 trait 的类型上调用（`Point.make(...)`），也可以在受该 trait 约束的类型参数上调用（`T.make(...)`）。构造器风格的 trait 就是这样写的，`FromJson` 的 `from_json(v)` 即是一例。

```yo
{ println } :: import("std/fmt");

// 没有 `self` 的 trait 方法是静态（构造器风格）方法。
Make :: trait(make : (fn(n : i32) -> Self));

Point :: struct(x : i32, y : i32);
impl(Point, Make(make : (n -> Point(x : n, y : n))));

Meters :: struct(v : i32);
impl(Meters, Make(make : (n -> Meters(v : (n * i32(1000))))));

// 在类型上调用，或在泛型函数体中通过类型参数调用。
build :: (fn(comptime(T) : Type, n : i32, where(T <: Make)) -> T)(T.make(n));

main :: (fn() -> unit)({
  p := Point.make(i32(3));
  m := build(Meters, i32(2));
  println(`${p.x} ${p.y} ${m.v}`); // 3 3 2000
});
export(main);
```

### trait 的 `where` 子句与关联类型

trait 要先声明关联类型，再声明引用它的成员（先写 `Item : Type`，再写 `next : (fn(...) -> Option(Self.Item))`）。它的 `where` 子句可以借助自身的投影去约束**另一个**类型，`IntoIterator` 的 `where(Self.IntoIter <: Iterator(Item := Self.Item))` 就是如此。但不能把 `Self` 本身的关联类型绑定到 `Self` 自己的投影上：

```yo
Source :: trait(Item : Type, pull : (fn(self : &mut Self) -> Option(Self.Item)));

// 错误：Expected type for associated type constraint "Item", got: (Self.Item)
Peekable :: trait(
  Item : Type,
  peek : (fn(self : Self) -> Option(Self.Item)),
  where(Self <: Source(Item := Self.Item))
);
```

下面两种写法都可以：

```yo
Source :: trait(Item : Type, pull : (fn(self : &mut Self) -> Option(Self.Item)));

// 约束 `Self`，但不绑定它的关联类型……
Rewindable :: trait(
  rewind : (fn(self : &mut Self) -> unit),
  where(Self <: Source)
);

// ……或者借助 `Self.Item` 约束另一个关联类型。
Pullable :: trait(
  Item : Type,
  Iter : Type,
  source : (fn(self : Self) -> Self.Iter),
  where(Self.Iter <: Source(Item := Self.Item))
);
```

### 一致性：每个类型对每个 trait 只有一个 impl

在整个程序中，一个类型最多实现某个 trait 一次（`plans/reference/TRAIT_COHERENCE.md`）。以下情况都是错误 E0612：

- 第二个 `impl(P, Summary(...))`，无论在同一模块还是其他模块；
- 被导入的模块或 prelude 已经为该类型实现过的 trait，再写一个 impl，例如 `impl(i32, ToString(...))`；
- 一揽子 impl（`impl(generic(T), where(T <: Bound), T, Summary(...))`）与某个满足 `Bound` 的类型的 `Summary` 具体 impl 同时存在，无论注册顺序。

Yo 没有特化，更具体的 impl 不会覆盖更一般的 impl；在此规则之前，先注册的 impl 会静默胜出，另一个成为死代码。泛型 trait 的两个实例是不同的 trait（`Eq(String)` 与 `Eq(str)`），约束互不重叠的一揽子 impl 也没有问题。

### Trait 方法消歧义

当一个类型实现了多个定义了同名方法的 trait 时，`where` 子句约束决定使用哪个 trait 的方法：

```yo
T1 :: trait(get_number : (fn(self : Self) -> i32));
T2 :: trait(get_number : (fn(self : Self) -> i32));

Point :: struct(x : i32, y : i32);
impl(Point, T1(get_number : (self -> self.x)));
impl(Point, T2(get_number : (self -> self.y)));

// 隐式分派 — where(T <: T1) 约束 self.get_number() 只使用 T1 的方法
use_t1 :: (fn(generic(T : Type), self : T, where(T <: T1)) -> i32)({
  return(self.get_number()); // 返回 self.x (10)
});

// 显式分派 — 使用 (T <: T2).method(self) 语法
use_t2 :: (fn(generic(T : Type), self : T, where(T <: T2)) -> i32)({
  return((T <: T2).get_number(self)); // 返回 self.y (20)
});

point := Point(10, 20);
use_t1(point); // 10
use_t2(point); // 20
```

## 字符串

### 字符串字面量作为 `str` 或 C 字符串指针

```yo
s := "Hello"; // s : str —— 字符串字面量就是内建的静态字符串视图 `str`。
(s2 : *u8) = "Hi"; // 可以显式声明一个 C 字符串指针。
s3 := (*u8)("Hi"); // 或使用指针类型转换获取 C 字符串指针。
```

### String（可增长字符串）

堆分配的可增长 UTF-8 字符串，与 Rust 的 `String` 形态一致。它**不是**不可变的：
`push_str`、`push_string`、`push_byte`、`push_rune`、`reserve`、`clear`、
`truncate`、`insert_str`、`insert`、`remove` 和 `pop` 接受 `self : &mut Self`
并就地修改；而 `+` 之类的运算符仍然产生新字符串。

增量拼接请使用 `StringBuilder`：它是一个拥有自己字节缓冲区的值
——`b2 := b` 是移动，`b.clone()` 是独立副本，
`into_string()` 把缓冲区直接交还为 `String`，不新分配。需要多个所有者
共享的构建器写作 `Rc(RefCell(StringBuilder))`。

```yo
s := String.new();
s2 := String.from("Hello World!");
s3 := (s + s2); // 创建一个新字符串。
```

#### 通过 `String` 的副本写入

`clone()` 才是独立的副本：它复制字节（O(n)），所以对克隆所做的任何事都不会通过原值
看到，反之亦然，无论原值是否为空。每个修改方法都接受 `self : &mut Self` 并就地写入，空
`String` 在第一次写入之前不分配任何内存。

`String` 唯一地拥有自己的字节（`newtype(_bytes : ArrayList(u8))`，而 `ArrayList`
是值类型）。因此普通的复制就是移动：`t := s`、用 `s` 构造结构体、按值传递 `s`，都会把
字符串交出去，之后再使用 `s` 是 E0901，其帮助信息会给出 `s.clone()`。从集合中读出的值
要么就地借用，要么克隆（`xs.get_cloned(i)`）。没有任何缓冲区是共享的，所以写入不会经由
另一个名字影响到字符串
（`issues/fixed/a-write-through-a-string-copy-is-lost-when-the-string-was-empty.md`，
由此修复）。

写入落在被写的位置上：

- **`&T` 参数** `fn(out : &String)` 借用调用方的值。写入它
  （`out.push_str("!")`，或把它传给 `&mut T` 形参）是 E0908。要修改调用方的字符串，
  请接受 `out : &mut String`；要产生新字符串，请按值接受 `out`（普通的
  `out : String` 拥有其实参，可以写入）并返回它。
- **`for` 或 `match` 的绑定**同样是借用：`for(xs, s => s.push_str("!"))` 是
  E0908。`for(&mut xs, s => s.push_str("!"))` 会就地写入每个元素，
  `xs(i).push_str("!")` 也一样。
- **结构体字段**通过它的位置写入：在 `p : &mut T` 形参或局部变量上写
  `p.name.push_str("!")`。

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");
{ ArrayList } :: import("std/collections/array-list");

// `&mut T` 参数传入的是调用方的变量本身。
append_mut :: (fn(out : &mut String) -> unit)({
  out.push_str("!");
});

// `&T` 参数是借用的：写一个局部克隆并返回它。
with_bang :: (fn(s : &String) -> String)({
  mut(t) := s.clone();
  t.push_str("!");
  t
});

main :: (fn() -> unit)({
  a := String.from("hi");
  mut(b) := a.clone(); // b 拥有自己的一份字节
  b.push_str("?"); // a 不受影响
  println(`"${a}" "${b}"`); // "hi" "hi?"

  e := String.new();
  mut(f) := e.clone();
  f.push_str("x"); // 无论是否为空，克隆都是独立的
  println(`"${e}" "${f}"`); // "" "x"

  mut(c) := String.new();
  append_mut(&mut c);
  d := with_bang(&a);
  println(`"${c}" "${a}" "${d}"`); // "!" "hi" "hi!"

  mut(names) := ArrayList(String).new();
  names.push(String.new());
  names.push(String.from("n"));
  for(&mut names, s => {
    s.push_str("!"); // 就地写入元素
  });
  println(`"${names(usize(0))}" "${names(usize(1))}"`); // "!" "n!"
});
export(main);
```

由于 `String` 之外的任何东西都不能写它的缓冲区，字节 API 只复制或移动，不出借：
`to_bytes()` 返回一个独立的 `ArrayList(u8)`；`into_bytes()` 消耗字符串并把缓冲区
移出（没有其他副本共享时不复制）；`from_bytes(sink(bytes))` / `from_utf8(sink(bytes))`
接管传入的列表。就地读取字节用 `len()`、`byte_at(i)`、`get_byte(i)` 和 `bytes()`；
运行期的 `String` 没有 `s(i)`（见 [STRINGS.md](./STRINGS.md)）。

#### 使用 `${}` 语法的模板字符串插值：

模板字符串的工作方式类似于 JavaScript 的模板字面量，允许你使用 `${}` 语法在字符串中嵌入表达式。`${}` 内的值必须实现 `ToString` trait 才能被转换为 `String`。

```yo
name := "Alice";
age := 16;
greeting := `Hello, ${name}!, age: ${age}`;
// greeting: String
// 值为 "Hello, Alice!, age: 16"
```

含两个或更多部分的模板只构建一个 `String`，并按顺序把各部分追加进去：字面量部分用 `push_str`，插值部分用 `ToString.append_to(self, out : &mut String)`。`append_to` 的默认实现追加 `self.to_string()`；`String` 和 `str` 以借用方式追加自己的字节，因此 `String` 部分不会先被复制一次。类型可以重写 `append_to`，把自己的文本直接写入结果。只有一个部分的模板（`${s}`）就是 `s.to_string()`。

##### 格式说明符 —— `${value:spec}`

插值可以在冒号后带一个格式说明符，语法与 Rust、Python 一致（不支持动态宽度与精度）：

```text
spec  := [[fill]align][+][#][0][width][.precision][kind]
align := "<" | ">" | "^"
kind  := "x" | "X" | "b" | "o"
```

```yo
name := `ada`;
n := i32(255);
pi := f64(3.14159);

`[${name:>8}]`; // "[     ada]"   右对齐至宽度 8
`[${name:<6}]`; // "[ada   ]"     左对齐
`[${name:^7}]`; // "[  ada  ]"    居中
`[${name:*>6}]`; // "[***ada]"     自定义填充字符
`${n:x}`; // "ff"           小写十六进制
`${n:#06x}`; // "0x00ff"       替代形式并补零
`${pi:.2}`; // "3.14"         保留两位小数
`${pi:>8.3}`; // "   3.142"     宽度在精度之后生效
```

宽度以**字符**计。数字补零时，零位于符号或进制前缀与数字之间——`${i32(-(42)):08}`
得到 `-0000042`，而非 `000-0042`。

数字支持全部部分：符号、进制与补零，以及宽度、填充、对齐与截断。文本、`bool`、`Option`、`Result`、`ArrayList` 以及其他实现了 `ToString` 的 std 类型通过 `Format` 的默认成员支持宽度、填充、对齐与截断。由于没有一揽子 impl（见上文“一致性”），自定义类型用一行代码接入：

```yo
impl(Point, ToString(to_string : (self -> `(${self.x}, ${self.y})`)));
impl(Point, Format());
`[${Point(x : i32(1), y : i32(2)):>8}]` // "[  (1, 2)]"
```

说明符与表达式之间以冒号分隔，且**冒号前不能有空格**。带空格的冒号不会被拆分，因此插值中
普通的冒号对保持原义；位于调用参数或字符串字面量内部的冒号——如 `${parts.join(":")}`
——也绝不会被误判为分隔符。

## Box：唯一所有的单元

`Box(T)` 是只有一个所有者、没有引用计数的堆单元，类似 Rust 的 `Box<T>`。递归类型和
需要稳定地址的值使用它；值需要共享时使用 `Rc`。

```yo
Tree :: enum(
  Leaf(v : i32),
  Node(l : Box(Self), r : Box(Self))
);
sum :: (fn(t : &Tree) -> i32)(
  match(
    t,
    .Leaf(v) => v.*,
    .Node(l, r) => (sum(&l.*.*) + sum(&r.*.*))
  )
);
t := Tree.Node(Box.new(Tree.Leaf(1)), Box.new(Tree.Leaf(2)));
assert(sum(&t) == 3);
```

- **`Box.new(v)`** 把 `v` 移入一个新单元。`b.*` 是载荷的位置，在安全代码中同样可用：
  `b.* = v` 替换载荷，`b.field` / `b.method()` 通过自动解引用访问载荷。模式用 `Box(p)`
  穿过 `Box` 的载荷进行匹配，与用 `Rc(p)` 穿过 `Rc` 相同；目前不写 `Box(…)` 也会穿透。
- **显式复制。** `Box` 永远不是 `Copy`。当 `c := b` 是 `b` 的最后一次使用时，它移动
  `b`；其他任何复制都是 E0901。`Box.clone(b)` 是深拷贝：一个持有载荷克隆的新单元
  （`b.clone()` 是 E0616，因为载荷可能有自己的 `clone`）。`T` 实现 `Clone` 时
  `Box(T)` 才实现 `Clone`，所以装着仅可移动值的 `Box` 也是仅可移动的。
- **一次释放。** 丢弃 `Box` 时会丢弃其载荷并释放单元。`ref_count(b)` 是编译错误：
  它没有计数。
- **移出载荷。** `b.into_inner()` 消耗 `Box`、释放单元并返回载荷，因此仅可移动的载荷
  无需复制即可离开单元（`RefCell.into_inner` 和 `BufWriter.into_parts` 用的就是它）。
- **`Eq`、`Hash` 和 `Default`** 比较、哈希和构造的都是载荷。`T` 是 `Send`/`Sync`
  时 `Box(T)` 才是。
- **布局。** `Box` 值是一个指针，`Option(Box(T))` 也是一个指针（`NULL` 即
  `.None`）。全局单元就是载荷本身，与 Rust 一样占 `size_of(T)` 字节，零大小的载荷不分配任何内存。由 `alloc` 参数放置的单元在载荷前带有 16 字节的所有者前缀，记录放置它的分配器，句柄用指针的第 0 位标明这一点（每个单元至少按 16 字节对齐，所以这一位是空闲的）。`Box` 的载荷可以是非定长类型（`comptime(V) : ?Sized`）：`Box([T])` 或 `Box(Dyn(T))` 的句柄是两个字。
- **分配器。** `Box.new(v, alloc : .Some(a))` 把单元放在 `a` 中；不传 `alloc` 时单元
  使用全局分配器。单元通过其所有者释放，
  `Box.clone(b)` 落在 `b` 所在的位置（由显式分配器放置的 box 克隆到同一个分配器中）。
  `Box.allocator(b)` 读回所有者（全局分配器为 `.None`）。
- **环。** `Box` 是其所有者的值的一部分，所以经由 `Box` 闭合的 `Rc` 环就是这些
  `Rc` 单元的环：与其他环一样会泄漏，除非用 `Weak` 打破。

## Rc 和引用计数单元

Yo 提供了 `Rc`（用 `Rc.new` 构造）用于将值类型堆分配并自动进行引用计数。

### Rc 类型

> **⚠️ `Rc` 对应 Rust 的 `Rc`，而不是 Rust 的 `Box`。** Rust 的 `Box<T>` 是唯一
> 所有者——传递即移动，克隆即深拷贝。Yo 的 `Rc(T)` 是计数句柄：`Rc.clone(a)`
> **产生指向同一个堆上值的第二个句柄并增加引用计数**，与 Rust 的 `Rc::clone`
> 完全一致。
>
> ```yo
> a := Rc.new(i32(42));
> b := Rc.clone(a);          // 第二个句柄，而不是值的副本
> assert(ref_count(a) == usize(2), "a 和 b 指向同一个值");
> ```
>
> **第二个句柄要显式写出**：句柄是新的
> 所有者，所以共享在创建处可见。句柄的最后一次使用会移动它（`b := a` 之后不再
> 使用 `a`）；源值之后仍被使用的隐式拷贝是 E0901，其提示写出 `Rc.clone(a)`。
> `&Rc(T)` 形参借用句柄而不拷贝。持有句柄的值（结构体字段、`Option(Rc(T))`）
> 用 `.clone()` 拷贝，它会克隆每个句柄；闭包在捕获列表里取得第二个句柄：
> `{ a : Rc.clone(a) }() => a.*`。克隆通过类型来写（`Rc.clone(a)`），因为 `a.clone()` 可能指
> 负载自己的 `clone`。`Rc(T)` 和 `Arc(T)` 对任何 `T` 都实现 `Clone`，
> 克隆总是第二个句柄；深拷贝写作 `Rc.new(h.*.clone())`。泛型函数体按每个实例化检查，所以当 `T` 是
> 句柄时，在那里拷贝 `T` 同样要写 `.clone()`（`where(T <: Clone)`）。std 的泛型
> 读取方法也同样检查：`ArrayList(Rc(T)).get(i)`、`HashMap.get` 通过 `T` 拷贝元素，
> 所以元素是句柄时，这个调用就是 E0901，报在你的调用处，std 内的位置作为附注。
> 请用不拷贝的访问器读取句柄元素：原地读取 `xs(i)`、用 `xs.get_cloned(i)` 取得
> 第二个句柄，或 `xs.with(i, ...)`。
>
> 实际影响：共享是隐式的；`Rc` 形成的环若不打破就会泄漏（Rust 的 `Box` 根本无法
> 形成环；`Weak` 回边可以打破它，见 [Weak：不拥有的句柄](#weak不拥有的句柄)）；用
> `ref_count(b)` / `Rc.try_unwrap` 来询问唯一性。
>
> `Box` 是另一种类型：唯一所有、不计数的单元，类似 Rust 的 `Box<T>`
> （[Box：唯一所有的单元](#box唯一所有的单元)）。

`Rc(T)` 是一个泛型单元类型，可以包装任何值类型：

```yo
// Rc 定义在 std/prelude.yo 中
Rc :: (fn(comptime(V) : ?Sized) -> comptime(Type))(
  newtype(_cell : __yo_cell(V))
);
```

构造函数是 `Rc(T).new(value, (alloc : Option(Allocator)) ?= .None)`。它分配一个计数为 1
的新单元；计数用 `ref_count(x)` 读取。`Rc.new(v)` 从实参推断 `T`，`Box.new(v)` 和
`Arc.new(v)` 也一样；实参不携带类型时（例如枚举简写 `.None`、闭包字面量）写出类型：
`Rc(T).new(...)`。`alloc : .Some(a)` 把单元放到分配器 `a` 中；默认值 `.None` 把它放到
全局分配器（[EXPLICIT_ALLOCATORS.md](./EXPLICIT_ALLOCATORS.md)）。`dyn(Rc.new(v))`
在一个新的单元之上构造 `Rc(Dyn(Trait))`（[DYN_DESIGN.md](./DYN_DESIGN.md)）。

### 使用示例

```yo
// 包装一个基本值
i := Rc.new(42); // i: Rc(i32)
assert(i.* == 42); // 使用 .* 解引用
// 包装一个结构体
Point :: struct(x : i32, y : i32);
p := Rc.new(Point(x : 3, y : 4)); // p: Rc(Point)
assert(p.*.x == 3);

// 使用显式类型的 Rc
b := Rc(i32)(100); // 等同于 Rc.new(100)
// 载荷经由句柄是只读的（E0919）；通过“门”写入
m := Rc.new(i32(10));
Rc.make_mut(&mut m) = i32(20); // 原地写入：m 是唯一的句柄
assert(m.* == 20);
```

### 自动解引用

prelude 中的 `Deref` trait 给出 `w.*` 所代表的位置，`DerefMut` 是它的写入半边：

```yo ignore
Deref :: trait(Target : Type, deref : (fn(self : &Self) -> &Self.Target));
DerefMut :: trait(Target : Type, deref_mut : (fn(self : &mut Self) -> &mut Self.Target));
```

二者的选择方式与 `Index` 和 `IndexMut` 相同：读取 `w.*` 调用 `deref`；写入、
`&mut` 借出、`self : &mut Self` 接收者以及 `addr_of` 调用 `deref_mut`。只有
`Deref` 而没有 `DerefMut` 的类型，其 `.*` 是只读的；两个实现共用同一个 `Target`。

`Box`、`Rc` 和 `Arc` 是**句柄**：`w.*` 是其指针所指的载荷，由编译器直接读取，
它们的 `deref` 是 `&self.*.*`。`Rc` 和 `Arc` 没有 `DerefMut`，因为通过句柄
访问的载荷是只读的。对 `Deref` 类型，包装器自身没有的字段或方法会到载荷上查找：
`w.field` 即 `w.*.field`，`w.method()` 即 `w.*.method()`。

```yo
Point :: struct(x : i32, y : i32);
impl(Point, norm1 : (fn(self : &Self) -> i32)(self.x + self.y));
p := Rc.new(Point(x : 3, y : 4));
assert(p.x == 3); // p.*.x
assert(p.norm1() == 7); // p.*.norm1()
pp := Rc.new(Rc.new(Point(x : 1, y : 2)));
assert(pp.y == 2); // 嵌套包装器：pp.*.*.y
mut(b) := Box.new(Point(x : 3, y : 4));
b.x = 5; // 是一个位置：写入 b.*.x —— 只有 Box 有 DerefMut
assert(b.norm1() == 9);
```

- **两者都有的名字是错误（E0616）。** `Point` 派生了 `Clone`，`Rc` 也实现了
  `Clone`，因此 `p.clone()` 两种含义都有可能。用 `Rc.clone(p)` 调用 `Rc`
  自己的 `clone`（得到一个新的 `Rc`），用 `p.*.clone()` 调用载荷的（得到一个
  `Point`）；`yo fix` 会把调用改写为 `Rc.clone(p)`。只有一方拥有的名字无需
  选择，`p.*` 永远就是载荷本身。泛型函数体中的调用，例如
  `where(T <: Clone)` 下的 `x.clone()`，即使 `T` 是 `Rc` 也是约束提供的方法。
- **位置。** 在 `Box` 上，转发得到的字段是一个位置：`b.x = v` 以及
  `&mut self` 调用（如 `b.items.push(v)`）都写入载荷。通过 `Rc` 的同样写法
  是 E0919（见下文）：`Rc` 没有 `DerefMut`，其载荷通过句柄只读。在没有
  `pragma(Pragma.AllowUnsafe)` 的文件中，通过 `Arc` 写入同样会被拒绝
  （`a.n = v`，或 `self : &mut Self` 的 `a.bump()`）：请通过 `Mutex` 或原子
  类型修改 `Arc` 的载荷。
- **在 prelude 之外，`Deref` 需要非定长的 `Target`。** prelude 之外的 `Deref`
  或 `DerefMut` 实现，只有当 `Target` 是 `[T]`、`str`、`Dyn(...)` 或尾部非定长的
  结构体时才被接受。定长的 `Target` 和开放的类型变量是错误 E0622：包装定长
  载荷的类型应通过自己的字段和方法暴露它。
- 当包装器和载荷都没有这个名字时，错误信息会说明这一点：
  ``No field "z" on Rc(Point). `p` is a Rc(Point); its payload Point has no
  field "z" either.``（E0406；方法则为 E0610）。
- **被调用位置。** `p.items(i)` 对载荷的 `items` 进行索引，`p.f(x)` 调用载荷中
  保存函数的字段。包装器的方法与载荷的同名字段同样是 E0616。
- **把整个载荷当作引用：`as_ref`。** `Rc`、`Box` 和 `Arc` 都有
  `as_ref : (fn(self : &Self) -> &T)`（沿用 Rust 的名字）：在需要 `&T` 的地方
  （例如传给 `&T` 参数，`takes_point(p.as_ref())`），`h.as_ref()` 把载荷借出；
  `Rc.as_ref(h)` 是通过类型写出的同一个调用。结果可以直接传给调用，或先绑定
  再使用（`q := p.as_ref(); q.clone()` 调用的是载荷的 `clone`）。

**所有者。** 其他所有 `Deref` 类型都是非定长内容的所有者，它们的 `.*` 是其
`deref` 投影给出的位置。prelude 中的 `Array(T, N)` 和 std 中的
`ArrayList(T)` 都是所有者（`Target : [T]`，并实现 `DerefMut`），因此
`&list.*` 把列表的元素借出为 `&[T]`。持有 `[T]` 的用户类型也是：

```yo
{ assert } :: import("std/assert");
Ring :: struct(items : Array(i32, 3));
impl(Ring, len : (fn(self : &Self) -> usize)(usize(30)));
impl(Ring, Deref(Target : [i32], deref : (fn(self : &Self) -> &Self.Target)(&self.items.*)));
impl(Ring, DerefMut(Target : [i32], deref_mut : (fn(self : &mut Self) -> &mut Self.Target)(&mut self.items.*)));
count :: (fn(xs : &[i32]) -> usize)(xs.len());
main :: (fn() -> unit)({
  mut(r) := Ring(items : Array(i32, 3)(1, 2, 3));
  v := &r.*; // r.deref()：以 r 为根的视图
  assert(count(v) == usize(3));
  assert(r.len() == usize(30)); // 所有者自己的 len
  assert(r.*.len() == usize(3)); // 视图的 len
  assert(!r.is_empty()); // 只有视图有它：r.*.is_empty()
  w := &mut r.*; // r.deref_mut()：w 存活期间独占
  assert(count(w) == usize(3));
});
export(main);
```

- `&w.*` 即 `w.deref()`，`&mut w.*` 即 `w.deref_mut()`，其他位置的 `w.*` 是该
  调用的位置。视图借用所有者，因此视图存活期间，所有者不能被写入、移动或以
  `&mut` 借出（E0911）。
- **所有者自己的成员优先。** 只有视图拥有的成员通过 `.*` 访问；所有者拥有的
  成员属于所有者，因此上例中 `r.len()` 是 `Ring` 的，`r.*.len()` 是视图的。
  因此，给所有者新增成员会让原先访问视图同名
  成员的调用改为解析到所有者。
- **其他地方都不解引用。** `&Ring` 不能填入 `&[i32]` 形参：`count(&r)` 是
  E0601，其帮助信息给出 `count(&r.*)`。运算符的操作数也从不解引用。

### Rc 与赋值

重新赋值要求绑定以 `mut` 声明，而赋值表达式的值是句柄的**旧值**：

```yo
{ assert } :: import("std/assert");

test("Rc assignment behavior", {
  mut(x) := Rc.new(1);
  y := (x = Rc.new(2)); // y 获得旧值
  assert(x.* == 2); // x 现在指向新的 Rc
  assert(y.* == 1); // y 持有旧的 Rc
});
```

### Rc 与引用计数

`Rc(T)` 使用自动引用计数；第二个句柄写作 `Rc.clone`：

```yo
{ assert } :: import("std/assert");

test("Rc reference counting", {
  original := Rc.new(42);
  copy := Rc.clone(original); // 引用计数递增
  another := Rc.clone(copy); // 引用计数递增
  // 三者都指向同一个 Rc
  assert(original.* == 42);
  assert(copy.* == 42); // 共享的！
  assert(ref_count(another) == usize(3));

  // 变量离开作用域时引用计数递减
});
```

### 修改共享载荷：`RefCell`、`Rc.get_mut`、`Rc.make_mut`、`Rc.try_unwrap`

`Rc` 的载荷是共享的，因此**通过句柄只能读取**，与 Rust 相同。通过 `Rc` 的写入（`h.n = v`、`h.* = v`、`bump(&mut h.n)`、`h.items.push(v)`）是错误 E0919，错误信息会列出下面这些入口（`yo explain E0919`）：

- **`RefCell(T)`**（`std/sync/refcell`）是共享修改的载荷：`Rc(RefCell(T))`。访问限定在闭包内，与 `Mutex(T)` 相同：`with(v => ...)` 借出 `v : &T`，`with_mut(v => ...)` 借出 `v : &mut T`，二者都返回闭包的结果。Rust 的按值移动方法不向调用者借出任何东西：`replace(v)` 和 `take()`（要求 `T <: Default`）存入新值并返回旧值，`replace_with(v => ...)` 存入闭包根据 `v : &T` 算出的新值并返回旧值，`into_inner()` 消耗这个单元。与 Rust 的 `replace_with`（闭包是 `FnOnce(&mut T) -> T`）不同，这里的闭包是借到 `&T` 的 `Fn`，与 `with` 闭包体相同。多个 `with` 闭包体可以同时运行；`with_mut`（以及 `replace_with` 的闭包）只能单独运行，运行期间的冲突访问会 panic，与 Rust 的 `RefCell::borrow_mut` 相同。闭包体返回或 unwind 时标记被释放。`RefCell` 在 `T` 是 `Send` 时是 `Send`，但永远不是 `Sync`，因此 `Arc(RefCell(T))` 会被拒绝（跨线程请共享 `Arc(Mutex(T))`）。它也可以放在普通值中，此时可以通过 `&` 借用进行写入。

  ```yo
  { RefCell } :: import("std/sync/refcell");
  log := Rc.new(RefCell(i32).new(i32(0)));
  other := Rc.clone(log); // 指向同一个单元的第二个句柄
  other.replace_with(n => (n + i32(1)));
  assert(log.with(n => n) == i32(1), "seen through the first handle");
  ```

- **`Rc.make_mut(&mut h)`**（`T <: Clone`）是被写入的载荷：若另一个句柄共享该单元，`h` 先移到一个持有载荷克隆的新单元，因此其他句柄永远看不到这次写入。若 `h` 是唯一句柄，则就地写入。即 Rust 的 `Rc::make_mut`；克隆体现在名字里。

  ```yo
  a := Rc.new(Point(x : 1, y : 2));
  b := Rc.clone(a);
  Rc.make_mut(&mut b).x = 10; // b 得到自己的单元
  assert((a.x == 1) && (b.x == 10), "a is unchanged");
  ```

- **`Rc.try_unwrap(h)`** 消耗该句柄：若它是唯一句柄，返回 `.Ok(payload)`（单元被释放），否则返回 `.Err(h)`，即原句柄。它不需要 `Clone`。
- **`Rc.get_mut(&mut h)`** 在没有其他 `Rc` 或 `Weak` 共享该单元时为 `.Some(&mut T)`，即指向单元内部的引用，否则为 `.None`；它从不克隆，因此不需要 `Clone`。即 Rust 的 `Rc::get_mut`。

  ```yo
  h := Rc.new(i32(1));
  match(
    Rc.get_mut(&mut h),
    .Some(v) => {
      v.* = i32(2);
    },
    .None => ()
  );
  assert(h.* == i32(2), "the only handle writes in place");
  ```

这些入口与 Rust 一样通过类型调用，因此载荷上同名的方法仍可用 `h.name()` 调用。`Arc` 有同样的 `Arc.get_mut`、`Arc.make_mut` 和 `Arc.try_unwrap`（[ARC.md](./ARC.md)）。

### Weak：不拥有的句柄

`Weak(T)` 对应 Rust 的 `rc::Weak<T>`：`Rc.downgrade(&h)` 创建一个指向该单元、但不让载荷保持存活的句柄；
只要还有指向它的 `Rc`，`w.upgrade()` 就是 `.Some(handle)`，最后一个 `Rc` 消失后为 `.None`。最后一个 `Rc`
释放载荷，任一种类的最后一个句柄释放单元。`Weak` 没有 `Deref`，是显式复制的（`Weak.clone(&w)`），也不是
所有权图中的边，因此父指针 `Weak(RefCell(Node))` 不会闭合环。见 [WEAK.md](./WEAK.md)。

```yo
a := Rc.new(i32(7));
w := Rc.downgrade(&a);
assert(w.upgrade().is_some(), "alive while a is");
consume(a);
assert(w.upgrade().is_none(), "the last Rc dropped the payload");
```

### 何时使用 Rc

- **堆分配**：当你需要将值类型放在堆上时
- **共享所有权**：同一个值的多个句柄；共享修改通过 `Rc(RefCell(T))` 进行
- **共享的动态分发**：`dyn(Rc.new(v))` 构造一个 `Rc(Dyn(Trait))`，即多个句柄共享的一个 trait 对象；唯一所有的则是 `dyn(Box.new(v))`
- **递归类型**：仅当节点被共享时；唯一所有的节点组成的树使用 `Box`

```yo
impl(i32, SomeTrait(...));
use_dyn :: (fn(value : &Dyn(SomeTrait)) -> unit)({ ... });

// 一个 i32 放在共享的 trait 对象后面
(shared : Rc(Dyn(SomeTrait))) = dyn(Rc.new(i32(42)));
use_dyn(&shared.*);
```

## Impl 类型

`Impl(TraitName)` 创建一个表示实现了指定 trait 的任意类型。这类似于 Rust 中的 `impl Trait`。

### 基本用法

```yo
// 定义一个 trait
Id :: trait(
  id : (fn(self : Self) -> Self)
);

// 接受任何实现了 Id 的类型的函数
use_id :: (
  fn(
    generic(T : Type),
    value : T,
    where(T <: Id)
  ) -> T
)({
  return(value.id());
});

// 为 i32 实现 Id
impl(
  i32,
  Id(
    id : (
      self -> {
        printf("i32: %d\n", self);
        return(self);
      }
    )
  )
);

// 使用
result := use_id(42); // 打印 "i32: 42"，返回 42
```

### Impl 作为返回类型

`Impl` 可以在返回类型中用于静态分发：

```yo
RetI32 :: trait(
  return_i32 : (fn(self : &mut Self) -> i32)
);

// `Impl(Trait)` 是静态分发：每条路径必须返回同一个具体类型，由编译器推断。
// 一个分支返回 `bool`、另一个返回 `i32` 无法通过编译。
get_value :: (fn(use_bool : bool) -> Impl(RetI32))({
  cond(
    use_bool => return(i32(1)),
    true => return(i32(42))
  );
});

// 要从不同分支返回不同的具体类型，请擦除为 `Dyn`：
get_any :: (fn(use_bool : bool) -> Box(Dyn(RetI32)))({
  cond(
    use_bool => return(dyn(Box.new(true))),
    true => return(dyn(Box.new(i32(42))))
  );
});
```

**重要提示**：每个返回路径必须返回一个具体类型，而不是恰好实现了相同 trait 的不同类型。

### Impl 与多个 Trait

```yo
Speak :: trait(
  speak : (fn(self : Self) -> unit)
);

Run :: trait(
  run : (fn(self : Self) -> unit)
);

// 类型必须同时实现 Speak 和 Run
perform :: (
  fn(
    generic(T : Type),
    actor : T,
    where(T <: (Speak, Run))
  ) -> unit
)({
  actor.speak();
  actor.run();
});
```

## 动态分发

详细的动态分发文档请参阅 [DYN_DESIGN.md](./DYN_DESIGN.md)，了解 `Dyn` 和 `dyn` 的完整说明。

### `Dyn` 和 `dyn`

`Dyn(Trait, ...)` 是 trait 对象：任何实现了所列 trait 的具体类型，被擦除后通过虚表调用它的方法。它是非定长的，所以放在指针后面使用，由指针决定谁拥有它：`Box(Dyn(Trait))` 拥有它，`Rc(Dyn(Trait))` 共享它，`&Dyn(Trait)` 借用它。`dyn(...)` 是唯一的入口：`dyn(Box.new(v))`、`dyn(Rc.new(v))`、`dyn(Arc.new(v))`、`dyn(&v)` 和 `dyn(&mut v)` 擦除的是该指针的指向类型。

`dyn(...)` 所在的位置必须能指明要构造哪一个 `Dyn(...)` —— 参数、带标注的绑定 `(x : Box(Dyn(Trait))) = dyn(Box.new(v))`、声明的返回类型、结构体字段或集合元素槽位。在没有这类期望类型的位置直接写裸 `dyn(...)`（例如 `downcast(dyn(...), T)` 的第一个参数）是编译错误：`cannot infer the Dyn type of dyn(...) here — annotate the value or bind it first`。

**主要特性：**

- 所有权属于指针：`Box` 独占，`Rc`/`Arc` 共享且只读，`&`/`&mut` 借用
- `dyn(&v)` 不分配任何内存
- `downcast` 和 `upcast` 保持指针的种类
- 一个 `Dyn` 中可以有多个 trait：`Dyn(Speak, Run)`

`Dyn` 只能位于指针之后：裸的 `Dyn(Trait)` 值类型是 E0619，对普通值写的 `dyn(v)` 是 E0620（`dyn(Box.new(v))` 会为它装箱）。见 [DYN_DESIGN.md](./DYN_DESIGN.md)。

### 示例

```yo
{ println } :: import("std/fmt");
Speak :: trait(speak : (fn(self : &Self) -> i32));
Run :: trait(run : (fn(self : &Self) -> i32));
Dog :: struct(legs : i32);
impl(Dog, Speak(speak : ((self : &Self) -> i32(1))));
impl(Dog, Run(run : ((self : &Self) -> self.legs)));

act :: (fn(s : &Dyn(Speak, Run)) -> i32)(s.speak() + s.run());

main :: (fn() -> unit)({
  dog := Dog(legs : i32(4));
  a := act(dyn(&dog)); // 借用的 trait 对象：不分配
  (owned : Box(Dyn(Speak, Run))) = dyn(Box.new(Dog(legs : i32(3)))); // 拥有的 trait 对象
  b := act(&owned.*);
  total := (a + b);
  println(&total);
});
export(main);
```

## 存在类型

"存在类型"指一个具体类型被藏在接口之后的值：`∃T. (T, 对 T 的操作)`。Yo 以一个
单态化 C 后端负担得起的两种形式提供它，并且有意不提供第三种。按需求选择：

| 你想要…… | 用 | 藏的是什么，怎么藏 |
| --- | --- | --- |
| 把**不同**具体类型的值放进同一个变量、字段或集合，并对它们调用 trait 方法 | `Box(Dyn(Trait))` + `dyn(Box.new(v))`，或 `&Dyn(Trait)` + `dyn(&v)` | 类型被**擦除**：一个胖指针 `{data, vtable}`；使用者只能用到 vtable。只能通过 `downcast(&d.*, T)` 找回具体类型。 |
| 返回**一个**具体类型但不点名它（闭包、迭代器、future） | 返回位置的 `Impl(Trait)`、`Impl(Fn(...))`、`Impl(Future(T, E))` | 类型是**不透明的，但没有被擦除**：每条返回路径必须产出同一个具体类型，编译器对调用方做单态化，不装箱。 |
| 隐藏类型所依赖的**长度**或其他值（ATS / DML 里的 `[n:nat] list(a, n)`） | 一个普通的运行时值加上契约：`ensures(r.len() == ...)`、`requires(i < xs.len())`、`refine(T, p)` | 见证是验证器推理的**幽灵值**（[FORMAL_VERIFICATION.md](./FORMAL_VERIFICATION.md)）；运行时什么都不存在。 |

### 打包形式：`Dyn(Trait)`

```yo
Shape :: trait(area : (fn(self : &Self) -> f64));

// 异构列表：每个元素的具体类型已经消失，只剩 `Shape`。
mut(shapes) := ArrayList(Box(Dyn(Shape))).new();
shapes.push(dyn(Box.new(Circle(r : f64(1.0)))));
shapes.push(dyn(Box.new(Square(side : f64(2.0)))));
for(&shapes, s => println(s.area()));
```

trait 必须是对象安全的（接收者是 `&Self` 或 `&mut Self`、签名中没有其他
`Self`、没有 `generic(...)` 参数），每个元素通过它的 `Box` 拥有自己的载荷，
向更小的 trait 集合上转型必须显式写出：
`upcast(d, Dyn(Sub))`。详见 [DYN_DESIGN.md](./DYN_DESIGN.md)。

### 不透明形式：`Impl(Trait)` 与闭包

```yo
// 调用方写不出闭包的类型；编译器却精确地知道它。
make_counter :: (fn(start : i32) -> Impl(Fn() -> i32))(() => (start + i32(1)));
```

每个闭包都是自己的类型，所以一个 `Impl(Fn(...))` 槽只能装一个闭包，装它们的
容器是 `ArrayList(type_of(k))`——同一个容器里装两个不同的闭包需要
`Dyn(Fn(...))`（见[闭包类型限制](./CLOSURES.md#闭包类型限制)）。`Impl(Future(T, E))` 是
`async` 结果的同一形态。

#### 裸函数类型中不能出现 `Impl(Fn(...))`

`fn(...) -> R` 类型是一个 C 函数指针，所以这种类型的槽——运行时参数、
struct/enum/tuple/union 字段、函数结果——必须只有一种表示。`Impl(Fn(...))`
没有：每个返回 `Impl(Fn() -> i32)` 的函数都按值返回它自己的闭包结构体，
而接受 `Impl(Fn(...))` 参数的函数会按闭包分别特化。这样的槽在 `check` 时
被拒绝，正如 Rust 拒绝 `fn(i32) -> impl Fn() -> i32`：

```yo
// 错误：The function type fn(x : i32) -> Impl(Fn() -> i32) cannot be the
//        type of parameter "mk" ...
use_mk :: (fn(mk : (fn(x : i32) -> Impl(Fn() -> i32)), v : i32) -> i32)(mk(v)());

// 可以：泛型 `Impl(Fn(...))` 参数按实参特化，内层 `Impl` 就是该实参
// （具名函数或闭包）自己的结果类型。
use_mk :: (fn(mk : &Impl(Fn(x : i32) -> Impl(Fn() -> i32)), v : i32) -> i32)(mk(v)());
// 可以，对应 Rust 写法 `F: Fn(i32) -> G, G: Fn() -> i32`：
use_mk :: (fn(generic(G : Type), mk : &Impl(Fn(x : i32) -> G), v : i32, where(G <: (Fn() -> i32))) -> i32)(mk(v)());
```

要在一个槽里存放闭包结果各不相同的函数，请返回 `Box(Dyn(Fn(...)))`（一种装箱
表示）。不被拒绝的情形：`Impl(Future(...))`（每个 future 都是指向状态机的
同一种指针，所以 `fn(x : i32, io : Io) -> Impl(Future(i32, Io))` 是合法的参数
类型）；`comptime(f)` 参数（按值特化）；局部标注
`(h : (fn(x : i32) -> Impl(Fn() -> i32))) = mk`，它取 `mk` 自己的函数类型，
就像 `Impl(Fn(...))` 标注取其闭包的类型一样（之后用闭包结果不同的函数执行
`h = other` 会报 E0601）。

### 不支持：存在型枚举构造器

```yo
// 不支持：`T` 由构造器而不是枚举绑定。
Showable :: enum(
  Wrap(generic(T : Type), value : T, show : (fn(v : T) -> String))
);
```

这是 ML 风格的 `pack`。在一个把一切单态化的编译器里，它的降级恰好就是一个
`Dyn`：没有 vtable 的隐藏 `T` 无法被操作，有了 vtable 它就是 trait 对象。它仍
是非目标（见 [GADTS.md](./GADTS.md#限制)）；请改写为 `Box(Dyn(Show))`。

因此 Yo 在类型层面没有 `exists`。标识符 `exists` 是验证器对值的幽灵量词，如
`ensures(exists(k : i32, xs(k) == target))`。

## Impl 与 Dyn 的对比

- **Impl**：静态分发，编译时多态，无运行时开销
- **Dyn**：动态分发，运行时多态，放在指针后面使用（`Box(Dyn(...))`、`&Dyn(...)`）

```yo
// Impl — 静态分发（单态化）
use_impl :: (fn(generic(T : Type), value : T, where(T <: SomeTrait)) -> unit)({
  value.method(); // 静态分发
});

// Dyn — 动态分发（虚函数表）
use_dyn :: (fn(value : &Dyn(SomeTrait)) -> unit)({
  value.method(); // 动态分发
});
```

更多示例请参阅 `tests/impl.test.yo`。

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
能够正确工作。如果在异步任务中调用了 `unwind`，该 Future 会进入
`Aborted`（中止）状态：对它 `io.await` 会把中止传播给等待者，而已启动任务的
`JoinHandle.await` 返回 `.None`。

详细文档请参阅 [ALGEBRAIC_EFFECTS.md](./ALGEBRAIC_EFFECTS.md)。

## 错误处理

Yo 提供了两种错误处理方式：

1. **Result ADT** — 使用模式匹配的显式 `Result(T, E)` 值
2. **Exception / ResumableException** — 基于代数效应的异常式控制流

### Result 类型

`Result` 类型是一个代数数据类型，用于可能失败的函数：

```yo
// 定义一个错误类型
DivisionError :: enum(
  DivideByZero,
  Overflow
);

// 可能失败的函数
safe_div :: (fn(a : i32, b : i32) -> Result(i32, DivisionError))(
  cond(
    (b == i32(0)) => .Error(.DivideByZero),
    true => .Ok(a / b)
  )
);

// 使用模式匹配处理错误
result := safe_div(10, 2);
match(
  result,
  .Ok(value) => printf("Result: %d\n", value),
  .Error(error) => match(
    error,
    .DivideByZero => printf("Error: Cannot divide by zero\n"),
    .Overflow => printf("Error: Overflow\n")
  )
);
```

### Error Trait 和 AnyError

标准库定义了用于动态错误处理的 `Error` trait 和 `AnyError` 类型：

```yo
{ Error, AnyError } :: import("std/error");

// Error trait 要求实现 ToString。`derive(Error)` 只需按声明顺序为每个变体
// 写一条消息，即可同时生成两者：
MathError :: enum(
  DivisionByZero,
  NegativeSqrt
);
derive(
  MathError,
  Error(
    .DivisionByZero => `Division by zero`,
    .NegativeSqrt => `Square root of a negative number`
  )
);
// AnyError 的载荷必须实现 Clone（见下）：
derive(MathError, Clone);

// 消息就是普通的 Yo 代码，会被拼接进绑定负载的那条 match 分支，因此变体自己的
// 字段可以按名字插值：
//   .NotFound(path : String)  =>  `not found: ${path}`
// 手写这两个 impl 依然可用；当消息不是简单的「每个变体一条字符串」时，就该那么写。
// AnyError 是 Box(Dyn(Error, Clone)) — 任何实现了 Error 和 Clone 的类型都
// 可以用 dyn(Box.new(e)) 包装。它独占其载荷，而 `throw`
// 按值传递错误，所以处理器通过移动来保留捕获的错误。
(err : AnyError) = dyn(Box.new(MathError.DivisionByZero));

// 向下转型回具体类型，借用它：
match(
  downcast(&err.*, MathError),
  .Some(math_err) => printf("Got MathError\n"),
  .None => printf("Not a MathError\n")
);
```

### Exception（不可恢复异常）

`Exception` 是用于不可恢复异常处理的效应捆绑。它的 `throw` 字段
是一个 `ctl(...) -> ret` 处理器 — 调用 `unwind(...)` 会丢弃续延，
从外围函数返回：

```yo
{ Exception } :: import("std/error");

safe_divide :: (fn(x : i32, y : i32, exn : Exception) -> i32)(
  cond(
    (y == i32(0)) => exn.throw(dyn(Box.new(MathError.DivisionByZero))),
    true => (x / y)
  )
);

// 安装处理器 — 注意 lambda 外层的括号（Yo 没有运算符优先级）。
(exn : Exception) = Exception(
  throw : (
    err -> {
      println(`Error: ${err}`); // 打印 "Error: Division by zero"
      unwind(()); // 丢弃续延，从外围函数返回
    }
  )
);

result := safe_divide(6, 3); // result = 2
safe_divide(10, 0, exn); // 处理器触发，unwind — 之后的代码不会执行
```

`Exception` 的处理器不能带着值恢复 throw。`throw` 的恢复类型是一个由每个
throw 点各自选定的类型变量，所以处理器只能 `unwind`、发散，或以 `()` 结束。
返回固定类型值的处理器（例如 `err -> { return(i32(7)); }`）是编译错误，
错误信息会指向 `ResumableException`：

### ResumableException

`ResumableException(ResumeType)` 用于可恢复异常处理。当处理器调用
`return` 时，它会以恢复值恢复续延：

```yo
{ ResumableException } :: import("std/error");

safe_divide :: (fn(x : i32, y : i32, exn : ResumableException(i32)) -> i32)(
  cond(
    (y == i32(0)) => exn.throw(dyn(Box.new(`division by zero`))),
    true => (x / y)
  )
);

(exn : ResumableException(i32)) = ResumableException(i32)(
  throw : (
    err -> {
      println(`Error: ${err}`);
      return(i32(0)); // 以恢复值 0 恢复续延
    }
  )
);

result := safe_divide(6, 3, exn); // result = 2
result2 := safe_divide(10, 0, exn); // 处理器以 0 恢复续延，result2 = 0
```

更多示例请参阅 `tests/error.test.yo`。

## 异步/等待

Yo 使用**基于状态机转换的 async/await** 实现高效的**单线程并发**。异步任务是**惰性的** — 它们在被显式等待或加入之前不会开始执行。

```yo
{ yield } :: import("std/async");

main :: (fn(io : Io) -> unit)({
  task1 := io.async((io : Io) => {
    io.await(yield(io), io);
    return(i32(1));
  });
  task2 := io.async((io : Io) => {
    io.await(yield(io), io);
    return(i32(2));
  });
  handle1 := io.spawn(task1, io); // 启动 task1，返回 JoinHandle(i32)
  handle2 := io.spawn(task2, io); // 启动 task2，返回 JoinHandle(i32)
  r1 := handle1.await(io); // 等待 → Option(i32)
  r2 := handle2.await(io);
});
export(main);
```

关键特性：

- `io.async(fn)` 创建一个**冷 Future** — 函数体在被等待或启动之前不会执行
- `io.await(future, e)` 消耗一个 Future：若为冷则启动，运行至完成并移出结果；Future 只 await **一次**（`e` 是效应记录 —— 纯 `Io` 任务就是 `io`）
- `io.spawn(future, e)` 消耗一个冷 Future 并启动而不等待，返回 `JoinHandle(T)`
- `handle.await(io)` 等待一个已启动的任务，返回 `Option(T)` — 任务中止（unwind）时返回 `.None`。`JoinHandle` 是只可移动的值：await 会消耗它，因此一个任务只 await 一次
- 所有异步代码运行在**同一线程**上（无线程创建，无数据竞争）

详细文档请参阅 [ASYNC_AWAIT.md](./ASYNC_AWAIT.md)。

## 并行

关于 Yo 中的并行编程详情，请参阅 [PARALLELISM.md](./PARALLELISM.md)。

## Arc 类型

`Arc(T)` 提供**共享所有权**并使用原子引用计数。它在 `std/prelude.yo` 中被定义为原子计数单元上的 newtype。
`Arc(T)` 要求 `T <: (Send, Sync)`：要求 `Sync`，是因为每个句柄都在自己的线程上读取载荷；
要求 `Send`，是因为最后一个句柄可能在任意线程上被释放（载荷也在那里被销毁）。因此它只包装可安全
跨线程共享的值，在该约束下 `Arc(T)` 自身也是 `Send` 和 `Sync`。与 Rust 一样，载荷不必是
`Acyclic`：没有环回收器，所以 `Arc` 句柄形成的环除非先清除一条回边或让回边成为 `ArcWeak`（`Arc.downgrade(&h)`，
[WEAK.md](./WEAK.md#arcweakt线程安全的形式)），否则会泄漏（[ARC.md](./ARC.md#环)）。
当你想共享单个值时使用 `Arc(T)`；要共享自己的类型，就写一个普通 `struct`，以 `Arc(YourType)` 共享它。

```yo
// 用 Arc.new 创建
shared := Arc.new(i32(42));

// 使用 .(*) 解引用（借用，只读）
val := shared.*; // val == 42
// 复制会递增引用计数
copy := shared; // 引用计数：1 → 2
// 跨线程共享
{ Thread } :: import("std/thread");
shared := Arc.new(i32(42));
t := Thread(unit).spawn(io => {
  assert(shared.* == i32(42), "thread sees shared value");
});
t.join();
assert(shared.* == i32(42), "main still sees shared value");
```

`Arc(T)` 实现了 `Deref`，因此读取会转发到载荷（`shared.field`、
`shared.method()`；见[自动解引用](#自动解引用)）；在安全代码中通过它写入会被拒绝。

完整详情请参阅 [ARC.md](./ARC.md)。

## 模块的导入和导出

```yo
// module1.yo
test :: (fn() -> unit)({
  println("Hello, world!");
});
export(test);

// module2.yo
// 导出类型
Option :: (fn(comptime(T) : Type) -> comptime(Type))(
  enum(
    Some(value : T),
    None
  )
);
export(Option);
```

```yo
{ ... } :: import("./test.yo"); // 从 test.yo 导入所有内容
test_module :: import("./test.yo"); // 从 test.yo 导入所有内容并放入 Test 命名空间
{ test } :: import("./test.yo"); // 从 test.yo 导入 test 函数
{ test : test2 } :: import("./test.yo"); // 从 test.yo 导入 test 函数并重命名为 test2
{ Option } :: import("./test.yo"); // 从 test.yo 导入 Option 类型
```

#### 同一个名字导入两次

每个导入的名字都是一个绑定，所以"禁止变量遮蔽"的规则同样适用于导入：同一个名字绑定两次是错误（`Failed to define variable "ArrayList"` … `variable shadowing is not allowed`），无论是两行都写了这个名字，还是 `{ ... }` 通配导入已经引入了它。同一路径写多行导入没有问题，只要每行绑定的名字不同；同一个名字也可以换个新名字再导入一次：

```yo
{ ArrayList } :: import("std/collections/array-list");
{ ArrayListIter } :: import("std/collections/array-list"); // 可以：名字不同
{ ArrayList : List } :: import("std/collections/array-list"); // 可以：绑定为新名字
xs := List(i32).new();
```

#### trait impl 通过你的导入可见

方法调用只在你的文件通过导入（传递地）能**到达**的模块的 `impl(...)` 块里解析，再加上 prelude。
一个 impl 如果所在模块不在你的导入路径上任何模块导入过，它就不是候选——即便同一次 `yo check`
或同一个程序里的其他文件碰巧加载了它。例如整数与 `str` 的 `to_string` 是 `std/fmt` 的 `ToString`
impl，所以调用它们的模块要导入 `std/fmt`（任意一个绑定即可：`{ ToString } :: import("std/fmt")`）。
这保证了一个文件单独检查和与其他文件一起检查时得到相同的结论。`YO_VISIBILITY_REPORT=1` 会把
所有只能通过调用方导入之外的 impl 才能解析的调用列出来而不是拒绝——用它来补上缺失的导入行。

### 匿名模块

匿名模块使用 `impl` 关键字后跟一个 `begin` 块来定义：

```yo
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

## 测试

Yo 内置了通过 `test` 关键字使用的测试框架。

### 基本测试语法

```yo
test("Test description", {
  // 测试代码
  x := (1 + 1);
  assert(x == 2, "x 应该为 2");
});

// Io 通过 `io` 自动注入到所有测试体中
test("With effects", {
  io.await(sleep(u64(1000)), io);
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

# 只列出路径 + 模式选中的测试，不编译任何东西
$ yo test ./tests --list

# 每行一个 JSON 对象：每个测试一条 "test" 事件（file、name、status、
# duration_ms；失败时附 message 与捕获的输出），最后一条 "summary" 事件
$ yo test ./tests --json
```

### 断言

#### 运行时断言

```yo
{ assert } :: import("std/assert");

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

```yo
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

```yo
test("Expected compile errors", {
  // 预期错误但不指定具体消息
  comptime_expect_error({
    x :: (1 / 0); // 除以零
  });

  // 预期错误并指定具体消息
  comptime_expect_error({
    arr : Array(i32, _);
    arr = [1, 2, 3];
  }, "Array type with inferred length '_' is not allowed in type annotations");

  // 测试某些模式是无效的
  comptime_expect_error({
    closure1 := (x => (x + 1));
    closure2 := (x => (x + 1));
    // 每个闭包都有唯一类型
    (c : type_of(closure1)) = closure2; // 错误！
  }, "no two closures have the same type");
});
```

### 测试组织

在同一文件中组织相关测试：

```yo
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

### 测试 Drop

测试清理和释放：

```yo
{ println } :: import("std/fmt");
{ assert } :: import("std/assert");

MyBox :: struct(value : i32);
impl(
  MyBox,
  Drop(
    drop : (fn(self : &mut Self) -> unit)({
      println(`Disposing MyBox with value: ${self.value}`);
    })
  )
);

test("Object disposal", {
  // MyBox 在作用域结束时自动释放
  mut(b) := MyBox(value : 42);
  assert(b.value == 42);
  b.value = 100;
  assert(b.value == 100);
  // 此处自动运行 drop；手动调用它是 E0915
});
```

### 测试文件

Yo 测试文件通常使用 `.test.yo` 扩展名：

- `basic.test.yo` — 基本语言特性
- `array.test.yo` — 数组操作
- `closure.test.yo` — 闭包功能
- `async-await.test.yo` — 异步/等待特性
- `collections/*.test.yo` — 集合类型

完整的测试示例请参阅 `tests/` 目录。

## 元编程

`quote` 类似于 Lisp 中的 `quasiquote`。
`unquote` 只能在 `quote` 中使用。
`unquote_splicing` 只能在 `quote` 中使用，用于将值展开到 AST 中。

```yo
x :: quote(2); // comptime(x) : Expr
list :: quote((1, unquote(x), 3)); // 元组 (1, 2, 3)
list2 :: quote((1, x, 3)); // 元组 (1, x, 3)
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
`plans/reference/MACRO_POLICY.md`）。*调用*宏（`if`、`for`、集合字面量）不需要该
pragma；在 comptime 函数中操作引用的 `Expr` 值（`derive_rule` 使用的机
制）同样不需要。

```yo
pragma(Pragma.AllowMacroDef);

// 自定义宏示例 —— 惰性求值 body 的 `unless`
unless :: (fn(quote(condition) : Expr, quote(do) : Expr) -> unquote(Expr))(
  quote(
    cond(unquote(condition) => (), true => unquote(do))
  )
);
```

prelude 的 `if` 宏是标准示例（当前编译器在解析阶段将 `if(...)` 调用脱糖
为 `cond(...)`，该定义作为规范/回退保留）：

```yo
if :: (
  fn(
    quote(condition) : Expr,
    quote(then) : Expr,
    (quote(else) : Expr) ?= quote(())
  ) -> unquote(Expr)
)(
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

> std 没有 `try` 宏：它会隐藏调用方栈帧内的 `return`，与代数效应冲突。
> 请改用对 `Result` 的 `match`。

## 派生特征（Derive Traits）

Yo 支持类似 Rust `#[derive(...)]` 的自动特征派生，但使用函数调用语法。`derive` 函数根据类型的结构自动生成 `impl` 块。

### 内置派生

五个特征具有内置派生支持：`Eq`、`Hash`、`Clone`、`Ord` 和 `ToString`。它们适用于结构体和枚举：

```yo
{ assert } :: import("std/assert");
{ ToString } :: import("std/fmt"); // ToString 的 derive 规则位于 std/fmt
Point :: struct(x : i32, y : i32);
derive(Point, Eq(Point), Hash, Clone, Ord(Point), ToString);

// 现在 Point 支持 ==、!=、哈希、克隆、比较和字符串转换
main :: (fn() -> unit)({
  p1 := Point(x : 1, y : 2);
  p2 := Point(x : 1, y : 2);
  assert(p1 == p2, "equal");
  assert(p1.to_string() == `Point(1, 2)`, "to_string");
});
export(main);
```

### 用户自定义派生规则（`derive_rule`）

特征作者可以使用 `derive_rule` 注册自定义派生规则。派生规则**不是宏** ——
它是返回 `comptime(Expr)` 的普通 comptime 函数，用 `quote`/`unquote` 构
造 `impl` 块，由 `derive` 内建函数显式求值（因此不需要
`Pragma.AllowMacroDef`）：

```yo
MyEq :: (fn(comptime(Rhs) : Type) -> comptime(Trait))(
  trait(my_eq : (fn(self : Self, other : Rhs) -> bool))
);

my_derive_eq :: (fn(comptime(T) : Type, comptime(ctx) : DeriveContext, comptime(trait_params) : ComptimeList(Expr)) -> comptime(Expr))({
  eq_body :: Type.join_fields(
    T,
    (fn(comptime(field) : FieldInfo) -> comptime(Expr))(
      quote(self.(unquote(field.name.to_expr())).my_eq(other.(unquote(field.name.to_expr()))))
    ),
    quote(&&)
  );
  ctx.make_impl(
    quote(
      MyEq(unquote_splicing(trait_params))(
        my_eq : ((self, other) -> unquote(eq_body))
      )
    )
  )
});
derive_rule(MyEq, my_derive_eq);

Point :: struct(x : i32, y : i32);
derive(Point, MyEq(Point)); // 使用注册的 derive_rule
```

## 类型反射（Type Reflection）

Yo 通过 `TypeInfo` 枚举和 `Type.get_info()` 提供编译时类型反射。与简单的类型标签系统不同，`TypeInfo` 携带丰富的结构元数据——结构体字段、枚举变体、函数参数等。

```yo
info :: Type.get_info(i32);
comptime_assert(info.is_primitive(), "i32 is primitive");
comptime_assert(info.is_integer(), "i32 is an integer");

info2 :: Type.get_info(Point);
comptime_assert(info2.is_struct(), "Point is a struct");
```

复合变体携带可通过 `match` 提取的元数据：

```yo
// 提取数组元素类型和长度
arr_info :: Type.get_info([i32 ; 3]);
elem :: match(arr_info, .Array(e, _) => e, _ => unit);
len :: match(arr_info, .Array(_, l) => l, _ => 0);
comptime_assert(len == 3, "array length is 3");

// 检查结构体字段
pt_info :: Type.get_info(Point);
field_count :: match(pt_info, .Struct(f, _) => f.len(), _ => usize(0));
comptime_assert(field_count == usize(2), "Point has 2 fields");

// 基于类型信息的 match 分发
describe :: (fn(comptime(T) : Type) -> comptime(comptime_str))(
  match(
    Type.get_info(T),
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

```yo
// 编译时整数
x :: 42; // comptime_int
y :: (x + 10); // comptime_int = 52
// 编译时类型
MyInt :: i32; // comptime(Type)
value := MyInt(100); // 运行时 i32
// 编译时计算
factorial :: (fn(comptime(n) : comptime_int) -> comptime(comptime_int))(
  cond(
    (n <= 1) => 1,
    true => (n * recur(n - 1))
  )
);
result :: factorial(5); // 编译时计算：120
```

### 编译时算术

所有基本运算都可以在编译时执行：

```yo
// 整数运算
a :: 100;
b :: 25;
sum :: (a + b); // 125
diff :: (a - b); // 75
prod :: (a * b); // 2500
quot :: (a / b); // 4
rem :: (a % b); // 0
// 比较运算
eq :: (a == b); // false
lt :: (b < a); // true
gte :: (a >= b); // true
// 浮点运算
pi :: f32(3.14159);
radius :: f32(5.0);
area :: (pi * (radius * radius)); // ~78.54
// 布尔运算
flag1 :: true;
flag2 :: false;
and_result :: (flag1 && flag2); // false
or_result :: (flag1 || flag2); // true
not_result :: not(flag1); // false
```

### 编译时数组

具有编译时已知长度的数组：

```yo
// 推断长度
arr :: [1, 2, 3, 4, 5]; // Array(i32, 5)
len := arr.len(); // 5（运行时读取；长度也在类型里）
// Array.fill 接受编译期值，返回运行时数组
zeros := Array(i32, 10).fill(0); // [0,0,0,0,0,0,0,0,0,0]
// 泛型数组函数
create_array :: (fn(comptime(T) : Type, comptime(n) : usize, value : T) -> [T ; n])(
  Array(T, n).fill(value)
);

int_array := create_array(i32, 5, 42); // [42,42,42,42,42]
```

### 编译时断言

使用 `comptime_assert` 验证编译时条件：

```yo
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

```yo
test("Expected compile errors", {
  // 验证此代码会产生错误
  comptime_expect_error(
    x :: (1 / 0),
    // 除以零
    "Division by zero"
  );

  comptime_expect_error({
    arr : Array(i32, _); // 无法在绑定中推断长度
    arr = [1, 2, 3];
  });
});
```

### 编译时与运行时

理解事物何时发生：

```yo
// 编译时：使用 :: 或 comptime(...) 声明
COMPT_VALUE :: 42; // 编译时计算
ComptimeType :: i32; // 编译时选择类型
// 运行时：使用 := 声明
runtime_value := 42; // 运行时计算
runtime_type := i32(100); // 运行时创建值
// 混合：编译时类型，运行时值
(x : i32) = 42; // 类型在编译时已知
// 值在运行时计算
// 编译时函数参数
array_fn :: (fn(comptime(n) : usize) -> Array(i32, n))(
  Array(i32, n).fill(0)
); // n 必须在编译时已知
// 运行时函数参数
increment :: (fn(x : i32) -> i32)(
  x + 1
); // x 是运行时值
```

### 编译时求值的优势

1. **零运行时开销**：计算在编译时一次性完成
2. **类型安全**：在执行前捕获错误
3. **泛型编程**：无运行时开销的类型级抽象
4. **元编程**：基于编译时信息生成代码

更多示例请参阅 `tests/comptime.test.yo`。

## 内联汇编

Yo 提供了 `asm()` 和 `global_asm()` 内置函数用于嵌入内联汇编，灵感来自 Rust 的 `asm!` 宏。特性包括：

- **操作数类型**：`in`、`out`、`inout`、`lateout`、`inlateout`、`const_val`、`sym`
- **寄存器约束**：`reg`、`imm`、`mem`、显式寄存器名（例如 `"rax"`）
- **命名操作数**：`out("result", reg, i32)` 配合模板引用 `{result}`
- **变量目标输出**：`out(reg, x)` 直接写入变量，包括未初始化的变量
- **破坏声明和选项**：`clobber("memory")`、`asm_options(volatile, noreturn)`
- **多架构支持**：x86_64 和 aarch64

````yo
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

完整的设计、语法参考和 C 代码生成细节，请参阅 [INLINE_ASSEMBLY.md](INLINE_ASSEMBLY.md)。

## Index 特征

Yo 提供了统一的 `Index` 特征，用于对任意类型的自定义索引。实现了 `Index(Idx)` 的类型可以使用函数调用语法 `value(index)` 进行元素访问，通过 `addr_of(value(index))` 获取指针，以及通过调用语法赋值 `value(index) = new_value` 进行修改。

标准库为 `ArrayList`、`HashMap`、`BTreeMap`、`Deque` 和 `String` 实现了 `Index`。定长数组与 `str` 使用内置索引（相同语法）；集合上的 `..` 与 `..=` 区间产生独立持有的拷贝（`slice_copy`），而 `str` 上的区间是零拷贝的静态窗口。

完整的设计、特征定义和实现细节，请参阅 [INDEX_TRAIT.md](./INDEX_TRAIT.md)。

## 设计中

仍处于设计阶段的特性请查阅 [IN_DESIGN.md](../../plans/archive/IN_DESIGN.md)。

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