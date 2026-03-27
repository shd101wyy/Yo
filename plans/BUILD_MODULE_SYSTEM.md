# Build Module System

## Problem

When project C depends on project B which depends on system library `raylib`, C must
redundantly re-declare and link `raylib` in its own `build.yo`. The current build system
has no mechanism for transitive system library propagation. This forces every consumer to
know the full C-level dependency tree of every Yo package it uses.

## Solution

Introduce `build.module()` and `Step.add_import()` APIs, following Zig's module model.
A **module** is a named source root that declares which system libraries its code needs.
When a consumer imports a module, the module's system library requirements propagate
automatically.

## API Design

### `build.module()` — replaces `build.project()`

```rust
build :: import "std/build";

raylib :: build.system_library({ name: "raylib", defines: "NOMINMAX NOGDI NOUSER" });

mod :: build.module({ name: "raylib_yo", root: "./src/lib.yo" });
mod.link(raylib);   // this module's code requires the raylib C library
```

- Returns a `BuildModule` comptime value (new type).
- `name` — module name (used for import resolution).
- `root` — entry source file.
- `BuildModule.link(system_library)` — declares a system library requirement.
- A single `build.yo` can declare multiple modules.
- **`build.project()` is removed.** Project metadata (output directory name, etc.) is
  derived from artifact names and the build directory.

### `Dependency.module(name)` — get a module from a dependency

```rust
raylib_yo :: build.dependency({
  name: "raylib_yo",
  url: "https://github.com/shd101wyy/raylib_yo.git",
  ref: "v0.0.3"
});

// Default module (no argument or empty string):
raylib_yo_mod :: raylib_yo.module();
// → uses the single module if the dependency declares exactly one
// → error if 0 modules: "dependency 'raylib_yo' has no modules"
// → error if 2+ modules: "dependency 'raylib_yo' has multiple modules, specify a name"

// Explicit module name:
raylib_yo_mod :: raylib_yo.module("raylib_yo");
```

To implement this, the build runner evaluates the dependency's `build.yo` at build time,
collects its registered modules, and returns the one matching the requested name (or the
sole module when the name is empty).

### `Step.add_import(entry)` — explicit import binding

```rust
// ImportEntry pairs an import name with a module
exe.add_import({ name: "raylib_yo", module: raylib_yo.module() });
```

- Registers the module as an importable name on the artifact.
- In source code: `import "raylib_yo"` resolves to the module's root file.
- System libraries linked to the module are transitively propagated to the artifact:
  the artifact gets the module's include paths, link flags, defines, etc.
- Duplicate import names on the same artifact produce a compile-time error.

### `Step.add_import_list(list)` — bulk import

For convenience when importing many dependency modules:

```rust
raylib_yo :: build.dependency({ ... });
other_dep :: build.dependency({ ... });

mods :: ComptimeList(ImportEntry)(
  { name: "raylib_yo", module: raylib_yo.module() },
  { name: "other", module: other_dep.module() }
);
exe.add_import_list(mods);
```

Takes a `ComptimeList(ImportEntry)`. Duplicate names are a compile-time error.

---

## Transitive System Library Propagation

When `tetris_yo` does:

```rust
exe.add_import({ name: "raylib_yo", module: raylib_yo.module() });
```

The build runner:

1. Evaluates `raylib_yo/build.yo` to discover its modules and system libraries.
2. Finds the module `"raylib_yo"` — which links system library `"raylib"`.
3. Resolves `raylib`'s C flags via pkg-config (or vcpkg on Windows).
4. Merges those flags into `tetris_yo`'s artifact:
   - `-I` include paths
   - `-L` library paths
   - `-l` link flags
   - `-D` defines
   - Runtime DLLs (Windows)

**Recursive transitive:** If `raylib_yo` itself imports modules from other dependencies
that link their own system libraries, those propagate too (BFS over the module graph).

---

## Example: Before → After

### raylib_yo/build.yo (the wrapper library)

**Before:**

```rust
build :: import "std/build";
build.project({ name: "raylib_yo", root: "./src/lib.yo" });
raylib :: build.system_library({ name: "raylib", defines: "NOMINMAX NOGDI NOUSER" });
exe :: build.executable({ name: "raylib_yo", root: "./src/main.yo", optimize: build.Optimize.ReleaseFast });
exe.link(raylib);
lib :: build.static_library({ name: "raylib_yo-lib", root: "./src/lib.yo" });
```

**After:**

```rust
build :: import "std/build";

raylib :: build.system_library({ name: "raylib", defines: "NOMINMAX NOGDI NOUSER" });

mod :: build.module({ name: "raylib_yo", root: "./src/lib.yo" });
mod.link(raylib);

exe :: build.executable({ name: "raylib_yo", root: "./src/main.yo", optimize: build.Optimize.ReleaseFast });
exe.link(raylib);

lib :: build.static_library({ name: "raylib_yo-lib", root: "./src/lib.yo" });
lib.link(raylib);

install :: build.step("install", "Build all artifacts");
install.depend_on(exe);
install.depend_on(lib);
```

