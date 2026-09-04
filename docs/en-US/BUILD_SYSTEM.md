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
├── deps.yo               ← Dependency declarations (managed by yo install)
├── src/
│   ├── main.yo           ← Executable entry point
│   └── lib.yo            ← Library code
├── tests/
│   └── main.test.yo      ← Test file
├── .gitignore
└── README.md
```

Build output goes to `yo-out/<target>/`, organized by target triple (like Cargo):

```
yo-out/
├── x86_64-unknown-linux-gnu/         ← Host target
│   ├── bin/
│   │   └── my-project
│   └── lib/
│       └── libmy-project-lib.a
└── wasm32-unknown-emscripten/           ← Cross-compilation target (Emscripten)
    └── bin/
        ├── my-project.html
        ├── my-project.js
        └── my-project.wasm
```

## `build.yo`

The build file is a regular Yo source file that imports the `std/build` module. All build functions run at compile time and register artifacts and steps.

```rust
build :: import "std/build";

// Module metadata
mod :: build.module({ name: "my-project", root: "./src/lib.yo" });

// Define artifacts — each returns a Step for dependency wiring
exe :: build.executable({
  name: "my-project",
  root: "./src/main.yo"
});

lib :: build.static_library({
  name: "my-project-lib",
  root: "./src/lib.yo"
});

tests :: build.test({ name: "tests", root: "./tests/" });

// Register a run step (compile + execute)
run_exe :: build.run(exe);

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

### `BuildModule`

| Field  | Type           | Default      | Description                                  |
| ------ | -------------- | ------------ | -------------------------------------------- |
| `name` | `comptime_str` | _(required)_ | Module name (importable as `"name"`)         |
| `root` | `comptime_str` | _(required)_ | Path to root source file (e.g. `src/lib.yo`) |

### `Executable`

| Field       | Type           | Default            | Description                                |
| ----------- | -------------- | ------------------ | ------------------------------------------ |
| `name`      | `comptime_str` | _(required)_       | Artifact name                              |
| `root`      | `comptime_str` | _(required)_       | Path to main source file                   |
| `target`    | `comptime_str` | `target_host`      | Target triple (e.g. `"wasm32-unknown-emscripten"`) |
| `optimize`  | `Optimize`     | `Optimize.Debug`   | Optimization level                         |
| `allocator` | `Allocator`    | `Allocator.System` | Memory allocator                           |
| `sanitize`  | `Sanitize`     | `Sanitize.None`    | Sanitizer                                  |

### `StaticLibrary`

| Field      | Type           | Default          | Description                 |
| ---------- | -------------- | ---------------- | --------------------------- |
| `name`     | `comptime_str` | _(required)_     | Artifact name               |
| `root`     | `comptime_str` | _(required)_     | Path to library source file |
| `target`   | `comptime_str` | `target_host`    | Target triple               |
| `optimize` | `Optimize`     | `Optimize.Debug` | Optimization level          |

### `SharedLibrary`

| Field      | Type           | Default          | Description                 |
| ---------- | -------------- | ---------------- | --------------------------- |
| `name`     | `comptime_str` | _(required)_     | Artifact name               |
| `root`     | `comptime_str` | _(required)_     | Path to library source file |
| `target`   | `comptime_str` | `target_host`    | Target triple               |
| `optimize` | `Optimize`     | `Optimize.Debug` | Optimization level          |

Shared libraries compile with `-shared -fPIC` and produce `.so` (Linux), `.dylib` (macOS), or `.dll` (Windows).

### `TestSuite`

| Field    | Type           | Default       | Description                    |
| -------- | -------------- | ------------- | ------------------------------ |
| `name`   | `comptime_str` | _(required)_  | Test suite name                |
| `root`   | `comptime_str` | _(required)_  | Path to test file or directory |
| `target` | `comptime_str` | `target_host` | Target triple                  |

### Optimization Levels

| Value                   | Compiler Flags | Description                    |
| ----------------------- | -------------- | ------------------------------ |
| `Optimize.Debug`        | `-O0 -g`       | No optimization, debug symbols |
| `Optimize.ReleaseSafe`  | `-O2 -g`       | Optimized with debug symbols   |
| `Optimize.ReleaseFast`  | `-O3`          | Maximum performance            |
| `Optimize.ReleaseSmall` | `-O2`          | Optimize for binary size       |

### Allocators

| Value                | Description                               |
| -------------------- | ----------------------------------------- |
| `Allocator.Mimalloc` | High-performance allocator (mimalloc)     |
| `Allocator.System`   | The platform's system allocator (default) |

### Sanitizers

| Value              | Description                              |
| ------------------ | ---------------------------------------- |
| `Sanitize.None`    | No sanitizer (default)                   |
| `Sanitize.Address` | AddressSanitizer for memory errors/leaks |
| `Sanitize.Leak`    | LeakSanitizer for leak detection only    |

### Compilation Targets

