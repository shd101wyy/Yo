# 安装 Yo

本页安装 `yo` 编译器以及它所交付输出的 C 工具链。Yo 编译为 C11，因此每次安装都需要一个
可用的 C 编译器。

## 安装脚本

```bash
# macOS / Linux
curl -sSL https://shd101wyy.github.io/Yo/install.sh | sh
```

```powershell
# Windows（PowerShell）
irm https://shd101wyy.github.io/Yo/install.ps1 | iex
```

脚本安装预编译的编译器（位于 `~/.local`，Windows 上为 `%LOCALAPPDATA%\Yo`），缺少
clang 和 git 时一并安装。每个发行版本位于 `<prefix>/lib/yo/<tag>`，标准库、手册和上下文包
与它并列，`<prefix>/bin/yo` 链接到它。
`curl -sSL https://shd101wyy.github.io/Yo/install.sh | sh -s -- --help` 列出全部选项：

| 选项                       | 作用                                                   |
| -------------------------- | ------------------------------------------------------ |
| `--version=<tag>`          | 安装该版本而不是最新版本                               |
| `--prefix=<dir>`           | 安装前缀（默认 `$HOME/.local`）                        |
| `--from-source`            | 从发布的单文件 `yo.c` 构建（见下文）                   |
| `--no-deps`、`--no-verify` | 跳过系统软件包安装，跳过 hello-world 检查              |
| `--no-solver`              | 不下载 Z3 求解器                                       |
| `-f`、`--force`            | 重新安装已经安装过的版本                               |
| `-u`、`--uninstall`        | 卸载                                                   |
| `--dry-run`                | 只显示将要执行的操作，不做任何改动                     |

脚本还会安装验证器使用的 [Z3](https://github.com/Z3Prover/z3) 求解器
（[FORMAL_VERIFICATION.md](FORMAL_VERIFICATION.md)）：为该版本构建的单个自包含
`z3` 可执行文件，解压到求解器缓存 `~/.cache/yo/solvers/`（Windows 上为
`%LOCALAPPDATA%\yo\cache\solvers\`，设置了 `$YO_CACHE_DIR` 时为
`$YO_CACHE_DIR/solvers/`）。Windows 上用 `-NoSolver` 跳过。

本页其余部分用于手动配置 C 工具链或排查安装失败。

## C 工具链

### Linux

安装 **Clang**（推荐）和 **pkg-config**（用于系统库发现）。异步 I/O 不需要任何额外的库：运行时通过内嵌在生成 C 中的环形层直接使用 io_uring，需要 Linux 内核 5.6 及以上（要让所有文件系统操作都走 io_uring 需 5.15 及以上——各操作的版本下限见 [STD_SYS_MODULE.md](./STD_SYS_MODULE.md)；io_uring 不可用时由 epoll 回退接管）：

```bash
# Ubuntu/Debian
$ sudo apt-get update
$ sudo apt-get install clang pkg-config

# Fedora/RHEL
$ sudo dnf install clang pkgconf-pkg-config

# Arch Linux
$ sudo pacman -S clang pkgconf
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
$ yo compile main.yo --cc zig --optimize 2 -o main
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

### WebAssembly

编译到 WebAssembly 还需要在上述工具链之外安装 Emscripten：[WASM.md](./WASM.md#配置)。

## 从可移植的 C 源码构建

每个发行版本还会以 C 源码 `yo.c` 的形式发布编译器，任何有 C 编译器的地方都能构建它。
`install.sh --from-source` 下载它，用你的工具链编译，并按预编译发行包的布局安装结果。
在预编译包无法运行的系统上（NixOS；脚本检测到这类系统时会提示）使用它。
`--c-compiler <cc>` 或 `--c-flags '<flags>'` 选择工具链，并隐含 `--from-source`：

```bash
curl -sSL https://shd101wyy.github.io/Yo/install.sh | sh -s -- --from-source
curl -sSL https://shd101wyy.github.io/Yo/install.sh | sh -s -- -cc=gcc -cflags='-march=native'
```

这样构建的安装没有 `vendor/` 目录，因此不能使用 `--allocator mimalloc`
（[BUILD_SYSTEM.md](./BUILD_SYSTEM.md#分配器)）。

## 升级与固定版本

再次运行安装脚本即可安装最新版本：它把新版本装在旧版本旁边，并让 `<prefix>/bin/yo`
指向它。`--version=<tag>` 安装（并切换到）指定版本。

`yo --version` 输出当前编译器的版本。项目在 `.yo-version` 文件中固定它所用的版本；
之后 `yo` 会下载该版本并用它执行命令：[VERSION_MANAGEMENT.md](./VERSION_MANAGEMENT.md)。
