# Build System

Yo includes a declarative build system inspired by [Zig's build system](https://ziglang.org/learn/build-system/) and [Nix](https://nixos.org/). Build configuration lives in a `build.yo` file that is evaluated at compile time — no separate config format needed.

## Quick Start

```bash
# Create a new project
yo init my-project
cd my-project

# Build and run
yo build run

# Run tests
yo build test

# Build all artifacts (default step)
yo build
```

## Project Structure

`yo init` creates a project with the following layout:

```
my-project/
├── build.yo              ← Build configuration
├── src/
│   ├── main.yo           ← Executable entry point
│   └── lib.yo            ← Library code
├── tests/
│   └── main.test.yo      ← Test file
├── .gitignore
└── README.md
```

Build output goes to `yo-out/`:

```
yo-out/
├── bin/                  ← Compiled executables
│   └── my-project
└── lib/                  ← Compiled libraries
    └── libmy-project-lib.a
```

## `build.yo`

The build file is a regular Yo source file that imports the `std/build` module. All build functions run at compile time and register artifacts and steps.

```yo
build :: import "std/build";

// Project metadata
build.project(name: "my-project", version: "0.1.0");

// Define an executable artifact
build.executable(build.Executable(
  name: "my-project",
  root: "./src/main.yo"
));

// Define a static library artifact
build.static_library(build.StaticLibrary(
  name: "my-project-lib",
  root: "./src/lib.yo"
));

// Define a test suite
build.test(build.TestSuite(name: "tests", root: "./tests/"));

// Register a run step (compile + execute)
build.run("my-project");

// Named steps with dependencies (by name)
build.step("install", "Build all artifacts", "my-project", "my-project-lib");
build.step("run", "Run the application", "run:my-project");
build.step("test", "Run unit tests", "tests");
```

## Config Structs

Build artifacts use struct types with default field values (like Zig's options pattern). Only `name` and `root` are required — everything else has sensible defaults:

### `Executable`

| Field       | Type              | Default       | Description                                 |
| ----------- | ----------------- | ------------- | ------------------------------------------- |
| `name`      | `comptime_string` | _(required)_  | Artifact name                               |
| `root`      | `comptime_string` | _(required)_  | Path to main source file                    |
| `target`    | `comptime_string` | `target_host` | Target triple (e.g. `"wasm32-wasi"`)        |
| `optimize`  | `comptime_string` | `"debug"`     | Optimization level                          |
| `allocator` | `comptime_string` | `"mimalloc"`  | Memory allocator (`"mimalloc"`, `"libc"`)   |
| `sanitize`  | `comptime_string` | `"none"`      | Sanitizer (`"none"`, `"address"`, `"leak"`) |

### `StaticLibrary`

| Field      | Type              | Default       | Description                 |
| ---------- | ----------------- | ------------- | --------------------------- |
| `name`     | `comptime_string` | _(required)_  | Artifact name               |
| `root`     | `comptime_string` | _(required)_  | Path to library source file |
| `target`   | `comptime_string` | `target_host` | Target triple               |
| `optimize` | `comptime_string` | `"debug"`     | Optimization level          |

### `TestSuite`

| Field    | Type              | Default       | Description                    |
| -------- | ----------------- | ------------- | ------------------------------ |
| `name`   | `comptime_string` | _(required)_  | Test suite name                |
| `root`   | `comptime_string` | _(required)_  | Path to test file or directory |
| `target` | `comptime_string` | `target_host` | Target triple                  |

### Optimization Levels

| Value             | Compiler Flags | Description                    |
| ----------------- | -------------- | ------------------------------ |
| `"debug"`         | `-O0 -g`       | No optimization, debug symbols |
| `"release-safe"`  | `-O2 -g`       | Optimized with debug symbols   |
| `"release-fast"`  | `-O3`          | Maximum performance            |
| `"release-small"` | `-Os`          | Optimize for binary size       |

These are also available as constants: `build.Optimize.Debug`, `.ReleaseSafe`, `.ReleaseFast`, `.ReleaseSmall`.

## Build Steps

Steps are named targets that define what `yo build <step>` does. Each step depends on one or more artifacts, tests, or run steps (referenced by name):

```yo
// "install" is the default step when running `yo build` with no arguments
build.step("install", "Build all artifacts", "my-app", "my-lib");

// Run steps reference artifacts with "run:<name>"
build.step("run", "Run the application", "run:my-app");

// Test steps reference test suite names
build.step("test", "Run unit tests", "tests");
```

List all available steps:

```bash
yo build --list-steps
```

```
Available steps:
  install (default)    Build all artifacts
  run                  Run the application
  test                 Run unit tests
```

## Cross-Compilation

Yo supports cross-compilation via target triples. Specify the target in `build.yo` or on the command line:

### In `build.yo`

```yo
build.executable(build.Executable(
  name: "my-app-wasm",
  root: "./src/main.yo",
  target: "wasm32-wasi",
  optimize: "release-small"
));
```

### On the command line

```bash
# Override target for all artifacts
yo build --target wasm32-wasi

# Use zig as the C compiler for cross-compilation
yo build --cc zig --target aarch64-linux-gnu
```

### Supported Targets

| Target Triple         | Notes                      |
| --------------------- | -------------------------- |
| `x86_64-linux-gnu`    | Linux x86-64 (glibc)       |
| `x86_64-linux-musl`   | Linux x86-64 (static musl) |
| `aarch64-linux-gnu`   | Linux ARM64                |
| `aarch64-macos`       | macOS Apple Silicon        |
| `x86_64-macos`        | macOS Intel                |
| `x86_64-windows-msvc` | Windows x86-64             |
| `wasm32-wasi`         | WebAssembly (WASI)         |

### Platform Detection in Code

Use `std/process` to write platform-aware code:

```yo
{ platform, arch, Platform, Arch } :: import "std/process";

cond(
  (platform == Platform.Linux) => { /* Linux-specific */ },
  (platform == Platform.Macos) => { /* macOS-specific */ },
  (platform == Platform.Wasi) => { /* WASM-specific */ },
  true => { /* fallback */ }
);
```

When cross-compiling, `platform` and `arch` return the **target** platform, not the host.

## `yo build` Reference

```
yo build [steps] [options]

Arguments:
  steps                  Named steps to run (default: install)

Options:
  --build-file <path>    Path to build file (default: ./build.yo)
  --target <triple>      Override target for all artifacts
  --cc <compiler>        C compiler: clang, gcc, zig, cc, cl
  --verbose, -v          Verbose build output
  --dry-run              Show what would be built
  --list-steps           List available build steps
```

## `yo init` Reference

```
yo init [dir] [options]

Arguments:
  dir                    Directory to initialize (default: .)

Options:
  --name <name>          Project name (default: directory name)
```

## Multi-Target Builds

Define multiple artifacts with different targets in a single `build.yo`:

```yo
build :: import "std/build";

build.project(name: "my-app", version: "1.0.0");

// Native build
build.executable(build.Executable(
  name: "my-app",
  root: "./src/main.yo",
  optimize: "release-fast"
));

// WASM build
build.executable(build.Executable(
  name: "my-app-wasm",
  root: "./src/main.yo",
  target: "wasm32-wasi",
  optimize: "release-small",
  allocator: "libc"
));

build.step("install", "Build all targets", "my-app", "my-app-wasm");
build.step("run", "Run native build", "run:my-app");
```

## Dependencies

### Git Dependencies

Declare git-hosted dependencies in `build.yo`:

```yo
build :: import "std/build";

build.project(name: "my-app", version: "1.0.0");

// Add a git dependency
build.dependency(build.GitDependency(
  name: "json-parser",
  url: "https://github.com/user/json-parser.git",
  ref: "v1.0.0"
));

// Dependency from a subdirectory of a repo
build.dependency(build.GitDependency(
  name: "utils",
  url: "https://github.com/user/mono-repo.git",
  ref: "main",
  path: "packages/utils"
));

build.executable(build.Executable(name: "my-app", root: "./src/main.yo"));
build.step("install", "Build all artifacts", "my-app");
```

Fetch dependencies with:

```bash
yo fetch              # Fetch all dependencies from build.yo
yo fetch --verbose    # Show detailed progress
```

Dependencies are cached in `.yo-cache/deps/` and tracked by `yo.lock` (commit this file to version control). `yo build` auto-fetches if dependencies are not yet cached.

### System Libraries (pkg-config)

Link against system C libraries discovered via `pkg-config`:

```yo
build.system_library(build.SystemLibrary(
  name: "openssl",
  pkg_config: "openssl",
  fallback_include: "/usr/include/openssl",
  fallback_lib: "/usr/lib",
  fallback_link: "ssl crypto"
));
```

When `pkg-config` is available (Linux, macOS), it automatically resolves include paths and link flags. The fallback fields are used when `pkg-config` is not found (common on Windows).

## `yo fetch` Reference

```
yo fetch [options]

Options:
  --build-file <path>    Path to build file (default: ./build.yo)
  --verbose, -v          Verbose output
```

## See Also

- [BUILD_SYSTEM.md](../../plans/BUILD_SYSTEM.md) — Full design document with implementation details
- [Zig Build System](https://ziglang.org/learn/build-system/) — Primary inspiration
