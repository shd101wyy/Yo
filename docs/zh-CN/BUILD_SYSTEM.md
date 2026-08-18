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
├── build.yo              ← 构建配置
├── deps.yo               ← 依赖声明（由 yo install 管理）
├── src/
│   ├── main.yo           ← 可执行文件入口
│   └── lib.yo            ← 库代码
├── tests/
│   └── main.test.yo      ← 测试文件
├── .gitignore
└── README.md
```

构建输出位于 `yo-out/<target>/` 目录下，按目标三元组组织（类似 Cargo）：

```
yo-out/
├── x86_64-linux-gnu/         ← 宿主目标
│   ├── bin/
│   │   └── my-project
│   └── lib/
│       └── libmy-project-lib.a
└── wasm32-emscripten/           ← 交叉编译目标（Emscripten）
    └── bin/
        ├── my-project.html
        ├── my-project.js
        └── my-project.wasm
```

## `build.yo`

构建文件是一个普通的 Yo 源文件，通过导入 `std/build` 模块来使用。所有构建函数在编译期执行，用于注册产物和步骤。

```rust
build :: import "std/build";

// 模块元数据
mod :: build.module({ name: "my-project", root: "./src/lib.yo" });

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
| `target`    | `comptime_str` | `target_host`      | 目标三元组（如 `"wasm32-emscripten"`） |
| `optimize`  | `Optimize`     | `Optimize.Debug`   | 优化级别                               |
| `allocator` | `Allocator`    | `Allocator.System` | 内存分配器                             |
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
| `Allocator.Libc`     | `Allocator.System` 的废弃别名 |

### 检测器

| 值                 | 描述                               |
| ------------------ | ---------------------------------- |
| `Sanitize.None`    | 不使用检测器（默认）               |
| `Sanitize.Address` | AddressSanitizer 内存错误/泄漏检测 |
| `Sanitize.Leak`    | LeakSanitizer 仅检测泄漏           |

### 编译目标

`CompilationTarget` 为支持的目标三元组提供了符号名称。推荐使用这些常量，而不是硬编码目标字符串：

| 值                                      | 目标三元组            | 说明                       |
| --------------------------------------- | --------------------- | -------------------------- |
| `CompilationTarget.X86_64_Linux_Gnu`    | `x86_64-linux-gnu`    | Linux x86-64（glibc）      |
| `CompilationTarget.X86_64_Linux_Musl`   | `x86_64-linux-musl`   | Linux x86-64（musl，原生） |
| `CompilationTarget.Aarch64_Linux_Gnu`   | `aarch64-linux-gnu`   | Linux ARM64                |
| `CompilationTarget.Aarch64_Linux_Musl`  | `aarch64-linux-musl`  | Linux ARM64（musl，原生）  |
| `CompilationTarget.Aarch64_Macos`       | `aarch64-macos`       | macOS Apple Silicon        |
| `CompilationTarget.X86_64_Macos`        | `x86_64-macos`        | macOS Intel                |
| `CompilationTarget.X86_64_Windows_Msvc` | `x86_64-windows-msvc` | Windows x86-64             |
| `CompilationTarget.Wasm32_Emscripten`   | `wasm32-emscripten`   | WebAssembly（Emscripten）  |
| `CompilationTarget.Wasm32_Wasi`         | `wasm32-wasi`         | WebAssembly（独立 WASI）   |

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
| `step.add_import(entry)`        | 添加单个模块导入到此步骤（用于依赖模块）            |
| `step.add_import_list(entries)` | 从 `ComptimeList(ImportEntry)` 批量添加多个模块导入 |
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

模块是 Yo 依赖间复用的基本单元。模块声明其源码根目录和系统库依赖。当其他项目导入某个模块时，其系统库会自动传播给使用者的构建——无需手动调用 `system_library` 或 `link`。

### 定义模块

```rust
build :: import "std/build";

raylib :: build.system_library({
  name: "raylib",
  defines: "NOMINMAX NOGDI NOUSER"
});

// 声明模块及其根源文件
mod :: build.module({ name: "raylib_yo", root: "./src/lib.yo" });

// 链接模块依赖的系统库
mod.link(raylib);

exe :: build.executable({ name: "raylib_yo", root: "./src/main.yo" });
exe.link(raylib);

install :: build.step("install", "Build all artifacts");
install.depend_on(exe);
```

### `BuildModule`

由 `build.module()` 返回。有一个方法：

| 方法            | 描述                     |
| --------------- | ------------------------ |
| `mod.link(lib)` | 声明此模块依赖某个系统库 |

