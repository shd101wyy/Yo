# Step API & Global Cache Design

## 1. Step API Redesign

### Problem

The original `step` function accepted up to 8 fixed positional dependency arguments (`dep0`..`dep7`). This was later changed to `ComptimeList(comptime_string)` for variable-length deps, but dependencies were still string-based — users had to know synthetic names like `"run:my-app"`.

### Solution: Unified Step type

All build functions (`executable`, `static_library`, `test`, `run`, `step`) now return a `Step` value. Steps are wired together using `ComptimeList(Step)`, making dependencies type-safe and explicit:

```yo
StepKind :: enum(Executable, StaticLibrary, TestSuite, Run, Custom);

Step :: struct(
  name : comptime_string,
  kind : StepKind
);

// Build functions return Step (with comptime return type)
executable :: (fn(comptime(config) : Executable) -> comptime(Step)) { ... };
static_library :: (fn(comptime(config) : StaticLibrary) -> comptime(Step)) { ... };
test :: (fn(comptime(config) : TestSuite) -> comptime(Step)) { ... };
run :: (fn(comptime(artifact_name) : comptime_string) -> comptime(Step)) { ... };

// step() accepts ComptimeList(Step) for dependencies
step :: (fn(
  comptime(name) : comptime_string,
  comptime(description) : comptime_string,
  comptime(deps) : ComptimeList(Step)
) -> comptime(Step)) { ... };
```

**Usage:**

```yo
build :: import "std/build";

exe :: build.executable(build.Executable(name: "my-app", root: "./src/main.yo"));
run_exe :: build.run("my-app");
tests :: build.test(build.TestSuite(name: "tests", root: "./tests/"));

build.step("install", "Build all targets", ComptimeList(build.Step)(exe));
build.step("run", "Run the application", ComptimeList(build.Step)(run_exe));
build.step("test", "Run unit tests", ComptimeList(build.Step)(tests));
```

### How dependency resolution works

The `__yo_build_step` builtin reads Step struct values from the ComptimeList:

- Extracts `name` field (comptime_string) and `kind` field (StepKind enum)
- Maps kind to dependency name: `Run` → `"run:<name>"`, all others → `"<name>"`
- Registry resolution remains unchanged (artifact → test → run step → sub-step)

### Why Step values instead of strings?

- **Type safety**: Can't accidentally misspell a dependency name
- **Zig alignment**: Mirrors Zig's pattern where `b.addExecutable()` returns a `*Compile` with a `.step` field
- **No synthetic names**: Users don't need to know `"run:my-app"` convention — the Step's kind handles it

### Implementation

1. **`std/build.yo`**: Added `StepKind` enum, changed `Step` to `(name, kind)`, all build functions return `comptime(Step)`
2. **`src/evaluator/builtins/build.ts`**: `__yo_build_step` handler extracts `StructValue` elements from `ComptimeListValue`, reads `name` and `kind` fields
3. **`src/init.ts`**: Generated `build.yo` template uses new syntax with variable bindings

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
