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
├── yo.toml               ← Package manifest: name, modules, dependencies (edited by yo add)
├── build.yo              ← Build configuration
├── src/
│   ├── main.yo           ← Executable entry point
│   └── lib.yo            ← Library code
├── tests/
│   └── main.test.yo      ← Test file
├── .gitignore
├── AGENTS.md             ← Guidance for AI coding agents (lists the skills)
├── CLAUDE.md             ← Points at AGENTS.md
├── .agents/skills/       ← Bundled agent skill files (see yo skills install)
└── README.md
```

The agent files are skipped when you pass `--no-skills`, and are only created
if they do not already exist. Refresh the skill files after upgrading `yo`
with `yo skills install`.

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

The build file is a regular Yo source file that imports the `std/build` module. All build functions run at compile time and register artifacts and steps. What the package IS — its name, the modules other packages may import, and its dependencies — lives in the data file `yo.toml` next to it (see [Dependencies](#dependencies)); `build.yo` only says how to build it.

```rust
build :: import "std/build";

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
| `heap_size` | `usize`        | `16777216` (16 MiB) | Fixed-region heap size (`Allocator.Fixed` only) |
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
| `Allocator.Fixed`    | General-purpose TLSF allocator over ONE statically-sized region (see below) |

`Allocator.Fixed` serves every allocation out of a single statically-sized
region in `.bss` — no libc heap (the first building block of the
embedded/freestanding story). Set its size with the executable's `heap_size`
field (bytes; 64 KiB to 4 GiB, rounded down to a 16-byte granule; default
16 MiB). With a bounded region, running out of memory is a **panic with a
diagnostic** (`out of memory: requested N bytes (fixed heap ...)`), which
makes OOM a reproducible test input instead of unreachable overcommit. The
allocator is thread-safe (the parallelism runtime allocates from worker
threads), and `yo compile --debug-heap` turns it into a portable leak oracle
by reporting live blocks at process exit.

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

A module is a root file that other code imports by name. Modules are declared in `yo.toml`'s `[modules]` table — `default` is what `import("<package name>")` means, and every other entry is importable as `import("<package name>/<module>")`, from inside the package and from every package that depends on it:

```toml
[package]
name = "raylib_yo"

[modules]
default = "src/lib.yo"
shapes  = "src/shapes.yo"
```

`build.yo` refers to a module when it needs to attach system libraries to it. When another package imports the module, its system libraries are propagated to the consumer's build:

```rust
build :: import "std/build";

raylib :: build.system_library({
  name: "raylib",
  defines: "NOMINMAX NOGDI NOUSER"
});

// Name a [modules] entry of yo.toml and link the system libraries it needs
mod :: build.module({ name: "default" });
mod.link(raylib);

exe :: build.executable({ name: "raylib_yo", root: "./src/main.yo" });
exe.link(raylib);

install :: build.step("install", "Build all artifacts");
install.depend_on(exe);
```

### `BuildModule`

Returned by `build.module()` and `dep.module()`. Has one method:

| Method          | Description                                          |
| --------------- | ---------------------------------------------------- |
| `mod.link(lib)` | Declare that this module depends on a system library |

### `ModuleConfig`

| Field  | Type           | Default      | Description                                          |
| ------ | -------------- | ------------ | ---------------------------------------------------- |
| `name` | `comptime_str` | _(required)_ | A `[modules]` entry of `yo.toml` (`"default"` for the root) |

### Importing a Dependency's Module

Nothing to wire in `build.yo`: a dependency declared in `yo.toml` is importable by its name, and its named modules as `name/module`:

```rust
raylib_yo :: import "raylib_yo";          // the dependency's [modules] default
{ Circle } :: import "raylib_yo/shapes";  // its [modules] shapes
```

This works in every command — `yo build`, `yo compile`, `yo check`, `yo test`, `yo doc` and the language server — because the compiler finds the nearest `yo.toml` above the file it is compiling and resolves the manifest's dependency closure (see [Importing a dependency](#importing-a-dependency)).

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
// `extern(...)` is an FFI declaration, so the file must opt into unsafe code.
pragma(Pragma.AllowUnsafe);
{ println } :: import("std/fmt");

