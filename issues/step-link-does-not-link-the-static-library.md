# `exe.link(lib)` orders the build but never links the library

**Status:** OPEN — runner half FIXED (branch `p0/build-yo-errors-surfaced`: `compile_artifact` now passes every linked static library, transitively, as `--extern <lib>.a`); still fails because the LIBRARY exports no symbols — `issues/static-library-exports-no-symbols.md`, fixed in the stacked PR together with the `build-link-static` cli-case.
**Found:** 2026-09-11, auditing the build system
(`plans/BUILD_AND_DEPENDENCY_SYSTEM_REDESIGN.md`). Reproduced with `yo 0.2.30` and
with a compiler built from `develop` (`94fae98f8`).
**Severity:** high — the "Cross-Module Linking with `extern "Yo"`" section of
`docs/en-US/BUILD_SYSTEM.md` is the flagship multi-artifact example and it fails
at link time.

## Reproducer

`add.yo`, `demo.yo` and `build.yo` exactly as in the docs, plus the
`pragma(Pragma.AllowUnsafe);` line that `extern(...)` now requires (the docs
example is missing it — a second, smaller bug):

```rust
// build.yo
build :: import("std/build");
lib :: build.static_library({ name : "add", root : "./add.yo" });
exe :: build.executable({ name : "demo", root : "./demo.yo" });
exe.link(lib);
install :: build.step("install", "Build all artifacts");
install.depend_on(exe);
```

```
$ yo build -v
Building add → yo-out/aarch64-apple-darwin/lib/libadd.a
Building demo → yo-out/aarch64-apple-darwin/bin/demo
Undefined symbols for architecture arm64:
  "_add", referenced from: ...
clang: error: linker command failed with exit code 1
```

`libadd.a` exists and exports `add`; the executable's `yo compile` argv never
mentions it.

## Root cause

`Step.link` → `__yo_build_link` → `register_link` records the name in
`artifact.linked_artifacts` (`src/evaluator/builtins/build.yo:1163-1180`).
`_walk_dag` turns that into a DAG edge (`src/build_runner.yo:257-266`) — and
that is the only consumer. `compile_artifact` (`:667-855`) adds `-L`/`-l`
only for **system** libraries resolved through pkg-config; it never looks at
`linked_artifacts`, so the produced `lib<name>.a` is not passed as `--extern`
(the flag `yo compile` already has for exactly this, `src/main.yo`).

The TS runner did this in `resolveLinkedArtifacts` (`src-attic-final`
`src/build-runner.ts`), appending each linked static library's output to the
consumer's `cSources`.

## Fix direction

In `compile_artifact`, for each `linked_artifacts` entry that resolves to a
static (or shared) library artifact, append its output path to the child argv
as `--extern <path>` (static) or `-L <dir> -l<name>` (shared), transitively
through the linked library's own `linked_artifacts`. Gate: this reproducer as
`tests/cli-cases/build-link-static`, asserting the run prints `7`.
