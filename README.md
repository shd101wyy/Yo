# Yo

<img src="./Yo_logo.png" width=96 height=96 />

**English** | [简体中文](./docs/zh-CN/README.md)

**Work in Progress :) Not Ready!**

https://shd101wyy.github.io/Yo

**LLM-friendly to write, human-friendly to read.**

A multi-paradigm, general-purpose, compiled programming language.
Yo aims to be **Simple** and **Fast** (around 0% - 15% slower than C).

> The name `Yo` comes from the Chinese word `柚` (yòu), meaning `pomelo`, a large citrus fruit similar to grapefruit. It's my daughter's nickname.

📖 [My Story with Programming Languages](./docs/en-US/MY_STORY_WITH_PROGRAMMING_LANGUAGES.md) — the journey from Java at 16 to building Yo.

<!-- @import "[TOC]" {cmd="toc" depthFrom=2 depthTo=6 orderedList=false} -->

<!-- code_chunk_output -->

- [Features](#features)
- [Installation](#installation)
  - [Install script (recommended)](#install-script-recommended)
  - [npm](#npm)
  - [Linux](#linux)
  - [macOS](#macos)
  - [Windows](#windows)
  - [WebAssembly (WASM)](#webassembly-wasm)
- [Quick Start](#quick-start)
- [Prelude](#prelude)
- [Standard Library](#standard-library)
- [Code examples](#code-examples)
  - [Hello World](#hello-world)
  - [Example Projects](#example-projects)
- [Contributing](#contributing)
  - [Setup](#setup)
- [Editor Support](#editor-support)
- [Version Management](#version-management)
- [AI Agent Skills](#ai-agent-skills)
  - [Using in your own project](#using-in-your-own-project)
- [Star History](#star-history)
- [License](#license)

<!-- /code_chunk_output -->

## Features

For the design of the language, please refer to [DESIGN.md](./docs/en-US/DESIGN.md).

Below is a non-exhaustive list of features that Yo supports:

- First-class types.
- Compile-time evaluation.
- Homoiconicity and metaprogramming (**Yo** syntax is inspired by the **Lisp** S expression. Simple syntax rule, Human & AI friendly).
- Closure.
- [Algebraic Effects and Handlers](./docs/en-US/ALGEBRAIC_EFFECTS.md) (One-shot delimited continuation. Tail-Resumptive. Effect handlers with `return`/`unwind`, by [Evidence Passing](https://xnning.github.io/papers/multip.pdf)).
- [Async/await](./docs/en-US/ASYNC_AWAIT.md) (Builtin `Io` effect. Stackless coroutine & Cooperative multi-tasking. Lazy Futures, multi-await, single-threaded concurrency via state machine transformation).
- [Memory safety by default](./docs/en-US/MEMORY_SAFETY.md) — user code can't write UB (no raw pointers, no FFI, no inline assembly) without an explicit `pragma(Pragma.AllowUnsafe);` opt-in. `inout(name)` for in-place mutation; `yo unsafe-report` for auditing the unsafe surface.
- `ref(struct(...))` and `ref(enum(...))` types with [Non-atomic Reference Counting and Thread-Local Cycle Collection](./docs/en-US/CYCLE_COLLECTION.md).
- [Compile-time Reference Counting with Ownership and Lifetime Analysis](./docs/en-US/COMPILE_TIME_RC_WITH_OWNERSHIP_ANALYSIS.md).
- Thread-per-core parallelism model (see [PARALLELISM.md](./docs/en-US/PARALLELISM.md)).
- [Declarative build system](./docs/en-US/BUILD_SYSTEM.md) inspired by Zig and Nix (`yo build`, `yo init`, WASM targets).
- **C** interop.
- etc.

<img width="855" height="368" alt="Image" src="https://github.com/user-attachments/assets/04a9050e-598b-4e02-a6c3-44863d47a4ac" />

## Installation

### Install script (recommended)

Installs a native prebuilt compiler — no Node.js or npm required.

```bash
# macOS / Linux
$ curl -sSL https://shd101wyy.github.io/Yo/install.sh | sh
```

```powershell
# Windows (PowerShell)
> irm https://shd101wyy.github.io/Yo/install.ps1 | iex
```

This installs to `<prefix>/lib/yo/<tag>` and links `<prefix>/bin/yo`, with the
prefix defaulting to `$HOME/.local`. Useful options:

| Option                   | Meaning                                                      |
| ------------------------ | ------------------------------------------------------------ |
| `-v, --version=<tag>`    | install a specific release (default: latest)                 |
| `-p, --prefix=<dir>`     | install prefix — `/usr/local` for system-wide (uses `sudo`)  |
| `--from-source`          | build from the published single-file `yo.c`                  |
| `-cc, --c-compiler=<cc>` | C compiler for the source build (implies `--from-source`)    |
| `-cflags, --c-flags=<f>` | extra C flags for the source build (implies `--from-source`) |
| `-u, --uninstall`        | uninstall instead of install                                 |
| `--dry-run`              | show what would happen, change nothing                       |

```bash
# a specific release, system-wide
$ curl -sSL https://shd101wyy.github.io/Yo/install.sh | sh -s -- --version=v0.2.6 --prefix=/usr/local

# build from source with your own toolchain
$ curl -sSL https://shd101wyy.github.io/Yo/install.sh | sh -s -- -cc=gcc -cflags='-march=native'
```

**Platforms without a prebuilt bundle** — pass `--from-source`. The installer
downloads the release's single-file `yo.c` and compiles it with your own C
compiler, so it links against your own libc and loader. This is the answer on
NixOS, where the prebuilt binary's hardcoded ELF interpreter
(`/lib64/ld-linux-x86-64.so.2`) does not exist.

### npm

The compiler is also published as an `npm` package:

```bash
$ npm install -g @shd101wyy/yo         # Install yo compiler globally
$ yarn global add @shd101wyy/yo        # Or using yarn
$ pnpm add -g @shd101wyy/yo            # Or using pnpm
$ bun install --global @shd101wyy/yo   # Or using bun
```

It exposes the `yo` command in your terminal.

There is also an alias `yo-cli` for `yo` command in case of naming conflicts.

Run `yo --help` or `yo-cli --help` to see available commands.

Yo transpiles to C, so a **C compiler** is required to produce machine code. Follow the instructions for your platform below.

### Linux

Install **Clang** (recommended), **liburing** (for async I/O), and **pkg-config** (for system library discovery):

```bash
# Ubuntu/Debian
$ sudo apt-get update
$ sudo apt-get install clang liburing-dev pkg-config

# Fedora/RHEL
$ sudo dnf install clang liburing-devel pkgconf-pkg-config

# Arch Linux
$ sudo pacman -S clang liburing pkgconf
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
$ yo compile main.yo --cc zig --release -o main
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

### WebAssembly (WASM)

Yo can compile to WebAssembly using [Emscripten](https://emscripten.org/):

```bash
# Install Emscripten (https://emscripten.org/docs/getting_started/downloads.html)
$ git clone https://github.com/emscripten-core/emsdk.git
$ cd emsdk
$ ./emsdk install latest
$ ./emsdk activate latest
$ source ./emsdk_env.sh

# Compile a Yo program to WASM
$ yo compile main.yo --cc emcc --release -o app

# This produces: app.html + app.js + app.wasm
# Run with Node.js:
$ node app.js

# Or open app.html in a browser
```

When using `--cc emcc`, Yo automatically targets `wasm32-emscripten` and uses the `libc` allocator. You can also use `--target wasm-emscripten` (which auto-selects `emcc`). Emscripten produces an `.html` file (browser shell), a `.js` file (runtime glue), and a `.wasm` file (compiled binary).

## Quick Start

```bash
$ yo init my-project        # Scaffold a new project
$ cd my-project
$ yo build run              # Build and run
Hello, world!
```

`yo init` generates a project with a build file, source, and tests:

```
my-project/
├── build.yo              # Build configuration
├── src/
│   ├── main.yo           # Entry point
│   └── lib.yo            # Library module
└── tests/
    └── main.test.yo      # Unit tests
```

`src/main.yo`:

```rust
{ println } :: import("std/fmt");

main :: (fn() -> unit)({
  println("Hello, world!");
});

export(main);
```

Common build commands:

```bash
$ yo build                  # Build all artifacts
$ yo build run              # Build and run the executable
$ yo build test             # Run tests
$ yo build --list-steps     # List available build steps
$ yo build doc              # Generate HTML documentation
$ yo fmt                    # Format Yo source files
$ yo fmt --check            # Check formatting without writing changes
```

## Prelude

Every Yo file automatically imports **[std/prelude.yo](./std/prelude.yo)**, which provides the core types, traits, and builtins available without any explicit import:

- **Primitive types**: `bool`, `i8`–`i64`, `u8`–`u64`, `f32`, `f64`, `isize`, `usize`, `str`
- **C-compatible types**: `int`, `uint`, `short`, `long`, `longlong`, `char`, etc.
- **Core traits**: `Eq`, `Ord`, `Add`, `Sub`, `Mul`, `Div`, `Iterator`, `IntoIterator`, `TryFrom`, `TryInto`, `Dispose`, `Send`, `Rc`, `Acyclic`, etc.
- **Metaprogramming**: `Type`, `Expr`, `ExprList`, `Var`
- **Async**: `Io`, `FutureState`, `JoinHandle`
- **Utilities**: `assert`, `unsafe`, `try`, `for`, `not`, `arc`, `Box`, `box`
- etc.

## Standard Library

_Still In Design_

Yo ships with a comprehensive standard library covering strings, collections, file I/O, networking, encoding, regex, crypto, and more. For the full module reference, see the **[Standard Library Documentation](https://shd101wyy.github.io/Yo/std)**.

You can generate documentation for your own project with `yo doc`:

```bash
$ yo doc ./src -o docs --title "My Project"
```

Or add a documentation step to your `build.yo` — see `yo doc --help` for details.

## Code examples

Check the [./tests](./tests/) and [./std](./std/) folders for more code examples.

### Hello World

```rust
// main.yo
{ println } :: import("std/fmt");

main :: (fn() -> unit)({
  println("Hello, world!");
});

export(main);

// $ yo compile main.yo --release -o main
// $ ./main
```

### Example Projects

| Project                                                                                                            | Description                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [raylib_yo](https://github.com/shd101wyy/raylib_yo)                                                                | Comprehensive [raylib](https://www.raylib.com/) bindings — 35 struct types, 535 functions, 227 constants                                                                            |
| [tetris_yo](https://github.com/shd101wyy/tetris_yo) \| [Online Demo](http://shd101wyy.github.io/tetris_yo)         | Classic Tetris game built with raylib_yo, demonstrating Yo's build system and C interop                                                                                             |
| [http_server_demo_yo](https://github.com/shd101wyy/http_server_demo_yo)                                            | Simple HTTP/1.1 server — async I/O, algebraic effects, TCP networking, request parsing & routing                                                                                    |
| [markdown_it_yo](https://github.com/shd101wyy/markdown_it_yo)                                                      | Direct port of the popular JavaScript markdown parser [markdown-it](https://github.com/markdown-it/markdown-it) to Yo, showcasing string processing and performance                 |
| [markdown_yo](https://github.com/shd101wyy/markdown_yo) \| [Online Demo](https://shd101wyy.github.io/markdown_yo/) | High-performance markdown-to-HTML converter — 5-7× faster than markdown-it (native), 2-6× faster (WASM at ≥1 MB). [Try it in the browser](https://shd101wyy.github.io/markdown_yo/) |
| [yo_http_benchmark](https://github.com/shd101wyy/yo_http_benchmark)                                                | HTTP throughput benchmark — Yo vs Bun vs Deno vs Node.js vs Go, using [wrk](https://github.com/wg/wrk) load testing                                                                 |

## Contributing

The `Yo` compiler is written in [TypeScript](https://www.typescriptlang.org/) and uses [Bun](https://bun.sh/) as the runtime.

Yo is primarily developed on the Steam Deck LCD (Linux). The compiler currently transpiles Yo to C; to produce
machine code you must have a C compiler (for example `gcc`, `clang`, `zig`, `cl`, `emcc`, etc).

Please install [nix](https://nixos.org/download.html) and [direnv](https://direnv.net/) before proceeding.

The dev environment is defined in [shell.nix](./shell.nix). You can also manually install the dependencies listed in the file.

### Setup

```bash
$ cd Yo
$ direnv allow . # Run this command to activate the nix shell.
                 # You only need to run it once.
$ bun install    # Install necessary dependencies.
```

Run the following command to watch for changes and build the project:

```bash
$ bun run dev
```

Run the following command to build the project:

```bash
$ bun run build
```

Test the local yo-cli:

```bash
$ bun run src/yo-cli.ts compile src/tests/fixme.yo

# There is also a `yo-cli` script in the project root for testing:
$ ./yo-cli compile src/tests/fixme.yo
```

## Editor Support

- A VS Code extension is available [here](https://marketplace.visualstudio.com/items?itemName=shd101wyy.yolang) with built-in **Language Server Protocol (LSP)** support, providing:

  - **Hover information** — types, values, and doc comments for any identifier
  - **Auto-completion** — struct fields, enum variants, module members, impl methods, keywords
  - **Go to definition** — jump to any symbol's definition
  - **Find references** — locate all usages of a symbol
  - **Rename symbol** — rename across all references
  - **Document symbols** — outline view of top-level declarations
  - **Signature help** — parameter hints while typing function calls
  - **Diagnostics** — real-time error reporting
  - **Code folding** — collapse function bodies, structs, impl blocks

  The LSP server can also be used with other editors via stdio JSON-RPC:

  ```bash
  node out/cjs/yo-lsp.cjs --stdio
  ```

  See [docs/en-US/LSP.md](./docs/en-US/LSP.md) for full documentation.

- Vim / Neovim: a minimal syntax file and a usage README are available in `vscode-extension/syntaxes/`.
  See [vscode-extension/syntaxes/README.md](./vscode-extension/syntaxes/README.md) for installation steps, `ftdetect` examples and `home-manager` snippets.

## Version Management

Yo supports per-project version pinning via a `.yo-version` file (similar to `.nvmrc` or `.python-version`):

```bash
# Pin your project to a specific Yo version
yo version pin 0.1.12

# Show current and pinned version
yo version

# Install, list, and clean cached versions
yo version install 0.1.13
yo version list
yo version clean
```

When a `.yo-version` file exists, the `yo` CLI automatically dispatches to the pinned version — downloading and caching it on first use. The LSP server also reads `.yo-version` to resolve the correct standard library for go-to-definition and completions.

See [docs/en-US/VERSION_MANAGEMENT.md](./docs/en-US/VERSION_MANAGEMENT.md) for full documentation.

## AI Agent Skills

This repository ships a set of **agent skill files** that teach AI agents how to write Yo programs. The skills are portable — you can copy the `.github/skills/` directory into any Yo project and agents will be able to use them there too.

| Skill                                                                | Description                                                                        |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [`yo-syntax`](.github/skills/yo-syntax/SKILL.md)                     | Core language syntax: curly braces, cond/match, structs, enums, operators, modules |
| [`yo-core-patterns`](.github/skills/yo-core-patterns/SKILL.md)       | Everyday patterns: types, generics, traits, error handling, collections, iterators |
| [`yo-async-effects`](.github/skills/yo-async-effects/SKILL.md)       | Async/await, algebraic effects, Exception, Io, spawning tasks                      |
| [`yo-project-workflow`](.github/skills/yo-project-workflow/SKILL.md) | `yo` CLI commands, `build.yo` project files, dependency management                 |

### Using in your own project

The easiest way is with the `yo` CLI:

```bash
yo skills install
```

This copies all skill files into every agent config directory found in the current project (`.github`, `.agents`, `.claude`, `.opencode`, `.openai`, `.cursor`). If none exist, `.agents/skills/` is created automatically.

You can also copy them manually:

```bash
cp -r .github/skills /path/to/your-yo-project/.github/
# or .agents, .claude, etc depending on your agent platform
```

Then in any AI agent session, invoke a skill by name (e.g. `@yo-syntax`) to give the agent contextual knowledge about the Yo language.

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=shd101wyy/Yo&type=date&legend=top-left)](https://www.star-history.com/#shd101wyy/Yo&type=date&legend=top-left)

## License

[UIUC/NCSA Open Source License](./LICENSE.md)
