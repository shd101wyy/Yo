# Mo 墨 🐼

A multi-paradigm, general-purpose, compiled programming language.

- [Learn Mo in 10 Minutes](./LEARN_MO_IN_10_MINUTES.mo)
- [Design](./DESIGN.md)
- [Grammar](./GRAMMAR.md)
- [Roadmap](./ROADMAP.md)
- [Removals](./REMOVALS.md)

## Development

Please install [nix](https://nixos.org/download.html) and [direnv](https://direnv.net/) before proceeding.

The dev environment is defined in [shell.nix](./shell.nix). You can also manually install the dependencies listed in the file.

### Setup

```bash
$ cd mo
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

Test some local mo program:

```bash
$ node --enable-source-maps ./out/cjs/mo-cli.cjs examples/generic/generic2.mo --print-ast --skip-codegen --skip-prelude
```

## License

[UIUC/NCSA Open Source License](./LICENSE.md)
