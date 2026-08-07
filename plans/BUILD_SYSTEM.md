# Yo Build System Design

## Problem Statement

The Yo compiler currently has no project-level build system. Each compilation is a standalone `yo compile <file>` invocation with all flags passed manually. This makes it difficult to:

- Reproduce builds with consistent settings across machines
- Handle multi-file projects with shared configuration
- Cross-compile for different architectures
- Manage dependencies (C libraries, Yo packages)
- Provide a standardized project layout

Additionally, several parts of the compiler conflate **host** and **target** platform:

- `getSizeOfType` defaults to 64-bit with `setTargetPointerSize()` never called
- `__yo_process_platform()` and `__yo_process_arch()` return the Node.js host values, not the target
- `process.platform` is used in `src/codegen/index.ts` to decide which system libraries to link — this should be based on target, not host

## Design Goals

1. **Declarative build configuration** via `build.yo` — inspired by Zig's `build.zig` and Nix's declarative model
2. **`yo build`** command that reads `build.yo` and orchestrates compilation
3. **`yo init`** command to scaffold new projects
4. **Target-aware compilation** — distinguish host from target, support cross-compilation
5. **Clang as primary compiler** — leverage clang's cross-compilation and target triple support
6. **Architecture-aware type sizing** — `getSizeOfType` uses target arch, not hardcoded 64-bit

## Non-Goals (for now)

- Package manager / dependency resolution (future work)
- Caching / incremental builds (future work)
- Remote build execution
- Build system self-hosting (build.yo is evaluated by the TypeScript compiler, not a compiled Yo binary)

---

## 1. Target System

### 1.1 Target Triple

Adopt the standard `<arch>-<os>-<abi>` triple format (subset of LLVM/clang triples):

```
x86_64-linux-gnu
x86_64-linux-musl
aarch64-linux-gnu
aarch64-linux-musl
x86_64-macos-none
aarch64-macos-none
x86_64-windows-msvc
aarch64-windows-msvc
x86_64-windows-gnu       (MinGW)
wasm32-emscripten        (WebAssembly, Emscripten)
wasm32-wasi              (WebAssembly, standalone WASI)
```

> **Note:** Only native targets and WASM are supported. Cross-compilation to a
> different architecture or OS is not supported — the target must match the host
> machine's architecture and OS. musl targets are only supported on native musl
> systems (e.g. Alpine Linux); liburing works normally on such systems.

### 1.2 Supported Architectures

| Arch      | Pointer Size | Notes                        |
| --------- | ------------ | ---------------------------- |
| `x86_64`  | 64-bit       | Primary tier                 |
| `aarch64` | 64-bit       | Primary tier (Apple Silicon) |
| `x86`     | 32-bit       | Secondary tier               |
| `arm`     | 32-bit       | Secondary tier               |
| `wasm32`  | 32-bit       | Supported (WASM/WASI)        |

### 1.3 Supported Operating Systems

| OS        | Async I/O Backend  | Notes                  |
| --------- | ------------------ | ---------------------- |
| `linux`   | io_uring           | Primary tier           |
| `macos`   | kqueue             | Primary tier           |
| `windows` | IOCP               | Primary tier           |
| `wasi`    | N/A (no async I/O) | WASM target            |
| `freebsd` | kqueue             | Tertiary tier (future) |

### 1.4 ABI

| ABI    | Notes                                  |
| ------ | -------------------------------------- |
| `gnu`  | glibc (Linux default)                  |
| `musl` | musl libc (native musl systems)        |
| `msvc` | Windows MSVC CRT                       |
| `wasm` | WebAssembly (WASI default)             |
| `none` | macOS (no ABI suffix needed for clang) |

### 1.5 Target Type in Yo

Define a `Target` type used in `build.yo`:

```rust
Target :: struct(
  arch : Arch,
  os : Os,
  abi : ?(Abi)
);

Arch :: enum(X86_64, Aarch64, X86, Arm, Wasm32);
Os :: enum(Linux, Macos, Windows, FreeBSD, Wasi);
Abi :: enum(Gnu, Musl, Msvc, Wasm, None);
```

A builtin `target.host()` returns the host machine's target. This replaces the current `__yo_process_platform()` / `__yo_process_arch()` for build-time detection.

---

## 2. `build.yo` — Declarative Build Configuration

### 2.1 Design Philosophy

- **Declarative, not imperative**: `build.yo` describes _what_ to build, not _how_. No control flow, no side effects — just data declarations. Inspired by Nix derivations.
- **Evaluated at compile time**: The Yo evaluator processes `build.yo` at comptime, extracting structured data. No C codegen is needed for the build file itself.
- **Single source of truth**: All build configuration lives in `build.yo`. No separate config files.

### 2.2 Example `build.yo`

```rust
build :: import "std/build";

build.module({ name: "my-app", root: "./src/lib.yo" });

exe :: build.executable({
  name: "my-app",
  root: "./src/main.yo",
  optimize: build.Optimize.ReleaseFast
});

lib :: build.static_library({ name: "my-app-lib", root: "./src/lib.yo" });

tests :: build.test({ name: "tests", root: "./tests/" });

// build.run creates a run step for an artifact step
run_app :: build.run(exe);

// Named steps with dependencies
install :: build.step("install", "Build all artifacts");
install.depend_on(exe);
install.depend_on(lib);

run_step :: build.step("run", "Run the application");
run_step.depend_on(run_app);

test_step :: build.step("test", "Run unit tests");
test_step.depend_on(tests);
```

Usage:

```bash
yo build              # Default step — install artifacts to yo-out/
yo build run          # Compile and run the app
yo build test         # Run the test suite
yo build --list-steps # List available steps
```

`--list-steps` output:

```
Available steps:
  install (default)    Install build artifacts
  run                  Run the application
  test                 Run unit tests
```

### 2.2.1 Implementation Details

All build functions are **evaluator builtins** (`src/evaluator/builtins/build.ts`):

