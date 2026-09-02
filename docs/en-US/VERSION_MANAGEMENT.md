# Version Management

Yo supports per-project version pinning through a `.yo-version` file, similar to `.nvmrc` (Node.js) or `.python-version` (Python). This ensures reproducible builds and correct IDE behavior across teams.

## Quick Start

```bash
# Pin your project to the current Yo version
yo version pin

# Pin to a specific version
yo version pin 0.2.4

# Show current version and pinned version
yo version

# Install a specific version (without pinning)
yo version install 0.2.9

# List locally cached versions
yo version list

# List all published releases
yo version list --remote
```

## `.yo-version` File

The `.yo-version` file contains a single line with a semver version number:

```
0.2.9
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
Yo 0.2.9
.yo-version: 0.2.4 (current: 0.2.9)
```

### `yo version pin [version]`

Create or update the `.yo-version` file. Without a version argument, pins to the currently installed version:

```bash
yo version pin           # pins to current version (e.g., 0.2.9)
yo version pin 0.2.4    # pins to specific version
```

The specified version is validated against the published GitHub releases before writing.

### `yo version install <version>`

Download and cache a specific version without pinning:

```bash
yo version install 0.2.9
```

This is useful for pre-fetching versions before switching projects.

### `yo version list [--remote]`

List cached versions:

```
$ yo version list
Cached versions:
  0.2.4
  0.2.9
```

With `--remote`, list every version published on GitHub Releases:

```
$ yo version list --remote
Available versions:
  0.0.2
  0.0.3
  ...
  0.2.9
```

### `yo version clean [version]`

Remove cached versions:

```bash
yo version clean 0.2.4   # remove specific version
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

The Yo LSP server read `.yo-version` to resolve the correct `std/` library path, so that go-to-definition, hover information and completions all came from the version the project was actually pinned to.

**There is no LSP server right now.** It was a TypeScript program and was retired together with the TypeScript compiler tree; the `.yo-version` lookup returns when a Yo-native server does. See [LSP.md](./LSP.md).

## Version Cache

Downloaded versions are stored in the global Yo cache directory, each one a plain extraction of that release's native bundle — the same layout `scripts/install.sh` installs:

```
~/.cache/yo/versions/
├── 0.2.4/
│   ├── bin/yo
│   ├── std/
│   ├── vendor/
│   └── LICENSE.md
└── 0.2.9/
    ├── bin/yo
    ├── std/
    ├── vendor/
    └── LICENSE.md
```

`vendor/` must stay a sibling of `std/` — the binary locates its standard library by walking up from the executable, and mimalloc as `<std>/../vendor`.

The cache location can be customized with environment variables:

- `$YO_CACHE_DIR` — set custom cache root
- `$XDG_CACHE_HOME` — follows XDG conventions (default: `~/.cache`)

## Notes

- The `latest` keyword is **not** supported in `.yo-version`. Always use a concrete version number.
- Version dispatch is skipped for the `yo version` subcommand and for `--help` / `--version`.
- Versions are downloaded from [GitHub Releases](https://github.com/shd101wyy/Yo/releases) as the native bundle for the host platform. Set `$YO_REPO` to point at a fork.
- Releases older than `0.2.1` predate the native bundles and can no longer be installed — npm publishing stopped at `0.2.0` and that channel is dead.
- The download needs `tar` on the `PATH`. As of v0.2.22 the HTTP itself is spoken by the compiler through `std/http` and the compiler-emitted TLS backend — the `curl` dependency is gone (it was a shell-out in every release before that). On a machine without OpenSSL the remote subcommands report `TLS is unavailable in this build` with install guidance; on Windows the Schannel backend is still pending, so remote operations say so until it lands. Node.js and Bun are **not** required — they were only needed back when Yo shipped as an npm package.
