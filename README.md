# Yo

`Work in Progress`

A multi-paradigm, general-purpose, compiled programming language.
Yo aims to be **Simple** and **Fast** (around 0% - 15% slower than C).

> The name `Yo` comes from the Chinese word `柚` (yòu), meaning `pomelo`, a large citrus fruit similar to grapefruit. It's my daughter's nickname.

## Features

- First-class types.
- Compile-time evaluation.
- Homoiconicity and metaprogramming (**Yo** is just a combination of **Lisp** and **C**).
- Closure.
- [Async/await](./docs/ASYNC_AWAIT.md) (Stackless coroutine & Cooperative multi-tasking).
- `object` type with [Non-atomic Reference Counting and Thread-Local Cycle Collection](./docs/CYCLE_COLLECTION.md).
- [Compile-time Reference Counting with Ownership and Lifetime Analysis](./docs/COMPILE_TIME_RC_WITH_OWNERSHIP_ANALYSIS.md).
- Thread-per-core parallelism model (see [PARALLELISM.md](./docs/PARALLELISM.md)).
- **C** interop.
- etc

## Language Design

For design of the language, please refer to the [DESIGN.md](./docs/DESIGN.md).

## Installation

The `Yo` language is currently distributed as an `npm` package:

```bash
$ npm install -g @shd101wyy/yo # Install yo compiler globally
```

It exposes the `yo` command in your terminal.
There is also an alias `yo-cli` for `yo` command in case of naming conflicts.

## Development

The `Yo` compiler is written in [TypeScript](https://www.typescriptlang.org/) and uses [Bun](https://bun.sh/) as the runtime.

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

Test some local yo-cli:

```bash
$ bun run src/yo-cli.ts compile src/tests/examples/fixme.yo
```

## Code examples

Check the `./tests` folder for code examples and test cases.  

## Editor support

- Vim / Neovim: a minimal syntax file and a usage README are available in `vscode-extension/syntaxes/`.
  See [vscode-extension/syntaxes/README.md](./vscode-extension/syntaxes/README.md) for installation steps, `ftdetect` examples and `home-manager` snippets.

## License

[UIUC/NCSA Open Source License](./LICENSE.md)
