# Yo

<img src="../../Yo_logo.png" width=96 height=96 />

[English](../../README.md) | **简体中文**

**开发中 :) 尚未就绪！**

https://shd101wyy.github.io/Yo

**LLM 友好地编写，人类友好地阅读。**

一种多范式、通用型、编译型编程语言。
Yo 的目标是 **简单** 和 **快速**（比 C 语言慢约 0% - 15%）。

> `Yo` 这个名字来源于中文单词 `柚`（yòu），意为柚子，一种类似葡萄柚的大型柑橘类水果。这是我女儿的小名。

📖 [我与编程语言的故事](./MY_STORY_WITH_PROGRAMMING_LANGUAGES.md) —— 从 16 岁学 Java 到构建 Yo 的旅程。

<!-- @import "[TOC]" {cmd="toc" depthFrom=2 depthTo=6 orderedList=false} -->

<!-- code_chunk_output -->

- [特性](#特性)
- [安装](#安装)
  - [安装脚本（推荐）](#安装脚本推荐)
- [快速开始](#快速开始)
- [预导入模块（Prelude）](#预导入模块prelude)
- [标准库](#标准库)
- [代码示例](#代码示例)
  - [Hello World](#hello-world)
  - [示例项目](#示例项目)
- [贡献](#贡献)
  - [环境设置](#环境设置)
- [编辑器支持](#编辑器支持)
- [版本管理](#版本管理)
- [AI Agent 技能包](#ai-agent-技能包)
  - [在自己的项目中使用](#在自己的项目中使用)
- [许可证](#许可证)

<!-- /code_chunk_output -->

## 特性

关于语言设计，请参阅 [DESIGN.md](./DESIGN.md)。

以下是 Yo 支持的部分特性（非详尽列表）：

- 一等类型（First-class types）。
- 编译时求值（Compile-time evaluation）。
- 同像性（Homoiconicity）和元编程（**Yo** 语法受 **Lisp** S 表达式启发。简单的语法规则，对人类和 AI 友好）。
- 闭包（Closure）。
- [代数效应与处理器](./ALGEBRAIC_EFFECTS.md)（一次性 delimited continuation、尾调用恢复式、通过 `return`/`unwind` 的效应处理器，基于 [证据传递/Evidence Passing](https://xnning.github.io/papers/multip.pdf)）。
- [Async/Await](./ASYNC_AWAIT.md)（内置 `Io` 效应。无栈协程与合作式多任务。惰性 Future、多 await、通过状态机转换实现的单线程并发）。
- [默认内存安全](./MEMORY_SAFETY.md) —— 用户代码无法在不显式声明 `pragma(Pragma.AllowUnsafe);` opt-in 的情况下写出 UB（无原始指针、无 FFI、无内联汇编）。原地修改使用 `inout(name)`；`yo unsafe-report` 用于审计 unsafe 表面。
- 带有 [非原子引用计数与线程本地循环回收](./CYCLE_COLLECTION.md) 的引用语义类型（`ref(struct(...))`/`ref(enum(...))`）。
- [基于所有权和生命周期分析的编译时引用计数](./COMPILE_TIME_RC_WITH_OWNERSHIP_ANALYSIS.md)。
- 每核并行模型（详见 [PARALLELISM.md](./PARALLELISM.md)）。
- 受 Zig 和 Nix 启发的[声明式构建系统](./BUILD_SYSTEM.md)（`yo build`、`yo init`、WASM 目标）。
- **C** 语言互操作。
- 等等。

<img width="855" height="368" alt="Image" src="https://github.com/user-attachments/assets/04a9050e-598b-4e02-a6c3-44863d47a4ac" />

## 安装

### 安装脚本（推荐）

安装原生预编译的编译器。

```bash
# macOS / Linux
$ curl -sSL https://raw.githubusercontent.com/shd101wyy/Yo/develop/scripts/install.sh | sh
```

```powershell
# Windows（PowerShell）
> irm https://raw.githubusercontent.com/shd101wyy/Yo/develop/scripts/install.ps1 | iex
```

安装到 `<prefix>/lib/yo/<tag>`，并在 `<prefix>/bin/yo` 创建链接，`prefix` 默认为
`$HOME/.local`。常用选项：

| 选项                     | 含义                                              |
| ------------------------ | ------------------------------------------------- |
| `-v, --version=<tag>`    | 安装指定版本（默认：最新版）                      |
| `-p, --prefix=<dir>`     | 安装前缀 —— 系统级安装用 `/usr/local`（需 sudo）  |
| `--from-source`          | 从发布的单文件 `yo.c` 构建                        |
| `-cc, --c-compiler=<cc>` | 源码构建使用的 C 编译器（隐含 `--from-source`）   |
| `-cflags, --c-flags=<f>` | 源码构建的额外 C 编译选项（隐含 `--from-source`） |
| `-u, --uninstall`        | 卸载而非安装                                      |
| `--dry-run`              | 仅显示将要执行的操作，不做任何改动                |

```bash
# 安装指定版本，系统级安装
$ curl -sSL https://raw.githubusercontent.com/shd101wyy/Yo/develop/scripts/install.sh | sh -s -- --version=v0.2.4 --prefix=/usr/local

# 使用自己的工具链从源码构建
$ curl -sSL https://raw.githubusercontent.com/shd101wyy/Yo/develop/scripts/install.sh | sh -s -- -cc=gcc -cflags='-march=native'
```

**没有预编译包的平台** —— 使用 `--from-source`。安装脚本会下载该版本的单文件
`yo.c`，并用你自己的 C 编译器编译，因此它链接的是你自己的 libc 和加载器。这正是
NixOS 上的解决方案 —— 预编译二进制文件中硬编码的 ELF 解释器路径
（`/lib64/ld-linux-x86-64.so.2`）在 NixOS 上并不存在。

> **注意：** `--from-source` 需要发布版本中包含单文件 `yo.c`。截至 `v0.2.4` 的所有
> 版本都早于该产物，因此该选项仅适用于此后发布的版本。安装脚本会明确提示这一点，
> 而不会以晦涩的方式失败。

安装脚本会把 `yo` 命令放到你的 `PATH` 中。运行 `yo --help` 查看可用命令。

Yo 将代码转换为 C，因此需要一个 **C 编译器**来生成机器码。上面的安装脚本会替你
准备好；下面的指南用于手动配置工具链，或排查安装失败的问题。

- **[Linux](./INSTALL_LINUX.md)**
- **[macOS](./INSTALL_MACOS.md)**
- **[Windows](./INSTALL_WINDOWS.md)**

以 WebAssembly 为目标还需要 Emscripten —— 参见
**[WASM 配置](./INSTALL_WASM.md)**。

## 快速开始

```bash
$ yo init my-project        # 创建新项目
$ cd my-project
$ yo build run              # 构建并运行
Hello, world!
```

`yo init` 生成一个包含构建文件、源代码和测试的项目：

```
my-project/
├── build.yo              # 构建配置
├── src/
│   ├── main.yo           # 入口点
│   └── lib.yo            # 库模块
└── tests/
    └── main.test.yo      # 单元测试
```

`src/main.yo`：

```rust
{ println } :: import("std/fmt");

main :: (fn() -> unit)({
  println("Hello, world!");
});

export(main);
```

常用构建命令：

```bash
$ yo build                  # 构建所有产物
$ yo build run              # 构建并运行可执行文件
$ yo build test             # 运行测试
$ yo build --list-steps     # 列出可用构建步骤
$ yo build doc              # 生成 HTML 文档
$ yo fmt                    # 格式化 Yo 源文件
$ yo fmt --check            # 只检查格式，不写入变更
```

## 预导入模块（Prelude）

每个 Yo 文件自动导入 **[std/prelude.yo](../../std/prelude.yo)**，它提供了无需任何显式导入即可使用的核心类型、trait 和内置函数：

- **基本类型**：`bool`、`i8`–`i64`、`u8`–`u64`、`f32`、`f64`、`isize`、`usize`、`str`
- **C 兼容类型**：`int`、`uint`、`short`、`long`、`longlong`、`char` 等
- **核心 trait**：`Eq`、`Ord`、`Add`、`Sub`、`Mul`、`Div`、`Iterator`、`IntoIterator`、`TryFrom`、`TryInto`、`Dispose`、`Send`、`Rc`、`Acyclic` 等
- **元编程**：`Type`、`Expr`、`ExprList`、`Var`
- **异步**：`Io`、`FutureState`、`JoinHandle`
- **工具函数**：`assert`、`unsafe`、`try`、`for`、`not`、`arc`、`Box`、`box`
- 等等

## 标准库

_设计中_

Yo 附带一个全面的标准库，涵盖字符串、集合、文件 I/O、网络、编码、正则表达式、加密等。完整模块参考，请参阅 **[标准库文档](https://shd101wyy.github.io/Yo/std)**。

你可以使用 `yo doc` 为自己的项目生成文档：

```bash
$ yo doc ./src -o docs --title "我的项目"
```

或者在 `build.yo` 中添加文档步骤 — 详见 `yo doc --help`。

## 代码示例

查看 [./tests](../../tests/) 和 [./std](../../std/) 文件夹获取更多代码示例。

### Hello World

```rust
// main.yo
{ println } :: import("std/fmt");

main :: (fn() -> unit)({
  println("Hello, world!");
});

export(main);

// $ yo compile main.yo --release -o main
// $ ./main
```

### 示例项目

| 项目                                                                                                            | 描述                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| [raylib_yo](https://github.com/shd101wyy/raylib_yo)                                                             | 全面的 [raylib](https://www.raylib.com/) bindings —— 35 个结构体类型、535 个函数、227 个常量                                                        |
| [tetris_yo](https://github.com/shd101wyy/tetris_yo) \| [在线演示](http://shd101wyy.github.io/tetris_yo)         | 使用 raylib_yo 构建的经典俄罗斯方块游戏，展示 Yo 的构建系统和 C 互操作                                                                              |
| [http_server_demo_yo](https://github.com/shd101wyy/http_server_demo_yo)                                         | 简单的 HTTP/1.1 服务器 —— 异步 I/O、代数效应、TCP 网络、请求解析与路由                                                                              |
| [markdown_it_yo](https://github.com/shd101wyy/markdown_it_yo)                                                   | 将流行的 JavaScript markdown 解析器 [markdown-it](https://github.com/markdown-it/markdown-it) 直接移植到 Yo，展示了字符串处理能力和性能             |
| [markdown_yo](https://github.com/shd101wyy/markdown_yo) \| [在线演示](https://shd101wyy.github.io/markdown_yo/) | 高性能 markdown 转 HTML 转换器 —— 原生比 markdown-it 快 5-7 倍，WASM 快 2-6 倍（≥1 MB）。[在浏览器中试用](https://shd101wyy.github.io/markdown_yo/) |
| [yo_http_benchmark](https://github.com/shd101wyy/yo_http_benchmark)                                             | HTTP 吞吐量基准测试 —— Yo 对比 Bun、Deno、Node.js、Go，使用 [wrk](https://github.com/wg/wrk) 负载测试                                               |

## 贡献

`Yo` 编译器是**自举**的：它用 Yo 自身编写，代码位于 [`src/`](../../src/)。
构建它需要一个已经安装好的 `yo` 二进制（可以用[安装脚本](#安装脚本推荐)获取）以及一个
C 编译器 —— 工具链中已经不再有 TypeScript、Node.js、npm 或 bun。

Yo 主要在 Steam Deck LCD（Linux）上开发。编译器目前将 Yo 转换为 C；要生成机器码，你必须有一个 C 编译器（例如 `gcc`、`clang`、`zig`、`emcc` 等）。

请继续之前安装 [nix](https://nixos.org/download.html) 和 [direnv](https://direnv.net/)。

开发环境定义在 [shell.nix](../../shell.nix) 中。你也可以手动安装文件中列出的依赖项。

### 环境设置

```bash
$ cd Yo
$ direnv allow . # 运行此命令激活 nix shell。
                  # 只需运行一次。
```

没有包管理器的安装步骤。唯一的第三方依赖是 git 子模块：

```bash
$ git submodule update --init --recursive
```

对编译器源码做类型检查（只跑求值器，不生成代码 —— 这是最快的迭代循环）：

```bash
$ yo check ./src
```

从源码构建编译器。务必加上 `--release`：在 `-O0` 下，求值器中那些大函数的栈帧有好几
兆字节，编译期的深度递归会耗尽栈空间。

```bash
$ yo compile src/main.yo --release -o /tmp/yo-self-bin
```

> **监视重建的循环已经没有了。** `bun run dev` 会在文件变更时重新构建 TypeScript
> 编译器；它没有任何替代品。改动之后请重新运行上面的 `yo compile`。

用刚构建出来的编译器试跑一个临时程序（`./tmp/` 已被 gitignore —— 请把一次性的 `.yo`
文件放在那里）：

```bash
$ /tmp/yo-self-bin compile ./tmp/fixme.yo --release -o /tmp/fixme && /tmp/fixme
```

用 `yo test` 运行测试套件：

```bash
$ yo test ./tests --exclude tests/internal --exclude tests/cli-cases --bail
$ yo test ./tests/internal --parallel 1   # 编译器自身的测试
```

## 编辑器支持

- VS Code 扩展可在 [这里](https://marketplace.visualstudio.com/items?itemName=shd101wyy.yolang) 获取，为 `.yo` 文件提供语法高亮。

  **扩展内置的语言服务器协议（LSP）支持目前已经没有了。** 悬停信息、自动补全、跳转到
  定义、查找引用、重命名符号、文档符号、签名帮助、诊断和代码折叠都由一个 TypeScript
  编写的 LSP 服务器提供，它直接调用 TypeScript 求值器；Yo 转为自举之后，它与整个
  TypeScript 编译器一起被删除了。目前还没有替代品，Yo 原生的服务器正在计划中。
  它需要恢复的行为记录在 [docs/zh-CN/LSP.md](./LSP.md)。

- Vim / Neovim：最小化的语法文件和使用说明位于 `vscode-extension/syntaxes/`。
  详见 [vscode-extension/syntaxes/README.md](../../vscode-extension/syntaxes/README.md) 了解安装步骤、`ftdetect` 示例和 `home-manager` 片段。

## 版本管理

Yo 支持通过 `.yo-version` 文件进行项目级版本固定（类似 `.nvmrc` 或 `.python-version`）：

```bash
# 将项目固定到特定的 Yo 版本
yo version pin 0.1.12

# 显示当前版本和固定版本
yo version

# 安装、列出和清理缓存的版本
yo version install 0.1.13
yo version list
yo version clean
```

当 `.yo-version` 文件存在时，`yo` CLI 会自动分发到固定的版本 —— 首次使用时下载并缓存对应的原生发布包。

完整文档请参阅 [docs/zh-CN/VERSION_MANAGEMENT.md](./VERSION_MANAGEMENT.md)。

## AI Agent 技能包

本仓库内置了一套 **Agent 技能文件**，帮助 AI Agent 学习如何编写 Yo 程序。这些技能文件具有可移植性 —— 只需将 `.github/skills/` 目录复制到任意 Yo 项目中，Agent 即可在该项目中使用它们。

| 技能                                                                       | 描述                                                             |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| [`yo-syntax`](../../.github/skills/yo-syntax/SKILL.md)                     | 核心语言语法：花括号语义、cond/match、结构体、枚举、运算符、模块 |
| [`yo-core-patterns`](../../.github/skills/yo-core-patterns/SKILL.md)       | 常用模式：类型、泛型、trait、错误处理、集合、迭代器              |
| [`yo-async-effects`](../../.github/skills/yo-async-effects/SKILL.md)       | 异步/await、代数效应、Exception、Io、任务派生                    |
| [`yo-project-workflow`](../../.github/skills/yo-project-workflow/SKILL.md) | `yo` CLI 命令、`build.yo` 项目文件、依赖管理                     |

### 在自己的项目中使用

最简单的方式是使用 `yo` CLI：

```bash
yo skills install
```

该命令会将所有技能文件复制到当前项目中发现的每个 Agent 配置目录（`.github`、`.agents`、`.claude`、`.opencode`、`.openai`、`.cursor`）。如果都不存在，会自动创建 `.agents/skills/`。

你也可以手动复制：

```bash
cp -r .github/skills /path/to/your-yo-project/.github/
# 或者 .agents, .claude, 等，取决于你的 Agent 平台
```

之后在任意 AI Agent 会话中，通过技能名称（例如 `@yo-syntax`）调用该技能，即可为 Agent 提供关于 Yo 语言的上下文知识。

## 许可证

[UIUC/NCSA Open Source License](../../LICENSE.md)