- Build functions return `Step` — each step has a `name` and `kind` (from `StepKind` enum)
- Dependencies are resolved by **Step values**, not by string names
- Run steps have `StepKind.Run` — no synthetic `"run:<artifact-name>"` naming needed
- `std/build.yo` wrapper functions use `comptime()` parameter annotations
- Config struct types (`Executable`, `StaticLibrary`, `TestSuite`) use `?=` defaults for optional fields
- Wrapper functions decompose structs and pass individual fields to builtins
- During trial evaluation (function definition type-check), builtins skip registration

The build runner (`src/build-runner.ts`) flow:

1. Clear BuildRegistry → evaluate build.yo via ModuleManager → reset evaluator state
2. Read registry for steps, artifacts, tests, run steps
3. Resolve step dependencies by name → compile artifacts → run tests → run executables

### 2.3 Multi-Target Example

```rust
build :: import "std/build";

build.module({ name: "my-app", root: "./src/lib.yo" });

linux :: build.executable({
  name: "my-app-linux",
  root: "./src/main.yo",
  target: "x86_64-linux-gnu",
  optimize: build.Optimize.ReleaseFast
});

macos :: build.executable({
  name: "my-app-macos",
  root: "./src/main.yo",
  target: "aarch64-macos",
  optimize: build.Optimize.ReleaseFast
});

wasm :: build.executable({
  name: "my-app-wasm",
  root: "./src/main.yo",
  target: "wasm32-emscripten",
  optimize: build.Optimize.ReleaseSmall
});

install :: build.step("install", "Install all targets");
install.depend_on(linux);
install.depend_on(macos);
install.depend_on(wasm);
```

### 2.4 Library Example

```rust
build :: import "std/build";

build.module({ name: "my-lib", root: "./src/lib.yo" });

lib :: build.static_library({ name: "mylib", root: "./src/lib.yo" });

lib_tests :: build.test({ name: "lib-tests", root: "./tests/" });

install :: build.step("install", "Install library");
install.depend_on(lib);

test_step :: build.step("test", "Run library tests");
test_step.depend_on(lib_tests);
```

### 2.4.1 Cross-Module Linking

Yo supports cross-module linking via `extern "Yo"` declarations and static libraries. When a module is compiled as a static library, its exported functions receive plain C names (not hash-mangled) so other modules can reference them.

**Library module** (`add.yo`) exports a function:

```rust
add :: (fn(a: i32, b: i32) -> i32)((a + b));
export add;
```

**Executable module** (`demo.yo`) declares it with `extern "Yo"` and calls it:

```rust
extern "Yo",
  add : (fn(a: i32, b: i32) -> i32);

main :: (fn() -> unit)({
  result := add(i32(3), i32(4));
});
export main;
```

**Build file** (`build.yo`) links them together:

```rust
build :: import "std/build";
build.module({ name: "demo", root: "./src/lib.yo" });

lib :: build.static_library({ name: "add", root: "./add.yo" });
exe :: build.executable({ name: "demo", root: "./demo.yo" });
exe.link(lib);

install :: build.step("install", "Build all artifacts");
install.depend_on(exe);
install.depend_on(lib);
```

**Implementation details:**

- In library mode (`--static-library`), exported functions use plain names (e.g., `add` → C symbol `add`)
- All non-exported functions are made `static` in the generated C to prevent duplicate symbol errors when linking
- The build runner compiles linked libraries first, then passes `.a` files as extern sources
- Global evaluator state is reset between artifact compilations to prevent impl conflicts

### 2.5 `build` Module API (`std/build.yo`)

The build module is imported as a namespace and provides compile-time functions backed by evaluator builtins.

**Constants:**

```rust
Optimize :: enum(Debug, ReleaseSafe, ReleaseFast, ReleaseSmall)
Allocator :: enum(Mimalloc, Libc)
Sanitize :: enum(None, Address, Leak)
StepKind :: enum(Executable, StaticLibrary, SharedLibrary, SystemLibrary, TestSuite, Run, Custom)
target_host :: comptime_string  // Host target triple
```

**Config Struct Types (with `?=` defaults):**

```rust
// Executable artifact config
Executable :: struct(
  name : comptime_string,
  root : comptime_string,
  (target : comptime_string) ?= target_host,
  (optimize : Optimize) ?= Optimize.Debug,
  (allocator : Allocator) ?= Allocator.Mimalloc,
  (sanitize : Sanitize) ?= Sanitize.None
);

// Static library artifact config
StaticLibrary :: struct(
  name : comptime_string,
  root : comptime_string,
  (target : comptime_string) ?= target_host,
  (optimize : Optimize) ?= Optimize.Debug
);

// Shared/dynamic library artifact config
SharedLibrary :: struct(
  name : comptime_string,
  root : comptime_string,
  (target : comptime_string) ?= target_host,
  (optimize : Optimize) ?= Optimize.Debug
);

// Test suite config
TestSuite :: struct(
  name : comptime_string,
  root : comptime_string,
  (target : comptime_string) ?= target_host
);
```

**Functions (all return `Step`):**

```rust
// Project metadata (returns unit — the only exception)
project(config: Project)

// Register an executable artifact (accepts Executable config struct)
executable(config: Executable) -> Step  // kind: StepKind.Executable

// Register a static library artifact (accepts StaticLibrary config struct)
static_library(config: StaticLibrary) -> Step  // kind: StepKind.StaticLibrary

// Register a shared/dynamic library artifact (accepts SharedLibrary config struct)
shared_library(config: SharedLibrary) -> Step  // kind: StepKind.SharedLibrary

// Register a system C library via pkg-config (accepts SystemLibrary config struct)
system_library(config: SystemLibrary) -> Step  // kind: StepKind.SystemLibrary

// Register a test suite (accepts TestSuite config struct)
test(config: TestSuite) -> Step  // kind: StepKind.TestSuite

// Register a run step for an artifact (by name)
run(artifact_name: comptime_string) -> Step  // kind: StepKind.Run

// Named build step (use step.depend_on() to add dependencies)
step(name: comptime_string, description: comptime_string) -> Step  // kind: StepKind.Custom

// Step methods:
// step.depend_on(other_step) -> unit                       — add dependency
// step.link(library_step) -> unit                          — link library to artifact
// step.add_import(entry: ImportEntry) -> unit              — import one dependency module into an artifact
// step.add_import_list(entries: ComptimeList(ImportEntry)) -> unit
//   bulk import dependency modules into an artifact
```

