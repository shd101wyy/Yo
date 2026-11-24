# Yo 手册

Yo 手册的总览：每一页讲什么、按什么顺序阅读，以及没有手册页回答的问题该问哪个工具。
`yo context --doc NAME` 输出这里列出的任何一页（发行包附带英文版）；`yo context --docs`
列出全部手册。

## 从哪里开始

1. [INSTALL](./INSTALL.md)：编译器及其 C 工具链。
2. `yo context`：上下文包，一份用已安装编译器编写 Yo 的精简指南
   （[CONTEXT](./CONTEXT.md)）。
3. [DESIGN](./DESIGN.md)：逐章介绍语言。
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

- [DESIGN](./DESIGN.md)：语法、类型、函数、闭包、trait、模式匹配、错误处理、模块与测试。
- [DEFINITION_ORDER](./DEFINITION_ORDER.md)：模块内的 `::` 定义、`impl` 注册与 `derive`
  语句与顺序无关。
- [STRINGS](./STRINGS.md)：以字节偏移索引的 UTF-8 字符串。
- [CTFE](./CTFE.md)：编译期函数求值与 `comptime` 值。
- [DERIVE_TRAITS](./DERIVE_TRAITS.md)：`derive(...)` 与自举实现的 `derive_rule` 机制。
- [TYPE_REFLECTION](./TYPE_REFLECTION.md)：`TypeInfo` 与 `Type.get_info()`。
- [GADTS](./GADTS.md)：细化类型参数的枚举构造器。
- [INDEX_TRAIT](./INDEX_TRAIT.md)：`Index`/`IndexMut`、`value(index)` 调用语法与切片。
- [DYN_DESIGN](./DYN_DESIGN.md)：`Dyn` trait 对象、虚表与向下转型。

## 内存与并发

- [OWNERSHIP_AND_BORROWING](./OWNERSHIP_AND_BORROWING.md)：每个值一个所有者、移动、
  `.clone()`、`&T`/`&mut T` 引用及其来源。
- [MEMORY_SAFETY](./MEMORY_SAFETY.md)：safe/unsafe 契约、`pragma(Pragma.AllowUnsafe)`
  与 `yo unsafe-report`。
- [ARC](./ARC.md)：`Arc(T)`，原子计数的共享所有权。
- [WEAK](./WEAK.md)：`Weak(T)` 与 `ArcWeak(T)`，打破循环的非拥有句柄。
- [EXPLICIT_ALLOCATORS](./EXPLICIT_ALLOCATORS.md)：用 `alloc :` 参数选择对象的字节存放在哪里。
- [ALGEBRAIC_EFFECTS](./ALGEBRAIC_EFFECTS.md)：效应、处理器、`return`（恢复）与
  `unwind`（丢弃）。
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

- [FFI](./FFI.md)：用 `c_include(...)` 与 `extern(...)` 绑定 C。
- [INLINE_ASSEMBLY](./INLINE_ASSEMBLY.md)：`asm(...)` 内建函数。
- [WASM](./WASM.md)：编译到 WebAssembly，并把 Yo 库交付给 JavaScript。

## 参考

- [GRAMMAR](./GRAMMAR.md)：形式语法、花括号规则与运算符集合。
