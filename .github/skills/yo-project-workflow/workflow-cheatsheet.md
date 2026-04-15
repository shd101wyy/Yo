# Yo Project Workflow Cheatsheet

These commands and patterns are aimed at normal Yo projects that use the public `yo` CLI.

## CLI quick reference

| Goal                      | Command                                                   |
| ------------------------- | --------------------------------------------------------- |
| Scaffold a project        | `yo init my-project`                                      |
| Pin Yo version            | `yo version pin`                                          |
| Pin specific version      | `yo version pin 0.1.12`                                   |
| Show current/pinned ver   | `yo version`                                              |
| Build default step        | `yo build`                                                |
| Build and run             | `yo build run`                                            |
| Run project test step     | `yo build test`                                           |
| List build steps          | `yo build --list-steps`                                   |
| Compile one file          | `yo compile main.yo --release -o app`                     |
| Inspect generated C       | `yo compile main.yo --emit-c --skip-c-compiler`           |
| Run tests in one file     | `yo test ./tests/main.test.yo --parallel 1`               |
| Filter tests by name      | `yo test ./tests/main.test.yo --test-name-pattern "Name"` |
| Generate docs for project | `yo doc ./src`                                            |
| Generate docs (custom)    | `yo doc ./src -o docs --title "My Project"`               |
| Install AI agent skills   | `yo skills install`                                       |
| Install dependency        | `yo install user/repo`                                    |
| Install pinned dependency | `yo install user/repo@v1.2.3`                             |
| Fetch dependency graph    | `yo fetch`                                                |

## Project layout

`yo init` produces a structure like this:

```text
my-project/
├── build.yo
├── deps.yo
├── src/
│   ├── main.yo
│   └── lib.yo
└── tests/
    └── main.test.yo
```

- `build.yo` defines artifacts, named steps, and doc generation
- `deps.yo` tracks installed dependencies
- `src/main.yo` is the executable entry point
- `src/lib.yo` is the library module root

## Minimal `build.yo`

```rust
build :: import "std/build";

mod :: build.module({ name: "my-project", root: "./src/lib.yo" });

exe :: build.executable({
  name: "my-project",
  root: "./src/main.yo"
});

tests :: build.test({
  name: "tests",
  root: "./tests/"
});

run_exe :: build.run(exe);

install :: build.step("install", "Build the default artifacts");
install.depend_on(exe);

run_step :: build.step("run", "Run the application");
run_step.depend_on(run_exe);

test_step :: build.step("test", "Run the tests");
test_step.depend_on(tests);

docs :: build.doc({ name: "my-project", root: "./src" });
doc_step :: build.step("doc", "Generate documentation");
doc_step.depend_on(docs);
```

- `build.yo` is ordinary Yo code evaluated at compile time
- Build functions return `Step` values that can be wired with `depend_on(...)`
- Prefer named steps like `install`, `run`, and `test` for common workflows

## Choosing the right entry point

| Situation                       | Preferred command                          |
| ------------------------------- | ------------------------------------------ |
| Whole project with `build.yo`   | `yo build ...`                             |
| One standalone file             | `yo compile ...`                           |
| One test file or test directory | `yo test ...`                              |
| Dependency changes              | `yo install ...` then `yo fetch` if needed |

## Testing patterns

```bash
yo test ./tests
yo test ./tests/main.test.yo --parallel 1
yo test ./tests/main.test.yo --bail --verbose --parallel 1
```

- Use `--parallel 1` for focused, readable single-file runs
- Use `--test-name-pattern` when a file contains many tests
- Use `yo build test` when the repository's main test workflow is defined in `build.yo`

### Writing tests in Yo

```rust
test "Basic assertion", {
  assert(((i32(1) + i32(1)) == i32(2)), "1+1 should be 2");
};

test "Compile-time check", {
  comptime_assert((2 + 2) == 4);
  comptime_expect_error({ x :: (1 / 0); });
};

test "Async test", {
  { yield } :: import "std/async";
  io.await(yield());
};
```

- `test "name", { body }` defines a test — `io : IO` is automatically available
- All tests can use `io.async(...)`, `io.await(...)`, etc. without a `using` clause
- `assert(condition, "message")` — always include a message string
- `comptime_assert(expr)` — verified at compile time
- `comptime_expect_error(expr)` — verify code produces a compile error
- Test files use `.test.yo` extension

## Targets and compilers

