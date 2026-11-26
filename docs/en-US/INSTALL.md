# Installing Yo

This page installs the `yo` compiler and the C toolchain it hands its output
to. Yo compiles to C11, so a working C compiler is part of every install.

## The install script

```bash
# macOS / Linux
curl -sSL https://shd101wyy.github.io/Yo/install.sh | sh
```

```powershell
# Windows (PowerShell)
irm https://shd101wyy.github.io/Yo/install.ps1 | iex
```

The script installs a prebuilt compiler (under `~/.local`, or
`%LOCALAPPDATA%\Yo` on Windows), plus clang and git if they are missing. A
release lives in `<prefix>/lib/yo/<tag>` with its standard library, the
manuals and the context pack beside it, and `<prefix>/bin/yo` links to it.
`curl -sSL https://shd101wyy.github.io/Yo/install.sh | sh -s -- --help` lists
its options:

| Option                     | Effect                                                    |
| -------------------------- | --------------------------------------------------------- |
| `--version=<tag>`          | Install that release instead of the latest                |
| `--prefix=<dir>`           | Install prefix (default `$HOME/.local`)                   |
| `--from-source`            | Build from the published single-file `yo.c` (see below)   |
| `--no-deps`, `--no-verify` | Skip the system packages, skip the hello-world check      |
| `--no-solver`              | Do not download the Z3 solver                             |
| `-f`, `--force`            | Reinstall a release that is already installed             |
| `-u`, `--uninstall`        | Remove the install                                        |
| `--dry-run`                | Show what would happen, change nothing                    |

The script also installs the [Z3](https://github.com/Z3Prover/z3) solver the
verifier uses ([FORMAL_VERIFICATION.md](FORMAL_VERIFICATION.md)): one
self-contained `z3` binary built for the release, unpacked into the solver
cache, `~/.cache/yo/solvers/` (`%LOCALAPPDATA%\yo\cache\solvers\` on Windows,
`$YO_CACHE_DIR/solvers/` when that is set). On Windows `-NoSolver` skips it.

The rest of this page is for setting the C toolchain up by hand, or for
diagnosing a failed install.

## The C toolchain

### Linux

Install **Clang** (recommended) and **pkg-config** (for system library discovery). Async I/O needs no extra library: the runtime speaks io_uring directly through a ring layer vendored into the emitted C, and needs a Linux kernel of 5.6 or newer (5.15 or newer for every filesystem operation to run on io_uring — the per-operation floors are in [STD_SYS_MODULE.md](./STD_SYS_MODULE.md); where io_uring is unavailable, the epoll fallback takes over):

```bash
# Ubuntu/Debian
$ sudo apt-get update
$ sudo apt-get install clang pkg-config

# Fedora/RHEL
$ sudo dnf install clang pkgconf-pkg-config

# Arch Linux
$ sudo pacman -S clang pkgconf
```

You can also use `gcc` or `zig` instead of `clang` by passing `--cc gcc` or `--cc zig`.

### macOS

Clang is included with Xcode Command Line Tools:

```bash
$ xcode-select --install

# Also install pkgconf for system library discovery
$ brew install pkgconf
```

Or install LLVM via Homebrew:

```bash
$ brew install llvm pkgconf
```

### Windows

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

### WebAssembly

Compiling to WebAssembly needs Emscripten on top of the above:
[WASM.md](./WASM.md#setup).

## Building from the portable C source

Every release also publishes the compiler as C source, `yo.c`, that builds
anywhere with a C compiler. `install.sh --from-source` downloads it, compiles
it with your toolchain and lays the result out like a prebuilt release. Use it
where the prebuilt bundle cannot run (NixOS; the script says so when it detects
such a system). `--c-compiler <cc>` or `--c-flags '<flags>'` choose the
toolchain and imply `--from-source`:

```bash
curl -sSL https://shd101wyy.github.io/Yo/install.sh | sh -s -- --from-source
curl -sSL https://shd101wyy.github.io/Yo/install.sh | sh -s -- -cc=gcc -cflags='-march=native'
```

An install built this way has no `vendor/` directory, so `--allocator mimalloc`
is unavailable there ([BUILD_SYSTEM.md](./BUILD_SYSTEM.md#allocators)).

## Upgrading and pinning

Run the install script again to install the latest release: it adds the new
release beside the old ones and points `<prefix>/bin/yo` at it. `--version=<tag>`
installs (and switches to) a specific release.

`yo --version` prints the running compiler's version. A project pins the
version it builds with in a `.yo-version` file; `yo` then downloads that
release and runs the command with it: [VERSION_MANAGEMENT.md](./VERSION_MANAGEMENT.md).