### `ModuleConfig`

| 字段   | 类型           | 默认值     | 描述         |
| ------ | -------------- | ---------- | ------------ |
| `name` | `comptime_str` | _（必填）_ | 模块名称     |
| `root` | `comptime_str` | _（必填）_ | 根源文件路径 |

### 从依赖导入模块

使用 `dep.module()` 和 `exe.add_import()` 从依赖中导入模块：

```rust
build :: import "std/build";

// Git 依赖
raylib_yo :: build.dependency({ name: "raylib_yo", url: "https://github.com/shd101wyy/raylib_yo.git", ref: "v0.0.4" });

// 或者本地路径依赖：
// raylib_yo :: build.path_dependency({ name: "raylib_yo", path: "../raylib_yo" });

exe :: build.executable({ name: "tetris_yo", root: "./src/main.yo" });

// 导入模块——系统库（raylib）会被传递性地传播
exe.add_import({ name: "raylib_yo", module: raylib_yo.module() });

install :: build.step("install", "Build all artifacts");
install.depend_on(exe);
```

- `dep.module()` — 获取依赖中唯一的模块（空名称默认为唯一模块）
- `dep.module("name")` — 如果依赖定义了多个模块，按名称获取特定模块
- `exe.add_import({ name, module })` — 在产物上注册单个模块导入
- `exe.add_import_list(list)` — 从 `ComptimeList(ImportEntry)` 批量注册多个模块导入

### 使用 `add_import_list` 批量导入

当依赖导出多个模块时，使用 `add_import_list` 一次性注册所有模块：

```rust
import_list :: ComptimeList(build.ImportEntry)(
  { name: "mod_a", module: dep.module("a") },
  { name: "mod_b", module: dep.module("b") }
);
exe.add_import_list(import_list);
```

### `ImportEntry`

| 字段     | 类型           | 描述                                |
| -------- | -------------- | ----------------------------------- |
| `name`   | `comptime_str` | 导入名称（用于 `import "name"`）    |
| `module` | `BuildModule`  | 要导入的模块（来自 `dep.module()`） |

### 工作原理

当你运行 `yo build` 时，构建系统会：

1. **求值依赖的 `build.yo`** 以发现其模块和链接的系统库
2. **解析系统库** 通过 `pkg-config`（或回退标志）为每个模块查找库
3. **传播标志** — 来自模块系统库的头文件路径、库路径、链接标志和宏定义会合并到使用方产物的编译命令中
4. **设置导入解析** — 使用方源码中的 `import "raylib_yo"` 会解析到该模块的根文件

这意味着使用方不需要声明 `build.system_library({ name: "raylib" })` —— 系统库会从依赖的模块定义中自动传播。

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
stdio :: import "std/libc/stdio";

extern "Yo",
  add : (fn(a: i32, b: i32) -> i32);

main :: (fn() -> unit)({
  result := add(i32(3), i32(4));
  stdio.printf("3 + 4 = %d\n", result);
});

export main;
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
└── x86_64-linux-gnu/
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
> musl 目标（`x86_64-linux-musl`）仅在 musl 原生系统（如 Alpine Linux）上受支持。

Yo 通过目标三元组支持 WASM 目标。可以在 `build.yo` 中或命令行上指定目标：

### 在 `build.yo` 中

```rust
build.executable({
  name: "my-app-wasm",
  root: "./src/main.yo",
  target: build.CompilationTarget.Wasm32_Emscripten,
  optimize: build.Optimize.ReleaseSmall
});
```

也可以使用原始目标字符串：

```rust
build.executable({
  name: "my-app-wasm",
  root: "./src/main.yo",
  target: "wasm32-emscripten",
  optimize: build.Optimize.ReleaseSmall
});
```

### 在命令行上

```bash
# 为所有产物覆盖目标
yo build --target wasm-emscripten
```

### 支持的目标

| 目标三元组            | 说明                       |
| --------------------- | -------------------------- |
| `x86_64-linux-gnu`    | Linux x86-64（glibc）      |
| `x86_64-linux-musl`   | Linux x86-64（musl，原生） |
| `aarch64-linux-gnu`   | Linux ARM64                |
| `aarch64-linux-musl`  | Linux ARM64（musl，原生）  |
| `aarch64-macos`       | macOS Apple Silicon        |
| `x86_64-macos`        | macOS Intel                |
| `x86_64-windows-msvc` | Windows x86-64             |
| `wasm32-emscripten`   | WebAssembly（Emscripten）  |
| `wasm32-wasi`         | WebAssembly（独立 WASI）   |