**Step struct:**

```rust
Step :: struct(
  name : comptime_string,
  kind : StepKind
);
```

**Import helpers:**

```rust
ImportEntry :: struct(
  name : comptime_string,
  module : BuildModule
);
```

`step.add_import()` registers a single dependency module import on an artifact step. `step.add_import_list()` accepts a `ComptimeList(ImportEntry)` and applies the same registration to every entry in the list, which is useful when a dependency exposes multiple modules that should all be imported into the generated build artifact.

`step.add_c_flags(flags)` appends custom C compiler/linker flags (a space-separated `comptime_string`) to the artifact's flag list. These are passed directly to the C compiler command. Useful for Emscripten-specific settings like `-sASYNCIFY -sUSE_GLFW=3` or any target-specific flags.

Internally, wrapper functions decompose the config struct and pass individual fields to the evaluator builtins (e.g., `__yo_build_executable(config.name, config.root, ...)`). This keeps the builtin implementation simple while providing a clean struct-based API to users.

### 2.6 User-Provided Build Options

Like Zig's `b.option()`, `build.yo` can declare user-configurable options via `yo build -D<name>=<value>`:

```rust
// In build.yo:
strip :: build.option({
  name: "strip",
  description: "Strip debug symbols",
  default: "false"
});
```

The `option()` function returns a `comptime_string` value. At evaluation time, if the CLI provides `-Dstrip=true`, the function returns `"true"`; otherwise it returns the default `"false"`.

**Config type:**

```rust
BuildOption :: struct(
  name : comptime_string,
  description : comptime_string,
  (default : comptime_string) ?= ""
);
```

**CLI usage:**

```bash
yo build -Dstrip=true -Dopt=release-fast
yo build -Dstrip          # shorthand for -Dstrip=true
```

### 2.6.1 System Library Linking

Register system libraries via `build.system_library()` and link them using the `step.link()` method:

```rust
// Register system libraries (returns Step)
openssl :: build.system_library({
  name: "openssl"
});

exe :: build.executable({ name: "my-app", root: "./src/main.yo" });

// Link using Step method
exe.link(openssl);
```

`step.link()` automatically detects the library type from the registry: system libraries get `pkg-config` flags, Yo libraries get compiled first and linked.

### 2.7 Evaluation Model

`build.yo` is evaluated purely at compile time by the existing Yo evaluator:

1. `yo build` clears the global `BuildRegistry` singleton
2. `ModuleManager` loads and evaluates `build.yo` — build functions (builtins) populate the registry
3. `ModuleManager.resetAllState()` cleans up evaluator globals (prevents stale prelude state)
4. The build runner reads `BuildRegistry` for project config, artifacts, tests, run steps, named steps
5. Step dependencies are resolved by Step values and executed in order
6. No C code is generated for `build.yo` itself — it's purely a configuration file

Key implementation details:

- Builtins detect trial evaluation (CTFE check) via `isTrialEvaluation()` and skip registration
- Args are pre-evaluated in `_expr.ts` dispatch before passing to builtin handlers
- `target_host` builtin always returns a value (used as default in struct field definitions)
- Config struct types use `?=` defaults; wrapper functions decompose struct → individual builtin args

---

## 3. `yo build` Command

### 3.1 Usage

```
yo build [steps] [options]

Arguments:
  steps                  Named steps to run (default: install all artifacts)
                         Common steps: run, test, or custom steps from build.yo

Options:
  --build-file <path>    Path to build file (default: ./build.yo)
  --target <triple>      Override target for all artifacts
  --cc <compiler>        C compiler to use (clang, gcc, zig, cc, cl)
  --optimize <level>     Override optimization level
  -D<name>=<value>       Set a user-defined build option (from build.yo)
  --verbose, -v          Verbose build output
  --emit-c               Emit C code without compiling
  --dry-run              Show what would be built without building
  --list-steps, -l       List available build steps
  --help                 Show help including project-specific -D options
```

### 3.2 Build Process

```
yo build
  │
  ├─ 1. Find build.yo (cwd or --build-file)
  ├─ 2. Evaluate build.yo at compile time
  │     ├─ Parse → AST → Evaluate
  │     └─ Extract: Project, Artifact[], TestSuite[]
  ├─ 3. Resolve targets
  │     ├─ host detection (replaces process.platform/arch)
  │     └─ target triple → { arch, os, abi }
  ├─ 4. For each Artifact:
  │     ├─ Set target pointer size (32 or 64 bit)
  │     ├─ Set target platform/arch for __yo_process_*
  │     ├─ Run Yo compilation pipeline
  │     │   ├─ Lex → Parse → Evaluate → Codegen (C)
  │     │   └─ Platform-conditional C code uses target, not host
  │     ├─ Invoke C compiler with target-specific flags
  │     │   ├─ clang --target=<triple> (cross-compile)
  │     │   └─ Platform-specific linker flags
  │     └─ Output to ./yo-out/bin/<name> (or ./yo-out/lib/)
  └─ 5. Report results
```

### 3.3 Output Directory

Following Zig's convention:

```
project/
├── build.yo
├── src/
│   └── main.yo
├── tests/
│   └── main.test.yo
├── yo-out/          ← build output (gitignored)
│   ├── bin/
│   │   └── my-app
│   └── lib/
│       └── libmylib.a
└── .yo-cache/       ← intermediate files (gitignored)
    └── ...
```

---

## 4. `yo init` Command

### 4.1 Usage

```
yo init [dir] [options]

Arguments:
  dir                    Directory to initialize (default: current directory)

Options:
  --name <name>          Project name (default: directory name)
```

