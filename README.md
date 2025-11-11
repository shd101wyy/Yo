# Yo

`Work in Progress`

A multi-paradigm, general-purpose, compiled programming language.
Yo aims to be **Simple** and **Fast** (around 0% - 20% slower than C).

> The name `Yo` comes from the Chinese word `柚` (yòu), meaning `pomelo`, a large citrus fruit similar to grapefruit. It's my daughter's nickname.

- [Learn Yo in 10 Minutes](./LEARN_YO_IN_10_MINUTES.yo)
- [Design](./DESIGN.md)
- [Grammar](./GRAMMAR.md)
- [Roadmap](./ROADMAP.md)

## Features

- First-class types.
- Compile-time evaluation.
- Homoiconicity and metaprogramming (**Yo** is just a combination of **Lisp** and **C**).
- Closure
- [Async/await](./ASYNC_AWAIT.md) (Stackless coroutine & Cooperative multi-tasking).
- `object` type with [Biased Reference Counting](./BIASED_REFERENCE_COUNTING.md) and Cycle detection.
- [Compile-time Reference Counting with Ownership and Lifetime Analysis](./BIASED_REFERENCE_COUNTING.md).
- [Thread-per-core and thread affinity concurrency model](./CONCURRENCY.md).
- Modular implicits.
- **C** interop.  
- etc

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

## License

[UIUC/NCSA Open Source License](./LICENSE.md)