```bash
yo compile main.yo --cc clang -o app
yo compile main.yo --cc zig -o app
yo compile main.yo --cc emcc --release -o app
yo test ./tests/main.test.yo --target wasm-wasi
```

- Common C compilers: `clang`, `gcc`, `zig`, `cl`, `emcc`
- `--cc emcc` targets Emscripten-based WebAssembly
- `--target wasm-wasi` targets standalone WASI
- Prefer the host target for routine development unless the task is explicitly cross-platform

### WASM library targets in build.yo

For projects that compile to WASM npm packages, use `target: build.CompilationTarget.Wasm32_Emscripten` and `add_c_flags(...)` for Emscripten settings:

```rust
build :: import "std/build";

wasm_api :: build.executable({
  name: "my_lib_wasm_api",
  root: "./src/wasm_api.yo",
  target: build.CompilationTarget.Wasm32_Emscripten,
  optimize: build.Optimize.ReleaseSmall,
  allocator: build.Allocator.Libc
});
wasm_api.add_c_flags("-O3 -flto -mbulk-memory -sALLOW_MEMORY_GROWTH -sENVIRONMENT=web,node -sMODULARIZE=1 -sEXPORT_NAME=createModule -sEXPORTED_FUNCTIONS=_my_func,_wasm_alloc,_wasm_free -sEXPORTED_RUNTIME_METHODS=HEAPU8");

wasm_step :: build.step("wasm_api", "Build WASM module");
wasm_step.depend_on(wasm_api);
```

Key API:

- `build.executable({...})` — `Executable` struct fields: `name`, `root`, `target`, `optimize`, `allocator`, `sanitize`
- `step.add_c_flags("...")` — append compiler/linker flags (Emscripten `-s` options go here)
- `step.add_import_list(imports)` — add module dependencies
- `build.CompilationTarget.Wasm32_Emscripten` — Emscripten target
- `build.CompilationTarget.Wasm32_Wasi` — WASI target

See the [yo-wasm-integration](../yo-wasm-integration/SKILL.md) skill for full npm packaging patterns.

## Documentation

### `yo doc` — Generate API documentation

```bash
yo doc ./src                         # Document all .yo files in directory
yo doc ./src/main.yo                 # Document single file
yo doc -o ./docs                     # Custom output directory
yo doc --title "My Project"          # Set doc site title
yo doc --format markdown             # Output as Markdown (default: html)
yo doc --format json                 # Output as JSON
yo doc --document-private            # Include non-exported items
```

### `build.doc()` — Documentation build step

In `build.yo`:

```rust
build :: import "std/build";

docs :: build.doc({ name: "docs", root: "./src" });
doc_step :: build.step("doc", "Generate documentation");
doc_step.depend_on(docs);
```

Then run: `yo build doc`

### Doc comments

````rust
/// Brief description of the function.
///
/// ## Examples
/// ```rust
/// add(i32(1), i32(2))
/// ```
add :: (fn(a: i32, b: i32) -> i32)((a + b));
````

Use `///` for item documentation and `//!` at the top of a file for module-level docs.

## Version management

```bash
yo version                      # Show current version and pinned version
yo version pin                  # Pin project to current Yo version
yo version pin 0.1.12           # Pin to specific version
yo version install 0.1.13       # Pre-download a version
yo version list                 # List locally cached versions
yo version list --remote        # List all available versions on npm
yo version clean                # Remove all cached versions
yo version clean 0.1.12         # Remove specific cached version
```

- `.yo-version` file pins a project to a specific Yo version (similar to `.nvmrc`)
- When `.yo-version` exists with a different version, `yo` auto-dispatches to the cached version
- The LSP also reads `.yo-version` to resolve the correct `std/` library for go-to-definition
- Commit `.yo-version` to version control for reproducible builds across the team

## Skills for AI agents

```bash
yo skills install       # Copy bundled skill files into the current project
```

`yo skills install` detects which agent config directories exist in the current project (`.github`, `.agents`, `.claude`, `.opencode`, `.openai`, `.cursor`) and copies all Yo skill files into each. Falls back to creating `.agents/skills/` if none exist.

## Dependency management

```bash
yo install user/repo
yo install user/repo@v1.0.0
yo install ./relative/path
yo fetch
yo fetch --update
```

- Use `yo install` to add dependencies from GitHub or a local path
- Use `yo fetch` to populate or refresh fetched dependencies
- Keep dependency management in Yo tooling instead of hand-editing generated cache state