缩写别名：`wasm-emscripten` → `wasm32-emscripten`，`wasm-wasi` → `wasm32-wasi`。

### WASM Emscripten 环境

通过 `yo build` 构建 `wasm32-emscripten` 目标时，默认输出为**浏览器**环境：

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
cd yo-out/wasm32-emscripten/bin
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
  --cc <compiler>        C 编译器：clang, gcc, zig, cc, cl
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
```

创建以下文件：

- `build.yo` — 构建配置（导入 `deps.yo`）
- `deps.yo` — 依赖声明（空模板）
- `src/main.yo` — 可执行文件入口
- `src/lib.yo` — 库代码
- `tests/main.test.yo` — 测试文件
- `.gitignore`、`README.md`

## 多目标构建

可以在单个 `build.yo` 中定义针对不同目标的多个产物：

```rust
build :: import "std/build";

// 模块定义
mod :: build.module({ name: "my-app", root: "./src/lib.yo" });

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
  target: build.CompilationTarget.Wasm32_Emscripten,
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

### Git 依赖

在 `build.yo` 中声明 Git 托管的依赖：

```rust
build :: import "std/build";

// 添加 Git 依赖——返回一个 Dependency 句柄
dep :: build.dependency({
  name: "json-parser",
  url: "https://github.com/user/json-parser.git",
  ref: "v1.0.0"
});

// 从仓库子目录获取依赖
build.dependency({
  name: "utils",
  url: "https://github.com/user/mono-repo.git",
  ref: "main",
  path: "packages/utils"
});

exe :: build.executable({ name: "my-app", root: "./src/main.yo" });

install :: build.step("install", "Build all artifacts");
install.depend_on(exe);
```

使用以下命令拉取依赖：

```bash
yo fetch              # 从 build.yo 中拉取所有依赖
yo fetch --verbose    # 显示详细进度
yo fetch --update     # 重新解析 Git 引用到最新提交
```

也可以直接从 GitHub 安装：

```bash
yo install github.com/user/repo          # 最新语义化版本标签
yo install github.com/user/repo@v1.0.0   # 固定版本
yo install user/repo                     # GitHub 简写
yo install ./path/to/local/dep           # 本地路径依赖
```

`yo install` 会从仓库解析最新的语义化版本标签（如果没有则回退到默认分支），在 `build.yo` 中追加 `build.dependency(...)` 调用，并将依赖拉取到全局缓存中。对于本地路径（`./`、`../` 或绝对路径），则追加 `build.path_dependency(...)` 调用——无需拉取。

依赖存储在全局缓存中，并由 `yo.lock` 追踪（请将此文件提交到版本控制）。`yo build` 会在依赖尚未缓存时自动拉取。

**更新依赖**：使用分支引用（如 `"main"`）时，锁文件会固定拉取时的确切提交 SHA。运行 `yo fetch --update`（或 `yo fetch -u`）可重新解析所有引用到最新提交并更新 `yo.lock`。

### 链接依赖产物

如果某个依赖有自己的 `build.yo` 且定义了产物（如静态库），可以使用 `dep.artifact()` 来链接：

```rust
build :: import "std/build";

// 注册依赖（Git 或路径）
dep :: build.path_dependency({ name: "dep_lib", path: "../dep_lib" });

// 访问 dep_lib 的 build.yo 中定义的 "add" 静态库
add_lib :: dep.artifact("add");

// 链接到我们的可执行文件
exe :: build.executable({ name: "demo", root: "./src/main.yo" });
exe.link(add_lib);

install :: build.step("install", "Build demo");
install.depend_on(exe);
```

依赖的 `build.yo` 定义了静态库：

```rust
build :: import "std/build";

lib :: build.static_library({ name: "add", root: "./src/lib.yo" });

install :: build.step("install", "Build the static library");
install.depend_on(lib);
```

当你运行 `yo build` 时，构建系统会：

1. 求值依赖的 `build.yo` 以发现其产物
2. 编译依赖的静态库（`libadd.a`）
3. 将其链接到使用方的可执行文件

使用方的源码通过 `extern "Yo"` 声明依赖的函数：

```rust
extern "Yo",
  add : (fn(a: i32, b: i32) -> i32);
```

### 路径依赖（本地）

使用 `path_dependency` 通过文件系统路径依赖本地包。与 `dependency` 一样，它返回一个 `Dependency` 句柄：