extern("Yo", add : (fn(a : i32, b : i32) -> i32));

main :: (fn() -> unit)({
  println(add(i32(3), i32(4)).to_string());
});

export(main);
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
  --no-skills            Skip the agent skill files and AGENTS.md/CLAUDE.md
```

Creates the following files:

- `yo.toml` — Package manifest: `[package]` name and version, `[modules] default = "src/lib.yo"`, an empty `[dependencies]` table
- `build.yo` — Build configuration
- `src/main.yo` — Executable entry point
- `src/lib.yo` — Library code
- `tests/main.test.yo` — Test file
- `.gitignore`, `README.md`

Then, unless `--no-skills` is passed, it installs the bundled agent skill
files into the project's agent config directories (`.agents/skills/` on a
fresh project) and writes two entry points for AI coding agents:

- `AGENTS.md` — lists the installed skills with their descriptions; created
  only if absent
- `CLAUDE.md` — a one-line pointer at `AGENTS.md`; created only if absent

## Multi-Target Builds

Define multiple artifacts with different targets in a single `build.yo`:

```rust
build :: import "std/build";

// Module definition

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

Dependencies are declared in the package manifest, `yo.toml` — data, not code: every tool reads it without running anything, and `yo add` / `yo remove` edit it in place, keeping your comments and formatting.

```toml
[package]
name = "tetris_yo"
version = "0.3.0"
description = "Tetris in Yo"
license = "MIT"

[modules]                     # what importers may `import("tetris_yo")` / `import("tetris_yo/board")`
default = "src/lib.yo"
board   = "src/board.yo"

[dependencies]
raylib_yo = { git = "https://github.com/shd101wyy/raylib_yo", version = "^0.0.6" }
json-yo   = { git = "https://github.com/user/json-yo", tag = "v1.2.0" }
utils     = { git = "https://github.com/user/mono", version = "~2.1", path = "packages/utils" }
mylib     = { path = "../mylib" }

[dev-dependencies]            # for this package's own tests; never propagated to dependents
snapshot  = { git = "https://github.com/user/snapshot-yo", version = "^0.4" }
```

### `[package]`

| Key           | Description                                                                        |
| ------------- | ---------------------------------------------------------------------------------- |
| `name`        | The package name — what importers write in `import("name")`. Required.             |
| `version`     | Semver version of this package (the version a release tag `vX.Y.Z` carries)        |
| `description` | Free text                                                                          |
| `license`     | SPDX identifier                                                                    |
| `yo`          | Minimum compiler version (mirrors `.yo-version`)                                   |

### Dependency entries

A dependency is a table key (its import name) with an inline table:

| Key       | Meaning                                                                                                    |
| --------- | ---------------------------------------------------------------------------------------------------------- |
| `git`     | Repository URL — `https://…`, `git@host:path`, `ssh://…`, or a local path git accepts                      |
| `version` | A semver range over the repository's `vX.Y.Z` tags; `yo install` picks the highest satisfying tag           |
| `tag`     | One exact tag                                                                                              |
| `branch`  | A branch, pinned to a commit in `yo.lock` and moved only by `yo update`                                    |
| `rev`     | One exact commit                                                                                           |
| `path`    | With `git`: the package's directory inside the repository. Alone: a local path dependency (relative to `yo.toml`) |

A git entry pins at most one of `version` / `tag` / `branch` / `rev`; `git` alone follows the remote's default branch. Any other key is an error — a typo never silently means "default branch".

### Version ranges

The range grammar is Cargo's:

| Range          | Accepts                                              |
| -------------- | ---------------------------------------------------- |
| `^1.2.3`, `1.2.3` | `>=1.2.3, <2.0.0` (for `0.x`: `^0.2.3` is `<0.3.0`, `^0.0.3` is exactly `0.0.3`) |
| `~1.2.3`       | `>=1.2.3, <1.3.0`                                    |
| `=1.2.3`       | exactly `1.2.3`                                      |
| `>=1.2, <2`    | comparators joined by `,` (all must hold)            |
| `1.*`, `1.2.*`, `*` | the major / minor series, anything                 |

