# `build.shared_library` compiles its root as an executable and fails on the missing `main`

**Status:** OPEN
**Found:** 2026-09-11, auditing the build system
(`plans/BUILD_AND_DEPENDENCY_SYSTEM_REDESIGN.md`). Reproduced with `yo 0.2.30`.
**Severity:** medium — the artifact kind is advertised in `std/build.yo`,
`docs/*/BUILD_SYSTEM.md` ("compile with `-shared -fPIC` and produce `.so`/
`.dylib`/`.dll`") and the `yo init` docs, and cannot produce anything.

## Reproducer

```rust
build :: import("std/build");
shlib :: build.shared_library({ name : "addshared", root : "./add.yo" });
install :: build.step("install", "Build all artifacts");
install.depend_on(shlib);
```

(`add.yo` exports one function and has no `main`.)

```
Building addshared → yo-out/aarch64-apple-darwin/lib/addshared
Undefined symbols for architecture arm64:
  "_main", referenced from: ...
yo: error: compile: C compiler failed (exit 1) on yo-out/aarch64-apple-darwin/lib/addshared.c
```

## Root cause

`compile_artifact` (`src/build_runner.yo:611-903`) only knows one library
flag: `--static-library` for `StepKind.StaticLibrary`. For `SharedLibrary` it
emits a plain `yo compile <root> -o lib/<name>` — an executable build with the
`main` wrapper — and `yo compile` itself has no `--shared` mode
(`src/main.yo` parses only `--static-library`). The output name has no `lib`
prefix and no platform extension either (`get_artifact_output_file_name`,
`:180-230`).

## Fix direction

Either implement it — a `--shared-library` compile mode that reuses the
static-library emission (plain exported names, static-ised runtime, no `main`)
and links with `-shared -fPIC` into `lib<name>.{so,dylib,dll}` — or remove
`SharedLibrary`/`StepKind.SharedLibrary` from `std/build.yo` and the docs until
it exists. `plans/BUILD_AND_DEPENDENCY_SYSTEM_REDESIGN.md` proposes the former
in Phase B (artifact kinds), gated by a cli-case that `dlopen`s the result.
