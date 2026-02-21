# Yo

**Work in Progress. Not Ready!**

A multi-paradigm, general-purpose, compiled programming language.
Yo aims to be **Simple** and **Fast** (around 0% - 15% slower than C).

> The name `Yo` comes from the Chinese word `柚` (yòu), meaning `pomelo`, a large citrus fruit similar to grapefruit. It's my daughter's nickname.

## Features

- First-class types.
- Compile-time evaluation.
- Homoiconicity and metaprogramming (**Yo** syntax is inspired by the **Lisp** S expression).
- Closure.
- [Algebraic Effects and Handlers](./docs/ALGEBRAIC_EFFECTS.md) (One-shot delimited continuation).
- [Async/await](./docs/ASYNC_AWAIT.md) (Stackless coroutine & Cooperative multi-tasking).
- `object` type with [Non-atomic Reference Counting and Thread-Local Cycle Collection](./docs/CYCLE_COLLECTION.md).
- [Compile-time Reference Counting with Ownership and Lifetime Analysis](./docs/COMPILE_TIME_RC_WITH_OWNERSHIP_ANALYSIS.md).
- Thread-per-core parallelism model (see [PARALLELISM.md](./docs/PARALLELISM.md)).
- **C** interop.
- etc.

<img width="855" height="368" alt="Image" src="https://github.com/user-attachments/assets/04a9050e-598b-4e02-a6c3-44863d47a4ac" />

## Language Design

For the design of the language, please refer to [DESIGN.md](./docs/DESIGN.md).

## Installation

The `Yo` language is currently distributed as an `npm` package:

```bash
$ npm install -g @shd101wyy/yo         # Install yo compiler globally
$ yarn global add @shd101wyy/yo        # Or using yarn
$ pnpm add -g @shd101wyy/yo            # Or using pnpm
$ bun install --global @shd101wyy/yo   # Or using bun
```

It exposes the `yo` command in your terminal.

There is also an alias `yo-cli` for `yo` command in case of naming conflicts.

Run `yo --help` or `yo-cli --help` to see available commands.

### C Compiler Requirement

Yo currently transpiles to C and requires a C compiler to produce machine code. **Clang is recommended** for the best experience.

#### Installing Clang

**Linux:**

```bash
# Ubuntu/Debian
$ sudo apt-get update
$ sudo apt-get install clang

# Fedora/RHEL
$ sudo dnf install clang

# Arch Linux
$ sudo pacman -S clang
```

**macOS:**

```bash
# Clang is included with Xcode Command Line Tools
$ xcode-select --install

# Or install via Homebrew
$ brew install llvm
```

**Windows:**

```bash
# Using Chocolatey
$ choco install llvm

# Using Scoop
$ scoop install llvm

# Or download from https://releases.llvm.org/
```

Alternatively, you can use other C compilers like `gcc` or `zig` by specifying the compiler with the `--c-compiler` flag.

### Linux liburing Requirement

On Linux, Yo uses `io_uring` for async I/O, which requires **liburing** to be installed.

#### Installing liburing (Linux)

```bash
# Ubuntu/Debian
$ sudo apt-get update
$ sudo apt-get install liburing-dev

# Fedora/RHEL
$ sudo dnf install liburing-devel

# Arch Linux
$ sudo pacman -S liburing
```

## Code examples

Check the [./tests](./tests/) and [./std](./std/) folders for code examples.

### Hello World

```typescript
// main.yo
{ println } :: import "std/fmt";

main :: (fn() -> unit) {
  println("Hello, world!");
};

export main;

// $ yo compile main.yo --release -o main
// $ ./main
```

## Development

The `Yo` compiler is written in [TypeScript](https://www.typescriptlang.org/) and uses [Bun](https://bun.sh/) as the runtime.

Yo is primarily developed on the Steam Deck LCD (Linux). The compiler currently transpiles Yo to C; to produce
machine code you must have a C compiler (for example `gcc`, `clang`, `zig`, `cl`, etc).

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
$ bun run src/yo-cli.ts compile src/tests/examples/fixme.yo

# There is also a `yo-cli` script in the project root for testing:
$ ./yo-cli compile src/tests/examples/fixme.yo
```

## Editor Support

- A VS Code extension is available [here](https://marketplace.visualstudio.com/items?itemName=shd101wyy.yolang) that supports basic syntax highlighting. No LSP yet.

- Vim / Neovim: a minimal syntax file and a usage README are available in `vscode-extension/syntaxes/`.
  See [vscode-extension/syntaxes/README.md](./vscode-extension/syntaxes/README.md) for installation steps, `ftdetect` examples and `home-manager` snippets.

## License

[UIUC/NCSA Open Source License](./LICENSE.md)