Pre-release tags (`v1.0.0-rc.1`) are versions, but a range only accepts a pre-release when it names one of the same `major.minor.patch` (`^1.0.0-rc.1` accepts `v1.0.0-rc.2` and `v1.0.0`; `^1.0.0` never accepts `v1.5.0-beta.1`).

### Adding a dependency: `yo add`

```bash
yo add shd101wyy/raylib_yo        # latest release tag, written as version = "^X.Y.Z"
yo add user/json-yo@^1.2          # a range
yo add user/json-yo@v1.2.0        # an exact tag
yo add github.com/user/repo       # explicit host; https://… and git@host:path work too
yo add user/mono --path packages/utils --name utils   # a package inside a repository
yo add user/tool --branch main    # follow a branch
yo add user/tool --rev 0123abcd   # pin a commit
yo add ./libs/mylib               # a local path dependency
yo add user/snapshot-yo --dev     # into [dev-dependencies]
```

`yo add` edits `yo.toml` in place (comments and formatting are preserved), then resolves and fetches every git dependency and writes `yo.lock`. Without an `@…` the latest release tag is looked up with `git ls-remote --tags` and written as a caret range; a repository without release tags is pinned to its default branch by name. The import name defaults to the repository (or directory) name — override it with `--name`.

`yo remove <name>` deletes the entry and prunes `yo.lock`.

### Installing and updating: `yo install`, `yo update`

```bash
yo install            # fetch what yo.toml declares, write yo.lock
yo update             # re-resolve every dependency within its range / to its branch tip
yo update raylib_yo   # just one
```

`yo install` decides each git dependency's ref (a range → the highest satisfying tag, a `tag`/`rev` → itself, a `branch` or bare `git` → the tip commit), clones what the cache lacks, and records the result in `yo.lock`. A lock entry that still satisfies its requirement is reused without touching the network, so `yo install` is what a fresh checkout runs to get exactly the recorded commits; `yo update` is what moves them. `yo build` runs the same step automatically for dependencies the cache lacks.

`yo.lock` records, per git dependency, the URL, the resolved ref, the commit and a content hash of the fetched tree — commit it to version control. Entries for dependencies no longer in `yo.toml` are pruned on the next `yo install`.

### Path Dependencies (Local)

```toml
[dependencies]
mylib = { path = "../mylib" }
```

The path is relative to `yo.toml`. Nothing is fetched and nothing is locked: the sources are read from where they are, so edits in `../mylib` are picked up by the next build. `yo add ./relative/path` writes the entry relative to `yo.toml` however you typed it.

### Importing a dependency

```rust
mylib :: import "mylib";             // the dependency's default module
{ triple } :: import "mylib/extra";  // a named module, or a sibling file of the default root
```

What `import("name")` resolves to, for a dependency `name`:

1. its `yo.toml` `[modules] default`, if the dependency has a manifest that declares one;
2. otherwise `src/lib.yo`, then `index.yo`, then `<name>.yo` in its directory.

`import("name/sub")` is the dependency's `[modules] sub` when declared, else `sub.yo` beside the default root. A dependency without a `yo.toml` is fine — the conventional roots apply and it has no dependencies of its own.

The resolution is manifest-driven in **every** command: the compiler finds the nearest `yo.toml` at or above the file it is compiling, reads the closure — the project's own `[modules]`, each dependency's modules under its name, and transitively each dependency's own dependencies under **their** names — and maps the names before any `import` is evaluated. So `yo check src/main.yo`, `yo test ./tests`, `yo doc` and the LSP all see the same imports `yo build` does. One flat namespace per project: the same import name reaching two different files is an error naming both. A dependency that is declared but not fetched yet fails with `import("x"): git dependency "x" is not installed — run \`yo install\``, not with "module not found".

Under `yo build` the runner writes the same mapping to `yo-out/<target>/<kind>/<artifact>.imports` and passes it to the child compile as `--imports <file>` (the flag is usable by hand: one `name=/abs/root.yo` per line).

### Transitive Dependencies

