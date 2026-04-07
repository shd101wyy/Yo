# Yo Project Workflow Cheatsheet

These commands and patterns are aimed at normal Yo projects that use the public `yo` CLI.

## CLI quick reference

| Goal                      | Command                                                   |
| ------------------------- | --------------------------------------------------------- |
| Scaffold a project        | `yo init my-project`                                      |
| Build default step        | `yo build`                                                |
| Build and run             | `yo build run`                                            |
| Run project test step     | `yo build test`                                           |
| List build steps          | `yo build --list-steps`                                   |
| Compile one file          | `yo compile main.yo --release -o app`                     |
| Inspect generated C       | `yo compile main.yo --emit-c --skip-c-compiler`           |
| Run tests in one file     | `yo test ./tests/main.test.yo --parallel 1`               |
| Filter tests by name      | `yo test ./tests/main.test.yo --test-name-pattern "Name"` |
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

- `build.yo` defines artifacts and named steps
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

test "Async test", using(io : IO), {
  { yield } :: import "std/async";
  io.await(yield());
};
```

- `test "name", { body }` defines a runtime test
- `test "name", using(io : IO), { body }` for async tests
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
