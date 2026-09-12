# 构建系统

Yo 内置了一个声明式构建系统，灵感来自 [Zig 的构建系统](https://ziglang.org/learn/build-system/) 和 [Nix](https://nixos.org/)。构建配置写在 `build.yo` 文件中，在编译期求值——无需额外的配置格式。

## 快速上手

```bash
# 创建新项目
yo init my-project
cd my-project

# 构建并运行
yo build run

# 运行测试
yo build test

# 构建所有产物（默认步骤）
yo build
```

## 项目结构

`yo init` 会创建如下布局的项目：

```
my-project/
├── yo.toml               ← 包清单：名称、模块、依赖（由 yo add 编辑）
├── build.yo              ← 构建配置
├── src/
│   ├── main.yo           ← 可执行文件入口
│   └── lib.yo            ← 库代码
├── tests/
│   └── main.test.yo      ← 测试文件
├── .gitignore
├── AGENTS.md             ← AI 编码代理的指引（列出各技能）
├── CLAUDE.md             ← 指向 AGENTS.md
├── .agents/skills/       ← 捆绑的 agent 技能文件（见 yo skills install）
└── README.md
```

传入 `--no-skills` 可跳过这些 agent 文件；已存在的文件不会被覆盖。升级 `yo`
后可用 `yo skills install` 刷新技能文件。

构建输出位于 `yo-out/<target>/` 目录下，按目标三元组组织（类似 Cargo）：

```
yo-out/
├── x86_64-unknown-linux-gnu/         ← 宿主目标
│   ├── bin/
│   │   └── my-project
│   └── lib/
│       └── libmy-project-lib.a
└── wasm32-unknown-emscripten/           ← 交叉编译目标（Emscripten）
    └── bin/
        ├── my-project.html
        ├── my-project.js
        └── my-project.wasm
```

## `build.yo`

构建文件是一个普通的 Yo 源文件，通过导入 `std/build` 模块来使用。所有构建函数在编译期执行，用于注册产物和步骤。

```rust
build :: import "std/build";

// 定义产物——每个都返回一个 Step 用于依赖连接
exe :: build.executable({
  name: "my-project",
  root: "./src/main.yo"
});

lib :: build.static_library({
  name: "my-project-lib",
  root: "./src/lib.yo"
});

tests :: build.test({ name: "tests", root: "./tests/" });

// 注册运行步骤（编译 + 执行）
run_exe :: build.run(exe);

// 命名步骤——使用 depend_on 来连接依赖
install :: build.step("install", "Build all artifacts");
install.depend_on(exe);
install.depend_on(lib);

run_step :: build.step("run", "Run the application");
run_step.depend_on(run_exe);

test_step :: build.step("test", "Run unit tests");
test_step.depend_on(tests);
```

## 配置结构体

构建产物使用带有默认字段值的结构体类型（类似 Zig 的 options 模式）。只有 `name` 和 `root` 是必填的——其余都有合理的默认值：

### `BuildModule`

| 字段   | 类型           | 默认值     | 描述                             |
| ------ | -------------- | ---------- | -------------------------------- |
| `name` | `comptime_str` | _（必填）_ | 模块名称（可通过 `"name"` 导入） |
| `root` | `comptime_str` | _（必填）_ | 根源文件路径（如 `src/lib.yo`）  |

### `Executable`

| 字段        | 类型           | 默认值             | 描述                                   |
| ----------- | -------------- | ------------------ | -------------------------------------- |
| `name`      | `comptime_str` | _（必填）_         | 产物名称                               |
| `root`      | `comptime_str` | _（必填）_         | 主源文件路径                           |
| `target`    | `comptime_str` | `target_host`      | 目标三元组（如 `"wasm32-unknown-emscripten"`） |
| `optimize`  | `Optimize`     | `Optimize.Debug`   | 优化级别                               |
| `allocator` | `Allocator`    | `Allocator.System` | 内存分配器                             |
| `heap_size` | `usize`        | `16777216`（16 MiB） | 固定区域堆大小（仅 `Allocator.Fixed`） |
| `sanitize`  | `Sanitize`     | `Sanitize.None`    | 检测器                                 |

### `StaticLibrary`

| 字段       | 类型           | 默认值           | 描述         |
| ---------- | -------------- | ---------------- | ------------ |
| `name`     | `comptime_str` | _（必填）_       | 产物名称     |
| `root`     | `comptime_str` | _（必填）_       | 库源文件路径 |
| `target`   | `comptime_str` | `target_host`    | 目标三元组   |
| `optimize` | `Optimize`     | `Optimize.Debug` | 优化级别     |

### `SharedLibrary`

| 字段       | 类型           | 默认值           | 描述         |
| ---------- | -------------- | ---------------- | ------------ |
| `name`     | `comptime_str` | _（必填）_       | 产物名称     |
| `root`     | `comptime_str` | _（必填）_       | 库源文件路径 |
| `target`   | `comptime_str` | `target_host`    | 目标三元组   |
| `optimize` | `Optimize`     | `Optimize.Debug` | 优化级别     |

共享库使用 `-shared -fPIC` 编译，生成 `.so`（Linux）、`.dylib`（macOS）或 `.dll`（Windows）。

### `TestSuite`

| 字段     | 类型           | 默认值        | 描述               |
| -------- | -------------- | ------------- | ------------------ |
| `name`   | `comptime_str` | _（必填）_    | 测试套件名称       |
| `root`   | `comptime_str` | _（必填）_    | 测试文件或目录路径 |
| `target` | `comptime_str` | `target_host` | 目标三元组         |

### 优化级别

| 值                      | 编译器标志 | 描述                 |
| ----------------------- | ---------- | -------------------- |
| `Optimize.Debug`        | `-O0 -g`   | 无优化，包含调试符号 |
| `Optimize.ReleaseSafe`  | `-O2 -g`   | 优化并包含调试符号   |
| `Optimize.ReleaseFast`  | `-O3`      | 最大性能             |
| `Optimize.ReleaseSmall` | `-O2`      | 优化二进制体积       |

### 分配器

| 值                   | 描述                          |
| -------------------- | ----------------------------- |
| `Allocator.Mimalloc` | 高性能分配器（mimalloc）      |
| `Allocator.System`   | 平台系统分配器（默认）        |
| `Allocator.Fixed`    | 作用于单个静态区域的通用 TLSF 分配器（见下文） |

`Allocator.Fixed` 让所有分配都来自 `.bss` 中一个静态定长的区域 —— 不依赖
libc 堆（嵌入式/裸机方向的第一块基石）。区域大小由可执行产物的 `heap_size`
字段设置（字节数；64 KiB 到 4 GiB，向下取整到 16 字节粒度；默认 16 MiB）。
有了有界的区域，内存耗尽是一次**带诊断信息的 panic**
（`out of memory: requested N bytes (fixed heap ...)`），OOM 因此成为可复现的
测试输入，而不是永远触发不了的 overcommit。该分配器是线程安全的（并行运行
时会从工作线程分配），`yo compile --debug-heap` 会在进程退出时报告存活块数，
构成一个可移植的泄漏检查工具。

### 检测器

| 值                 | 描述                               |
| ------------------ | ---------------------------------- |
| `Sanitize.None`    | 不使用检测器（默认）               |
| `Sanitize.Address` | AddressSanitizer 内存错误/泄漏检测 |
| `Sanitize.Leak`    | LeakSanitizer 仅检测泄漏           |

### 编译目标

`CompilationTarget` 为支持的目标三元组提供了符号名称。推荐使用这些常量，而不是硬编码目标字符串：

| 值                                       | 目标三元组             | 说明                       |
| ---------------------------------------- | ---------------------- | -------------------------- |
| `CompilationTarget.X86_64_Unknown_Linux_Gnu`     | `x86_64-unknown-linux-gnu`     | Linux x86-64（glibc）      |
| `CompilationTarget.X86_64_Unknown_Linux_Musl`    | `x86_64-unknown-linux-musl`    | Linux x86-64（musl，原生） |
| `CompilationTarget.Aarch64_Unknown_Linux_Gnu`    | `aarch64-unknown-linux-gnu`    | Linux ARM64                |
| `CompilationTarget.Aarch64_Unknown_Linux_Musl`   | `aarch64-unknown-linux-musl`   | Linux ARM64（musl，原生）  |
| `CompilationTarget.Aarch64_Apple_Darwin`        | `aarch64-apple-darwin`        | macOS Apple Silicon        |
| `CompilationTarget.X86_64_Apple_Darwin`         | `x86_64-apple-darwin`         | macOS Intel                |
| `CompilationTarget.X86_64_Pc_Windows_Msvc`  | `x86_64-pc-windows-msvc`  | Windows x86-64             |
| `CompilationTarget.Aarch64_Pc_Windows_Msvc` | `aarch64-pc-windows-msvc` | Windows ARM64              |
| `CompilationTarget.Wasm32_Unknown_Emscripten`    | `wasm32-unknown-emscripten`    | WebAssembly（Emscripten）  |
| `CompilationTarget.Wasm32_Wasip1`          | `wasm32-wasip1`          | WebAssembly（独立 WASI）   |

宿主目标也可通过 `build.target_host` 获取。

## 构建步骤

步骤是命名的目标，定义了 `yo build <step>` 的行为。每个构建函数（`executable`、`static_library`、`test`、`run`）都返回一个 `Step` 值。使用 `step.depend_on(dep)` 来连接依赖：

```rust
// 每个构建函数都返回一个 Step
exe :: build.executable({ name: "my-app", root: "./src/main.yo" });
lib :: build.static_library({ name: "my-lib", root: "./src/lib.yo" });
tests :: build.test({ name: "tests", root: "./tests/" });
run_exe :: build.run(exe);

// 创建命名步骤并连接依赖
install :: build.step("install", "Build all artifacts");
install.depend_on(exe);
install.depend_on(lib);

run_step :: build.step("run", "Run the application");
run_step.depend_on(run_exe);

test_step :: build.step("test", "Run unit tests");
test_step.depend_on(tests);
```

### 基于 DAG 的执行

构建系统将项目建模为步骤的**有向无环图（DAG）**。当你运行 `yo build install` 时，构建运行器会：

1. 根据步骤依赖和链接的产物构建 DAG
2. 检测环并报告错误
3. 在每个层级并发执行独立的步骤

例如，如果 `install` 同时依赖 `exe` 和 `lib`（且它们之间互相独立），则它们在同一个 DAG 层级并行编译。如果 `exe` 链接了 `lib`，则 `lib` 先编译。

```
Level 0: lib-a, lib-b, tests   （独立——并发编译）
Level 1: app                    （依赖 lib-a, lib-b）
Level 2: install                （依赖 app, tests）
```

> **注意**：产物编译目前是串行的（Yo 求值器使用全局状态）。测试和运行步骤可并发执行。

### `Step`

| 字段   | 类型           | 描述                                                                                                    |
| ------ | -------------- | ------------------------------------------------------------------------------------------------------- |
| `name` | `comptime_str` | 步骤名称（产物名称，或 `build.step` 的自定义名称）                                                      |
| `kind` | `StepKind`     | 步骤类型：`Executable`、`StaticLibrary`、`SharedLibrary`、`SystemLibrary`、`TestSuite`、`Run`、`Custom` |

### Step 方法

| 方法                            | 描述                                                |
| ------------------------------- | --------------------------------------------------- |
| `step.depend_on(other)`         | 添加依赖——`other` 会在 `step` 之前构建              |
| `step.link(library)`            | 将库链接到产物（静态库、共享库或系统库）            |
| `step.add_c_flags(flags)`       | 添加自定义 C 编译器/链接器标志（空格分隔的字符串）  |

### `StepKind`

| 值              | 描述                             |
| --------------- | -------------------------------- |
| `Executable`    | 由 `build.executable()` 返回     |
| `StaticLibrary` | 由 `build.static_library()` 返回 |
| `SharedLibrary` | 由 `build.shared_library()` 返回 |
| `SystemLibrary` | 由 `build.system_library()` 返回 |
| `TestSuite`     | 由 `build.test()` 返回           |
| `Run`           | 由 `build.run()` 返回            |
| `Custom`        | 由 `build.step()` 返回           |

列出所有可用步骤：

```bash
yo build --list-steps
```

```
Available steps:
  install (default)    Build all artifacts
  run                  Run the application
  test                 Run unit tests
```

### 构建摘要

使用 `--summary` 可以打印已执行步骤的树形结构及耗时（类似 Zig 的 `--summary all`）：

```bash
yo build --summary
```

```
Build Summary: 3/3 steps succeeded
install success
├── compile exe my-app Debug native success 1.3s MaxRSS:706M
│   └── compile lib math Debug native success 295ms MaxRSS:650M
└── compile lib my-app-lib Debug native success 310ms MaxRSS:680M
```

每个节点显示：步骤描述、成功/失败状态、耗时以及峰值内存使用量（MaxRSS）。树形结构反映了 DAG 的依赖边。

## 模块

模块是其他代码按名称导入的根文件。模块在 `yo.toml` 的 `[modules]` 表中声明——`default` 就是 `import("<包名>")` 的含义，其余每一项可通过 `import("<包名>/<模块>")` 导入，在包内和每个依赖它的包中都一样：

```toml
[package]
name = "raylib_yo"

[modules]
default = "src/lib.yo"
shapes  = "src/shapes.yo"
```

`build.yo` 在需要给模块附加系统库时才引用它。当另一个包导入该模块时，其系统库会传播到使用方的构建：

```rust
build :: import "std/build";

raylib :: build.system_library({
  name: "raylib",
  defines: "NOMINMAX NOGDI NOUSER"
});

// 指名 yo.toml [modules] 中的一项，并链接它需要的系统库
mod :: build.module({ name: "default" });
mod.link(raylib);

exe :: build.executable({ name: "raylib_yo", root: "./src/main.yo" });
exe.link(raylib);

install :: build.step("install", "Build all artifacts");
install.depend_on(exe);
```

### `BuildModule`

由 `build.module()` 和 `dep.module()` 返回。有一个方法：

| 方法            | 说明                       |
| --------------- | -------------------------- |
| `mod.link(lib)` | 声明此模块依赖某个系统库   |

### `ModuleConfig`

| 字段   | 类型           | 默认值     | 说明                                                  |
| ------ | -------------- | ---------- | ----------------------------------------------------- |
| `name` | `comptime_str` | _（必填）_ | `yo.toml` `[modules]` 中的一项（根模块为 `"default"`） |

### 导入依赖的模块

`build.yo` 中无需任何接线：在 `yo.toml` 中声明的依赖可按其名称导入，其命名模块按 `name/module` 导入：

```rust
raylib_yo :: import "raylib_yo";          // 依赖的 [modules] default
{ Circle } :: import "raylib_yo/shapes";  // 它的 [modules] shapes
```

这在每个命令中都成立——`yo build`、`yo compile`、`yo check`、`yo test`、`yo doc` 和语言服务器——因为编译器会在被编译文件之上找到最近的 `yo.toml`，并解析清单的依赖闭包（见[导入依赖](#导入依赖)）。

## 链接库

使用 `step.link()` 将任何库链接到产物 —— 支持静态库、共享库和系统库。类似 Zig 的 `exe.linkLibrary(lib)`：

```rust
build :: import "std/build";

// Yo 库
lib :: build.shared_library({
  name: "mylib",
  root: "./src/lib.yo"
});

// 系统库（通过 pkg-config）
openssl :: build.system_library({
  name: "openssl"
});

exe :: build.executable({
  name: "my-app",
  root: "./src/main.yo"
});

// 使用 Step 方法链接库
exe.link(lib);
exe.link(openssl);

install :: build.step("install", "Build all artifacts");
install.depend_on(exe);
install.depend_on(lib);
```

`step.link()` 会自动判断库类型：

- **静态/共享库** — 先编译，输出传给链接器
- **系统库** — 在构建时通过 `pkg-config` 解析，标志应用于产物

### 使用 `extern "Yo"` 进行跨模块链接

静态库导出的 Yo 函数可以通过 `extern "Yo"` 被其他模块调用。这类似于 Zig 的 `@import` 跨模块机制。

**库模块**（`add.yo`）：

```rust
add :: (fn(a: i32, b: i32) -> i32)(
  (a + b)
);

export add;
```

**可执行模块**（`demo.yo`）：

```rust
// `extern(...)` is an FFI declaration, so the file must opt into unsafe code.
pragma(Pragma.AllowUnsafe);
{ println } :: import("std/fmt");

extern("Yo", add : (fn(a : i32, b : i32) -> i32));

main :: (fn() -> unit)({
  println(add(i32(3), i32(4)).to_string());
});

export(main);
```

**构建文件**（`build.yo`）：

```rust
build :: import "std/build";

lib :: build.static_library({
  name: "add",
  root: "./add.yo"
});

exe :: build.executable({
  name: "demo",
  root: "./demo.yo"
});

exe.link(lib);

install :: build.step("install", "Build all artifacts");
install.depend_on(exe);
install.depend_on(lib);
```

运行 `yo build` 产生：

```
yo-out/
└── x86_64-unknown-linux-gnu/
    ├── bin/
    │   └── demo          ← 可执行文件（调用库中的 add 函数）
    └── lib/
        └── libadd.a      ← 静态库（导出 add 函数）
```

在库模式下，编译器会：

1. 对导出函数使用普通的 C 名称（如 `add` 而非 `fn_yo3818ce2d_id_3_add`）
2. 将所有内部运行时函数标记为 `static`，避免链接时的重复符号
3. 跳过 `main()` 包装函数的生成

你也可以通过 CLI 直接编译静态库：

```bash
yo compile add.yo --static-library -o libadd
yo compile demo.yo --extern libadd.a -o demo
```

## 构建选项

类似 Zig 的 `b.option()`，可以声明用户可配置的构建选项，并通过 CLI 的 `-Dname=value` 设置：

```rust
build :: import "std/build";

// 声明带有默认值的构建选项
strip :: build.option({
  name: "strip",
  description: "Strip debug symbols",
  default: "false"
});

opt_level :: build.option({
  name: "opt",
  description: "Optimization level",
  default: "debug"
});
```

CLI 用法：

```bash
yo build -Dstrip=true -Dopt=release-fast
yo build run -Dstrip=true
```

如果没有提供 `-D` 标志，则使用默认值。布尔选项省略 `=` 时默认为 `"true"`：

```bash
yo build -Dstrip       # 等同于 -Dstrip=true
```

运行 `yo build --help` 可以查看所有可用的项目专属选项以及标准标志。

### `BuildOption`

| 字段          | 类型           | 默认值     | 描述             |
| ------------- | -------------- | ---------- | ---------------- |
| `name`        | `comptime_str` | _（必填）_ | 选项名称         |
| `description` | `comptime_str` | _（必填）_ | 帮助文本         |
| `default`     | `comptime_str` | `""`       | 未设置时的默认值 |

## 交叉编译

> **注意：** 真正的交叉编译（目标 CPU 架构或操作系统与宿主机不同）**不受支持**。
> 目标必须与宿主机的架构和操作系统相匹配。唯一的例外是 **WebAssembly（WASM）**，
> 可以通过 `emcc` 在任意宿主机上编译。
>
> musl 目标（`x86_64-unknown-linux-musl`）仅在 musl 原生系统（如 Alpine Linux）上受支持。

Yo 通过目标三元组支持 WASM 目标。可以在 `build.yo` 中或命令行上指定目标：

### 在 `build.yo` 中

```rust
build.executable({
  name: "my-app-wasm",
  root: "./src/main.yo",
  target: build.CompilationTarget.Wasm32_Unknown_Emscripten,
  optimize: build.Optimize.ReleaseSmall
});
```

也可以使用原始目标字符串：

```rust
build.executable({
  name: "my-app-wasm",
  root: "./src/main.yo",
  target: "wasm32-unknown-emscripten",
  optimize: build.Optimize.ReleaseSmall
});
```

### 在命令行上

```bash
# 为所有产物覆盖目标
yo build --target wasm32-unknown-emscripten
```

### 支持的目标

| 目标三元组             | 说明                       |
| ---------------------- | -------------------------- |
| `x86_64-unknown-linux-gnu`     | Linux x86-64（glibc）      |
| `x86_64-unknown-linux-musl`    | Linux x86-64（musl，原生） |
| `aarch64-unknown-linux-gnu`    | Linux ARM64                |
| `aarch64-unknown-linux-musl`   | Linux ARM64（musl，原生）  |
| `aarch64-apple-darwin`        | macOS Apple Silicon        |
| `x86_64-apple-darwin`         | macOS Intel                |
| `x86_64-pc-windows-msvc`  | Windows x86-64             |
| `aarch64-pc-windows-msvc` | Windows ARM64              |
| `wasm32-unknown-emscripten`    | WebAssembly（Emscripten）  |
| `wasm32-wasip1`          | WebAssembly（独立 WASI）   |

目标名与 Rust 的拼写完全一致——没有缩写或别名；无法识别的拼写会被拒绝，并列出支持的目标。

### WASM Emscripten 环境

通过 `yo build` 构建 `wasm32-unknown-emscripten` 目标时，默认输出为**浏览器**环境：

- 输出为 `.html` + `.js` + `.wasm`（完整的浏览器页面）
- **不**添加 `-sNODERAWFS`（该选项使用 `require('fs')`，浏览器中不存在）
- 始终添加 `-sEMULATE_FUNCTION_POINTER_CASTS=1`（代码生成所需）
- 通过 `system_library()` 声明的系统库以 `-l<name>` 形式传递给 emcc（跳过 pkg-config/vcpkg 宿主平台解析）

#### 输出格式自动检测

主输出文件的扩展名会自动确定：

| C 标志           | 主输出文件 | 附加文件        | 使用场景                   |
| ---------------- | ---------- | --------------- | -------------------------- |
| （默认）         | `.html`    | `.js` + `.wasm` | 浏览器应用（GitHub Pages） |
| `-sMODULARIZE=1` | `.js`      | `.wasm`         | JS 模块（库/打包工具）     |

- **`.html`（默认）：** emcc 会生成浏览器外壳页面，同时生成 `.js` 胶水代码和 `.wasm` 二进制文件。适用于独立 Web 应用和 GitHub Pages 部署。
- **`.js`（使用 `-sMODULARIZE`）：** emcc 的 `-sMODULARIZE` 标志与 `.html` 输出不兼容，因此构建系统会自动切换为 `.js` 输出。适用于将输出作为 JavaScript 模块使用的场景（如打包工具、动态导入或自定义 HTML 页面）。

通过 `yo build run` 运行 WASM 构件时，无论主输出文件是 `.html` 还是 `.js`，构建系统始终使用 Node.js 执行 `.js` 文件。

要运行输出文件，需使用本地 HTTP 服务器（WASM 需要 HTTP，不支持 `file://`）：

```bash
cd yo-out/wasm32-unknown-emscripten/bin
python -m http.server 8080
# 打开 http://localhost:8080/my-project.html
```

如需 Node.js 执行环境（如无界面/服务端 WASM），可手动添加标志：

```rust
exe_wasm.add_c_flags("-sNODERAWFS=1");
```

> **注意：** `yo test --cc emcc` 始终使用 Node.js 模式（`-sNODERAWFS=1`），因为测试通过 Node 运行。

### 代码中的平台检测

使用 `std/process` 编写平台相关代码：

```rust
{ platform, arch, Platform, Arch } :: import "std/process";

cond(
  (platform == Platform.Linux) => { /* Linux 专用 */ },
  (platform == Platform.Macos) => { /* macOS 专用 */ },
  (platform == Platform.Emscripten) => { /* Emscripten WASM */ },
  (platform == Platform.Wasi) => { /* 独立 WASI */ },
  true => { /* 回退 */ }
);
```

交叉编译时，`platform` 和 `arch` 返回的是**目标**平台而非宿主平台。

## `yo build` 参考

```
yo build [steps] [options]

Arguments:
  steps                  要运行的命名步骤（默认：install）

Options:
  --build-file <path>    构建文件路径（默认：./build.yo）
  --target <triple>      为所有产物覆盖目标
  --sysroot <path>       交叉编译的 sysroot 目录
  --cc <compiler>        C 编译器：clang, gcc, zig, cc, emcc
  --verbose, -v          详细构建输出
  --dry-run              显示将要构建的内容
  --list-steps           列出可用的构建步骤
```

## `yo init` 参考

```
yo init [dir] [options]

Arguments:
  dir                    要初始化的目录（默认：.）

Options:
  --name <name>          项目名称（默认：目录名）
  --no-skills            跳过 agent 技能文件与 AGENTS.md/CLAUDE.md
```

创建以下文件：

- `yo.toml` — 包清单：`[package]` 的名称与版本、`[modules] default = "src/lib.yo"`、一个空的 `[dependencies]` 表
- `build.yo` — 构建配置
- `src/main.yo` — 可执行文件入口
- `src/lib.yo` — 库代码
- `tests/main.test.yo` — 测试文件
- `.gitignore`、`README.md`

随后（除非传入 `--no-skills`）会把捆绑的 agent 技能文件安装到项目的 agent
配置目录（新项目中为 `.agents/skills/`），并写入两个面向 AI 编码代理的入口
文件：

- `AGENTS.md` — 列出已安装的技能及其描述；仅在不存在时创建
- `CLAUDE.md` — 指向 `AGENTS.md` 的一行指针；仅在不存在时创建

## 多目标构建

可以在单个 `build.yo` 中定义针对不同目标的多个产物：

```rust
build :: import "std/build";

// 模块定义

// 原生构建
native :: build.executable({
  name: "my-app",
  root: "./src/main.yo",
  optimize: build.Optimize.ReleaseFast
});

// WASM 构建（Emscripten）
wasm :: build.executable({
  name: "my-app-wasm",
  root: "./src/main.yo",
  target: build.CompilationTarget.Wasm32_Unknown_Emscripten,
  optimize: build.Optimize.ReleaseSmall,
  allocator: build.Allocator.System
});

// 每个产物的 C 标志——适用于 Emscripten 特定的链接器设置
wasm.add_c_flags("-sASYNCIFY -DPLATFORM_WEB");

run_native :: build.run(native);

install :: build.step("install", "Build all targets");
install.depend_on(native);
install.depend_on(wasm);

run_step :: build.step("run", "Run native build");
run_step.depend_on(run_native);
```

## 依赖管理

依赖在包清单 `yo.toml` 中声明——它是数据而不是代码：任何工具都能在不运行任何东西的情况下读取它，`yo add` / `yo remove` 原地编辑它并保留你的注释和格式。

```toml
[package]
name = "tetris_yo"
version = "0.3.0"
description = "Tetris in Yo"
license = "MIT"

[modules]                     # 导入方可写 `import("tetris_yo")` / `import("tetris_yo/board")`
default = "src/lib.yo"
board   = "src/board.yo"

[dependencies]
raylib_yo = { git = "https://github.com/shd101wyy/raylib_yo", version = "^0.0.6" }
json-yo   = { git = "https://github.com/user/json-yo", tag = "v1.2.0" }
utils     = { git = "https://github.com/user/mono", version = "~2.1", path = "packages/utils" }
mylib     = { path = "../mylib" }

[dev-dependencies]            # 只供本包自己的测试使用；不会传播给依赖方
snapshot  = { git = "https://github.com/user/snapshot-yo", version = "^0.4" }
```

### `[package]`

| 键            | 说明                                                             |
| ------------- | ---------------------------------------------------------------- |
| `name`        | 包名——导入方在 `import("name")` 中写的名字。必填。                |
| `version`     | 本包的语义化版本（发布标签 `vX.Y.Z` 所携带的版本）                 |
| `description` | 自由文本                                                         |
| `license`     | SPDX 标识符                                                      |
| `yo`          | 最低编译器版本（与 `.yo-version` 对应）                           |

### 依赖条目

一个依赖是一个表键（它的导入名）加一个内联表：

| 键        | 含义                                                                                     |
| --------- | ---------------------------------------------------------------------------------------- |
| `git`     | 仓库 URL——`https://…`、`git@host:path`、`ssh://…`，或 git 接受的本地路径                  |
| `version` | 覆盖仓库 `vX.Y.Z` 标签的 semver 范围；`yo install` 选取满足范围的最高标签                  |
| `tag`     | 一个精确标签                                                                             |
| `branch`  | 一个分支，在 `yo.lock` 中锁定到某个提交，只由 `yo update` 移动                             |
| `rev`     | 一个精确提交                                                                             |
| `path`    | 与 `git` 同用：包在仓库内的目录。单独使用：本地路径依赖（相对于 `yo.toml`）                 |

git 条目最多锁定 `version` / `tag` / `branch` / `rev` 之一；只有 `git` 时跟随远端默认分支。其他任何键都是错误——拼写错误永远不会悄悄变成"默认分支"。

### 版本范围

范围语法与 Cargo 相同：

| 范围              | 接受                                                                       |
| ----------------- | -------------------------------------------------------------------------- |
| `^1.2.3`、`1.2.3` | `>=1.2.3, <2.0.0`（`0.x`：`^0.2.3` 是 `<0.3.0`，`^0.0.3` 恰好是 `0.0.3`） |
| `~1.2.3`          | `>=1.2.3, <1.3.0`                                                          |
| `=1.2.3`          | 恰好 `1.2.3`                                                               |
| `>=1.2, <2`       | 用 `,` 连接的比较器（必须全部成立）                                        |
| `1.*`、`1.2.*`、`*` | 该主版本 / 次版本系列，任意版本                                            |

预发布标签（`v1.0.0-rc.1`）也是版本，但只有当范围指名了同一 `major.minor.patch` 的预发布版本时才接受（`^1.0.0-rc.1` 接受 `v1.0.0-rc.2` 和 `v1.0.0`；`^1.0.0` 永远不接受 `v1.5.0-beta.1`）。

### 添加依赖：`yo add`

```bash
yo add shd101wyy/raylib_yo        # 最新发布标签，写成 version = "^X.Y.Z"
yo add user/json-yo@^1.2          # 一个范围
yo add user/json-yo@v1.2.0        # 一个精确标签
yo add github.com/user/repo       # 显式主机；https://… 与 git@host:path 也可以
yo add user/mono --path packages/utils --name utils   # 仓库内的一个包
yo add user/tool --branch main    # 跟随分支
yo add user/tool --rev 0123abcd   # 锁定提交
yo add ./libs/mylib               # 本地路径依赖
yo add user/snapshot-yo --dev     # 写入 [dev-dependencies]
```

`yo add` 原地编辑 `yo.toml`（保留注释与格式），然后解析并抓取全部 git 依赖并写入 `yo.lock`。不带 `@…` 时用 `git ls-remote --tags` 查找最新发布标签并写成 caret 范围；没有发布标签的仓库按名字锁定到默认分支。导入名默认是仓库（或目录）名——用 `--name` 覆盖。

`yo remove <name>` 删除条目并剪除 `yo.lock`。

### 安装与更新：`yo install`、`yo update`

```bash
yo install            # 抓取 yo.toml 声明的依赖，写入 yo.lock
yo update             # 在范围内 / 到分支最新提交重新解析所有依赖
yo update raylib_yo   # 只更新一个
```

`yo install` 决定每个 git 依赖的 ref（范围 → 满足范围的最高标签，`tag`/`rev` → 本身，`branch` 或只有 `git` → 最新提交），克隆缓存缺少的内容，并把结果记录到 `yo.lock`。仍满足需求的锁条目直接复用而不访问网络，因此新克隆的项目运行 `yo install` 就能得到记录的提交；`yo update` 才会移动它们。`yo build` 对缓存缺失的依赖自动执行同一步骤。

`yo.lock` 为每个 git 依赖记录 URL、解析出的 ref、提交和抓取树的内容哈希——请提交到版本控制。不再出现在 `yo.toml` 中的依赖条目会在下一次 `yo install` 时剪除。

### 路径依赖（本地）

```toml
[dependencies]
mylib = { path = "../mylib" }
```

路径相对于 `yo.toml`。不抓取也不锁定：源码直接从原处读取，`../mylib` 中的修改在下次构建时生效。`yo add ./relative/path` 无论你如何输入，都以相对于 `yo.toml` 的形式写入条目。

### 导入依赖

```rust
mylib :: import "mylib";             // 依赖的默认模块
{ triple } :: import "mylib/extra";  // 命名模块，或默认根文件旁的同级文件
```

对依赖 `name`，`import("name")` 解析为：

1. 它的 `yo.toml` `[modules] default`（如果依赖有清单并声明了它）；
2. 否则依次为其目录中的 `src/lib.yo`、`index.yo`、`<name>.yo`。

`import("name/sub")` 是依赖声明的 `[modules] sub`，否则是默认根旁的 `sub.yo`。没有 `yo.toml` 的依赖也可以——按惯例根文件解析，且它没有自己的依赖。

解析在**每个**命令中都由清单驱动：编译器在被编译文件所在目录及以上找到最近的 `yo.toml`，读取闭包——项目自己的 `[modules]`、每个依赖以其名称暴露的模块，以及传递地每个依赖以**它们的**名称暴露的依赖——并在任何 `import` 求值之前完成名称映射。因此 `yo check src/main.yo`、`yo test ./tests`、`yo doc` 和 LSP 看到的导入与 `yo build` 相同。每个项目一个扁平命名空间：同一导入名指向两个不同文件是错误，并会报出两者。已声明但尚未抓取的依赖以 `import("x"): git dependency "x" is not installed — run \`yo install\`` 失败，而不是"module not found"。

在 `yo build` 下，运行器把同一映射写到 `yo-out/<target>/<kind>/<artifact>.imports`，并以 `--imports <file>` 传给子编译（该标志也可手工使用：每行一个 `name=/abs/root.yo`）。

### 传递依赖

每个依赖自己的 `yo.toml` 也会被读取，因此它的依赖可由它的模块按名称导入，整个闭包作为一组抓取；依赖的 git 依赖记录在根项目的 `yo.lock` 中。依赖的 `[dev-dependencies]` 是它自己的事，不会被解析。两个包以相同路径或提交指名同一依赖时共享一个条目；同一名称指向两个不同根文件是错误（`import name "x" reaches two different modules: … and …`）。跨图的版本统一（Cargo 的"每个兼容范围一个版本"规则）是计划的下一步；今天每个声明的范围由声明它的包各自解析。

### 依赖产物与 `build.dependency`

`build.dependency("name")` 返回 `yo.toml` 中已声明依赖的句柄——名称必须是清单声明的，否则构建失败。其 `.module("x")` 指名依赖的某个模块（以传播它链接的系统库），`.artifact("lib")` 指名依赖 `build.yo` 定义的静态库：

```rust
build :: import "std/build";

dep :: build.dependency("dep_lib");
add_lib :: dep.artifact("add");   // dep_lib 的 build.yo 中的一个 build.static_library

exe :: build.executable({ name: "demo", root: "./src/main.yo" });
exe.link(add_lib);
```

编译依赖的产物并链接进使用方（plans/BUILD_AND_DEPENDENCY_SYSTEM_REDESIGN.md §4.5.2–§4.5.3）尚未实现：今天 `dep.artifact` 只记录引用，`Step.link` 链接的是本项目 `build.yo` 的库。请改为按名称导入依赖的 Yo 代码。

### 全局缓存

依赖被全局缓存，避免跨项目重复下载：

```bash
# 显示缓存位置
yo cache path           # 例如 ~/.cache/yo

# 清除缓存
yo cache clean
```

**解析顺序：**

1. `$YO_CACHE_DIR`（环境变量）
2. `$XDG_CACHE_HOME/yo`（XDG 标准）
3. `~/.cache/yo`（Linux/macOS 默认）
4. `%LOCALAPPDATA%\yo\cache`（Windows 默认）

### 缓存完整性

每个抓取的依赖都在 `yo.lock` 中记录一个**内容哈希**：

```toml
[[dependencies]]
name   = "json-parser"
url    = "https://github.com/user/json-parser.git"
ref    = "v1.0.0"
commit = "abc123..."
hash   = "sha256-7c19c1..."
```

1. **抓取时** — `yo install` 在解析出的提交处克隆依赖，遍历提取的文件树，计算所有文件名和内容的 SHA-256 哈希。哈希写入 `yo.lock` 以及缓存目录内的 `.yo-content-hash` 旁车文件。

2. **安装时** — 锁条目仍满足需求的依赖会与旁车文件核对（O(1)）；匹配则不抓取任何东西。旁车文件缺失会触发完整重算；不匹配（文件被篡改或损坏）会删除缓存条目并重新克隆。

**跨平台稳定性：**哈希把 `\r\n` 规范化为 `\n`，因此同一依赖在 Windows 与 Linux 上的哈希相同；文件名以与区域设置无关的顺序排序。这遵循 Zig 对提取内容而非归档字节做哈希的模型。

### 系统库（pkg-config）

通过 `pkg-config` 链接系统 C 库：

```rust
build.system_library({
  name: "openssl",
  fallback_include: "/usr/include/openssl",
  fallback_lib: "/usr/lib",
  fallback_link: "ssl crypto",
  defines: "OPENSSL_API_COMPAT=0x10100000L"
});
```

当 `pkg-config` 可用时（Linux、macOS），它会自动使用 `name` 作为 pkg-config 包名来解析头文件路径和链接标志。当 `pkg-config` 不可用时（常见于 Windows），使用 fallback 字段。

`defines` 是一个以空格分隔的预处理器宏定义列表，Yo 会将其传递给 C 编译器（clang/gcc 使用 `-D...`，MSVC 使用 `/D...`），用于链接此系统库的任何产物。这适用于头文件修正、功能开关或属于库集成而非编译器本身的平台特定兼容性宏。

例如，`raylib` 在 Windows 上需要在包含 `raylib.h` 之前定义几个 Win32 宏：

```rust
raylib :: build.system_library({
  name: "raylib",
  defines: "NOMINMAX NOGDI NOUSER"
});
```

## `yo add` 参考

```
yo add <spec> [options]

规格：
  user/repo                  GitHub 简写
  user/repo@^1.2             semver 范围（^、~、=、>=、<、*，或裸版本号）
  user/repo@v1.2.0           精确标签
  github.com/user/repo、https://…、git@host:path
  ./path/to/dep              本地路径依赖

选项：
  --dev                      写入 [dev-dependencies]
  --path <subdir>            包在仓库内的子目录
  --name <name>              导入名（默认：仓库名）
  --branch <branch>          跟随分支（yo.lock 锁定提交）
  --rev <sha>                锁定某个提交
  -v, --verbose              显示详细进度
```

原地编辑 `yo.toml`，然后运行 `yo install`。需要当前目录或其上级存在 `yo.toml`（`yo init` 会创建）。

## `yo remove` 参考

```
yo remove <name> [--verbose]
```

从 `yo.toml`（`[dependencies]` 或 `[dev-dependencies]`）删除依赖并剪除其 `yo.lock` 条目。

## `yo install` 参考

```
yo install [--verbose]
```

把 `yo.toml` 声明的每个 git 依赖解析到一个提交（复用仍满足需求的 `yo.lock` 条目），抓取全局缓存缺少的内容，校验内容哈希，剪除过期条目并写入 `yo.lock`。锁完整且缓存完好时不需要网络。

## `yo update` 参考

```
yo update [name...] [--verbose]
```

重新解析指名的依赖（不给名字则全部）：`version` 范围允许的最高标签、`branch` 的最新提交、只有 `git` 的条目的远端默认分支。重写 `yo.lock`。

## `yo cache` 参考

```
yo cache <action>

Actions:
  path                   打印全局缓存目录路径
  clean                  删除所有缓存的依赖
```

可通过 `YO_CACHE_DIR` 环境变量覆盖缓存位置。

## 文档生成

Yo 内置了文档生成功能，能够从源代码中提取文档注释并生成 API 参考网站。

### 文档注释语法

Yo 支持四种文档注释样式，与 Rust 的约定一致：

| 样式     | 示例                       | 用途                        |
| -------- | -------------------------- | --------------------------- |
| `///`    | `/// 将两个数相加。`       | 外部行文档 — 记录下一个声明 |
| `//!`    | `//! 此模块提供数学工具。` | 内部行文档 — 记录所属模块   |
| `/** */` | `/** 将两个数相加。 */`    | 外部块文档 — 记录下一个声明 |
| `/*! */` | `/*! 模块级文档。 */`      | 内部块文档 — 记录所属模块   |

普通注释（`//`、`/* */`）**不是**文档注释 — 它们是内部注解和属性载体。

````rust
//! Yo 标准库的数学工具模块。

/// 将两个整数相加。
///
/// # 示例
///
/// ```rust
/// result :: add(i32(1), i32(2));
/// assert((result == i32(3)), "1 + 2 = 3");
/// ```
add :: (fn(a : i32, b : i32) -> i32)((a + b));
export add;
````

### `yo doc` 命令

生成文档的最简方式 — 无需任何配置：

```bash
# 为当前目录生成文档
yo doc

# 为特定文件或目录生成文档
yo doc ./src/lib.yo
yo doc ./std

# 选择输出格式
yo doc --format html        # 默认：静态 HTML 网站
yo doc --format markdown    # Markdown 文件
yo doc --format json        # 机器可读的 JSON

# 其他选项
yo doc -o docs/api          # 自定义输出目录
yo doc --name "My Library"  # 覆盖项目名称
yo doc --document-private   # 包含非导出项
yo doc --version v1.0.0     # 设置版本号（未指定时自动从 git 检测）
```

### 构建系统集成

对于高级项目，可在 `build.yo` 中配置文档生成：

```rust
build :: import "std/build";

// 定义文档配置
docs :: build.doc({
  name: "docs",
  root: "./src",
  output: "yo-out/doc",
  format: build.DocFormat.Html,
  title: "My Project API",
  version: "v1.0.0"
});

// 接入构建 DAG
doc_step :: build.step("doc", "Generate documentation");
doc_step.depend_on(docs);

install :: build.step("install", "Build all artifacts");
install.depend_on(doc_step);
```

然后运行：

```bash
yo build doc          # 生成文档
yo build --list-steps # 查看所有步骤（包括 doc）
```

### `DocFormat`

```rust
DocFormat :: enum(
  Html,       // 完全离线的静态 HTML 网站（默认）
  Markdown,   // README.md + module/<name>.md 文件
  Json        // 机器可读的 doc.json
);
```

### `DocConfig`

```rust
DocConfig :: struct(
  name : comptime_str,                            // 步骤名称
  root : comptime_str,                            // 源码根文件/目录
  (output : comptime_str) ?= "yo-out/doc",       // 输出目录
  (format : DocFormat) ?= DocFormat.Html,             // 输出格式
  (include_private : bool) ?= false,                 // 文档化非导出项
  (include_deps : bool) ?= false,                    // 文档化依赖项
  (title : comptime_str) ?= "",                   // 自定义站点标题
  (logo : comptime_str) ?= "",                    // Logo 图片路径
  (favicon : comptime_str) ?= ""                  // Favicon 路径
);
```

### 输出格式

**HTML**（默认）：生成完全自包含的静态网站，包括：

- 暗色模式、响应式布局
- 客户端搜索
- 侧边栏导航
- 所有 CSS/JS 内联 — 可从 `file://` URL 直接打开，无需 CDN
- 使用 [markdown_yo](https://www.npmjs.com/package/markdown_yo) 进行 Markdown 渲染

**Markdown**：生成 `README.md`（模块索引）和 `module/<name>.md`（每模块页面）。适合嵌入 GitHub 仓库或其他基于 Markdown 的文档系统。

**JSON**：将完整的文档模型序列化为 `doc.json`。适合自定义工具链、IDE 集成或接入其他渲染器。

## `yo doc` 参考

```
yo doc [path]

生成 API 文档

位置参数:
  path                   要文档化的文件或目录（默认："."）

选项:
  -o, --output           输出目录（默认："yo-out/doc"）
  -f, --format           输出格式：html、markdown、json（默认："html"）
      --name             项目名称（默认：自动推断）
      --document-private 包含非导出声明
  -v, --verbose          详细输出
```

## 另请参阅

- [BUILD_SYSTEM.md](../../plans/reference/BUILD_SYSTEM.md) — 包含实现细节的完整设计文档
- [Zig Build System](https://ziglang.org/learn/build-system/) — 主要灵感来源