### 4.2 Generated Files

All projects get both `src/main.yo` (executable) and `src/lib.yo` (library). The user chooses what to build via `build.yo` steps.

```
my-project/
├── build.yo
├── src/
│   ├── main.yo
│   └── lib.yo
├── tests/
│   └── main.test.yo
├── .gitignore
└── README.md
```

**`build.yo`:**

```rust
build :: import "std/build";

build.module({ name: "my-project", root: "./src/lib.yo" });

exe :: build.executable({ name: "my-project", root: "./src/main.yo" });

lib :: build.static_library({ name: "my-project-lib", root: "./src/lib.yo" });

tests :: build.test({ name: "tests", root: "./tests/" });

run_app :: build.run(exe);

install :: build.step("install", "Build all artifacts");
install.depend_on(exe);
install.depend_on(lib);

run_step :: build.step("run", "Run the application");
run_step.depend_on(run_app);

test_step :: build.step("test", "Run unit tests");
test_step.depend_on(tests);
```

**`src/main.yo`:**

```rust
{ println } :: import "std/fmt";

main :: (fn()-> unit) {
  println("Hello, world!");
};

export(main);
```

**`src/lib.yo`:**

```rust
add :: (fn(a: i32, b: i32) -> i32)(
  (a + b)
);
export(add);
```

**`tests/main.test.yo`:**

```rust
{ test } :: import "std/testing";

test("it works", {
  assert((1 + 1) == 2, "math is broken");
});
```

**`.gitignore`:**

```
yo-out/
.yo-cache/
*.o
a.out
```

---

## 5. Platform/Architecture Refactoring

### 5.1 Separating Host vs Target

The fundamental change: distinguish **host** (machine running the compiler) from **target** (machine the output binary will run on).

| Concept                   | Current                      | Proposed                                       |
| ------------------------- | ---------------------------- | ---------------------------------------------- |
| Host platform             | `process.platform` (Node.js) | `HostInfo.platform` (detected once at startup) |
| Host arch                 | `process.arch` (Node.js)     | `HostInfo.arch` (detected once at startup)     |
| Target platform           | Same as host (bug)           | `TargetInfo.os` (from build.yo or CLI)         |
| Target arch               | Same as host (bug)           | `TargetInfo.arch` (from build.yo or CLI)       |
| Pointer size              | Hardcoded 64-bit             | Derived from `TargetInfo.arch`                 |
| `__yo_process_platform()` | Returns host                 | Returns **target** platform                    |
| `__yo_process_arch()`     | Returns host                 | Returns **target** arch                        |

### 5.2 New TypeScript Types

```typescript
// src/target.ts (new file)

interface HostInfo {
  platform: "linux" | "macos" | "windows";
  arch: "x86_64" | "aarch64" | "x86" | "arm";
}

interface TargetInfo {
  arch: "x86_64" | "aarch64" | "x86" | "arm" | "wasm32";
  os: "linux" | "macos" | "windows" | "freebsd" | "wasi";
  abi: "gnu" | "musl" | "msvc" | "wasm" | "none" | undefined;
  pointerSizeBits: 32 | 64;
  triple: string; // e.g. "x86_64-linux-gnu"
}

function detectHost(): HostInfo;
function parseTarget(triple: string): TargetInfo;
function hostTarget(): TargetInfo; // host as target
function pointerSizeForArch(arch: string): 32 | 64;
function clangTriple(target: TargetInfo): string; // for --target=
```

### 5.3 Updating `__yo_process_platform()` / `__yo_process_arch()`

Currently:

```typescript
const platform = process.platform; // Node.js host
const arch = process.arch; // Node.js host
```

Proposed:

```typescript
// The evaluator receives target info from the build context
const platform = context.target.os; // Target OS
const arch = context.target.arch; // Target arch
```

The Yo-side naming also changes to avoid Node.js conventions:

| Current (Node.js style) | Proposed    |
| ----------------------- | ----------- |
| `"darwin"`              | `"macos"`   |
| `"win32"`               | `"windows"` |
| `"x64"`                 | `"x86_64"`  |
| `"ia32"`                | `"x86"`     |
| `"arm64"`               | `"aarch64"` |

### 5.4 Updating `std/process.yo`

```rust
// Current (Node.js naming)
Platform :: {
  Darwin : "darwin",
  Win32 : "win32",
  // ...
};
Arch :: {
  X64 : "x64",
  Arm64 : "arm64",
  Ia32 : "ia32",
  // ...
};

// Proposed (standard naming) — ✅ IMPLEMENTED
Platform :: enum(
  Linux : "linux",
  Macos : "macos",
  Windows : "windows",
  FreeBSD : "freebsd",
  Wasi : "wasi"
);

Arch :: enum(
  X86_64 : "x86_64",
  Aarch64 : "aarch64",
  X86 : "x86",
  Arm : "arm",
  Wasm32 : "wasm32"
);
```

### 5.5 Updating `getSizeOfType`

Currently, `setTargetPointerSize()` is never called. The fix:

```typescript
// In the build/compile pipeline, before evaluation:
function initializeTarget(target: TargetInfo): void {
  setTargetPointerSize(target.pointerSizeBits);
  // Set other target-dependent globals...
}
```

This is called:

- In `yo compile`: from CLI `--target` flag (default: host)
- In `yo build`: from each artifact's target in `build.yo`

### 5.6 Updating C Codegen: Target-Based Decisions

Replace all `process.platform` checks in `src/codegen/index.ts` with target-based checks:

```typescript
// BEFORE (host-based, wrong for cross-compilation):
if (process.platform === "win32" && !libraries.includes("ws2_32")) {
  libraries.push("ws2_32");
}
if (process.platform === "linux" && !isMSVC) {
  compileArgs.push("-luring");
}

// AFTER (target-based, correct for cross-compilation):
if (target.os === "windows" && !libraries.includes("ws2_32")) {
  libraries.push("ws2_32");
}
if (target.os === "linux" && !isMSVC) {
  compileArgs.push("-luring");
}
```

