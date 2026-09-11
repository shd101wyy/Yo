# `import("<dep-name>")` never resolves — path and git dependencies are unusable end to end

**Status:** FIXED for direct dependencies 2026-09-11 (branch `p1/imports-plumbing`, stacked on #578) — the mechanism is plan §4.5.1: the build runner resolves every `add_import` entry to a module root (`resolve_import_roots`: a path dependency's directory or a git dependency's fetched cache dir via `yo.lock`, then the dependency's `build.yo` evaluated in an isolated registry for its `build.module` root, else `src/lib.yo` → `index.yo` → `<name>.yo`), writes `name=/abs/root.yo` lines to `yo-out/<target>/<kind>/<artifact>.imports`, and passes `--imports <file>` (a new global flag, also forwarded by `yo test` to its batch compiles) to the child compile; `resolve_module_path` gained rule 0, which maps a bare first segment through that table (`import("dep")` → the root, `import("dep/sub")` → `sub` under the root's directory). Gates: cli-cases `build-path-dep-import` (this reproducer plus the `dep/sub` form; prints 12 and 15) and `build-local-module-import` (the `yo init` scaffold's own `build.module` + `add_import`; prints 42). Transitive path dependencies followed on `p1/transitive-path-deps`: the runner walks each dependency's registry and adds its artifacts' `add_import` entries to the consumer's flat mapping (cli-case `build-transitive-path-dep`, prints 41); a dependency's GIT dependencies resolve only if the root `yo.lock` knows them (transitive fetching is the manifest/resolver work). Still open, tracked by the plan: `yo check`/LSP without a build (no mapping outside `yo build`), and propagation of a dependency module's `link`ed system libraries.
**Found:** 2026-09-11, auditing the build and dependency subsystems
(`plans/BUILD_AND_DEPENDENCY_SYSTEM_REDESIGN.md`). Reproduced with the released
`yo 0.2.30` and again with a compiler built from `develop` (`94fae98f8`).
**Severity:** high — the documented dependency workflow (`yo init` → `yo install`
→ `import("name")` → `yo build`) fails at the import, so no Yo project can
consume another Yo package through the build system. `tetris_yo` worked around
it by vendoring `raylib_yo` (its commit `a10bf1a`: "the 0.2.30 git-dependency
flow (yo fetch + import-list resolution) currently fails to resolve the fetched
module").

## Reproducer

```bash
yo init mylib --name mylib --no-skills
cat > mylib/src/lib.yo <<'Y'
multiply :: (fn(a : i32, b : i32) -> i32)((a * b));
export(multiply);
Y
yo init app --name app --no-skills
cd app
yo install ../mylib          # writes deps.yo + the imports list, exits 0
cat > src/main.yo <<'Y'
{ println } :: import("std/fmt");
mylib :: import("mylib");
main :: (fn() -> unit)({ println(mylib.multiply(i32(3), i32(4)).to_string()); });
export(main);
Y
yo build run
```

```
Building app → yo-out/aarch64-apple-darwin/bin/app
error: Module not found: tried ".../app/mylib.yo" and ".../app/mylib/index.yo"
  --> src/main.yo:2:17
2 | mylib :: import("mylib");
Compilation error: Compilation failed (exit 1)
```

`deps.yo` is correct (`mylib :: build.path_dependency({ name: "mylib", path: "../mylib" })`,
and `imports` lists `{ name: "mylib", module: mylib.module() }`), and the
scaffolded `build.yo` does call `exe.add_import_list(imports)`. The git flow
fails identically once the dependency is fetched.

## Root cause

The TypeScript compiler resolved a bare import name in three places that the
port dropped (`git show src-attic-final:src/evaluator/exprs/import.ts`, lines
132–194): the build runner's module-import-root map (`setModuleImportRoot`),
the registry's path dependencies, and `yo.lock` + the global cache for git
dependencies. In the self-hosted compiler:

- `resolve_module_path` (`src/evaluator/exprs/import.yo:81-125`) has exactly
  four rules — `std/`, `std`, `./`/`../`, and "otherwise relative to CWD".
  There is no dependency-name rule. Its own header (`:5-10`) says so:
  "Dependency name resolution (`getBuildRegistry`, `getModuleImportRoot`,
  `resolveDependencyPath`) is not yet ported."
- `_find_project_root` (`:135`) and `_resolve_dependency_entry_point` (`:180`)
  were ported but have **zero callers**.
- The runner registers `add_import` entries into
  `BuildArtifact.imported_modules` (`src/evaluator/builtins/build.yo:1332-1372`)
  and never reads them; `ImportedModule.resolved_root` is always `.None`.
  `run_build` fetches git deps and binds the resolved cache paths to
  `_fetched`, which is never used (`src/build_runner.yo:1569`).
- Structurally, even a ported in-process map would not reach the compile: the
  runner compiles every artifact in a **child** `yo compile` process
  (`compile_artifact`, `src/build_runner.yo:611-903`), whose argv carries no
  import mapping. The TS runner compiled in-process.

`plans/archive/P2_5_RETIRE_EXECUTION.md:420` recorded this as an accepted
loss awaiting a "step 11 decision" ("git/path dependencies unusable;
`dep.artifact(...)` links nothing; `add_import_list` decorative"). The
decision was never taken; `plans/reference/DEPENDENCY_MANAGEMENT.md` §9–§11
and `docs/*/BUILD_SYSTEM.md` still describe the TS behaviour as landed.

## Fix direction

Owned by `plans/BUILD_AND_DEPENDENCY_SYSTEM_REDESIGN.md` (Phase D1/D2): the
runner resolves every `ImportEntry` to an absolute root file and passes the
mapping to the child compile explicitly (`--import name=/abs/root.yo`, or a
generated manifest file), and `resolve_module_path` gains a first rule that
consults that mapping. Gate: this reproducer as a `tests/cli-cases/` fixture
(path dep) plus an offline git-dep fixture using a `file://` repository.
