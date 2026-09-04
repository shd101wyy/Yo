<!-- 从 README.md 拆分出来，让首页可以直接推荐安装脚本；
     本页面用于手动配置与排查问题。 -->

# 在 Windows 上安装 C 工具链

> **多数情况下你不需要这一页。**`scripts/install.sh` 会替你安装 C 编译器和
> 其余依赖 —— 参见 [安装](../../README.md#安装)。只有在手动配置工具链或
> 排查安装失败时才需要阅读本页。


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
