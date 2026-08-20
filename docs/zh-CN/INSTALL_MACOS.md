<!-- 从 README.md 拆分出来，让首页可以直接推荐安装脚本；
     本页面用于手动配置与排查问题。 -->

# 在 macOS 上安装 C 工具链

> **多数情况下你不需要这一页。**`scripts/install.sh` 会替你安装 C 编译器和
> 其余依赖 —— 参见 [安装](../../README.md#安装)。只有在手动配置工具链或
> 排查安装失败时才需要阅读本页。


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
