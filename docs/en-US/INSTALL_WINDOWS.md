<!-- Split out of README.md so the front page can lead with the install
script, which sets these up for you. This guide is for manual setup and
for troubleshooting. -->

# Installing the C toolchain on Windows

> **You probably do not need this page.** `scripts/install.sh` installs a C
> compiler and the rest of these dependencies for you — see
> [Installation](../../README.md#installation). Read on only if you are
> setting the toolchain up by hand, or diagnosing a failed install.


Clang on Windows requires a linker and Windows SDK headers. Install **Visual Studio** (Community edition is free) or the **Build Tools for Visual Studio** with the "Desktop development with C++" workload:

1. Download from [https://visualstudio.microsoft.com/downloads/](https://visualstudio.microsoft.com/downloads/)
2. In the installer, select **"Desktop development with C++"** (this includes MSVC, Windows SDK, and the linker)
3. Then install LLVM/Clang:

```bash
# Using Chocolatey
$ choco install llvm

# Using Scoop
$ scoop install llvm

# Or download from https://releases.llvm.org/
```

Alternatively, you can use `zig` as the C compiler (no Visual Studio needed):

```bash
$ choco install zig
$ yo compile main.yo --cc zig --optimize 2 -o main
```

For system library discovery, install **vcpkg**:

```bash
$ git clone https://github.com/microsoft/vcpkg.git
$ .\vcpkg\bootstrap-vcpkg.bat
# Then set the VCPKG_ROOT environment variable to the vcpkg directory

# Or using Scoop
$ scoop install vcpkg
```

For more information, see the [vcpkg documentation](https://learn.microsoft.com/en-us/vcpkg/get_started/get-started).
