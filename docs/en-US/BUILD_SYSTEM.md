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
build.project(build.Project(name: "my-project"));

// Define artifacts — each returns a Step for dependency wiring
exe :: build.executable(build.Executable(
  name: "my-project",
  root: "./src/main.yo"
));

lib :: build.static_library(build.StaticLibrary(
  name: "my-project-lib",
  root: "./src/lib.yo"
));

tests :: build.test(build.TestSuite(name: "tests", root: "./tests/"));

// Register a run step (compile + execute)
run_exe :: build.run("my-project");

// Named steps — use depend_on to wire dependencies
install :: build.step("install", "Build all artifacts");
install.depend_on(exe);
install.depend_on(lib);

run_step :: build.step("run", "Run the application");
run_step.depend_on(run_exe);

test_step :: build.step("test", "Run unit tests");
test_step.depend_on(tests);
```

## Config Structs

Build artifacts use struct types with default field values (like Zig's options pattern). Only `name` and `root` are required — everything else has sensible defaults:

### `Executable`

| Field       | Type              | Default              | Description                          |
| ----------- | ----------------- | -------------------- | ------------------------------------ |
| `name`      | `comptime_string` | _(required)_         | Artifact name                        |
| `root`      | `comptime_string` | _(required)_         | Path to main source file             |
| `target`    | `comptime_string` | `target_host`        | Target triple (e.g. `"wasm32-wasi"`) |
| `optimize`  | `Optimize`        | `Optimize.Debug`     | Optimization level                   |
| `allocator` | `Allocator`       | `Allocator.Mimalloc` | Memory allocator                     |
| `sanitize`  | `Sanitize`        | `Sanitize.None`      | Sanitizer                            |

### `StaticLibrary`

| Field      | Type              | Default          | Description                 |
| ---------- | ----------------- | ---------------- | --------------------------- |
| `name`     | `comptime_string` | _(required)_     | Artifact name               |
| `root`     | `comptime_string` | _(required)_     | Path to library source file |
| `target`   | `comptime_string` | `target_host`    | Target triple               |
| `optimize` | `Optimize`        | `Optimize.Debug` | Optimization level          |

### `SharedLibrary`

| Field      | Type              | Default          | Description                 |
| ---------- | ----------------- | ---------------- | --------------------------- |
| `name`     | `comptime_string` | _(required)_     | Artifact name               |
| `root`     | `comptime_string` | _(required)_     | Path to library source file |
| `target`   | `comptime_string` | `target_host`    | Target triple               |
| `optimize` | `Optimize`        | `Optimize.Debug` | Optimization level          |

Shared libraries compile with `-shared -fPIC` and produce `.so` (Linux), `.dylib` (macOS), or `.dll` (Windows).

### `TestSuite`

| Field    | Type              | Default       | Description                    |
| -------- | ----------------- | ------------- | ------------------------------ |
| `name`   | `comptime_string` | _(required)_  | Test suite name                |
| `root`   | `comptime_string` | _(required)_  | Path to test file or directory |
| `target` | `comptime_string` | `target_host` | Target triple                  |

### Optimization Levels

| Value                   | Compiler Flags | Description                    |
| ----------------------- | -------------- | ------------------------------ |
| `Optimize.Debug`        | `-O0 -g`       | No optimization, debug symbols |
| `Optimize.ReleaseSafe`  | `-O2 -g`       | Optimized with debug symbols   |
| `Optimize.ReleaseFast`  | `-O3`          | Maximum performance            |
| `Optimize.ReleaseSmall` | `-Os`          | Optimize for binary size       |

### Allocators

| Value                | Description                          |
| -------------------- | ------------------------------------ |
| `Allocator.Mimalloc` | High-performance allocator (default) |
| `Allocator.Libc`     | Standard libc malloc                 |

### Sanitizers

| Value              | Description                              |
| ------------------ | ---------------------------------------- |
| `Sanitize.None`    | No sanitizer (default)                   |
| `Sanitize.Address` | AddressSanitizer for memory errors/leaks |
| `Sanitize.Leak`    | LeakSanitizer for leak detection only    |

## Build Steps

Steps are named targets that define what `yo build <step>` does. Every build function (`executable`, `static_library`, `test`, `run`) returns a `Step` value. Use `step.depend_on(dep)` to wire dependencies:

```yo
// Each build function returns a Step
exe :: build.executable(build.Executable(name: "my-app", root: "./src/main.yo"));
lib :: build.static_library(build.StaticLibrary(name: "my-lib", root: "./src/lib.yo"));
tests :: build.test(build.TestSuite(name: "tests", root: "./tests/"));
run_exe :: build.run("my-app");

// Create named steps and wire dependencies
install :: build.step("install", "Build all artifacts");
install.depend_on(exe);
install.depend_on(lib);

run_step :: build.step("run", "Run the application");
run_step.depend_on(run_exe);

