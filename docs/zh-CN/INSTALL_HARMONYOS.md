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

安装完成后，请确保 `<prefix>/bin`（默认 `~/.local/bin`）在 `PATH` 中 ——
例如在 `~/.zshrc` / `~/.bashrc` 中加入：
`export PATH="$HOME/.local/bin:$PATH"`，然后重新登录或 `source` 该文件。

**需要多久：** 第 4 步占绝大部分时间 —— 它是用 `-O2` 对约 100 MB 的单文件
C 做一次 clang 编译，请按几十分钟而不是几秒来预计。实测于 HarmonyOS PC
（arm64，SDK clang 15）：**机器空闲时约 20 分钟，有正常后台负载时约 1 小时，
机器繁忙时更长**（本机运行着负载 20+ 的搜索/AI 服务，一次完整安装曾被拖到
接近两小时）。其余步骤（下载、打补丁、安装）都在一两分钟内。没有增量捷径：
每个版本安装都会重新编译整个文件。

## 要求与故障排查

- **内核必须支持 io_uring。** 编译器读取每个源文件都经过
  `io.await(read_file(...))`，而 Linux 异步运行时在 liburing 存在时无条件
  使用 io_uring —— 没有阻塞式 I/O 回退；不带 liburing 构建则会编译成桩
  实现，连源文件都无法读取。在内核不支持 `io_uring_setup` 的机器上，编译器
  启动时输出 `[Yo] io_uring_queue_init failed: ...` 并退出。
  实测于沙箱化的 HarmonyOS 镜像：`io_uring_setup` 成功，但 `io_uring_enter`
  （提交阶段）被 seccomp 拦截，首次文件读取就被 SIGSYS（rc=159）杀死 ——
  与仓库 CI 曾遇到的 Docker seccomp 拦截 io_uring 是同一模式（当时用
  `--security-opt seccomp=unconfined` 解决）。在该镜像上这种拦截是**系统级**
  的（所有进程和 shell 都受影响，不只是某个工具的沙箱），且安装 SIGSYS
  处理器也无济于事：系统调用根本不会执行（submit 看似成功但没有完成事件，
  即使带超时的等待也会挂起）。真实主机内核通常允许 io_uring；若某台
  HarmonyOS PC 的策略禁止它，Yo 目前无法在那台机器上运行（阻塞式 I/O
  回退属于另一个项目）。
- **旧版本会自动打补丁。** OHOS clang 严格遵循 C11：它拒绝标签直接位于
  声明之前（label-before-declaration），且 OHOS sysroot 不在 `<sys/stat.h>`
  中提供 `struct statx`。在 codegen 修复之前发布的版本（v0.2.14/v0.2.15
  时代）生成的 C 同时带有这两个问题，因此安装脚本会在编译前对下载的
  `yo.c` 就地打补丁（幂等变换 —— 修复后的新版本原样通过，不受影响）。
- **用户程序同样使用这个 clang 编译。** `yo compile` 默认调用 `clang`，
  因此上述严格 C11 保证适用于 Yo 生成的所有代码 —— 这也是为什么修复在
  codegen 里而不是在安装脚本里。
- **OHOS 加载器对运行库路径非常严格。** 实测于 HarmonyOS PC（鸿蒙内核、
  ohos-sdk 26.0.0.18）：加载器按 musl 搜索路径（`/etc/ld-musl-aarch64.path`）
  解析库文件，brew 的 `lib` 目录不在其中；更糟的是，一旦把
  `LD_LIBRARY_PATH` 指向 brew 前缀，加载器会拒绝解析 lld 自带的
  `libxml2` 依赖 —— clang 的链接器随即报 `Error relocating ... xmlFreeDoc:
  symbol not found`，此时任何 `LD_PRELOAD` 变通方案也无效。Yo 通过
  **静态链接 liburing** 绕开了这一切：编译器二进制和它构建的每个程序
  都只依赖系统 libc（实测 `DT_NEEDED` 只有 `libc.so`）。所以：不要把
  `LD_LIBRARY_PATH` 写进 shell 配置文件；如果某个依赖 brew 库的工具需要
  它，只在该命令上临时设置。
