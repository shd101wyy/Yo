# Step API & Global Cache Design

## 1. Step API Redesign

### Problem

The current `step` function accepts up to 8 fixed positional dependency arguments (`dep0`..`dep7`), which is both limiting and inelegant.

### Solution: Struct-based Step with `ComptimeList`

Use the existing `ComptimeList(comptime_string)` type for variable-length dependency lists, wrapped in a `Step` struct following our established pattern:

```yo
Step :: struct(
  name : comptime_string,
  description : comptime_string
);

step :: (fn(
  comptime(config) : Step,
  comptime(deps) : ComptimeList(comptime_string)
) -> unit) { ... };
```

**Usage:**

```yo
build :: import "std/build";

build.executable(build.Executable(
  name: "my-app",
  root: "./src/main.yo"
));

// Step with dependencies
build.step(
  build.Step(name: "install", description: "Build all targets"),
  ComptimeList(comptime_string)("my-app")
);

// Step with no dependencies
build.step(
  build.Step(name: "clean", description: "Clean build artifacts"),
  ComptimeList(comptime_string)()
);
```

### Why not `deps` as a struct field?

Struct default values with `ComptimeList` would require `(deps : ComptimeList(comptime_string)) ?= ComptimeList(comptime_string)()`, which adds complexity to the default value evaluation path. Keeping `deps` as a separate parameter is simpler and more explicit.

### Implementation

1. **`std/build.yo`**: Add `Step` struct, update `step` function signature to take `(config: Step, deps: ComptimeList(comptime_string))`
2. **`src/evaluator/builtins/build.ts`**: Update `__yo_build_step` handler to extract deps from `ComptimeListValue`
3. **`src/init.ts`**: Update generated `build.yo` template to use new syntax

---

## 2. Global Package Cache

### Problem

Currently dependencies are stored per-project in `.yo-cache/deps/`. This means:

- Same dependency is cloned multiple times across projects
- No sharing between projects
- Wastes disk space and bandwidth

### Solution: XDG-based global cache

Follow XDG Base Directory Specification (like Zig, Cargo, pnpm):

**Resolution order:**

1. `$YO_CACHE_DIR` (environment variable, highest priority)
2. `$XDG_CACHE_HOME/yo` (XDG standard)
3. `~/.cache/yo` (Linux/macOS default)
4. `%LOCALAPPDATA%\yo\cache` (Windows default)

### Cache Structure

```
~/.cache/yo/
├── deps/
│   ├── json-parser-abc123def456/   # <name>-<commit12>/
│   │   ├── src/
│   │   ├── build.yo
│   │   └── ...
│   └── http-client-789abc012def/
└── git/
    ├── <url-sha256>/               # Bare git repos for fast re-fetch
    └── ...
```

**Content-addressed**: deps are stored by `<name>-<commit-short>` so multiple projects using the same version share one copy.

**Bare git cache**: Bare repos in `git/` allow `git clone --reference` for near-instant re-fetches.

### Configuration

- `YO_CACHE_DIR` env var overrides all defaults
- Future: `~/.yo/config.toml` for persistent configuration

### Migration

- Remove `.yo-cache/` per-project directory
- Update `.gitignore` template (no longer needs `.yo-cache/`)
- Lock file (`yo.lock`) stays in the project root (committed to VCS)

### Implementation

1. **`src/cache.ts`** (new): Global cache directory resolution with XDG support
2. **`src/fetch.ts`**: Use global cache directory, add bare git clone caching
3. **`src/evaluator/exprs/import.ts`**: Resolve dependencies from global cache
4. **`src/init.ts`**: Remove `.yo-cache` from generated `.gitignore`
5. **`docs/en-US/BUILD_SYSTEM.md`**: Update cache documentation
