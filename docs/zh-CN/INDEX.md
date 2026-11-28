# Yo 手册

Yo 手册的总览：每一页讲什么、按什么顺序阅读，以及没有手册页回答的问题该问哪个工具。
`yo context --doc NAME` 输出这里列出的任何一页（发行包附带英文版）；`yo context --docs`
列出全部手册。

## 从哪里开始

1. [INSTALL](./INSTALL.md)：编译器及其 C 工具链。
2. `yo context`：上下文包，一份用已安装编译器编写 Yo 的精简指南
   （[CONTEXT](./CONTEXT.md)）。
3. [SYNTAX](./SYNTAX.md)、[DATA_TYPES](./DATA_TYPES.md)、[FUNCTIONS](./FUNCTIONS.md)、
   [CLOSURES](./CLOSURES.md) 与 [PATTERN_MATCHING](./PATTERN_MATCHING.md)：语言核心。
4. [OWNERSHIP_AND_BORROWING](./OWNERSHIP_AND_BORROWING.md)：移动、克隆与引用，
   第一个程序最常出错的规则。
5. 其余按主题阅读，见下文。

## 哪个工具回答什么

| 问题                                     | 去问                                                      |
| ---------------------------------------- | --------------------------------------------------------- |
| 怎样写 Yo？（语法、惯用法、陷阱）        | `yo context`（上下文包）                                  |
| 这个 std 模块或函数提供什么？            | `yo context <module>`、`yo context --search <query>`、[std 参考](https://shd101wyy.github.io/Yo/std) |
| 某个语言特性深入是怎样工作的？           | `yo context --doc NAME`（这些手册）                       |
| 错误 `E0xxx` 是什么意思，如何修复？      | `yo explain E0xxx`                                        |
| 某个命令接受哪些参数？                   | `yo <command> --help`                                     |
| 我自己的包的 API 是什么？                | `yo doc`                                                  |

## 语言

- [SYNTAX](./SYNTAX.md)：调用与运算符（无优先级）、绑定与 `mut`、字面量、控制流、算术失败、
  命名与 `yo fmt`。
- [DATA_TYPES](./DATA_TYPES.md)：原始类型、结构体、元组、数组与区间、枚举与 ADT、联合体、
  newtype、私有成员与集合。
- [FUNCTIONS](./FUNCTIONS.md)：声明、参数模式与引用、命名参数与默认参数、泛型、偏应用、类型方法。
- [CLOSURES](./CLOSURES.md)：捕获、捕获列表、`FnOnce`/`FnMut`、`Impl(Fn(...))` 与
  `Dyn(Fn(...))`。
- [PATTERN_MATCHING](./PATTERN_MATCHING.md)：`match`、模式的形式、守卫与穷尽性。
- [TRAITS](./TRAITS.md)：trait 与 `impl`、静态方法、关联类型、一致性、`Impl(Trait)`、
  `Index`/`IndexMut` 与 `Deref`。
- [TRAIT_OBJECTS](./TRAIT_OBJECTS.md)：`Dyn` trait 对象、`dyn(...)`、对象安全、
  `downcast`/`upcast` 与存在类型。
- [ADVANCED_TYPES](./ADVANCED_TYPES.md)：高阶类型、GADTs 与类型状态。
- [ERROR_HANDLING](./ERROR_HANDLING.md)：`Result`、`Error`/`AnyError`、`Exception` 与
  `ResumableException`。
- [MODULES](./MODULES.md)：`import`/`export`、模块级绑定与顺序无关的定义。
- [TESTING](./TESTING.md)：`test(...)`、断言、预期的编译错误与测试文件。
- [STRINGS](./STRINGS.md)：以字节偏移索引的 UTF-8 字符串、`str`、`String` 与模板字符串。
- [CTFE](./CTFE.md)：编译期函数求值、`comptime` 值与元编程。
- [DERIVE_TRAITS](./DERIVE_TRAITS.md)：`derive(...)` 与自举实现的 `derive_rule` 机制。
- [TYPE_REFLECTION](./TYPE_REFLECTION.md)：`TypeInfo` 与 `Type.get_info()`。

## 内存与并发

- [OWNERSHIP_AND_BORROWING](./OWNERSHIP_AND_BORROWING.md)：每个值一个所有者、移动、
  `.clone()`、`&T`/`&mut T` 引用及其来源。
- [SHARED_OWNERSHIP](./SHARED_OWNERSHIP.md)：`Rc`、`Box`、`RefCell`、`Weak`、`Copy`、
  只能移动的值与 `Drop`。
- [MEMORY_SAFETY](./MEMORY_SAFETY.md)：safe/unsafe 契约、`pragma(Pragma.AllowUnsafe)`
  与 `yo unsafe-report`。
- [ARC](./ARC.md)：`Arc(T)`，原子计数的共享所有权。
- [WEAK](./WEAK.md)：`Weak(T)` 与 `ArcWeak(T)`，打破循环的非拥有句柄。
- [EXPLICIT_ALLOCATORS](./EXPLICIT_ALLOCATORS.md)：用 `alloc :` 参数选择对象的字节存放在哪里。
- [ALGEBRAIC_EFFECTS](./ALGEBRAIC_EFFECTS.md)：处理器（`ctl`）、`return`（回答调用）与
  `unwind`（结束构造该处理器的函数）。
- [ASYNC_AWAIT](./ASYNC_AWAIT.md)：单线程事件循环上的 `io.async`/`io.await`。
- [STD_SYS_MODULE](./STD_SYS_MODULE.md)：事件循环背后的各平台异步 I/O 后端。
- [PARALLELISM](./PARALLELISM.md)：`Thread(T)` 与 `ThreadPool`。
- [THREAD_SAFETY](./THREAD_SAFETY.md)：`Send`/`Sync`、原子操作与 `std/sync`。

## 工具链

- [CONTEXT](./CONTEXT.md)：`yo context`，面向智能体的上下文包与 API 索引。
- [BUILD_SYSTEM](./BUILD_SYSTEM.md)：`build.yo`、构建步骤、交叉编译、`yo.toml` 依赖与工作区。
- [ERROR_DIAGNOSTICS](./ERROR_DIAGNOSTICS.md)：诊断代码、输出格式、`yo explain` 与 `yo fix`。
- [FORMAL_VERIFICATION](./FORMAL_VERIFICATION.md)：由 Z3 证明的 `requires`/`ensures`
  契约与精化类型（`yo verify`）。
- [LSP](./LSP.md)：`yo lsp` 与编辑器配置。
- [VERSION_MANAGEMENT](./VERSION_MANAGEMENT.md)：`.yo-version` 与 `yo version`。

## 互操作与编译目标

- [FFI](./FFI.md)：用 `c_include(...)` 与 `extern(...)` 绑定 C、裸指针与 `unsafe(...)`。
- [INLINE_ASSEMBLY](./INLINE_ASSEMBLY.md)：`asm(...)` 内建函数。
- [WASM](./WASM.md)：编译到 WebAssembly，并把 Yo 库交付给 JavaScript。

## 参考

- [GRAMMAR](./GRAMMAR.md)：形式语法、花括号规则与运算符集合。

## 命令

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
