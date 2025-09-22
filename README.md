# Yo

A multi-paradigm, general-purpose, compiled programming language.

- [Learn Yo in 10 Minutes](./LEARN_YO_IN_10_MINUTES.yo)
- [Design](./DESIGN.md)
- [Grammar](./GRAMMAR.md)
- [Roadmap](./ROADMAP.md)
- [Removals](./REMOVALS.md)

## Features

- Linear types, combined with RAII.
- First-class types.
- Compile-time evaluation.
- 2nd-class reference, allowing for unsafe raw-pointers.
- Modular implicits.
- Homoiconicity and metaprogramming.
- High-performance memory allocation with bundled [mimalloc](./MIMALLOC.md).

## Development

Please install [nix](https://nixos.org/download.html) and [direnv](https://direnv.net/) before proceeding.

The dev environment is defined in [shell.nix](./shell.nix). You can also manually install the dependencies listed in the file.

### Setup

```bash
$ cd Yo
$ direnv allow # Run this command to activate the nix shell.
               # You only need to run it once.
$ bun install # Install necessary dependencies.
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
$ bun run src/yo-cli.ts src/tests/examples/fixme.yo --print-c
```

## License

[UIUC/NCSA Open Source License](./LICENSE.md)
