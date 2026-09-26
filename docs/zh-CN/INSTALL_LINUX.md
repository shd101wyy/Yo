<!-- 从 README.md 拆分出来，让首页可以直接推荐安装脚本；
     本页面用于手动配置与排查问题。 -->

# 在 Linux 上安装 C 工具链

> **多数情况下你不需要这一页。**`scripts/install.sh` 会替你安装 C 编译器和
> 其余依赖 —— 参见 [安装](../../README.md#安装)。只有在手动配置工具链或
> 排查安装失败时才需要阅读本页。


安装 **Clang**（推荐）和 **pkg-config**（用于系统库发现）。异步 I/O 不需要任何额外的库：运行时通过内嵌在生成 C 中的环形层直接使用 io_uring，只需要 Linux 内核 5.6 及以上：

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