---

## 6. Clang as Primary Compiler

### 6.1 Why Clang

- **Cross-compilation**: `clang --target=aarch64-linux-gnu` works out of the box
- **Consistent behavior**: Same frontend across all platforms
- **Sanitizer support**: ASan, LSan, UBSan on all major platforms
- **C11 compliance**: Strict standard mode
- **Wide availability**: Ships with Xcode, most Linux distros, LLVM releases

### 6.2 Compiler Priority

```
1. clang (preferred — cross-compilation, consistent behavior)
2. cc    (system default, often symlinks to clang or gcc)
3. gcc   (fallback)
4. zig cc (alternative cross-compiler)
5. cl    (Windows MSVC only)
```

Update `findAvailableCompiler()`:

```typescript
export function findAvailableCompiler(): string | null {
  const compilers = ["clang", "cc", "gcc", "zig", "cl"];
  // ... (clang first, not cc)
}
```

### 6.3 Cross-Compilation with Clang

When target ≠ host:

```bash
# Native compilation (target == host)
clang -std=c11 -O2 -o my-app a.out.c

# Cross-compilation (target != host)
clang -std=c11 -O2 --target=aarch64-linux-gnu --sysroot=/path/to/sysroot -o my-app a.out.c
```

The build system detects when cross-compiling and adds `--target=` automatically:

```typescript
if (target.triple !== hostTarget().triple) {
  compileArgs.push(`--target=${clangTriple(target)}`);
  if (options.sysroot) {
    compileArgs.push(`--sysroot=${options.sysroot}`);
  }
}
```

### 6.4 Optimization Levels

Map `build.yo` optimization enum to clang flags:

| Build Optimize  | Clang Flags | Description                    |
| --------------- | ----------- | ------------------------------ |
| `.Debug`        | `-O0 -g`    | No optimization, debug symbols |
| `.ReleaseSafe`  | `-O2 -g`    | Optimized with debug symbols   |
| `.ReleaseFast`  | `-O3`       | Maximum performance            |
| `.ReleaseSmall` | `-Os`       | Optimize for binary size       |

---

## 7. `yo compile` Updates

The existing `yo compile` command gains a `--target` flag:

```bash
# Current behavior (host-only)
yo compile src/main.yo --release -o app

# New: explicit target
yo compile src/main.yo --target x86_64-linux-gnu --release -o app

# New: default is host (same as current behavior)
yo compile src/main.yo -o app   # uses host target
```

This ensures `yo compile` remains useful for quick one-off compilations while `yo build` handles project-level builds.

### 7.1 Updated `yo compile` Options

```
yo compile <file> [options]

New options:
  --target <triple>      Target triple (default: host)
  --sysroot <path>       Sysroot for cross-compilation

Existing options (unchanged):
  -o, --output           Output file
  -cc, --c-compiler      C compiler to use
  --release              Release build (-O2)
  --optimize <level>     Optimization level (0-3, s)
  --allocator            Memory allocator (mimalloc, libc)
  --sanitize             Sanitizer (address, leak)
  --emit-c               Emit C only
  --skip-c-compiler      Skip C compilation
  -l, -L, -I, -D, etc.  Linker/compiler flags
```

---

## 8. Migration Strategy

### Phase 1: Target Infrastructure (Foundation) ✅

1. ✅ Create `src/target.ts` with `HostInfo`, `TargetInfo`, `detectHost()`, `parseTarget()`, `hostTarget()`
2. ✅ Wire `setTargetPointerSize()` to be called from target info before evaluation
3. ✅ Add `--target` flag to `yo compile`
4. ✅ Update `findAvailableCompiler()` to prefer clang

### Phase 2: Host/Target Separation ✅

5. ✅ Update `__yo_process_platform()` / `__yo_process_arch()` to use target info from evaluator context
6. ✅ Replace all `process.platform` / `process.arch` usages in codegen with target-based checks
7. ✅ Update `std/process.yo` platform/arch enums to use standard naming
8. ✅ Update `std/path.yo` to use new platform names

### Phase 3: Build System Core ✅

9. ✅ Implement `yo init` command (project scaffolding — exe and lib templates)
10. ✅ Create `std/build.yo` module with evaluator builtins (`src/evaluator/builtins/build.ts`)
11. ✅ Implement `yo build` command (build.yo evaluation via ModuleManager + BuildRegistry)
12. ✅ Implement build output directory structure (`yo-out/bin/`, `yo-out/lib/`)
13. ✅ Step resolution with Step-value-based dependency system
14. ✅ `yo build`, `yo build run`, `yo build test`, `yo build --list-steps`

### Phase 4: Cross-Compilation & WASM ✅

15. ✅ Add `--target=<triple>` passthrough to clang in codegen
16. ✅ WASM/WASI target support (`wasm32-emscripten` + `wasm32-wasi` triples, 32-bit pointer, skip platform libs/mimalloc/liburing)
17. ✅ `--cc` flag on `yo build` for compiler override (e.g., `yo build --cc zig`)
18. ✅ Platform-specific library linking based on target (not host)
19. Add `--sysroot` support (future)
20. Test cross-compilation: macOS → Linux, Linux → macOS, etc. (future)

### Phase 5: Struct-Based API & Unified Init ✅

21. ✅ Config struct types (`Executable`, `StaticLibrary`, `TestSuite`) with `?=` defaults
22. ✅ Wrapper functions decompose structs → pass individual fields to builtins
23. ✅ Unified `yo init` — generates both `src/main.yo` and `src/lib.yo` (no `--lib` flag)
24. ✅ `std/process.yo` updated with `Wasi` platform

### Phase 6: Dependencies & Ecosystem (Future)

25. ~~Git-hosted dependency support~~ ✅ Implemented
26. ~~`pkg-config` integration for C library discovery~~ ✅ Implemented
27. Caching / incremental builds
28. Build self-hosting

### Phase 7: Local Path Dependencies ✅

