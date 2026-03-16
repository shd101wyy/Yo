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
- Parallel build steps (future work)
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
```

### 1.2 Supported Architectures

| Arch      | Pointer Size | Notes                        |
| --------- | ------------ | ---------------------------- |
| `x86_64`  | 64-bit       | Primary tier                 |
| `aarch64` | 64-bit       | Primary tier (Apple Silicon) |
| `x86`     | 32-bit       | Secondary tier               |
| `arm`     | 32-bit       | Secondary tier               |
| `wasm32`  | 32-bit       | Tertiary tier (future)       |

### 1.3 Supported Operating Systems

| OS        | Async I/O Backend      | Notes                  |
| --------- | ---------------------- | ---------------------- |
| `linux`   | io_uring               | Primary tier           |
| `macos`   | Grand Central Dispatch | Primary tier           |
| `windows` | IOCP                   | Primary tier           |
| `freebsd` | kqueue                 | Tertiary tier (future) |

### 1.4 ABI

| ABI    | Notes                                  |
| ------ | -------------------------------------- |
| `gnu`  | glibc (Linux default)                  |
| `musl` | Static linking friendly (Linux)        |
| `msvc` | Windows MSVC CRT                       |
| `none` | macOS (no ABI suffix needed for clang) |

### 1.5 Target Type in Yo

Define a `Target` type used in `build.yo`:

```yo
Target :: struct(
  arch : Arch,
  os : Os,
  abi : ?(Abi)
);

Arch :: enum(X86_64, Aarch64, X86, Arm, Wasm32);
Os :: enum(Linux, Macos, Windows, FreeBSD);
Abi :: enum(Gnu, Musl, Msvc, None);
```

A builtin `target.host()` returns the host machine's target. This replaces the current `__yo_process_platform()` / `__yo_process_arch()` for build-time detection.

---

## 2. `build.yo` — Declarative Build Configuration

### 2.1 Design Philosophy

- **Declarative, not imperative**: `build.yo` describes _what_ to build, not _how_. No control flow, no side effects — just data declarations. Inspired by Nix derivations.
- **Evaluated at compile time**: The Yo evaluator processes `build.yo` at comptime, extracting structured data. No C codegen is needed for the build file itself.
- **Single source of truth**: All build configuration lives in `build.yo`. No separate config files.

### 2.2 Example `build.yo`

```yo
{ build } :: import "std/build";

project :: build.project(
  name: "my-app",
  version: "0.1.0"
);

app :: build.executable(
  name: "my-app",
  root: "./src/main.yo",
  target: build.target.host(),
  optimize: .ReleaseFast,
  allocator: .Mimalloc,
  sanitize: .None
);

tests :: build.test(
  name: "tests",
  root: "./tests/"
);

// Named steps (like Zig's b.step)
// `yo build run` compiles and runs the app
run_exe :: build.run(app);
run :: build.step("run", "Run the application",
  depends_on: ComptimeList(build.Step)(run_exe)
);

// `yo build test` runs the test suite
test_step :: build.step("test", "Run unit tests",
  depends_on: ComptimeList(build.Step)(tests)
);

// Default step: `yo build` installs all artifacts
install :: build.step("install", "Install build artifacts",
  depends_on: ComptimeList(build.Step)(app)
);

export project;
export install;
export run;
export test_step;
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

### 2.3 Multi-Target Example

```yo
{ build } :: import "std/build";

project :: build.project(
  name: "my-app",
  version: "0.1.0"
);

linux_x64 :: build.executable(
  name: "my-app",
  root: "./src/main.yo",
  target: build.target.parse("x86_64-linux-gnu"),
  optimize: .ReleaseFast
);

macos_arm :: build.executable(
  name: "my-app",
  root: "./src/main.yo",
  target: build.target.parse("aarch64-macos-none"),
  optimize: .ReleaseFast
);

export project;
export linux_x64;
export macos_arm;
```

### 2.4 Library Example