```rust
build :: import "std/build";

// 依赖同级项目——返回一个 Dependency 句柄
dep :: build.path_dependency({
  name: "mylib",
  path: "../mylib"
});

exe :: build.executable({ name: "my-app", root: "./src/main.yo" });

install :: build.step("install", "Build all artifacts");
install.depend_on(exe);
```

在源码中按名称导入依赖：

```rust
mylib :: import "mylib";

main :: (fn() -> unit) {
  result := mylib.multiply(i32(3), i32(4));
};
export main;
```

路径依赖的**入口文件解析顺序**：

1. 来自 `add_import()` 的模块根文件（如果使用方调用了 `exe.add_import()`）
2. 依赖的 `build.yo` 中唯一的模块根文件（如果恰好定义了一个模块）
3. `index.yo`
4. `<name>.yo`

路径依赖不需要拉取或锁文件条目——直接从本地文件系统解析。

### `deps.yo` — 依赖声明文件

`yo init` 会在 `build.yo` 旁生成一个 `deps.yo` 文件。该文件是声明所有项目依赖的集中位置，让 `build.yo` 专注于构建逻辑。

**生成的 `deps.yo`（空模板）：**

```rust
// Dependencies for this project.
// Managed by `yo install`. Manual edits are preserved.
//
// Usage in build.yo:
//   { imports } :: import "./deps.yo";
//   exe.add_import_list(imports);
//
// Add a dependency:
//   yo install user/repo
//   yo install user/repo@v1.0.0
//   yo install ./local-path

build :: import "std/build";

// --- Dependencies ---

// --- Import list ---
imports :: ComptimeList(build.ImportEntry)();
export imports;
```

**包含依赖的 `deps.yo`：**

```rust
build :: import "std/build";

// --- Dependencies ---
raylib_yo :: build.dependency({ name: "raylib_yo", url: "https://github.com/shd101wyy/raylib_yo.git", ref: "v0.0.4" });
json :: build.path_dependency({ name: "json", path: "../json-yo" });

// --- Import list ---
imports :: ComptimeList(build.ImportEntry)(
  { name: "raylib_yo", module: raylib_yo.module() },
  { name: "json", module: json.module() }
);
export imports;
```

**在 `build.yo` 中使用 `deps.yo`：**

```rust
build :: import "std/build";
{ imports } :: import "./deps.yo";

exe :: build.executable({ name: "my-app", root: "./src/main.yo" });
exe.add_import_list(imports);

install :: build.step("install", "Build all artifacts");
install.depend_on(exe);
```

运行 `yo install` 时，依赖会自动添加到 `deps.yo` 中，并重新生成 `imports` 列表。如果 `deps.yo` 不存在，会从模板创建。

> **注意：** 在 `build.yo` 中直接使用 `build.dependency()` 仍然有效。`deps.yo` 模式是新项目的推荐做法。

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

每个缓存的依赖在 `yo.lock` 中都有一个**内容哈希**：

```toml
[[dependencies]]
name = "json-parser"
url = "https://github.com/user/json-parser.git"
ref = "v1.0.0"
commit = "abc123..."
hash = "sha256-7c19c1..."
```

**工作原理：**

1. **拉取时** — `yo fetch` 克隆依赖，遍历提取的文件树，计算所有文件名和内容的 SHA-256 哈希。哈希写入 `yo.lock` 以及缓存目录内的 `.yo-content-hash` 辅助文件。

2. **构建时** — `yo build` 读取辅助文件（O(1)），与 `yo.lock` 中的哈希进行比较。如果匹配，则信任缓存。如果辅助文件缺失（例如旧版缓存），会执行完整的重新哈希并写入辅助文件供后续构建使用。

3. **不匹配时** — 如果哈希不匹配（例如文件被篡改或损坏），`yo build` 会报告错误，显示预期和实际的哈希值，并建议运行 `yo fetch`。运行 `yo fetch` 会自动删除损坏的缓存并重新克隆。

**跨平台稳定性：**

内容哈希在计算时会将 `\r\n` 规范化为 `\n`，因此同一个依赖在 Windows（可能检出 CRLF）和 Linux（LF）上产生相同的哈希值。文件名使用与区域设置无关的 Unicode 排序（大小写不敏感的主排序，码点作为辅助排序），而非依赖区域设置的排序方式，确保哈希值在任何系统区域设置下都是确定的。

这种方式遵循了 Zig 的模型——对提取的内容进行哈希，而非像 npm/Go 那样对归档字节进行哈希。它不需要存储归档文件，且能验证编译器实际读取的源文件。

### 共享依赖

