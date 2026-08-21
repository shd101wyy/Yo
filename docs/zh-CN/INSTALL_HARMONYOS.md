<!-- 从 README.md 拆分出来，让首页可以直接推荐安装脚本；
     本页面用于手动配置与排查问题。 -->

# 在 HarmonyOS 上安装 C 工具链

> **多数情况下你不需要这一页。** `scripts/install.sh` 会自动检测 HarmonyOS
> 并替你安装全部依赖 —— 参见 [安装](../../README.md#安装)。只有在手动配置
> 工具链或排查安装失败时才需要阅读本页。

HarmonyOS 没有 Yo 的预编译 bundle，因此安装脚本会从发布的单文件 `yo.c`
构建 Yo（即 `yo-v<tag>-linux-<arch>.c.gz` 目标产物 —— HarmonyOS 是基于
Linux 内核的 musl 系统，所以 Linux 目标可以用 OHOS 工具链构建）。在此之前，
机器需要先有包管理器和几个软件包：

## 1. 安装 harmonybrew

HarmonyOS 没有 apt / dnf / pacman。包管理由 **harmonybrew** 承担 —— 它是
Homebrew 的移植实现，`brew` 命令的用法与 macOS 一致。请先安装它（安装脚本
不会替你猜测安装方式）：

- <https://harmonybrew.atomgit.com/>

## 2. 安装工具链

```bash
$ brew install git curl pkgconf liburing ohos-sdk
```

| 软件包      | 提供内容                                                           |
| ----------- | ------------------------------------------------------------------ |
| `ohos-sdk`  | `clang` / LLVM（目标平台为 `aarch64-unknown-linux-ohos`）          |
| `liburing`  | io_uring 头文件与库（异步 I/O）                                    |
| `pkgconf`   | `pkg-config` —— 编译器用它发现 `liburing`                          |
| `git`       | 依赖管理（`yo fetch` / `yo install`）                              |
| `curl`      | 安装脚本与编译器的发布包下载                                       |

`pkgconf` 必须与 `liburing` 成对安装，原因与 Linux 完全一致：只有
`pkg-config --exists liburing` 成功时 Yo 才会加 `-luring`，所以只有头文件
而没有 pkg-config 的机器会生成无法链接的 io_uring 调用。

## 3. 安装 Yo

```bash
$ curl -sSL https://raw.githubusercontent.com/shd101wyy/Yo/develop/scripts/install.sh | sh
```

安装脚本会：

1. 检测 HarmonyOS（`uname -s` 输出为 `HarmonyOS`）；
2. 检查 `brew` 是否存在，缺失时通过它安装 `git curl pkgconf liburing ohos-sdk`；
3. 下载 `yo-v<tag>-linux-<arch>.c.gz` 与发布版的源码包；
4. 用 OHOS clang 编译 `yo.c`（编译进 liburing，启用异步 I/O）；
5. 把 `yo` 安装到 `<prefix>/lib/yo/<tag>`，并链接 `<prefix>/bin/yo`。

## 要求与故障排查

- **内核必须支持 io_uring。** 编译器读取每个源文件都经过
  `io.await(read_file(...))`，而 Linux 异步运行时在 liburing 存在时无条件
  使用 io_uring —— 没有阻塞式 I/O 回退；不带 liburing 构建则会编译成桩
  实现，连源文件都无法读取。在内核不支持 `io_uring_setup` 的机器上，编译器
  启动时输出 `[Yo] io_uring_queue_init failed: ...` 并退出。
  实测于沙箱化的 HarmonyOS 镜像：`io_uring_setup` 成功，但 `io_uring_enter`
  （提交阶段）被 seccomp 拦截，首次文件读取就被 SIGSYS（rc=159）杀死 ——
  与仓库 CI 曾遇到的 Docker seccomp 拦截 io_uring 是同一模式（当时用
  `--security-opt seccomp=unconfined` 解决）。真实主机内核通常允许 io_uring；
  若某台 HarmonyOS PC 的策略禁止它，Yo 目前无法在那台机器上运行（阻塞式
  I/O 回退属于另一个项目）。
- **C11 兼容性修复之前的版本无法在此构建。** OHOS clang 严格遵循 C11：
  它拒绝标签直接位于声明之前（label-before-declaration），且 OHOS sysroot
  不在 `<sys/stat.h>` 中提供 `struct statx`。这两点都已在生成的 C 中修复
  （异步 while 标签后输出空语句；在 `__OHOS__` 下 `#include <linux/stat.h>`），
  因此发布在这些修复之后的 `yo.c` 可以顺利编译。更早的版本会报
  `expected expression` / `incomplete definition of type 'struct statx'` ——
  请使用更新的版本。
- **用户程序同样使用这个 clang 编译。** `yo compile` 默认调用 `clang`，
  因此上述严格 C11 保证适用于 Yo 生成的所有代码 —— 这也是为什么修复在
  codegen 里而不是在安装脚本里。
- **OHOS 加载器对运行库路径非常严格。** 实测于 HarmonyOS PC（鸿蒙内核、
  ohos-sdk 26.0.0.18）：加载器按 musl 搜索路径（`/etc/ld-musl-aarch64.path`）
  解析库文件，而 SDK 自带的 `llvm/lib/libxml2.so.16` 无法被加载器解析符号，
  导致 clang 的链接器 `ld.lld` 报 `Error relocating ... xmlFreeDoc:
  symbol not found`。有效的规避方法是预加载 harmonybrew 的 libxml2 ——
  `export LD_PRELOAD=$(brew --prefix)/lib/libxml2.so.16` —— 另外注意：一旦
  把 `LD_LIBRARY_PATH` 指向 brew 目录，加载器就会忽略 `LD_PRELOAD`
  （安全模式行为），所以编译时只用 preload，运行编译产物时再用
  `LD_LIBRARY_PATH`（或把 brew 的 `lib` 目录加入加载器路径文件）。
  修复后的 `ohos-sdk` bottle 会消除此问题。