```yo
{ build } :: import "std/build";

project :: build.project(
  name: "my-lib",
  version: "0.2.0"
);

lib :: build.static_library(
  name: "mylib",
  root: "./src/lib.yo",
  target: build.target.host()
);

// Link external C library
app :: build.executable(
  name: "my-app",
  root: "./src/main.yo",
  target: build.target.host(),
  link_libraries: build.StringList("pthread", "m"),
  include_paths: build.StringList("./vendor/include"),
  c_sources: build.StringList("./vendor/src/helper.c"),
  depends_on: ComptimeList(build.Artifact)(lib)
);

export project;
export app;
```

### 2.5 `build` Module API

The `build` module (`std/build.yo` or built-in) provides these compile-time functions:

```yo
build :: module(

  // Project metadata
  project : (fn(
    comptime(name) : comptime_string,
    comptime(version) : comptime_string,
    (comptime(description) : comptime_string) ?= "",
    (comptime(license) : comptime_string) ?= ""
  ) -> comptime(Project)),

  // String list alias for convenience
  StringList :: ComptimeList(comptime_string),

  // Build an executable
  executable : (fn(
    comptime(name) : comptime_string,
    comptime(root) : comptime_string,
    (comptime(target) : Target) ?= target.host(),
    (comptime(optimize) : Optimize) ?= .Debug,
    (comptime(allocator) : Allocator) ?= .Mimalloc,
    (comptime(sanitize) : Sanitize) ?= .None,
    (comptime(link_libraries) : StringList) ?= StringList(),
    (comptime(include_paths) : StringList) ?= StringList(),
    (comptime(library_paths) : StringList) ?= StringList(),
    (comptime(c_sources) : StringList) ?= StringList(),
    (comptime(c_flags) : StringList) ?= StringList(),
    (comptime(defines) : StringList) ?= StringList(),
    (comptime(depends_on) : ComptimeList(Artifact)) ?= ComptimeList(Artifact)(),
    (comptime(strip) : bool) ?= false,
    (comptime(static_link) : bool) ?= false
  ) -> comptime(Artifact)),

  // Build a static library
  static_library : (fn(
    comptime(name) : comptime_string,
    comptime(root) : comptime_string,
    (comptime(target) : Target) ?= target.host(),
    (comptime(optimize) : Optimize) ?= .Debug
  ) -> comptime(Artifact)),

  // Define test suite
  test : (fn(
    comptime(name) : comptime_string,
    comptime(root) : comptime_string,
    (comptime(target) : Target) ?= target.host(),
    (comptime(parallel) : comptime_int) ?= 0,
    (comptime(verbose) : bool) ?= false,
    (comptime(bail) : bool) ?= false
  ) -> comptime(TestSuite)),

  // Convenience step: compile and run an artifact
  run : (fn(
    comptime(artifact) : Artifact,
    (comptime(args) : StringList) ?= StringList()
  ) -> comptime(Step)),

  // Custom named step with dependencies
  step : (fn(
    comptime(name) : comptime_string,
    comptime(description) : comptime_string,
    (comptime(depends_on) : ComptimeList(Step)) ?= ComptimeList(Step)()
  ) -> comptime(Step)),

  // Target utilities
  target : module(
    host : (fn() -> comptime(Target)),
    parse : (fn(comptime(triple) : comptime_string) -> comptime(Target)),
    triple : (fn(comptime(t) : Target) -> comptime(comptime_string))
  ),

  // Enums
  Optimize :: enum(Debug, ReleaseSafe, ReleaseFast, ReleaseSmall),
  Allocator :: enum(Mimalloc, Libc),
  Sanitize :: enum(None, Address, Leak),

  // User-provided build options (like Zig's b.option)
  // These are configurable from the command line via -D<name>=<value>
  option_bool : (fn(
    comptime(name) : comptime_string,
    comptime(description) : comptime_string,
    (comptime(default) : bool) ?= false
  ) -> comptime(bool)),

  option_string : (fn(
    comptime(name) : comptime_string,
    comptime(description) : comptime_string,
    (comptime(default) : comptime_string) ?= ""
  ) -> comptime(comptime_string)),

  option_enum : (fn(
    comptime(EnumType) : Type,
    comptime(name) : comptime_string,
    comptime(description) : comptime_string,
    (comptime(default) : EnumType) ?= EnumType.values().car()
  ) -> comptime(EnumType))
);
```