Each dependency's own `yo.toml` is read in turn, so its dependencies are importable — under their names — by its modules, and the closure is fetched as one set; a dependency's git dependencies are recorded in the root project's `yo.lock`. A dependency's `[dev-dependencies]` are its own business and are not resolved. Two packages naming the same dependency at the same path or commit share one entry; the same name at two different roots is an error (`import name "x" reaches two different modules: … and …`). Version unification across the graph (Cargo's one-version-per-compatible-range rule) is the next cut of the plan; today each declared range is resolved for the package that declares it.

### Dependency artifacts and `build.dependency`

`build.dependency("name")` returns the handle of a dependency declared in `yo.toml` — the name must be one the manifest declares, or the build fails. Its `.module("x")` names one of the dependency's modules (to propagate the system libraries it links) and `.artifact("lib")` names a static library the dependency's `build.yo` defines:

```rust
build :: import "std/build";

dep :: build.dependency("dep_lib");
add_lib :: dep.artifact("add");   // a build.static_library of dep_lib's build.yo

exe :: build.executable({ name: "demo", root: "./src/main.yo" });
exe.link(add_lib);
```

Compiling a dependency's artifacts and linking them into the consumer (plans/BUILD_AND_DEPENDENCY_SYSTEM_REDESIGN.md §4.5.2–§4.5.3) is not implemented yet: today `dep.artifact` records the reference and `Step.link` links the libraries of the project's own `build.yo`. Import a dependency's Yo code by name instead.

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

Every fetched dependency has a **content hash** recorded in `yo.lock`:

```toml
[[dependencies]]
name   = "json-parser"
url    = "https://github.com/user/json-parser.git"
ref    = "v1.0.0"
commit = "abc123..."
hash   = "sha256-7c19c1..."
```

1. **At fetch time** — `yo install` clones the dependency at the resolved commit, walks the extracted file tree, and computes a SHA-256 hash of all file names and contents. The hash is written to `yo.lock` and to a `.yo-content-hash` sidecar file inside the cached directory.

2. **At install time** — a dependency whose lock entry still satisfies its requirement is verified against the sidecar (O(1)); on a match nothing is fetched. A missing sidecar triggers a full re-hash; a mismatch (tampered or corrupted files) deletes the cache entry and re-clones it.

**Cross-platform stability:** the hash normalizes `\r\n` → `\n`, so the same dependency hashes identically on Windows and Linux, and file names are sorted with locale-independent ordering. This follows Zig's model of hashing the extracted content rather than archive bytes.

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

## `yo add` Reference

```
yo add <spec> [options]

Specs:
  user/repo                  GitHub shorthand
  user/repo@^1.2             Semver range (^, ~, =, >=, <, *, or a bare version)
  user/repo@v1.2.0           Exact tag
  github.com/user/repo, https://…, git@host:path
  ./path/to/dep              Local path dependency

Options:
  --dev                      Add to [dev-dependencies]
  --path <subdir>            The package's directory inside the repository
  --name <name>              Import name (default: the repository name)
  --branch <branch>          Follow a branch (pinned to a commit in yo.lock)
  --rev <sha>                Pin a commit
  -v, --verbose              Show detailed progress
```

Edits `yo.toml` in place, then runs `yo install`. Requires a `yo.toml` in the current directory or above it (`yo init` creates one).

## `yo remove` Reference

```
yo remove <name> [--verbose]
```

Deletes the dependency from `yo.toml` (from `[dependencies]` or `[dev-dependencies]`) and prunes its `yo.lock` entry.

## `yo install` Reference

```
yo install [--verbose]
```

Resolves every git dependency `yo.toml` declares to a commit (reusing `yo.lock` entries that still satisfy their requirement), fetches what the global cache lacks, verifies content hashes, prunes stale entries and writes `yo.lock`. No network access is needed when the lock is complete and the cache is intact.

## `yo update` Reference

```
yo update [name...] [--verbose]
```

Re-resolves the named dependencies (all when none are given): the highest tag a `version` range allows, the tip of a `branch`, the remote's default branch for a bare `git` entry. Rewrites `yo.lock`.

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