29. `PathDependency` struct and `build.path_dependency()` function in `std/build.yo`
30. `__yo_build_path_dependency` builtin handler
31. Import resolution for path dependencies (resolve by name → local path → entry point)
32. `Project.root` field for explicit library entry point
33. Convention-based entry point resolution: `src/lib.yo` → `index.yo` → `<name>.yo`

### Phase 8: Dependency Build Artifacts (Zig-style) ✅

34. `Dependency` struct with `artifact` method in `std/build.yo`
35. `dependency()` and `path_dependency()` now return `Dependency` (was `unit`)
36. `__yo_build_dep_artifact` builtin — registers `DependencyArtifactRef` in registry
37. Build runner: `resolveDependencyArtifacts()` evaluates dependency `build.yo` files
38. Registry swap via `swapBuildRegistry()` for isolated dependency evaluation
39. Dependency artifacts compiled to `yo-out/deps/<dep>/lib/`
40. End-to-end test: path dep with static library → consumer links and calls

### Phase 9: Declarative Dependency File (`deps.yo`) ✅

41. `deps.yo` generated by `yo init` alongside `build.yo`
42. `yo install` writes to `deps.yo` instead of `build.yo`
43. Auto-generated `imports :: ComptimeList(build.ImportEntry)(...)` exported from `deps.yo`
44. `build.yo` imports `deps.yo` and uses `exe.add_import_list(imports)`
45. `deps.yo` created from template if missing during `yo install`
46. Duplicate dependency detection in `deps.yo`
47. Backward compatible — inline `build.dependency()` in `build.yo` still works

---

## 9. Open Questions (Resolved & Remaining)

### Resolved

1. **Conditional logic in `build.yo`?** ✅ YES — the evaluator supports `cond()` at comptime, so `build.yo` can use conditional logic for platform-specific configurations.

2. **Package management / dependencies?** ✅ YES — will support git-hosted dependencies (e.g., GitHub repos). Syntax design TBD.

3. **C library discovery via `pkg-config`?** ✅ YES — will support `pkg-config` integration, including Windows support.

4. **Zig CC as alternative cross-compiler?** ✅ YES — `yo build --cc zig` is implemented. Zig bundles cross-compilation sysroots.

### Remaining

5. **Build.yo for the Yo compiler itself**: Should the Yo standard library and compiler have their own `build.yo`? This is a self-hosting question — deferred.

6. **Multiple artifacts sharing config**: Should there be a way to define shared configuration (e.g., common flags) applied to multiple artifacts? Deferred.

7. **Dependency syntax**: ✅ Resolved — `build.dependency({ name: "...", url: "...", ref: "..." })` returns a `Dependency` handle. `dep.artifact("name")` accesses artifacts from the dependency's `build.yo`.

---

## 10. File Changes Summary

### New Files

| File                              | Purpose                                                                           |
| --------------------------------- | --------------------------------------------------------------------------------- |
| `src/target.ts`                   | Target/host detection, triple parsing, pointer size derivation, WASM support      |
| `src/build-runner.ts`             | `yo build` orchestration — evaluates build.yo, runs compilation for each artifact |
| `src/init.ts`                     | `yo init` project scaffolding (unified — generates main.yo and lib.yo)            |
| `src/evaluator/builtins/build.ts` | BuildRegistry singleton + 8 evaluator builtin handlers                            |
| `std/build.yo`                    | Build system API with struct config types and wrapper functions                   |

### Modified Files

| File                                | Changes                                                                     |
| ----------------------------------- | --------------------------------------------------------------------------- |
| `src/yo-cli.ts`                     | Add `build` and `init` commands, add `--target`/`--cc` to `compile`/`build` |
| `src/types/utils.ts`                | Call `setTargetPointerSize()` based on target arch                          |
| `src/evaluator/builtins/process.ts` | Use target info instead of `process.platform`/`process.arch`                |
| `src/evaluator/exprs/_expr.ts`      | Build builtin dispatch with arg pre-evaluation                              |
| `src/codegen/index.ts`              | Target-based checks; WASM guards; `--target` to clang args                  |
| `src/compiler-utils.ts`             | Update `findAvailableCompiler()` to prefer clang                            |
| `std/process.yo`                    | Update Platform/Arch enums (standard naming + Wasi)                         |
| `std/path.yo`                       | Update platform comparison strings                                          |

### WASM-Specific Changes

| File                   | WASM-Related Changes                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `src/target.ts`        | `wasi`/`emscripten` OS, `wasm` ABI, `isTargetWasm()`, `isTargetEmscripten()`, `isTargetStandaloneWasi()`           |
| `src/codegen/index.ts` | Skip ws2_32/bcrypt, force libc allocator, skip liburing, NODERAWFS/STANDALONE_WASM flags, `emccEnvironment` option |
| `src/build-runner.ts`  | WASM syslib: skip pkg-config/vcpkg, add `-l<name>` transitively; pass `emccEnvironment: "web"` for WASM targets    |
| `std/process.yo`       | `Platform.Emscripten` and `Platform.Wasi` variants                                                                 |
| C runtime (generated)  | Platform guards (`#if defined(__linux__)`, etc.) auto-exclude WASM                                                 |

#### Emscripten environment defaults

- **`yo build`** WASM targets default to **browser** environment (no `-sNODERAWFS`), output `.html` + `.js` + `.wasm`
- **`yo test --cc emcc`** uses **Node.js** environment (`-sNODERAWFS=1`) for test execution
- Users can opt into Node.js mode via `step.add_c_flags("-sNODERAWFS=1")`

---

## 11. Future Work — Roadmap

This section documents features the build system does not yet support, organized by priority. The current system handles project configuration, multi-artifact compilation, dependencies (git/path/system), DAG-based execution, cross-compilation, and build summary output. The items below represent the next evolution.

---

### 11.1 High Priority

#### 11.1.1 Incremental / Cached Builds

**Problem**: Every `yo build` recompiles from scratch — lexing, parsing, evaluating, C codegen, and clang compilation all repeat even if nothing changed. This becomes a bottleneck as projects grow.