### 2.6 User-Provided Build Options

Like Zig's `b.option()`, `build.yo` can declare user-configurable options. These become CLI flags under `yo build -D<name>=<value>` and are auto-documented in `yo build --help`.

**Example: Conditional platform targeting**

```yo
{ build } :: import "std/build";

project :: build.project(
  name: "my-app",
  version: "0.1.0"
);

// User-provided options — configurable from CLI
enable_windows :: build.option_bool("windows", "Cross-compile for Windows", false);
log_level :: build.option_enum(LogLevel, "log-level", "Logging verbosity", .Info);

LogLevel :: enum(Debug, Info, Warn, Error);

target :: cond(
  enable_windows => build.target.parse("x86_64-windows-msvc"),
  true => build.target.host()
);

app :: build.executable(
  name: "my-app",
  root: "./src/main.yo",
  target: target,
  optimize: .ReleaseFast,
  defines: cond(
    (log_level == .Debug) => build.StringList("DEBUG=1", "LOG_LEVEL=0"),
    true => build.StringList()
  )
);

export project;
export app;
```

**CLI usage:**

```bash
# Default options
yo build

# Override options
yo build -Dwindows=true -Dlog-level=Debug

# Show available options
yo build --help
```

**Auto-generated help output:**

```
Project-Specific Options:
  -Dwindows=[bool]           Cross-compile for Windows (default: false)
  -Dlog-level=[enum]         Logging verbosity (default: Info)
                               Supported values: Debug, Info, Warn, Error
```

**How it works internally:**

1. `yo build` first evaluates `build.yo` in a "discovery" pass to find all `build.option_*` calls
2. Each `option_*` call registers a named option with its type, description, and default
3. CLI `-D` flags override the defaults before full evaluation
4. The evaluator substitutes the resolved values during comptime evaluation
5. Unknown `-D` flags produce an error listing valid options

### 2.7 Evaluation Model

`build.yo` is evaluated purely at compile time by the existing Yo evaluator:

1. `yo build` invokes the evaluator on `build.yo`
2. The evaluator processes all declarations and resolves all comptime values
3. The build runner (TypeScript) extracts the structured `Project`, `Artifact`, and `TestSuite` values
4. For each `Artifact`, the build runner invokes the normal compilation pipeline with the extracted options
5. No C code is generated for `build.yo` itself — it's purely a configuration language

This means `build.yo` runs in a restricted comptime-only environment. Only comptime functions and types are available — no runtime I/O, no effects.

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
  --lib                  Create a library project (default: executable)
```

### 4.2 Generated Files

**Executable project (`yo init`):**

```
my-project/
├── build.yo
├── src/
│   └── main.yo
├── tests/
│   └── main.test.yo
├── .gitignore
└── README.md
```

**`build.yo`:**

```yo
{ build } :: import "std/build";

project :: build.project(
  name: "my-project",
  version: "0.1.0"
);

app :: build.executable(
  name: "my-project",
  root: "./src/main.yo",
  target: build.target.host(),
  optimize: .Debug
);

tests :: build.test(
  name: "tests",
  root: "./tests/"
);

export project;
export app;
export tests;
```

**`src/main.yo`:**

```yo
{ println } :: import "std/fmt";

main :: fn() {
  println("Hello, world!");
};

export main;
```

**`tests/main.test.yo`:**

```yo
{ test } :: import "std/testing";