### tetris_yo/build.yo (the consumer)

**Before:**

```rust
build :: import "std/build";
raylib_yo :: build.dependency({ name: "raylib_yo", url: "...", ref: "v0.0.3" });
raylib :: build.system_library({ name: "raylib", defines: "NOMINMAX NOGDI NOUSER" });
build.project({ name: "tetris_yo", root: "./src/lib.yo" });
exe :: build.executable({ name: "tetris_yo", root: "./src/main.yo", optimize: build.Optimize.ReleaseFast });
exe.link(raylib);
```

**After:**

```rust
build :: import "std/build";

raylib_yo :: build.dependency({ name: "raylib_yo", url: "...", ref: "v0.0.3" });

exe :: build.executable({ name: "tetris_yo", root: "./src/main.yo", optimize: build.Optimize.ReleaseFast });
exe.add_import({ name: "raylib_yo", module: raylib_yo.module() });
// No explicit raylib declaration — it propagates from raylib_yo's module.

install :: build.step("install", "Build all artifacts");
install.depend_on(exe);
```

---

## `yo install` Integration

`yo install user/repo` currently appends a `build.dependency(...)` line to `build.yo`.
With the new model, it should also print guidance:

```
Added dependency: raylib_yo (v0.0.3)

To use in your code, add to your executable or library:
  exe.add_import("raylib_yo", raylib_yo.module("raylib_yo"));
```

For convenience, if the build file contains a `comptime_list` pattern for dependencies,
`yo install` could append to it automatically. But this is a later optimization.

---

## Future: C Interop via Static Libraries

Static libraries (`build.static_library()`) remain available for exporting Yo code as
`.a` files that C projects can link. This is the C interop story — Yo-to-Yo dependencies
always use source-level module imports.

Binary imports (importing a `.a` from Yo) are not planned. Since Yo compiles to a single
C file, source-level imports are the natural and preferred mechanism for Yo consumers.

---

## Implementation Plan

### Phase 1: Core module system + system library propagation

#### 1. Define `BuildModule` type in `std/build.yo`

- New struct: `BuildModule :: struct(name: comptime_string, root: comptime_string)`
- Or a new comptime type returned by `build.module()`.
- Method: `BuildModule.link(system_library: Step) -> comptime(unit)`.

#### 2. Add evaluator builtins (`src/evaluator/builtins/build.ts`)

- `__yo_build_module(name, root)` — registers a module in the build registry.
  Returns a comptime `BuildModule` value.
- `__yo_build_module_link(module_name, system_library_name)` — records that a module
  requires a system library.
- `__yo_build_add_import(artifact_name, import_name, module_ref)` — registers a module
  import on an artifact. Called by `Step.add_import()`.
- `__yo_build_add_import_list(artifact_name, module_list)` — bulk import. Called by
  `Step.add_import_list()`.
- `__yo_build_dep_module(dep_name, module_name)` — resolves a module from a dependency
  (triggers evaluation of the dependency's `build.yo`). Empty `module_name` defaults to
  the sole module.

#### 3. Extend `BuildRegistry` (`src/evaluator/builtins/build.ts`)

- New field: `modules: BuildModuleEntry[]` — registered modules with their linked
  system libraries.
- New field on `BuildArtifact`: `importedModules: ImportedModule[]` — module imports
  registered via `add_import`.
- `ImportedModule` contains: `importName`, `moduleName`, `dependencyName` (optional),
  `linkedSystemLibraries`.

#### 4. Resolve module imports in build runner (`src/build-runner.ts`)

- When compiling an artifact, iterate its `importedModules`.
- For each imported module:
  - If from a dependency: evaluate the dependency's `build.yo`, find the module,
    collect its linked system libraries.
  - Resolve system library flags (pkg-config/vcpkg).
  - Merge flags into the artifact.
- Register the module's root file as the import resolution path for the given name.

#### 5. Update import resolution (`src/evaluator/exprs/import.ts`)

- When resolving `import "name"`, check the artifact's `importedModules` first.
- If found, resolve to the module's root file path.
- Fall back to current resolution (std library paths, etc.).

#### 6. Remove `build.project()`

- Remove `__yo_build_project` builtin.
- Remove `BuildProject` from `BuildRegistry`.
- Update build runner to derive project name from directory or first module name.
- Update all internal test `build.yo` files.

#### 7. Update `yo install` (`src/install-command.ts`)

- After adding `build.dependency(...)`, print guidance about `add_import`.
- Optionally detect `add_import_list` patterns and append automatically.

#### 8. Update tests and documentation

- Update `src/tests/build-system.test.ts` with module-based tests.
- Update `docs/en-US/BUILD_SYSTEM.md`.
- Update `plans/DEPENDENCY_MANAGEMENT.md`.
- Update all example `build.yo` files in tests.
