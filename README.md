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

## Development

Please install [nix](https://nixos.org/download.html) and [direnv](https://direnv.net/) before proceeding.

The dev environment is defined in [shell.nix](./shell.nix). You can also manually install the dependencies listed in the file.

### Setup

```bash
$ cd Yo
$ direnv allow # Run this command to activate the nix shell.
               # You only need to run it once.
$ yarn install # Install necessary dependencies.
```

Run the following command to watch for changes and build the project:

```bash
$ yarn dev
```

Run the following command to build the project:

```bash
$ yarn build
```

Test some local yo program:

```bash
$ node --enable-source-maps ./out/cjs/yo-cli.cjs examples/generic/generic2.yo --print-ast --skip-codegen --skip-prelude
```

## License

[UIUC/NCSA Open Source License](./LICENSE.md)