test("it works", fn() {
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

**Library project (`yo init --lib`):**

Same structure but with `src/lib.yo` instead of `src/main.yo`, and a `static_library` artifact in `build.yo`.

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
  os: "linux" | "macos" | "windows" | "freebsd";
  abi: "gnu" | "musl" | "msvc" | "none" | undefined;
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

```yo
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

// Proposed (standard naming)
Platform :: enum(
  Linux : "linux",
  Macos : "macos",
  Windows : "windows",
  FreeBSD : "freebsd"
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

### Phase 1: Target Infrastructure (Foundation)

1. Create `src/target.ts` with `HostInfo`, `TargetInfo`, `detectHost()`, `parseTarget()`, `hostTarget()`
2. Wire `setTargetPointerSize()` to be called from target info before evaluation
3. Add `--target` flag to `yo compile`
4. Update `findAvailableCompiler()` to prefer clang

### Phase 2: Host/Target Separation

5. Update `__yo_process_platform()` / `__yo_process_arch()` to use target info from evaluator context
6. Replace all `process.platform` / `process.arch` usages in codegen with target-based checks
7. Update `std/process.yo` platform/arch enums to use standard naming
8. Update `std/path.yo` to use new platform names

### Phase 3: Build System Core

9. Implement `yo init` command (project scaffolding)
10. Create `std/build.yo` module (or evaluator builtins for build API)
11. Implement `yo build` command (build.yo evaluation + orchestration)
12. Implement build output directory structure (`yo-out/`, `.yo-cache/`)

### Phase 4: Cross-Compilation

13. Add `--target=<triple>` passthrough to clang in codegen
14. Add `--sysroot` support
15. Test cross-compilation: macOS → Linux, Linux → macOS, etc.
16. Handle platform-specific library linking based on target (not host)

---

## 9. Open Questions

1. **Should `build.yo` support conditional logic?** For example, platform-specific dependencies. The current design is purely declarative — conditionals would use `cond()` at comptime, which is already supported by the evaluator.

2. **Package management**: How will dependencies on other Yo packages work? This is deferred but the `build.yo` format should be extensible enough to add `dependencies` later.

3. **C library discovery**: Should `build.yo` support `pkg-config` integration for finding system C libraries? This is common in C/C++ build systems.

4. **Zig CC as alternative cross-compiler**: Zig bundles a C compiler with cross-compilation sysroots. Should we support `yo build --cc zig` for easy cross-compilation without installing separate toolchains?

5. **Build.yo for the Yo compiler itself**: Should the Yo standard library and compiler have their own `build.yo`? This is a self-hosting question.

6. **Multiple artifacts sharing config**: Should there be a way to define shared configuration (e.g., common flags) applied to multiple artifacts?

---

## 10. File Changes Summary

### New Files

| File                  | Purpose                                                                           |
| --------------------- | --------------------------------------------------------------------------------- |
| `src/target.ts`       | Target/host detection, triple parsing, pointer size derivation                    |
| `src/build-runner.ts` | `yo build` orchestration — evaluates build.yo, runs compilation for each artifact |
| `src/init.ts`         | `yo init` project scaffolding                                                     |
| `std/build.yo`        | Build system API module (or implemented as evaluator builtins)                    |

### Modified Files

| File                                | Changes                                                                     |
| ----------------------------------- | --------------------------------------------------------------------------- |
| `src/yo-cli.ts`                     | Add `build` and `init` commands, add `--target` to `compile`                |
| `src/types/utils.ts`                | Call `setTargetPointerSize()` based on target arch                          |
| `src/evaluator/builtins/process.ts` | Use target info instead of `process.platform`/`process.arch`                |
| `src/codegen/index.ts`              | Replace `process.platform` with target checks; add `--target` to clang args |
| `src/compiler-utils.ts`             | Update `findAvailableCompiler()` to prefer clang; add target-aware helpers  |
| `std/process.yo`                    | Update Platform/Arch enums to standard naming                               |
| `std/path.yo`                       | Update platform comparison strings                                          |