`CompilationTarget` provides symbolic names for supported target triples. Use these instead of hardcoding target strings:

| Value                                    | Target Triple          | Notes                         |
| ---------------------------------------- | ---------------------- | ----------------------------- |
| `CompilationTarget.X86_64_Unknown_Linux_Gnu`     | `x86_64-unknown-linux-gnu`     | Linux x86-64 (glibc)          |
| `CompilationTarget.X86_64_Unknown_Linux_Musl`    | `x86_64-unknown-linux-musl`    | Linux x86-64 (musl, native)   |
| `CompilationTarget.Aarch64_Unknown_Linux_Gnu`    | `aarch64-unknown-linux-gnu`    | Linux ARM64                   |
| `CompilationTarget.Aarch64_Unknown_Linux_Musl`   | `aarch64-unknown-linux-musl`   | Linux ARM64 (musl, native)    |
| `CompilationTarget.Aarch64_Apple_Darwin`        | `aarch64-apple-darwin`        | macOS Apple Silicon           |
| `CompilationTarget.X86_64_Apple_Darwin`         | `x86_64-apple-darwin`         | macOS Intel                   |
| `CompilationTarget.X86_64_Pc_Windows_Msvc`  | `x86_64-pc-windows-msvc`  | Windows x86-64                |
| `CompilationTarget.Aarch64_Pc_Windows_Msvc` | `aarch64-pc-windows-msvc` | Windows ARM64                 |
| `CompilationTarget.Wasm32_Unknown_Emscripten`    | `wasm32-unknown-emscripten`    | WebAssembly (Emscripten)      |
| `CompilationTarget.Wasm32_Wasip1`          | `wasm32-wasip1`          | WebAssembly (standalone WASI) |

The host target is also available as `build.target_host`.

## Build Steps

Steps are named targets that define what `yo build <step>` does. Every build function (`executable`, `static_library`, `test`, `run`) returns a `Step` value. Use `step.depend_on(dep)` to wire dependencies:

```rust
// Each build function returns a Step
exe :: build.executable({ name: "my-app", root: "./src/main.yo" });
lib :: build.static_library({ name: "my-lib", root: "./src/lib.yo" });
tests :: build.test({ name: "tests", root: "./tests/" });
run_exe :: build.run(exe);

// Create named steps and wire dependencies
install :: build.step("install", "Build all artifacts");
install.depend_on(exe);
install.depend_on(lib);

run_step :: build.step("run", "Run the application");
run_step.depend_on(run_exe);

test_step :: build.step("test", "Run unit tests");
test_step.depend_on(tests);
```

### DAG-Based Execution

The build system models the project as a **directed acyclic graph (DAG)** of steps. When you run `yo build install`, the build runner:

1. Builds a DAG from step dependencies and linked artifacts
2. Detects cycles and reports errors
3. Executes independent steps concurrently at each level

For example, if `install` depends on both `exe` and `lib` (and they are independent), they compile at the same DAG level. If `exe` links `lib`, then `lib` compiles first.

```
Level 0: lib-a, lib-b, tests   (independent — compile concurrently)
Level 1: app                    (depends on lib-a, lib-b)
Level 2: install                (depends on app, tests)
```

> **Note**: Artifact compilations are currently serialized (the Yo evaluator uses global state). Tests and run steps execute concurrently.

### `Step`

| Field  | Type           | Description                                                                                              |
| ------ | -------------- | -------------------------------------------------------------------------------------------------------- |
| `name` | `comptime_str` | Step name (artifact name, or custom name for `build.step`)                                               |
| `kind` | `StepKind`     | Step kind: `Executable`, `StaticLibrary`, `SharedLibrary`, `SystemLibrary`, `TestSuite`, `Run`, `Custom` |

### Step Methods

| Method                          | Description                                                            |
| ------------------------------- | ---------------------------------------------------------------------- |
| `step.depend_on(other)`         | Add a dependency — `other` is built before `step`                      |
| `step.link(library)`            | Link a library to an artifact (static, shared, or system lib)          |
| `step.add_import(entry)`        | Add a single module import to this step (for dependency modules)       |
| `step.add_import_list(entries)` | Add multiple module imports at once from a `ComptimeList(ImportEntry)` |
| `step.add_c_flags(flags)`       | Add custom C compiler/linker flags (space-separated string)            |

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

### Build Summary

