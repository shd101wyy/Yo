# Yo Dependency Management Design

## Problem Statement

Yo projects currently have no way to depend on external libraries — neither other Yo packages nor system C libraries. Users must manually download sources, set include paths, and configure linker flags. We need:

1. **Git-hosted Yo package dependencies** (like Zig's `build.zig.zon`)
2. **System C library discovery** via `pkg-config`
3. **A lock file** for reproducible builds (like `yarn.lock`, `pnpm-lock.yaml`)

## Design Goals

- **Declarative**: Dependencies declared in `build.yo` using the same struct-based API pattern
- **Content-addressed**: Lock file stores content hashes for integrity (inspired by Zig)
- **Decentralized**: No central registry — dependencies are URLs (Git repos, tarballs)
- **Reproducible**: Lock file ensures identical builds across machines
- **Simple**: Minimal new concepts; leverage existing comptime evaluation

## Non-Goals (for now)

- Central package registry (like crates.io, npm)
- Version resolution / semver constraints (pin to exact refs)
- Caching / incremental builds
- Publishing packages

---

## 1. Git Dependencies

### 1.1 API in `build.yo`

```rust
build :: import "std/build";

build.project({ name: "my-app", root: "./src/lib.yo" });

// Declare a git dependency
build.dependency({
  name: "json-parser",
  url: "https://github.com/user/json-parser.yo",
  ref: "v1.0.0"
});

// Use the dependency as a module path in source code
// In src/main.yo:
//   { parse } :: import "json-parser";

build.executable({
  name: "my-app",
  root: "./src/main.yo"
});
```

### 1.2 Config Struct

```rust
GitDependency :: struct(
  name : comptime_string,                          // Import name
  url : comptime_string,                           // Git repository URL
  (ref : comptime_string) ?= "HEAD",               // Git ref: tag, branch, or commit SHA
  (path : comptime_string) ?= ""                   // Subdirectory within the repo (monorepo support)
);
export GitDependency;
```

### 1.3 Resolution Flow

```
build.yo declares dependency
        │
        ▼
yo build / yo fetch
        │
        ├─ 1. Read yo.lock (if exists)
        │     ├─ Found matching entry → use cached
        │     └─ Not found → fetch from git
        │
        ├─ 2. Git clone/fetch to .yo-cache/deps/<hash>/
        │     └─ Shallow clone: git clone --depth 1 --branch <ref> <url>
        │
        ├─ 3. Compute content hash (SHA-256 of fetched tree)
        │
        ├─ 4. Update yo.lock with url, ref, resolved commit, hash
        │
        └─ 5. Make package available as import path
              └─ "json-parser" → .yo-cache/deps/<hash>/<path>/
```

### 1.4 Import Resolution

When the evaluator encounters `import "json-parser"`, it checks:

1. Is `"json-parser"` a registered dependency name in the BuildRegistry?
2. If yes, resolve to `.yo-cache/deps/<hash>/<path>/` directory
3. Look for entry point: `<dep-dir>/src/lib.yo` (default) or as specified in the dependency's own `build.yo`

This extends the existing module resolution in `ModuleManager` without changing how `import` works for relative or `std/` paths.

---

## 2. Lock File (`yo.lock`)

### 2.1 Format

Use a simple, human-readable format (like Zig's hash-based approach, but YAML-like for readability):

```
# yo.lock — auto-generated, do not edit manually
# Run `yo fetch` to update

[[dependencies]]
name = "json-parser"
url = "https://github.com/user/json-parser.yo"
ref = "v1.0.0"
commit = "abc123def456789..."
hash = "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

[[dependencies]]
name = "http-client"
url = "https://github.com/user/http-client.yo"
ref = "main"
commit = "789abc123def456..."
hash = "sha256:a1b2c3d4e5f6..."
```

### 2.2 Lock File Behavior

| Command            | Lock file exists                                      | Lock file missing            |
| ------------------ | ----------------------------------------------------- | ---------------------------- |
| `yo build`         | Use locked versions; error if deps missing from cache | Run `yo fetch` automatically |
| `yo fetch`         | Re-fetch if `build.yo` deps changed; update lock      | Fetch all deps; create lock  |
| `yo fetch --force` | Re-fetch everything; update lock                      | Fetch all; create lock       |

### 2.3 Cache Directory

```
.yo-cache/
└── deps/
    ├── sha256-e3b0c442.../     ← content-addressed
    │   ├── src/
    │   │   └── lib.yo
    │   └── build.yo
    └── sha256-a1b2c3d4.../
        └── ...
```

The `.yo-cache/` directory is gitignored. The lock file (`yo.lock`) is committed to version control.

---

## 3. `pkg-config` Integration

### 3.1 API in `build.yo`

```rust
build :: import "std/build";

// Link against a system C library discovered via pkg-config
build.system_library({
  name: "openssl"
});

// Or with manual fallback paths (for systems without pkg-config)
build.system_library({
  name: "zlib",
  fallback_include: "/usr/include",
  fallback_lib: "/usr/lib"
});

build.executable({
  name: "my-app",
  root: "./src/main.yo",
  link: "openssl", "zlib"         // Reference by name
});
```

### 3.2 Config Struct

```rust
SystemLibrary :: struct(
  name : comptime_string,                                // Identifier and pkg-config package name
  (fallback_include : comptime_string) ?= "",             // Manual include path
  (fallback_lib : comptime_string) ?= "",                 // Manual library path
  (fallback_link : comptime_string) ?= ""                 // Manual -l flag
);
export SystemLibrary;
```

### 3.3 Resolution Flow

```
build.system_library({ name: "openssl" })
        │
        ▼
Build runner (at build time, not comptime):
        │
        ├─ 1. Run: pkg-config --cflags openssl
        │     → "-I/usr/include/openssl"
        │
        ├─ 2. Run: pkg-config --libs openssl
        │     → "-L/usr/lib -lssl -lcrypto"
        │
        ├─ 3. Parse into includePaths, libraryPaths, linkLibraries
        │
        └─ 4. Merge into artifact's compile options
```

### 3.4 Windows Support

On Windows, `pkg-config` may not be available. Resolution order:

1. Try `pkg-config` (works if installed via MSYS2, vcpkg, etc.)
2. Try `pkgconf` (alternative implementation)
3. Fall back to `fallback_*` paths if specified
4. Error with helpful message if nothing works

---

## 4. `yo fetch` Command

New CLI command to manage dependencies:

```
yo fetch [options]

Options:
  --force               Re-fetch all dependencies (ignore cache)
  --build-file <path>   Path to build file (default: ./build.yo)
  --verbose, -v         Verbose output
```

### 4.1 Behavior

1. Evaluate `build.yo` to extract dependency declarations
2. For each `GitDependency`:
   - Check `yo.lock` for existing entry
   - If locked and cached: skip (unless `--force`)
   - If not cached: clone repo, compute hash, update lock
3. For each `SystemLibrary`:
   - Run `pkg-config --exists <name>` to verify availability
   - Report missing system libraries
4. Write updated `yo.lock`

---

## 5. Implementation Plan

### Phase 1: Git Dependencies (Core)

1. **`git-dep-types`**: Add `GitDependency` struct to `std/build.yo`, add `__yo_build_dependency` builtin to `src/expr.ts`
2. **`git-dep-builtin`**: Implement `evaluateYoBuildDependency()` in `src/evaluator/builtins/build.ts` — registers dependency in BuildRegistry
3. **`lock-file`**: Create `src/lock-file.ts` — parse/write `yo.lock` format
4. **`fetch-command`**: Implement `yo fetch` in `src/yo-cli.ts` and `src/fetch.ts` — git clone, hash computation, lock file update
5. **`import-resolution`**: Update `ModuleManager` to resolve dependency names to cached paths
6. **`build-integration`**: Update `runBuild()` to auto-fetch if deps missing

### Phase 2: pkg-config

7. **`pkg-config-types`**: Add `SystemLibrary` struct to `std/build.yo`, add `__yo_build_system_library` builtin
8. **`pkg-config-resolve`**: Create `src/pkg-config.ts` — run `pkg-config`, parse output, handle Windows fallback
9. **`pkg-config-integration`**: Merge discovered flags into artifact compile options in build runner

### Phase 3: Polish

10. **`yo-init-deps`**: Update `yo init` templates with dependency example (commented out)
11. **`docs`**: Update `docs/en-US/BUILD_SYSTEM.md` and `plans/reference/BUILD_SYSTEM.md`
12. **`tests`**: Integration tests for dependency fetching

---

## 6. BuildRegistry Extensions

```typescript
// New types in src/evaluator/builtins/build.ts

export interface BuildGitDependency {
  name: string; // Import name
  url: string; // Git URL
  ref: string; // Git ref (tag, branch, commit)
  path: string; // Subdirectory within repo
}

export interface BuildSystemLibrary {
  name: string; // Identifier and pkg-config package name
  fallbackInclude: string;
  fallbackLib: string;
  fallbackLink: string;
}

// Add to BuildRegistry class:
export class BuildRegistry {
  // ... existing fields ...
  dependencies: BuildGitDependency[] = [];
  systemLibraries: BuildSystemLibrary[] = [];
}
```

---

## 7. Lock File Parser (`src/lock-file.ts`)

```typescript
export interface LockEntry {
  name: string;
  url: string;
  ref: string;
  commit: string;
  hash: string;
}

export interface LockFile {
  entries: LockEntry[];
}

export function parseLockFile(content: string): LockFile;
export function writeLockFile(lock: LockFile): string;
export function lockFilePath(projectDir: string): string;
```

---

## 8. Path Dependencies (Local)

Path dependencies allow depending on a local package by filesystem path, without fetching or locking.

### 8.1 API in `build.yo`

```rust
build :: import "std/build";

build.path_dependency({
  name: "mylib",
  path: "../mylib"
});
```

### 8.2 Config Struct

```rust
PathDependency :: struct(
  name : comptime_string,
  path : comptime_string
);
```

### 8.3 Resolution Flow

1. `build.path_dependency()` registers the dependency in `BuildRegistry.pathDependencies`
2. When source code uses `import "mylib"`, the import resolver:
   a. Checks `BuildRegistry.pathDependencies` for a matching name
   b. Resolves `path` relative to the project directory
   c. Finds the entry point: `src/lib.yo` → `index.yo` → `<name>.yo`
3. No fetching, locking, or caching needed — the path is used directly

### 8.4 Project Root Entry Point

The `Project` struct has a `root` field that specifies the library entry point:

```rust
Project :: struct(
  name : comptime_string,
  (root : comptime_string) ?= "./src/lib.yo"
);
```

Versioning is determined by **git tags** (like Go), not a manifest field.

When a dependency has a `build.yo`, its `Project.root` can be used to locate the entry point file.

---

## 9. Dependency Build Artifacts (Zig-style)

When a dependency has its own `build.yo` that defines artifacts (e.g., a static library), the consumer can access them via the `Dependency` handle returned by `build.dependency()` or `build.path_dependency()`.

### 9.1 API

```rust
build :: import "std/build";

build.project({ name: "demo" });

// Both dependency() and path_dependency() return a Dependency handle
dep :: build.path_dependency({ name: "dep_lib", path: "../dep_lib" });

// Access a named artifact from the dependency's build.yo
add_lib :: dep.artifact("add");  // Returns a Step

// Link it to the consumer's executable
exe :: build.executable({ name: "demo", root: "./src/main.yo" });
exe.link(add_lib);

install :: build.step("install", "Build demo");
install.depend_on(exe);
```

### 9.2 Dependency Struct

```rust
Dependency :: struct(
  name : comptime_string
);

impl(Dependency,
  artifact : (fn(comptime(self) : Self, comptime(artifact_name) : comptime_string) -> comptime(Step))({
    __yo_build_dep_artifact(self.name, artifact_name);
    Step(name: artifact_name, kind: StepKind.StaticLibrary)
  })
);
```

### 9.3 Build Flow

1. `dep.artifact("add")` registers a `DependencyArtifactRef { dependencyName, artifactName }` in the root registry
2. During `yo build`, the build runner:
   a. Groups dependency artifact refs by dependency name
   b. Finds each dependency's source directory (path dep → local path, git dep → cache)
   c. Evaluates the dependency's `build.yo` in isolation (global registry swap)
   d. Finds the requested artifact in the dependency's registry
   e. Compiles it to `yo-out/deps/<dep_name>/lib/lib<artifact>.a`
   f. Adds the `.a` file to consumer artifacts that link against it
3. The consumer uses `extern "Yo"` declarations to call dependency functions

### 9.4 Registry Isolation

The build runner uses `swapBuildRegistry()` to evaluate dependency build.yo files without interfering with the root project's registry:

```
Root Registry (saved) → Fresh Registry (active) → Evaluate dep build.yo → Capture dep registry → Restore root registry
```

---

## 10. Transitive Dependencies

✅ **Resolved** — Transitive dependencies are resolved automatically.

When dep A depends on dep B, the build system resolves B without the root project explicitly declaring it.

### Recursive Fetching

`fetchTransitiveDependencies()` in `build-runner.ts` performs a BFS traversal:

1. For each direct dependency, evaluate its `build.yo` to discover sub-dependencies
2. Fetch newly-discovered git deps into the root `yo.lock`
3. Continue until no new deps are found (visited set prevents cycles)

Path dependencies of dependencies are resolved relative to the dependency's directory.

### Recursive Compilation

`resolveTransitiveDependencyArtifacts()` compiles sub-deps before parent deps:

1. Evaluate the sub-dep's `build.yo` in isolation
2. Compile its artifacts (e.g., static libraries)
3. Add the `.a` files to the parent dep's `cSources` before compilation

### Transitive Link Propagation

When dep A links dep B's static library, dep B's `.a` file must reach the root linker:

- `compiledDepCache` stores `{ libFile, transitiveSources }` per artifact
- When the root executable links dep A, both `libadd3.a` (dep A) and `libadd.a` (dep B) are included

### Import Resolution Fallback

When dep A's source does `import "dep_b"`, import resolution falls back to the root project's `yo.lock` via `rootBuildProjectDir` (a global set by `runBuild()`).

---

## 11. `deps.yo` — Declarative Dependency File

`yo install` now writes dependencies to a dedicated `deps.yo` file instead of inlining them in `build.yo`.

### Motivation

- Separates dependency declarations from build logic
- `yo install` never modifies `build.yo` — it only touches `deps.yo`
- Auto-generated `imports` ComptimeList eliminates manual `add_import` calls

### File Structure

```rust
// Dependencies for this project.
// Managed by `yo install`. Manual edits are preserved.

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

### Usage in `build.yo`

```rust
build :: import "std/build";
{ imports } :: import "./deps.yo";

exe :: build.executable({ name: "my-app", root: "./src/main.yo" });
exe.add_import_list(imports);
```

### Workflow

1. `yo init` generates empty `deps.yo` and `build.yo` (with `import "./deps.yo"`)
2. `yo install user/repo` appends dep to `deps.yo`, regenerates imports list, runs fetch
3. `yo build` evaluates `build.yo` → imports `deps.yo` → all deps discovered transitively
4. `yo fetch` works unchanged (evaluates `build.yo` which imports `deps.yo`)

### Backward Compatibility

Inline `build.dependency()` calls in `build.yo` still work. The `deps.yo` pattern is recommended for new projects but not mandatory.

## 12. Open Questions

1. ~~**Transitive dependencies**~~: ✅ Resolved — see Section 10.

2. **Dependency entry point**: ✅ Resolved — Convention-based: `src/lib.yo` → `index.yo` → `<name>.yo`. `Project.root` field for explicit override.

3. **Dependency build artifacts**: ✅ Resolved — `dep.artifact("name")` accesses artifacts from the dependency's `build.yo`. Build runner evaluates and compiles them.

4. **Version conflicts**: ✅ Resolved — Content-addressed caching by dependency identity hash. Same version (same path/URL+ref) shares compiled artifact. Different versions compile separately with unique hashes.

5. **Private dependencies**: Should there be a way to use SSH URLs for private repos? Yes — `git+ssh://` URLs should work with the user's SSH agent.

6. **Tarball/URL dependencies**: Besides git, support HTTP tarball URLs? Defer to future — git covers most cases.