test_step :: build.step("test", "Run unit tests");
test_step.depend_on(tests);
```

### `Step`

| Field  | Type              | Description                                                                                              |
| ------ | ----------------- | -------------------------------------------------------------------------------------------------------- |
| `name` | `comptime_string` | Step name (artifact name, or custom name for `build.step`)                                               |
| `kind` | `StepKind`        | Step kind: `Executable`, `StaticLibrary`, `SharedLibrary`, `SystemLibrary`, `TestSuite`, `Run`, `Custom` |

### Step Methods

| Method                  | Description                                                   |
| ----------------------- | ------------------------------------------------------------- |
| `step.depend_on(other)` | Add a dependency — `other` is built before `step`             |
| `step.link(library)`    | Link a library to an artifact (static, shared, or system lib) |

### `StepKind`

| Value           | Description                          |
| --------------- | ------------------------------------ |
| `Executable`    | Returned by `build.executable()`     |
| `StaticLibrary` | Returned by `build.static_library()` |
| `SharedLibrary` | Returned by `build.shared_library()` |
| `SystemLibrary` | Returned by `build.system_library()` |
| `TestSuite`     | Returned by `build.test()`           |
| `Run`           | Returned by `build.run()`            |
| `Custom`        | Returned by `build.step()`           |

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

## Linking Libraries

Use `step.link()` to link any library to an artifact — works with static, shared, and system libraries. Similar to Zig's `exe.linkLibrary(lib)`:

```yo
build :: import "std/build";

build.project(build.Project(name: "my-app"));

// Yo libraries
lib :: build.shared_library(build.SharedLibrary(
  name: "mylib",
  root: "./src/lib.yo"
));

// System libraries (via pkg-config)
openssl :: build.system_library(build.SystemLibrary(
  name: "openssl",
  pkg_config: "openssl"
));

exe :: build.executable(build.Executable(
  name: "my-app",
  root: "./src/main.yo"
));

// Link libraries using Step method
exe.link(lib);
exe.link(openssl);

install :: build.step("install", "Build all artifacts");
install.depend_on(exe);
install.depend_on(lib);
```

`step.link()` automatically determines the library type:

- **Static/shared libraries** — compiled first, output passed to the linker
- **System libraries** — resolved via `pkg-config` at build time, flags applied to the artifact

## Build Options

Like Zig's `b.option()`, declare user-configurable build options that can be set from the CLI with `-Dname=value`:

```yo
build :: import "std/build";

// Declare a build option with a default value
strip :: build.option(build.BuildOption(
  name: "strip",
  description: "Strip debug symbols",
  default: "false"
));

opt_level :: build.option(build.BuildOption(
  name: "opt",
  description: "Optimization level",
  default: "debug"
));
```

CLI usage:

```bash
yo build -Dstrip=true -Dopt=release-fast
yo build run -Dstrip=true
```

If no `-D` flag is provided, the default value is used. Boolean options without `=` default to `"true"`:

```bash
yo build -Dstrip       # same as -Dstrip=true
```

Run `yo build --help` to see all available project-specific options alongside standard flags.

### `BuildOption`

| Field         | Type              | Default      | Description              |
| ------------- | ----------------- | ------------ | ------------------------ |
| `name`        | `comptime_string` | _(required)_ | Option name              |
| `description` | `comptime_string` | _(required)_ | Help text                |
| `default`     | `comptime_string` | `""`         | Default value if not set |

## Cross-Compilation

Yo supports cross-compilation via target triples. Specify the target in `build.yo` or on the command line:

### In `build.yo`

```yo
build.executable(build.Executable(
  name: "my-app-wasm",
  root: "./src/main.yo",
  target: "wasm32-wasi",
  optimize: build.Optimize.ReleaseSmall
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
  --sysroot <path>       Sysroot directory for cross-compilation
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

build.project(build.Project(name: "my-app", version: "1.0.0"));

// Native build
native :: build.executable(build.Executable(
  name: "my-app",
  root: "./src/main.yo",
  optimize: build.Optimize.ReleaseFast
));

// WASM build
wasm :: build.executable(build.Executable(
  name: "my-app-wasm",
  root: "./src/main.yo",
  target: "wasm32-wasi",
  optimize: build.Optimize.ReleaseSmall,
  allocator: build.Allocator.Libc
));

run_native :: build.run("my-app");

install :: build.step("install", "Build all targets");
install.depend_on(native);
install.depend_on(wasm);

run_step :: build.step("run", "Run native build");
run_step.depend_on(run_native);
```

## Dependencies

### Git Dependencies

Declare git-hosted dependencies in `build.yo`:

```yo
build :: import "std/build";

build.project(build.Project(name: "my-app", version: "1.0.0"));

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

exe :: build.executable(build.Executable(name: "my-app", root: "./src/main.yo"));

install :: build.step("install", "Build all artifacts");
install.depend_on(exe);
```

Fetch dependencies with:

```bash
yo fetch              # Fetch all dependencies from build.yo
yo fetch --verbose    # Show detailed progress
```

Dependencies are stored in a global cache and tracked by `yo.lock` (commit this file to version control). `yo build` auto-fetches if dependencies are not yet cached.

### Global Cache

Dependencies are cached globally to avoid redundant downloads across projects:

```bash
# Show cache location
yo cache path           # e.g., ~/.cache/yo

# Clear cache
yo cache clean
```

**Resolution order:**

1. `$YO_CACHE_DIR` (environment variable)
2. `$XDG_CACHE_HOME/yo` (XDG standard)
3. `~/.cache/yo` (Linux/macOS default)
4. `%LOCALAPPDATA%\yo\cache` (Windows default)

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

## `yo cache` Reference

```
yo cache <action>

Actions:
  path                   Print the global cache directory path
  clean                  Remove all cached dependencies
```

The cache location can be overridden via the `YO_CACHE_DIR` environment variable.

## See Also

- [BUILD_SYSTEM.md](../../plans/BUILD_SYSTEM.md) — Full design document with implementation details
- [Zig Build System](https://ziglang.org/learn/build-system/) — Primary inspiration