Use `--summary` to print a tree of executed steps with timing (like Zig's `--summary all`):

```bash
yo build --summary
```

```
Build Summary: 3/3 steps succeeded
install success
├── compile exe my-app Debug native success 1.3s MaxRSS:706M
│   └── compile lib math Debug native success 295ms MaxRSS:650M
└── compile lib my-app-lib Debug native success 310ms MaxRSS:680M
```

Each node shows: step description, success/failure status, duration, and peak memory usage (MaxRSS). The tree structure reflects the DAG dependency edges.

## Modules

Modules are the unit of reuse across Yo dependencies. A module declares its source root and system library requirements. When another project imports a module, its system libraries are automatically propagated to the consumer's build — no manual `system_library` or `link` calls needed.

### Defining a Module

```rust
build :: import "std/build";

raylib :: build.system_library({
  name: "raylib",
  defines: "NOMINMAX NOGDI NOUSER"
});

// Declare a module with its root source file
mod :: build.module({ name: "raylib_yo", root: "./src/lib.yo" });

// Link system libraries the module depends on
mod.link(raylib);

exe :: build.executable({ name: "raylib_yo", root: "./src/main.yo" });
exe.link(raylib);

install :: build.step("install", "Build all artifacts");
install.depend_on(exe);
```

### `BuildModule`

Returned by `build.module()`. Has one method:

| Method          | Description                                          |
| --------------- | ---------------------------------------------------- |
| `mod.link(lib)` | Declare that this module depends on a system library |

### `ModuleConfig`

| Field  | Type           | Default      | Description           |
| ------ | -------------- | ------------ | --------------------- |
| `name` | `comptime_str` | _(required)_ | Module name           |
| `root` | `comptime_str` | _(required)_ | Root source file path |

### Importing a Module from a Dependency

Use `dep.module()` and `exe.add_import()` to import a module from a dependency:

```rust
build :: import "std/build";

// Git dependency
raylib_yo :: build.dependency({ name: "raylib_yo", url: "https://github.com/shd101wyy/raylib_yo.git", ref: "v0.0.4" });

// Or local path dependency:
// raylib_yo :: build.path_dependency({ name: "raylib_yo", path: "../raylib_yo" });

exe :: build.executable({ name: "tetris_yo", root: "./src/main.yo" });

// Import the module — system libraries (raylib) are transitively propagated
exe.add_import({ name: "raylib_yo", module: raylib_yo.module() });

install :: build.step("install", "Build all artifacts");
install.depend_on(exe);
```

- `dep.module()` — get the sole module from a dependency (empty name defaults to the only module)
- `dep.module("name")` — get a specific module by name if the dependency defines multiple modules
- `exe.add_import({ name, module })` — register a single module import on an artifact
- `exe.add_import_list(list)` — register multiple module imports at once from a `ComptimeList(ImportEntry)`

### Bulk Import with `add_import_list`

When a dependency exposes multiple modules, use `add_import_list` to register them all at once:

```rust
import_list :: ComptimeList(build.ImportEntry)(
  { name: "mod_a", module: dep.module("a") },
  { name: "mod_b", module: dep.module("b") }
);
exe.add_import_list(import_list);
```

### `ImportEntry`

| Field    | Type           | Description                            |
| -------- | -------------- | -------------------------------------- |
| `name`   | `comptime_str` | Import name (used in `import "name"`)  |
| `module` | `BuildModule`  | Module to import (from `dep.module()`) |

### How It Works

When you run `yo build`, the build system:

1. **Evaluates the dependency's `build.yo`** to discover its modules and linked system libraries
2. **Resolves system libraries** via `pkg-config` (or fallback flags) for each module
3. **Propagates flags** — include paths, library paths, link flags, and defines from the module's system libraries are merged into the consumer artifact's compile command
4. **Sets up import resolution** — `import "raylib_yo"` in the consumer's source resolves to the module's root file

This means the consumer doesn't need to declare `build.system_library({ name: "raylib" })` — it's automatically propagated from the dependency's module definition.

## Linking Libraries

Use `step.link()` to link any library to an artifact — works with static, shared, and system libraries. Similar to Zig's `exe.linkLibrary(lib)`:

```rust
build :: import "std/build";

// Yo libraries
lib :: build.shared_library({
  name: "mylib",
  root: "./src/lib.yo"
});

// System libraries (via pkg-config)
openssl :: build.system_library({
  name: "openssl"
});

exe :: build.executable({
  name: "my-app",
  root: "./src/main.yo"
});

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

### Cross-Module Linking with `extern "Yo"`

Static libraries export Yo functions that other modules can call using `extern "Yo"`. This is similar to Zig's `@import` across modules.

**Library module** (`add.yo`):

```rust
add :: (fn(a: i32, b: i32) -> i32)(
  (a + b)
);

export add;
```

**Executable module** (`demo.yo`):

```rust
stdio :: import "std/libc/stdio";

extern "Yo",
  add : (fn(a: i32, b: i32) -> i32);

main :: (fn() -> unit)({
  result := add(i32(3), i32(4));
  stdio.printf("3 + 4 = %d\n", result);
});

export main;
```

**Build file** (`build.yo`):

```rust
build :: import "std/build";

lib :: build.static_library({
  name: "add",
  root: "./add.yo"
});

exe :: build.executable({
  name: "demo",
  root: "./demo.yo"
});

exe.link(lib);

install :: build.step("install", "Build all artifacts");
install.depend_on(exe);
install.depend_on(lib);
```

Running `yo build` produces:

```
yo-out/
└── x86_64-unknown-linux-gnu/
    ├── bin/
    │   └── demo          ← Executable (calls add from library)
    └── lib/
        └── libadd.a      ← Static library (exports add function)
```

In library mode, the compiler:

1. Uses plain C names for exported functions (e.g., `add` instead of `fn_yo3818ce2d_id_3_add`)
2. Makes all internal runtime functions `static` to avoid duplicate symbols when linking
3. Skips `main()` wrapper generation

You can also compile static libraries directly via CLI:

```bash
yo compile add.yo --static-library -o libadd
yo compile demo.yo --extern libadd.a -o demo
```

## Build Options

Like Zig's `b.option()`, declare user-configurable build options that can be set from the CLI with `-Dname=value`:

```rust
build :: import "std/build";

// Declare a build option with a default value
strip :: build.option({
  name: "strip",
  description: "Strip debug symbols",
  default: "false"
});

opt_level :: build.option({
  name: "opt",
  description: "Optimization level",
  default: "debug"
});
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

| Field         | Type           | Default      | Description              |
| ------------- | -------------- | ------------ | ------------------------ |
| `name`        | `comptime_str` | _(required)_ | Option name              |
| `description` | `comptime_str` | _(required)_ | Help text                |
| `default`     | `comptime_str` | `""`         | Default value if not set |

## Cross-Compilation

> **Note:** True cross-compilation (targeting a different CPU architecture or OS
> than the host machine) is **not supported**. The target must match the host's
> architecture and OS. The only exception is **WebAssembly** (WASM), which can
> always be targeted from any host via `emcc`.
>
> musl targets (`x86_64-unknown-linux-musl`) are only supported when running natively
> on a musl-based system (e.g. Alpine Linux).

Yo supports targeting WASM via target triples. Specify the target in `build.yo` or on the command line:

### In `build.yo`

```rust
build.executable({
  name: "my-app-wasm",
  root: "./src/main.yo",
  target: build.CompilationTarget.Wasm32_Unknown_Emscripten,
  optimize: build.Optimize.ReleaseSmall
});
```

You can also use raw target strings if preferred:

```rust
build.executable({
  name: "my-app-wasm",
  root: "./src/main.yo",
  target: "wasm32-unknown-emscripten",
  optimize: build.Optimize.ReleaseSmall
});
```

### On the command line

```bash
# Override target for all artifacts
yo build --target wasm32-unknown-emscripten
```

### Supported Targets

| Target Triple          | Notes                         |
| ---------------------- | ----------------------------- |
| `x86_64-unknown-linux-gnu`     | Linux x86-64 (glibc)          |
| `x86_64-unknown-linux-musl`    | Linux x86-64 (musl, native)   |
| `aarch64-unknown-linux-gnu`    | Linux ARM64                   |
| `aarch64-unknown-linux-musl`   | Linux ARM64 (musl, native)    |
| `aarch64-apple-darwin`        | macOS Apple Silicon           |
| `x86_64-apple-darwin`         | macOS Intel                   |
| `x86_64-pc-windows-msvc`  | Windows x86-64                |
| `aarch64-pc-windows-msvc` | Windows ARM64                 |
| `wasm32-unknown-emscripten`    | WebAssembly (Emscripten)      |
| `wasm32-wasip1`          | WebAssembly (standalone WASI) |

Targets are spelled exactly as Rust spells them — there are no shorthands or aliases; an unrecognised spelling is rejected with the supported list.

### WASM Emscripten Environment

When building for `wasm32-unknown-emscripten` via `yo build`, the output defaults to **browser** environment:

- Output is `.html` + `.js` + `.wasm` (a complete browser shell)
- `-sNODERAWFS` is **not** added (it uses `require('fs')` which doesn't exist in browsers)
- `-sEMULATE_FUNCTION_POINTER_CASTS=1` is always added (required for codegen)
- System libraries declared via `system_library()` are passed as `-l<name>` to emcc (pkg-config/vcpkg host-platform resolution is skipped)

#### Output Format Auto-Detection

The primary output file extension is automatically determined:

| C Flags          | Primary Output | Extra Files     | Use Case                    |
| ---------------- | -------------- | --------------- | --------------------------- |
| (default)        | `.html`        | `.js` + `.wasm` | Browser app (GitHub Pages)  |
| `-sMODULARIZE=1` | `.js`          | `.wasm`         | JS module (library/bundler) |

- **`.html` (default):** emcc generates a browser shell page alongside the `.js` glue code and `.wasm` binary. Use this for standalone web apps and GitHub Pages deployment.
- **`.js` (with `-sMODULARIZE`):** emcc's `-sMODULARIZE` flag is incompatible with `.html` output, so the build system automatically switches to `.js`. Use this when you need the output as a JavaScript module (e.g., for bundlers, dynamic imports, or custom HTML pages).

When running WASM artifacts via `yo build run`, the build system always executes the `.js` file with Node.js, regardless of whether the primary output is `.html` or `.js`.

To serve the output, use a local HTTP server (WASM requires HTTP, not `file://`):

```bash
cd yo-out/wasm32-unknown-emscripten/bin
python -m http.server 8080
# Open http://localhost:8080/my-project.html
```

If you need Node.js execution instead (e.g., headless/server-side WASM), add the flag manually:

```rust
exe_wasm.add_c_flags("-sNODERAWFS=1");
```

> **Note:** `yo test --cc emcc` always uses Node.js mode (`-sNODERAWFS=1`) since tests run via Node.

### Platform Detection in Code

Use `std/process` to write platform-aware code:

```rust
{ platform, arch, Platform, Arch } :: import "std/process";

cond(
  (platform == Platform.Linux) => { /* Linux-specific */ },
  (platform == Platform.Macos) => { /* macOS-specific */ },
  (platform == Platform.Emscripten) => { /* Emscripten WASM */ },
  (platform == Platform.Wasi) => { /* Standalone WASI */ },
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
  --cc <compiler>        C compiler: clang, gcc, zig, cc, emcc
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

Creates the following files:

- `build.yo` — Build configuration (imports `deps.yo`)
- `deps.yo` — Dependency declarations (empty template)
- `src/main.yo` — Executable entry point
- `src/lib.yo` — Library code
- `tests/main.test.yo` — Test file
- `.gitignore`, `README.md`

## Multi-Target Builds

Define multiple artifacts with different targets in a single `build.yo`:

```rust
build :: import "std/build";

// Module definition
mod :: build.module({ name: "my-app", root: "./src/lib.yo" });

// Native build
native :: build.executable({
  name: "my-app",
  root: "./src/main.yo",
  optimize: build.Optimize.ReleaseFast
});

// WASM build (Emscripten)
wasm :: build.executable({
  name: "my-app-wasm",
  root: "./src/main.yo",
  target: build.CompilationTarget.Wasm32_Unknown_Emscripten,
  optimize: build.Optimize.ReleaseSmall,
  allocator: build.Allocator.System
});

// Per-artifact C flags — useful for Emscripten-specific linker settings
wasm.add_c_flags("-sASYNCIFY -DPLATFORM_WEB");

run_native :: build.run(native);

install :: build.step("install", "Build all targets");
install.depend_on(native);
install.depend_on(wasm);

run_step :: build.step("run", "Run native build");
run_step.depend_on(run_native);
```

## Dependencies

### Git Dependencies

Declare git-hosted dependencies in `build.yo`:

```rust
build :: import "std/build";

// Add a git dependency — returns a Dependency handle
dep :: build.dependency({
  name: "json-parser",
  url: "https://github.com/user/json-parser.git",
  ref: "v1.0.0"
});

// Dependency from a subdirectory of a repo
build.dependency({
  name: "utils",
  url: "https://github.com/user/mono-repo.git",
  ref: "main",
  path: "packages/utils"
});

exe :: build.executable({ name: "my-app", root: "./src/main.yo" });

install :: build.step("install", "Build all artifacts");
install.depend_on(exe);
```

Fetch dependencies with:

```bash
yo fetch              # Fetch all dependencies from build.yo
yo fetch --verbose    # Show detailed progress
yo fetch --update     # Re-resolve git refs to latest commits
```

Or install directly from GitHub:

```bash
yo install github.com/user/repo          # Latest semver tag
yo install github.com/user/repo@v1.0.0   # Pinned version
yo install user/repo                     # Shorthand for GitHub
yo install ./path/to/local/dep           # Local path dependency
```

`yo install` resolves the latest semver tag from the repository (or falls back to the default branch), appends a `build.dependency(...)` call to `build.yo`, and fetches the dependency into the global cache. For local paths (`./`, `../`, or absolute), it appends a `build.path_dependency(...)` call instead — no fetching needed.

Dependencies are stored in a global cache and tracked by `yo.lock` (commit this file to version control). `yo build` auto-fetches if dependencies are not yet cached.

**Updating dependencies**: When using branch refs like `"main"`, the lock file pins the exact commit SHA at fetch time. Run `yo fetch --update` (or `yo fetch -u`) to re-resolve all refs to their latest commits and update `yo.lock`.

### Linking Dependency Artifacts

If a dependency has its own `build.yo` that defines artifacts (e.g., a static library), you can link them using `dep.artifact()`:

```rust
build :: import "std/build";

// Register a dependency (git or path)
dep :: build.path_dependency({ name: "dep_lib", path: "../dep_lib" });

// Access the "add" static library from dep_lib's build.yo
add_lib :: dep.artifact("add");

// Link it to our executable
exe :: build.executable({ name: "demo", root: "./src/main.yo" });
exe.link(add_lib);

install :: build.step("install", "Build demo");
install.depend_on(exe);
```

The dependency's `build.yo` defines the static library:

```rust
build :: import "std/build";

lib :: build.static_library({ name: "add", root: "./src/lib.yo" });

install :: build.step("install", "Build the static library");
install.depend_on(lib);
```

When you run `yo build`, the build system:

1. Evaluates the dependency's `build.yo` to discover its artifacts
2. Compiles the dependency's static library (`libadd.a`)
3. Links it into the consumer executable

The consumer's source code declares the dependency functions using `extern "Yo"`:

```rust
extern "Yo",
  add : (fn(a: i32, b: i32) -> i32);
```

### Path Dependencies (Local)

Use `path_dependency` to depend on a local package by filesystem path. Like `dependency`, it returns a `Dependency` handle:

```rust
build :: import "std/build";

// Depend on a sibling project — returns a Dependency handle
dep :: build.path_dependency({
  name: "mylib",
  path: "../mylib"
});

exe :: build.executable({ name: "my-app", root: "./src/main.yo" });

install :: build.step("install", "Build all artifacts");
install.depend_on(exe);
```

In your source code, import the dependency by name:

```rust
mylib :: import "mylib";

main :: (fn() -> unit) {
  result := mylib.multiply(i32(3), i32(4));
};
export main;
```

**Entry point resolution order** for path dependencies:

1. Module root from `add_import()` (if the consumer uses `exe.add_import()`)
2. Sole module root from the dependency's `build.yo` (if exactly one module is defined)
3. `index.yo`
4. `<name>.yo`

Path dependencies need no fetching or lock file entries — they are resolved directly from the local filesystem.

### `deps.yo` — Dependency Declaration File

`yo init` generates a `deps.yo` file alongside `build.yo`. This file is the central place to declare all project dependencies, keeping `build.yo` focused on build logic.

**Generated `deps.yo` (empty):**

```rust
// Dependencies for this project.
// Managed by `yo install`. Manual edits are preserved.
//
// Usage in build.yo:
//   { imports } :: import "./deps.yo";
//   exe.add_import_list(imports);
//
// Add a dependency:
//   yo install user/repo
//   yo install user/repo@v1.0.0
//   yo install ./local-path

build :: import "std/build";

// --- Dependencies ---

// --- Import list ---
imports :: ComptimeList(build.ImportEntry)();
export imports;
```

**`deps.yo` with dependencies:**

```rust
build :: import "std/build";

// --- Dependencies ---
raylib_yo :: build.dependency({ name: "raylib_yo", url: "https://github.com/shd101wyy/raylib_yo.git", ref: "v0.0.4" });
json :: build.path_dependency({ name: "json", path: "../json-yo" });

// --- Import list ---
imports :: ComptimeList(build.ImportEntry)(
  { name: "raylib_yo", module: raylib_yo.module() },
  { name: "json", module: json.module() }
);
export imports;
```

**Using `deps.yo` in `build.yo`:**

```rust
build :: import "std/build";
{ imports } :: import "./deps.yo";

exe :: build.executable({ name: "my-app", root: "./src/main.yo" });
exe.add_import_list(imports);

install :: build.step("install", "Build all artifacts");
install.depend_on(exe);
```

When you run `yo install`, the dependency is automatically added to `deps.yo` and the `imports` list is regenerated. If `deps.yo` doesn't exist yet, it is created from the template.

> **Note:** Inline `build.dependency()` calls in `build.yo` still work. The `deps.yo` pattern is the recommended approach for new projects.

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

### Cache Integrity

Every cached dependency has a **content hash** stored in `yo.lock`:

```toml
[[dependencies]]
name = "json-parser"
url = "https://github.com/user/json-parser.git"
ref = "v1.0.0"
commit = "abc123..."
hash = "sha256-7c19c1..."
```

**How it works:**

1. **At fetch time** — `yo fetch` clones the dependency, walks the extracted file tree, and computes a SHA-256 hash of all file names and contents. The hash is written to `yo.lock` and to a `.yo-content-hash` sidecar file inside the cached directory.

2. **At build time** — `yo build` reads the sidecar file (O(1)) and compares it against the `yo.lock` hash. If they match, the cache is trusted. If the sidecar is missing (e.g. older caches), a full re-hash is performed and the sidecar is written for future builds.

3. **On mismatch** — If the hash doesn't match (e.g. files were tampered with or corrupted), `yo build` reports an error with the expected vs actual hash and suggests running `yo fetch`. Running `yo fetch` automatically deletes the corrupted cache and reclones.

**Cross-platform stability:**

The content hash normalizes `\r\n` → `\n` during hashing, so the same dependency produces the same hash on Windows (which may check out CRLF) and Linux (LF). File names are sorted using locale-independent Unicode ordering (case-insensitive primary, codepoint tiebreaker) rather than locale-sensitive collation, ensuring hashes are deterministic regardless of the system locale.

This approach follows Zig's model of hashing extracted content rather than npm/Go's approach of hashing archive bytes. It requires no archive storage and verifies the actual source files that the compiler reads.

### Shared Dependencies

When multiple packages depend on the same dependency (same URL+ref or same path), the build system uses **content-addressed caching** to compile the dependency only once:

```
   root project
   ├── dep_A → dep_C (path: ../shared_lib)
   └── dep_B → dep_C (path: ../shared_lib)
```

The dependency identity is hashed (based on resolved path or git URL+ref). Identical hashes share a single compiled artifact, avoiding redundant builds.

If two dependencies require **different versions** of the same package (different URLs or refs), each version is compiled separately with a unique content hash.

### Transitive Dependencies

Dependencies can have their own dependencies. The build system resolves the full transitive closure automatically:

```
root project
├── dep_a (links dep_b)
│   └── dep_b
└── (dep_b is fetched and compiled transitively)
```

**How it works:**

1. **Recursive fetching** — When `yo build` (or `yo fetch`) runs, each dependency's `build.yo` is evaluated to discover its own dependencies. Sub-dependencies are fetched recursively (BFS) and recorded in the root project's `yo.lock`.

2. **Recursive compilation** — Sub-dependencies are compiled before their parents. In the example above, `dep_b`'s static library is compiled first, then `dep_a` links against it.

3. **Link propagation** — When `dep_a` links `dep_b`'s `.a` file, that transitive `.a` file is automatically propagated to the root project's linker command. The root executable ends up linking both `libadd3.a` (from dep_a) and `libadd.a` (from dep_b).

4. **Import resolution** — When `dep_a`'s source code does `import "dep_b"`, the build system falls back to the root project's `yo.lock` to resolve the import path.

No special configuration is needed — transitive dependencies are discovered and linked automatically from the dependency graph.

### System Libraries (pkg-config)

Link against system C libraries discovered via `pkg-config`:

```rust
build.system_library({
  name: "openssl",
  fallback_include: "/usr/include/openssl",
  fallback_lib: "/usr/lib",
  fallback_link: "ssl crypto",
  defines: "OPENSSL_API_COMPAT=0x10100000L"
});
```

When `pkg-config` is available (Linux, macOS), it automatically resolves include paths and link flags using the `name` as the pkg-config package name. The fallback fields are used when `pkg-config` is not found (common on Windows).

`defines` is a space-separated list of preprocessor definitions that Yo passes to the C compiler (`-D...` on clang/gcc, `/D...` on MSVC) for any artifact that links this system library. This is useful for header fixups, feature toggles, or platform-specific compatibility macros that belong to the library integration rather than the compiler itself.

For example, `raylib` on Windows needs a few Win32 macros defined before including `raylib.h`:

```rust
raylib :: build.system_library({
  name: "raylib",
  defines: "NOMINMAX NOGDI NOUSER"
});
```

## `yo fetch` Reference

```
yo fetch [options]

Options:
  --build-file <path>    Path to build file (default: ./build.yo)
  --verbose, -v          Verbose output
  --update, -u           Re-resolve git refs to latest commits and update yo.lock
```

`yo fetch` evaluates `build.yo` to discover dependencies, resolves git refs to exact commit SHAs via `git ls-remote`, clones them to the global cache, computes a content hash, and records everything in `yo.lock`.

Without `--update`, cached dependencies are verified against their `yo.lock` hash using a sidecar file. If the hash matches, fetching is skipped entirely (no network access required). If the hash mismatches, the corrupted cache entry is deleted and the dependency is recloned automatically. With `--update`, all refs are re-resolved and re-fetched even if already cached — useful for tracking branch HEAD changes.

**Auto-pruning**: If a dependency is removed from `build.yo`, `yo fetch` automatically removes the stale entry from `yo.lock`. The cached files in the global cache are not deleted (use `yo cache clean` to purge the cache).

## `yo install` Reference

```
yo install <package> [options]

Arguments:
  package                Package specifier (see formats below)

Options:
  --build-file <path>    Path to build file (default: ./build.yo)
  --verbose, -v          Verbose output

Package specifier formats:
  github.com/user/repo          Latest semver tag from GitHub
  github.com/user/repo@v1.0.0  Pinned version/tag
  user/repo                     Shorthand for GitHub
  user/repo@v2.0.0              Shorthand with version pin
  https://example.com/repo.git  Full URL
  ./path/to/dep                 Local path dependency
  ../sibling-dep                Local path dependency
```

`yo install` performs the following steps:

**For git dependencies:**

1. Parses the package specifier and infers the dependency name from the repo name
2. Resolves the latest semver tag via `git ls-remote --tags` (or uses the pinned version)
3. Falls back to the default branch if no semver tags are found
4. Appends `build.dependency(...)` to `deps.yo` (creates the file if it doesn't exist)
5. Regenerates the `imports` ComptimeList in `deps.yo`
6. Fetches the dependency and updates `yo.lock`

**For local path dependencies:**

1. Infers the name from the directory basename
2. Validates that the path exists
3. Appends `build.path_dependency(...)` to `deps.yo`
4. Regenerates the `imports` ComptimeList in `deps.yo`

If `build.yo` already imports `deps.yo`, no further manual changes are needed.

## `yo cache` Reference

```
yo cache <action>

Actions:
  path                   Print the global cache directory path
  clean                  Remove all cached dependencies
```

The cache location can be overridden via the `YO_CACHE_DIR` environment variable.

## Documentation Generation

Yo includes built-in documentation generation that extracts doc comments from source code and produces API reference sites.

### Doc Comment Syntax

Yo supports four styles of documentation comments, matching Rust conventions:

| Style    | Example                                    | Purpose                                          |
| -------- | ------------------------------------------ | ------------------------------------------------ |
| `///`    | `/// Adds two numbers.`                    | Outer line doc — documents the next declaration  |
| `//!`    | `//! This module provides math utilities.` | Inner line doc — documents the enclosing module  |
| `/** */` | `/** Adds two numbers. */`                 | Outer block doc — documents the next declaration |
| `/*! */` | `/*! Module-level documentation. */`       | Inner block doc — documents the enclosing module |

Regular comments (`//`, `/* */`) are **not** documentation comments — they are internal notes and attribute carriers.

````rust
//! Math utilities for the Yo standard library.

/// Add two integers.
///
/// # Examples
///
/// ```rust
/// result :: add(i32(1), i32(2));
/// assert((result == i32(3)), "1 + 2 = 3");
/// ```
add :: (fn(a : i32, b : i32) -> i32)((a + b));
export add;
````

### `yo doc` Command

The simplest way to generate docs — zero configuration required:

```bash
# Document current directory
yo doc

# Document a specific file or directory
yo doc ./src/lib.yo
yo doc ./std

# Choose output format
yo doc --format html        # Default: static HTML site
yo doc --format markdown    # Markdown files
yo doc --format json        # Machine-readable JSON

# Other options
yo doc -o docs/api          # Custom output directory
yo doc --name "My Library"  # Override project name
yo doc --document-private   # Include non-exported items
yo doc --version v1.0.0     # Set version (auto-detects from git if omitted)
```

### Build System Integration

For advanced projects, configure documentation generation in `build.yo`:

```rust
build :: import "std/build";

// Define doc config
docs :: build.doc({
  name: "docs",
  root: "./src",
  output: "yo-out/doc",
  format: build.DocFormat.Html,
  title: "My Project API",
  version: "v1.0.0"
});

// Wire into the build DAG
doc_step :: build.step("doc", "Generate documentation");
doc_step.depend_on(docs);

install :: build.step("install", "Build all artifacts");
install.depend_on(doc_step);
```

Then run:

```bash
yo build doc          # Generate documentation
yo build --list-steps # See all steps including doc
```

### `DocFormat`

```rust
DocFormat :: enum(
  Html,       // Fully offline static HTML site (default)
  Markdown,   // README.md + module/<name>.md files
  Json        // Machine-readable doc.json
);
```

### `DocConfig`

```rust
DocConfig :: struct(
  name : comptime_str,                            // Step name
  root : comptime_str,                            // Source root file/directory
  (output : comptime_str) ?= "yo-out/doc",       // Output directory
  (format : DocFormat) ?= DocFormat.Html,             // Output format
  (include_private : bool) ?= false,                 // Document non-exported items
  (include_deps : bool) ?= false,                    // Document dependencies too
  (title : comptime_str) ?= "",                   // Custom site title
  (logo : comptime_str) ?= "",                    // Logo image path
  (favicon : comptime_str) ?= ""                  // Favicon path
);
```

### Output Formats

**HTML** (default): Generates a fully self-contained static site with:

- Dark mode, responsive layout
- Client-side search
- Sidebar navigation
- All CSS/JS inlined — works from `file://` URLs, no CDN needed
- Uses [markdown_yo](https://www.npmjs.com/package/markdown_yo) for Markdown rendering

**Markdown**: Generates `README.md` (module index) and `module/<name>.md` (per-module pages). Useful for embedding in GitHub repos or other Markdown-based documentation systems.

**JSON**: Serializes the full documentation model to `doc.json`. Useful for custom tooling, IDE integration, or feeding into other renderers.

## `yo doc` Reference

```
yo doc [path]

Generate API documentation

Positionals:
  path                   File or directory to document (default: ".")

Options:
  -o, --output           Output directory (default: "yo-out/doc")
  -f, --format           Output format: html, markdown, json (default: "html")
      --name             Project name (default: inferred)
      --document-private Include non-exported declarations
  -v, --verbose          Verbose output
```

## See Also

- [BUILD_SYSTEM.md](../../plans/reference/BUILD_SYSTEM.md) — Full design document with implementation details
- [Zig Build System](https://ziglang.org/learn/build-system/) — Primary inspiration
