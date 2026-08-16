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
  - [npm](#npm)
  - [Linux](#linux)
  - [macOS](#macos)
  - [Windows](#windows)
  - [WebAssembly (WASM)](#webassembly-wasm)
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
- [Star 历史](#star-历史)
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

安装原生预编译的编译器 —— 无需 Node.js 或 npm。

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

### npm

编译器同时也作为 `npm` 包发布：

```bash
$ npm install -g @shd101wyy/yo         # 全局安装 yo 编译器
$ yarn global add @shd101wyy/yo        # 或使用 yarn
$ pnpm add -g @shd101wyy/yo            # 或使用 pnpm
$ bun install --global @shd101wyy/yo   # 或使用 bun
```

它会在终端中暴露 `yo` 命令。

还有一个别名 `yo-cli`，用于避免命名冲突。

运行 `yo --help` 或 `yo-cli --help` 查看可用命令。

Yo 将代码转换为 C，因此需要一个 **C 编译器**来生成机器码。请按照以下平台说明操作。

### Linux

安装 **Clang**（推荐）、**liburing**（用于异步 I/O）和 **pkg-config**（用于系统库发现）：

```bash
# Ubuntu/Debian
$ sudo apt-get update
$ sudo apt-get install clang liburing-dev pkg-config

# Fedora/RHEL
$ sudo dnf install clang liburing-devel pkgconf-pkg-config

# Arch Linux
$ sudo pacman -S clang liburing pkgconf
```

你也可以通过传递 `--cc gcc` 或 `--cc zig` 使用 `gcc` 或 `zig` 代替 `clang`。

### macOS

Clang 包含在 Xcode 命令行工具中：

```bash
$ xcode-select --install

# 同时安装 pkgconf 用于系统库发现
$ brew install pkgconf
```

或者通过 Homebrew 安装 LLVM：

```bash
$ brew install llvm pkgconf
```

### Windows

Windows 上的 Clang 需要链接器和 Windows SDK 头文件。安装 **Visual Studio**（社区版免费）或带有"Desktop development with C++"工作负载的 **Build Tools for Visual Studio**：

1. 从 [https://visualstudio.microsoft.com/downloads/](https://visualstudio.microsoft.com/downloads/) 下载
2. 在安装程序中选择 **"Desktop development with C++"**（包含 MSVC、Windows SDK 和链接器）
3. 然后安装 LLVM/Clang：

```bash
# 使用 Chocolatey
$ choco install llvm

# 使用 Scoop
$ scoop install llvm

# 或从 https://releases.llvm.org/ 下载
```

或者，你可以使用 `zig` 作为 C 编译器（无需 Visual Studio）：

```bash
$ choco install zig
$ yo compile main.yo --cc zig --release -o main
```

对于系统库发现，安装 **vcpkg**：

```bash
$ git clone https://github.com/microsoft/vcpkg.git
$ .\vcpkg\bootstrap-vcpkg.bat
# 然后将 VCPKG_ROOT 环境变量设置为 vcpkg 目录

# 或使用 Scoop
$ scoop install vcpkg
```

更多信息，请参阅 [vcpkg 文档](https://learn.microsoft.com/en-us/vcpkg/get_started/get-started)。

### WebAssembly (WASM)

Yo 可以使用 [Emscripten](https://emscripten.org/) 编译到 WebAssembly：

```bash
# 安装 Emscripten（https://emscripten.org/docs/getting_started/downloads.html）
$ git clone https://github.com/emscripten-core/emsdk.git
$ cd emsdk
$ ./emsdk install latest
$ ./emsdk activate latest
$ source ./emsdk_env.sh

# 将 Yo 程序编译为 WASM
$ yo compile main.yo --cc emcc --release -o app

# 生成：app.html + app.js + app.wasm
# 使用 Node.js 运行：
$ node app.js

# 或在浏览器中打开 app.html
```

使用 `--cc emcc` 时，Yo 自动针对 `wasm32-emscripten` 目标并使用 `libc` 分配器。你也可以使用 `--target wasm-emscripten`（会自动选择 `emcc`）。Emscripten 生成一个 `.html` 文件（浏览器外壳）、一个 `.js` 文件（运行时胶水代码）和一个 `.wasm` 文件（编译后的二进制文件）。

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

`Yo` 编译器用 [TypeScript](https://www.typescriptlang.org/) 编写，使用 [Bun](https://bun.sh/) 作为运行时。

Yo 主要在 Steam Deck LCD（Linux）上开发。编译器目前将 Yo 转换为 C；要生成机器码，你必须有一个 C 编译器（例如 `gcc`、`clang`、`zig`、`cl`、`emcc` 等）。

请继续之前安装 [nix](https://nixos.org/download.html) 和 [direnv](https://direnv.net/)。

开发环境定义在 [shell.nix](../../shell.nix) 中。你也可以手动安装文件中列出的依赖项。

### 环境设置

```bash
$ cd Yo
$ direnv allow . # 运行此命令激活 nix shell。
                  # 只需运行一次。
$ bun install    # 安装必要的依赖项。
```

运行以下命令监视更改并构建项目：

```bash
$ bun run dev
```

运行以下命令构建项目：

```bash
$ bun run build
```

测试本地 yo-cli：

```bash
$ bun run src/yo-cli.ts compile src/tests/fixme.yo

# 项目中还有一个 `yo-cli` 脚本用于测试：
$ ./yo-cli compile src/tests/fixme.yo
```

## 编辑器支持

- VS Code 扩展可在 [这里](https://marketplace.visualstudio.com/items?itemName=shd101wyy.yolang) 获取，内置 **语言服务器协议（LSP）** 支持，提供：

  - **悬停信息** —— 任意标识符的类型、值和文档注释
  - **自动补全** —— 结构体字段、枚举变体、模块成员、impl 方法、关键字
  - **跳转到定义** —— 跳转到任意符号的定义处
  - **查找引用** —— 定位符号的所有使用位置
  - **重命名符号** —— 跨所有引用重命名
  - **文档符号** —— 顶层声明的大纲视图
  - **签名帮助** —— 输入函数调用时的参数提示
  - **诊断** —— 实时错误报告
  - **代码折叠** —— 折叠函数体、结构体、impl 块

  LSP 服务器也可以通过 stdio JSON-RPC 在其他编辑器中使用：

  ```bash
  node out/cjs/yo-lsp.cjs --stdio
  ```

  完整文档请参阅 [docs/zh-CN/LSP.md](./LSP.md)。

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

当 `.yo-version` 文件存在时，`yo` CLI 会自动分发到固定的版本 —— 首次使用时下载并缓存。LSP 服务器也会读取 `.yo-version`，为跳转到定义和补全解析正确的标准库。

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

## Star 历史

[![Star History Chart](https://api.star-history.com/svg?repos=shd101wyy/Yo&type=date&legend=top-left)](https://www.star-history.com/#shd101wyy/Yo&type=date&legend=top-left)

## 许可证

[UIUC/NCSA Open Source License](../../LICENSE.md)
