# Version Management

Yo supports per-project version pinning through a `.yo-version` file, similar to `.nvmrc` (Node.js) or `.python-version` (Python). This ensures reproducible builds and correct IDE behavior across teams.

## Quick Start

```bash
# Pin your project to the current Yo version
yo version pin

# Pin to a specific version
yo version pin 0.1.12

# Show current version and pinned version
yo version

# Install a specific version (without pinning)
yo version install 0.1.13

# List locally cached versions
yo version list

# List all available versions from npm
yo version list --remote
```

## `.yo-version` File

The `.yo-version` file contains a single line with a semver version number:

```
0.1.14
```

The `v` prefix is optional and automatically stripped:

```
v0.1.14
```

### File Discovery

When you run any `yo` command, the CLI searches for `.yo-version` starting from the current working directory and walking up the directory tree — the same behavior as `.nvmrc` or `.python-version`. The first file found is used.

```
my-project/
├── .yo-version      ← found here
├── build.yo
├── src/
│   └── main.yo      ← running `yo compile src/main.yo` from here
└── tests/
    └── test.test.yo
```

### Automatic Version Dispatch

When a `.yo-version` file specifies a version different from the currently installed one, the `yo` CLI automatically:

1. Downloads and caches the specified version (if not already cached)
2. Re-dispatches the command to the cached version

This happens transparently — you don't need to manually switch versions.

## Commands

### `yo version`

Display the current Yo version and any pinned version:

```
$ yo version
Yo 0.1.14
.yo-version: 0.1.12 (current: 0.1.14)
```

### `yo version pin [version]`

Create or update the `.yo-version` file. Without a version argument, pins to the currently installed version:

```bash
yo version pin           # pins to current version (e.g., 0.1.14)
yo version pin 0.1.12    # pins to specific version
```

The specified version is validated against the npm registry before writing.

### `yo version install <version>`

Download and cache a specific version without pinning:

```bash
yo version install 0.1.13
```

This is useful for pre-fetching versions before switching projects.

### `yo version list [--remote]`

List cached versions:

```
$ yo version list
Cached versions:
  0.1.12
  0.1.13
```

With `--remote`, list all available versions from npm:

```
$ yo version list --remote
Available versions:
  0.0.2
  0.0.3
  ...
  0.1.14
```

### `yo version clean [version]`

Remove cached versions:

```bash
yo version clean 0.1.12   # remove specific version
yo version clean           # remove ALL cached versions
```

## `yo init` Integration

New projects created with `yo init` do **not** include a `.yo-version` file by default. To pin a version after initialization:

```bash
yo init my-project
cd my-project
yo version pin
```

## LSP Integration

The Yo LSP server reads `.yo-version` to resolve the correct `std/` library path. When your project is pinned to a specific version and that version is cached locally, the LSP uses the cached version's standard library for:

- **Go to definition** — jumps to the correct version's `std/` files
- **Hover information** — shows types from the pinned version's standard library
- **Completions** — suggests symbols from the pinned version

This ensures that your IDE experience matches the version your project actually uses.

## Version Cache

Downloaded versions are stored in the global Yo cache directory:

```
~/.cache/yo/versions/
├── 0.1.12/
│   ├── out/cjs/yo-cli.cjs
│   ├── std/
│   ├── vendor/
│   └── package.json
└── 0.1.13/
    ├── out/cjs/yo-cli.cjs
    ├── std/
    ├── vendor/
    └── package.json
```

The cache location can be customized with environment variables:

- `$YO_CACHE_DIR` — set custom cache root
- `$XDG_CACHE_HOME` — follows XDG conventions (default: `~/.cache`)

## Notes

- The `latest` keyword is **not** supported in `.yo-version`. Always use a concrete version number.
- Version dispatch is skipped for `yo version`, `yo lsp`, `--help`, and `--version` commands.
- Versions are downloaded from the [`@shd101wyy/yo`](https://www.npmjs.com/package/@shd101wyy/yo) npm package.
- The download requires Node.js or Bun to be available on the system.