**Design**: Content-addressed artifact caching keyed by a hash of:

- Source file content (SHA256)
- Compiler flags (target, optimize, allocator, sanitize)
- Dependency artifact hashes (transitive)
- Yo compiler version

**Approach**:

1. Before compiling an artifact, compute its cache key from inputs
2. Check `yo-out/.cache/<hash>/` for a previously compiled `.o` or `.a`
3. If cache hit, skip compilation and link from cache
4. If cache miss, compile normally and store result
5. Source change detection: compare file mtimes or content hashes against a `.yo-build-state` manifest

**Scope**:

- Phase 1: File-level caching (skip clang if `.c` unchanged)
- Phase 2: Artifact-level caching (skip Yo evaluation if source files unchanged)
- Phase 3: Cross-session caching (persist across `yo build` invocations)

**Zig reference**: Zig uses a global artifact cache with hash-based invalidation. Artifacts are identified by their full set of inputs.

#### 11.1.2 Parallel Artifact Compilation

**Problem**: Artifacts are compiled sequentially because the evaluator has global state (prelude env, module caches, impl registries). Independent artifacts that don't depend on each other could compile in parallel.

**Design options**:

- **Option A (Worker threads)**: Fork evaluator state into worker threads, each compiling one artifact. Requires making evaluator thread-safe or cloning state.
- **Option B (Child processes)**: Spawn `yo compile` child processes for each artifact. Simpler isolation but more overhead.
- **Option C (C-level parallelism only)**: Keep Yo evaluation serial but run multiple `clang` invocations in parallel. Lowest effort, moderate benefit.

**Current constraint**: `clearAllGlobalImplState()` / `clearEnvContainingPrelude()` are called between artifacts because the evaluator is not re-entrant.

**Recommendation**: Start with Option C (parallel clang), then evolve to Option B (child processes) for full parallelism.

#### 11.1.3 Custom Build Steps (Shell Commands)

**Problem**: Build systems often need to run arbitrary commands — code generators (protoc, graphql-codegen), asset processors, script hooks. Currently `build.run()` only runs compiled Yo executables.

**Proposed API**:

```rust
// Run an arbitrary shell command as a build step
cmd := build.system_command({
  name: "generate-proto",
  program: "protoc",
  args: ComptimeList("--yo_out=src/gen", "proto/api.proto"),
  cwd: "."
});

// Wire it as a dependency
exe := build.executable({ name: "server", root: "./src/main.yo" });
exe.depend_on(cmd);
```

**Implementation**:

- New `StepKind.SystemCommand` variant
- New `SystemCommand` struct in `std/build.yo`
- `__yo_build_system_command` builtin handler
- Build runner executes via `child_process.spawnSync()`
- Respect DAG ordering — command runs before dependent artifacts

#### 11.1.4 Watch Mode

**Problem**: Developers must manually run `yo build` after every change. A watch mode that auto-rebuilds on file changes improves the development loop.

**Proposed CLI**:

```bash
yo build --watch              # Rebuild on any source change
yo build --watch --run        # Rebuild and re-run on change
```

**Implementation**:

- Use `fs.watch()` (or `chokidar` for reliability) on `src/` directory
- Debounce file change events (e.g., 200ms)
- Re-run `runBuild()` on change, leveraging incremental caching
- Clear screen between rebuilds
- Show build duration and status

#### 11.1.5 Installation Support

