# Mo 墨 🐼

A multi-paradigm, general-purpose, compiled programming language.

- [Design](./DESIGN.md)
- [Specification](./SPECIFICATION.md)
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

## License

[UIUC/NCSA Open Source License](./LICENSE.md)