当多个包依赖同一个依赖（相同的 URL+ref 或相同的路径）时，构建系统使用**内容寻址缓存**，确保该依赖只编译一次：

```
   root project
   ├── dep_A → dep_C (path: ../shared_lib)
   └── dep_B → dep_C (path: ../shared_lib)
```

依赖标识通过哈希计算（基于解析后的路径或 Git URL+ref）。相同的哈希共享单个编译产物，避免冗余构建。

如果两个依赖需要**不同版本**的同一个包（不同的 URL 或 ref），每个版本会使用唯一的内容哈希分别编译。

### 传递依赖

依赖可以有自己的依赖。构建系统会自动解析完整的传递闭包：

```
root project
├── dep_a（链接 dep_b）
│   └── dep_b
└──（dep_b 被传递性地拉取和编译）
```

**工作原理：**

1. **递归拉取** — 当 `yo build`（或 `yo fetch`）运行时，每个依赖的 `build.yo` 都会被求值以发现其自身的依赖。子依赖以广度优先的方式递归拉取，并记录在根项目的 `yo.lock` 中。

2. **递归编译** — 子依赖在其父依赖之前编译。在上面的例子中，`dep_b` 的静态库先编译，然后 `dep_a` 链接它。

3. **链接传播** — 当 `dep_a` 链接 `dep_b` 的 `.a` 文件时，该传递性 `.a` 文件会自动传播到根项目的链接器命令中。最终根可执行文件会同时链接 `libadd3.a`（来自 dep_a）和 `libadd.a`（来自 dep_b）。

4. **导入解析** — 当 `dep_a` 的源码执行 `import "dep_b"` 时，构建系统会回退到根项目的 `yo.lock` 来解析导入路径。

无需特殊配置——传递依赖会从依赖图中被自动发现和链接。

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

## `yo fetch` 参考

```
yo fetch [options]

Options:
  --build-file <path>    构建文件路径（默认：./build.yo）
  --verbose, -v          详细输出
  --update, -u           重新解析 Git 引用到最新提交并更新 yo.lock
```

`yo fetch` 求值 `build.yo` 以发现依赖，通过 `git ls-remote` 将 Git 引用解析为确切的提交 SHA，克隆到全局缓存，计算内容哈希，并将所有信息记录在 `yo.lock` 中。

不使用 `--update` 时，已缓存的依赖会通过辅助文件与 `yo.lock` 中的哈希进行比对验证。如果哈希匹配，则完全跳过拉取（无需网络访问）。如果哈希不匹配，损坏的缓存条目会被删除并自动重新克隆。使用 `--update` 时，即使已缓存，所有引用也会被重新解析和重新拉取——适用于追踪分支 HEAD 的变化。

**自动清理**：如果某个依赖已从 `build.yo` 中移除，`yo fetch` 会自动从 `yo.lock` 中移除该过时条目。全局缓存中的文件不会被删除（使用 `yo cache clean` 可清除缓存）。

## `yo install` 参考

```
yo install <package> [options]

Arguments:
  package                包标识符（格式见下方）

Options:
  --build-file <path>    构建文件路径（默认：./build.yo）
  --verbose, -v          详细输出

包标识符格式：
  github.com/user/repo          GitHub 最新语义化版本标签
  github.com/user/repo@v1.0.0   固定版本/标签
  user/repo                     GitHub 简写
  user/repo@v2.0.0              简写加版本固定
  https://example.com/repo.git  完整 URL
  ./path/to/dep                 本地路径依赖
  ../sibling-dep                本地路径依赖
```

`yo install` 执行以下步骤：

**对于 Git 依赖：**

1. 解析包标识符并从仓库名推断依赖名称
2. 通过 `git ls-remote --tags` 解析最新的语义化版本标签（或使用固定版本）
3. 如果没有语义化版本标签，回退到默认分支
4. 在 `deps.yo` 中追加 `build.dependency(...)`（如果文件不存在则创建）
5. 重新生成 `deps.yo` 中的 `imports` ComptimeList
6. 拉取依赖并更新 `yo.lock`

**对于本地路径依赖：**

1. 从目录名推断名称
2. 验证路径是否存在
3. 在 `deps.yo` 中追加 `build.path_dependency(...)`
4. 重新生成 `deps.yo` 中的 `imports` ComptimeList

如果 `build.yo` 已经导入了 `deps.yo`，则无需额外修改。

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

- [BUILD_SYSTEM.md](../../plans/BUILD_SYSTEM.md) — 包含实现细节的完整设计文档
- [Zig Build System](https://ziglang.org/learn/build-system/) — 主要灵感来源
