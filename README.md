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
- [Quick Start](#quick-start)
- [Prelude](#prelude)
- [Standard Library](#standard-library)
- [Code examples](#code-examples)
  - [Hello World](#hello-world)
  - [Example Projects](#example-projects)
- [Contributing](#contributing)
- [Editor Support](#editor-support)
- [Version Management](#version-management)
- [AI Agent Skills](#ai-agent-skills)
  - [Using in your own project](#using-in-your-own-project)
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

Installs a native prebuilt compiler.

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
$ curl -sSL https://shd101wyy.github.io/Yo/install.sh | sh -s -- --version=v0.2.4 --prefix=/usr/local

# build from source with your own toolchain
$ curl -sSL https://shd101wyy.github.io/Yo/install.sh | sh -s -- -cc=gcc -cflags='-march=native'
```

**Platforms without a prebuilt bundle** — pass `--from-source`. The installer
downloads the release's single-file `yo.c` and compiles it with your own C
compiler, so it links against your own libc and loader. This is the answer on
NixOS, where the prebuilt binary's hardcoded ELF interpreter
(`/lib64/ld-linux-x86-64.so.2`) does not exist.

> **Note:** `--from-source` needs a release that publishes the single-file
> `yo.c`. Releases up to and including `v0.2.4` predate that artifact, so the
> option only works on releases made after it. The installer says so explicitly
> rather than failing obscurely.

The installer puts the `yo` command on your `PATH`. Run `yo --help` to see the
available commands.

Yo transpiles to C, so a **C compiler** is required to produce machine code. The
install script above sets one up for you — these guides are for configuring the
toolchain by hand, or for diagnosing a failed install.

- **[Linux](./docs/en-US/INSTALL_LINUX.md)**
- **[macOS](./docs/en-US/INSTALL_MACOS.md)**
- **[Windows](./docs/en-US/INSTALL_WINDOWS.md)**

Targeting WebAssembly needs Emscripten as well —
**[WASM setup](./docs/en-US/INSTALL_WASM.md)**.

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

// $ yo compile main.yo --optimize 2 -o main
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

The compiler is written in Yo and builds itself. See
**[CONTRIBUTING.md](./CONTRIBUTING.md)** for the dev environment, the build loop,
and how to run the test suites — LLM-assisted contributions included.

## Editor Support

- A VS Code extension is available [here](https://marketplace.visualstudio.com/items?itemName=shd101wyy.yolang), providing syntax highlighting for `.yo` files.

  **The bundled Language Server Protocol (LSP) support is currently gone.**
  Hover, auto-completion, go-to-definition, find references, rename, document
  symbols, signature help, diagnostics and folding were served by a TypeScript
  LSP server that called the TypeScript evaluator directly, and it was deleted
  along with the rest of the TypeScript compiler when Yo became self-hosted.
  Nothing replaces it yet; a Yo-native server is planned.
  See [docs/en-US/LSP.md](./docs/en-US/LSP.md) for the behaviour it is expected
  to restore.

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

When a `.yo-version` file exists, the `yo` CLI automatically dispatches to the pinned version — downloading and caching the matching native release bundle on first use.

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

## License

[UIUC/NCSA Open Source License](./LICENSE.md)