**Problem**: No way to install built artifacts to system directories or a standardized output prefix (like Zig's `zig-out/`).

**Proposed API**:

```rust
exe := build.executable({ name: "my-app", root: "./src/main.yo" });
build.install(exe);  // Marks artifact for installation

// yo build --prefix /usr/local   → copies to /usr/local/bin/my-app
// yo build                       → copies to yo-out/bin/my-app (default)
```

**Implementation**:

- `build.install(step)` registers artifact for installation
- Default prefix: `yo-out/` (already works)
- `--prefix PATH` flag: copies to `<prefix>/bin/` or `<prefix>/lib/`
- Separate `yo install` command for system-level installation

---

### 11.2 Medium Priority

#### 11.2.1 Feature Flags / Conditional Compilation

**Problem**: Libraries need to expose optional features that consumers can enable/disable. Currently this requires ad-hoc `build.option()` usage with no standard convention.

**Proposed API**:

```rust
// In library's build.yo:
build.feature({ name: "tls", description: "Enable TLS support", default: false });
build.feature({ name: "json", description: "Enable JSON parsing", default: true });

// In consumer's build.yo:
dep := build.dependency({ name: "http", url: "...", ref: "main" });
dep.enable_feature("tls");
dep.disable_feature("json");
```

**Implementation**: Features compile to `build.option()` values that library code checks via `cond()`.

#### 11.2.2 Build Profiles

**Problem**: Common configurations (dev, test, release) require repeating the same optimize/allocator/sanitize settings across multiple artifacts.

**Proposed API**:

```rust
// Define a named profile
Profile :: struct(
  optimize : Optimize,
  allocator : Allocator,
  sanitize : Sanitize
);

dev :: Profile({ optimize: .Debug, allocator: .Libc, sanitize: .Address });
release :: Profile({ optimize: .ReleaseFast, allocator: .Mimalloc, sanitize: .None });

// Apply to artifact
exe := build.executable({ name: "app", root: "./src/main.yo", profile: dev });
```

Or simpler: `--profile dev` / `--profile release` CLI flag.

#### 11.2.3 Multi-Package Workspaces (Monorepo)

**Problem**: Large projects with multiple packages in one repository need coordinated builds, shared dependencies, and unified versioning.

**Proposed API**:

```rust
// workspace.yo (root of monorepo)
build :: import "std/build";

build.workspace({
  members: ComptimeList(
    "./packages/core",
    "./packages/cli",
    "./packages/server"
  )
});
```

**Semantics**:

- Each member has its own `build.yo`
- Shared dependencies are deduped across members
- `yo build` at root builds all members
- `yo build --package core` builds one member
- Path dependencies between workspace members are auto-resolved

#### 11.2.4 Code Coverage

**Problem**: No way to measure test code coverage.

**Implementation**:

- Pass `-fprofile-arcs -ftest-coverage` (or `--coverage`) to clang
- After test execution, run `llvm-cov` or `gcov` to generate coverage reports
- `yo build test --coverage` CLI flag
- Output to `yo-out/coverage/`

#### 11.2.5 Test Filtering and Parallelization

**Proposed CLI**:

```bash
yo build test --filter "http*"     # Run tests matching pattern
yo build test --jobs 4             # Run 4 test suites in parallel
yo build test --timeout 30000      # Per-test timeout in ms
```

#### 11.2.6 Documentation Generation

**Problem**: No standard way to generate API docs from Yo source code.

**Proposed approach**:

- Extract doc comments from `.yo` files (/// or /\*\* \*/ syntax, TBD)
- Generate HTML/Markdown documentation
- `yo doc` or `yo build doc` command
- Output to `yo-out/doc/`

#### 11.2.7 Dependency Vendoring

**Problem**: For reproducible offline builds, dependencies should be checkable into source control.

**Proposed CLI**:

```bash
yo vendor                         # Copy all deps to ./vendor/
yo build --vendored               # Build using vendored deps only
```

#### 11.2.8 Check Mode

**Problem**: Sometimes you want to verify a build without producing artifacts (similar to `tsc --noEmit`).

**Proposed CLI**:

```bash
yo build --check                  # Type-check and evaluate, skip C codegen + clang
```

**Implementation**: Run evaluator but skip `CodeGenerator` and clang invocation. Useful for CI and editor integration.

---

### 11.3 Lower Priority

#### 11.3.1 Link-Time Optimization (LTO)

```rust
exe := build.executable({
  name: "app",
  root: "./src/main.yo",
  lto: true          // Pass -flto to clang
});
```

- **Thin LTO**: `-flto=thin` for parallel LTO (faster builds)
- **Full LTO**: `-flto` for maximum optimization (slower builds)

#### 11.3.2 Benchmarking

```rust
bench := build.benchmark({
  name: "perf-tests",
  root: "./benchmarks/main.yo"
});
```

- `yo build bench` command
- Track results in `yo-out/bench/` for regression detection

#### 11.3.3 Build Graph Export

```bash
yo build --graph dot > build.dot    # Export as Graphviz
yo build --graph json > build.json  # Export as JSON
```

Useful for debugging complex dependency graphs and CI integration.

#### 11.3.4 Remote / Distributed Caching

Share compiled artifact caches across machines:

```bash
yo build --remote-cache s3://my-bucket/yo-cache
```

Inspired by Bazel's remote caching. Useful for CI where multiple runners compile the same dependencies.

#### 11.3.5 Hermetic / Reproducible Builds

Guarantee bit-for-bit identical output across machines:

- Pin compiler versions in `build.yo`
- Normalize file paths in generated C code
- Deterministic ordering of function emission

#### 11.3.6 Fat / Universal Binaries (macOS)

```bash
yo build --target universal-macos   # Combines x86_64 + aarch64
```

Uses `lipo` to merge two single-arch binaries.

#### 11.3.7 Semantic Version Constraints

For dependencies, allow version ranges instead of exact refs:

```rust
dep := build.dependency({
  name: "json-parser",
  url: "https://github.com/user/json-parser.git",
  version: "^1.2.0"    // Any 1.x.y where x >= 2
});
```

Requires a version resolver that maps `^1.2.0` to the best matching git tag.

#### 11.3.8 Build-Only / Dev Dependencies

```rust
// Only needed during build, not linked into final artifact
build.dev_dependency({ name: "test-utils", path: "../test-utils" });
```

#### 11.3.9 Debug Info Levels

```rust
exe := build.executable({
  name: "app",
  root: "./src/main.yo",
  debug_info: .Full     // .Full | .LineOnly | .None
});
```

Maps to clang's `-g`, `-gline-tables-only`, or no debug flag.

#### 11.3.10 RPATH / Runtime Library Paths

For shared library consumers, control where the runtime linker searches:

```rust
exe := build.executable({
  name: "app",
  root: "./src/main.yo",
  rpath: ComptimeList("$ORIGIN/../lib", "/opt/mylibs")
});
```

---

### 11.4 Summary — What We Have vs What's Next

| Category                                         | Status                 | Key Missing Features                         |
| ------------------------------------------------ | ---------------------- | -------------------------------------------- |
| **Core build** (project, artifacts, steps)       | ✅ Complete            | —                                            |
| **Dependencies** (git, path, system, transitive) | ✅ Complete            | Feature flags, semver constraints, vendoring |
| **Cross-compilation** (target triple, WASM)      | ✅ Complete            | Fat binaries, Android/iOS                    |
| **DAG execution** (ordering, cycle detection)    | ✅ Complete            | True parallel compilation                    |
| **Build summary** (timing, MaxRSS, tree)         | ✅ Complete            | Graph export (JSON/DOT)                      |
| **Build options** (`-D` flags, `--help`)         | ✅ Complete            | Feature flags standard                       |
| **Caching / Incremental**                        | ❌ Not started         | File-level, artifact-level, remote           |
| **Custom shell steps**                           | ❌ Not started         | `system_command()`                           |
| **Watch mode**                                   | ❌ Not started         | `--watch` flag                               |
| **Installation**                                 | ⚠️ Partial (`yo-out/`) | `--prefix`, `yo install`                     |
| **Workspaces**                                   | ❌ Not started         | `workspace.yo` monorepo support              |
| **Testing enhancements**                         | ⚠️ Basic               | Filtering, parallelism, coverage, timeout    |
| **Documentation**                                | ❌ Not started         | `yo doc` command                             |
| **Build profiles**                               | ❌ Not started         | Named config presets                         |
| **LTO**                                          | ❌ Not started         | `-flto` / `-flto=thin`                       |
