# Build system & dependency system — audit and redesign plan

_Status: **COMPLETE (2026-09-13)** — P0, P1, P2 (§5.1, §5.2, §5.4) and P3
(§4.6, §4.8, §4.9) have all landed. P4 (registry, `yo publish`) is designed
and deliberately not scheduled; §4.10 records its shape._

_Proposed 2026-09-11, revised the same day after maintainer review — the
manifest is **declarative data read without the evaluator**; after weighing
a Yo data literal against TOML (§4.1 records both) the maintainer chose TOML
(`yo.toml`). The plan carries no backward-compatibility scaffolding (Yo has
one user today; breaking changes land outright — §6). Successor of
`plans/reference/BUILD_SYSTEM.md` and `plans/reference/DEPENDENCY_MANAGEMENT.md`
for everything those two documents describe as landed but the self-hosted
compiler does not do (§1.2 explains why the gap exists)._

_What landed, in merge order: **P1.3** the `yo.toml` manifest (#596) · **P1.4a**
resolver + `yo.lock` v2 (#601) · **P1.4b** the content-addressed store (#602) ·
**P1.4c** `build.manifest` (#605) · **P1.4d** dependency `build.yo` evaluation
and real `dep.artifact()` linking (#611) · **P1.4e** shared libraries with rpath
(#615) · **P1.4f** the runner stops failing silently (#616) · **P1.4g** run
arguments, a stamp that sees dotted directories, one name namespace (#618) ·
**P1.4h / §4.8** parallel DAG levels and `-j N` (#620) · **B13** the last of the
write-only state (#626) · **§4.9** depfile-scoped stamps (#631) · **§5.1**
`comptime_read_file` (#632) · **§5.2** `comptime_json_parse` /
`comptime_toml_parse` (#633) · **§5.4** `build.env` (#642) · **§4.6**
workspaces (#646). The five bugs the audit reproduced are filed
under `issues/` and are all fixed. The campaign surfaced further compiler bugs
of its own along the way, and NONE is left open. Three were FIXED: the extern
prototype collision and the `-O2` flag that hid it (#624), the build
scheduler's nested event loop (in #620), and `yo doc` taking the project name
from the directory rather than from `[package] name`
(`issues/fixed/yo-doc-infers-the-project-name-from-package-json.md`). A fourth
was filed and then RETRACTED — it could not be reproduced and rested on a
misread of a two-error build log
(`issues/retired/async-body-local-read-by-two-matches-is-emitted-twice.md`)._

The question that prompted this plan, from the maintainer, in three parts:

1. *The build system requires a compile-time-only context — is that right?*
   Yes (§2.1). `build.yo` is an ordinary module evaluated by the compile-time
   evaluator; every `std/build` function takes `comptime(...)` parameters and
   returns `comptime(...)` values, and the only inputs a build file can observe
   are the host triple, `-D` options and other `.yo` files it imports.
2. *Should Yo grow compile-time functions like `comptime_read_file`,
   `comptime_json_parse`, `comptime_fetch` for that context?* Two yes, one no,
   with the rules that keep the build hermetic (§5).
3. *Should the dependency system work like pnpm, Cargo, or bun?* Yes, and
   today it does not work at all (§1.1, §3): the fetch half exists, the consume
   half was never ported. §4 is the redesign — manifest, semver ranges,
   resolver, lockfile with integrity, content-addressed store, workspaces.

Everything in §1–§3 is measured against the live tree at `37a0096ea`
(develop, 2026-09-11) and reproduced with the released `yo 0.2.30`; file
references are `src/**.yo` paths in that tree. The audited sources are the
same in both: `src/install_command.yo` and `src/evaluator/exprs/import.yo` are
byte-identical to v0.2.30, and the diffs in `src/fetch.yo`, `src/build_runner.yo`
and `src/evaluator/builtins/build.yo` since then are the `--heap-size` /
`--emit-chunks auto` plumbing and a hex-helper rename — none touch a finding.
The three headline reproducers (§1.1 import, B1 link, D1 install) were re-run
against a compiler built from `develop` `94fae98f8` by the 0.2.30 seed and
reproduce identically.

---

## 1. Audit — what is actually true today

### 1.1 The headline: the dependency system is fetch-only

> **Progress 2026-09-11:** the consume half now exists for DIRECT dependencies —
> #577 (runner errors, linking), #578 (library exports) and the stacked
> `p1/imports-plumbing` branch (`--imports` file + resolver rule 0, §4.5.1)
> make `import("mylib")` / `import("mylib/sub")` work for path and fetched git
> dependencies and for a project's own `build.module`; the `p1/transitive-path-deps`
> branch walks the dependencies' own registries so a dependency's imports
> resolve too (one flat mapping per artifact; git dependencies of dependencies
> still need the root `yo.lock` to know them). `yo check`/LSP outside a build
> and system-library propagation remain (§6 P1).


The documented workflow — `yo init`, `yo install user/repo`, `import("repo")`,
`yo build` — fails at the import on 0.2.30, for path and git dependencies
alike:

```
$ yo install ../mylib          # ok, writes deps.yo + the imports list
$ yo build run
Building app → yo-out/aarch64-apple-darwin/bin/app
error: Module not found: tried ".../app/mylib.yo" and ".../app/mylib/index.yo"
  --> src/main.yo:2:17
2 | mylib :: import("mylib");
```

`tetris_yo`, the flagship downstream project, hit exactly this and vendored
`raylib_yo` (its commit `a10bf1a`: "the 0.2.30 git-dependency flow currently
fails to resolve the fetched module"). Its `deps.yo` and `yo.lock` were deleted
in that commit.

Why: the TypeScript compiler resolved a bare import name through three
mechanisms (`src-attic-final:src/evaluator/exprs/import.ts:132-194`) — the
build runner's in-process module-import-root map, the registry's path
dependencies, and `yo.lock` plus the global cache. The Yo port kept the
registration side and dropped the consumption side:

| piece | state in `src/` |
| --- | --- |
| `resolve_module_path` (`src/evaluator/exprs/import.yo:81-125`) | four rules: `std/`, `std`, `./`/`../`, else CWD. No dependency-name rule; header `:5-10` says "not yet ported" |
| `_find_project_root`, `_resolve_dependency_entry_point` (`import.yo:135,180`) | ported, **zero callers** |
| `run_build` fetch (`src/build_runner.yo:1559-1575`) | fetches direct git deps, binds the resolved cache paths to `_fetched`, never reads it |
| `add_import` / `add_import_list` → `BuildArtifact.imported_modules` (`src/evaluator/builtins/build.yo:1332-1372`) | registered, never read by any code outside that file; `resolved_root` always `.None` |
| `Dependency.artifact()` / `dependency_artifacts` | registered, never read; always returns `StepKind.StaticLibrary` |
| `swap_build_registry` (`builtins/build.yo:705`) — evaluate a dependency's `build.yo` in isolation | defined, zero callers; no dependency `build.yo` is ever evaluated, so no transitive deps, no propagated system libraries |
| `resolve_dep_path` (`src/fetch.yo:830-878`) — name → cache path with integrity errors | zero callers outside its file |
| child compile argv (`compile_artifact`, `build_runner.yo:667-855`) | carries no import mapping at all — and because artifacts compile in **child processes**, an in-process map (the TS design) could not have worked even if ported |

`plans/archive/P2_5_RETIRE_EXECUTION.md:420` recorded this as an accepted loss
awaiting a "step 11 decision" — "git/path dependencies unusable;
`dep.artifact(...)` links nothing; `add_import_list` decorative; a `yo init`
project's own `build.module` imports fail". The decision was never taken.
Meanwhile `plans/reference/DEPENDENCY_MANAGEMENT.md` §9–§11 still marks
transitive dependencies, dependency artifacts and version conflicts
"✅ Resolved", and `docs/*/BUILD_SYSTEM.md` describes shared-dependency dedup
that never runs. Those describe the deleted compiler.

### 1.2 Build system — the runner behind the declarative surface

The `std/build.yo` surface (Zig-shaped: config structs, `Step`,
`depend_on`, `link`, `option`, `-D`, `yo-out/<triple>/`) is sound and worth
keeping. The runner is where the port is incomplete. Reproduced on 0.2.30:

| # | finding | evidence | issue |
| --- | --- | --- | --- |
| B1 | `exe.link(lib)` for a `static_library` orders the build and **does not link** — the docs' "Cross-Module Linking with `extern "Yo"`" example fails with `Undefined symbols: "_add"`. `linked_artifacts` is read only by `_walk_dag` (`build_runner.yo:257-266`); `compile_artifact` never emits `--extern lib<name>.a` | reproduced | `issues/fixed/step-link-does-not-link-the-static-library.md` |
| B2 | `build.shared_library` compiles its root as an **executable** (no `--shared` mode exists in `yo compile`), fails on `_main`, output has no `lib` prefix or extension | reproduced | `issues/fixed/shared-library-artifact-is-compiled-as-an-executable.md` |
| B3 | a parse or evaluation error in `build.yo` is **swallowed**: `evaluate_build_file` binds `mm_load_yo_file`'s outcome to `_outcome` and never calls `_take_load_error` (`build_runner.yo:1491-1510`). The user sees `Unknown step "install". Available: (none)`. The duplicate-artifact-name diagnostic that exists (`builtins/build.yo:652-670`) is therefore never shown; `yo fetch` has the same swallow (`fetch_command.yo:97-103`) | reproduced | `issues/fixed/build-yo-evaluation-errors-are-swallowed.md` |
| B4 | `-D` options are **unvalidated**: undeclared names accepted silently (`declared_options` has no reader outside the builtins file), values are untyped strings, `yo build --help` does not list the project's options although `docs/en-US/BUILD_SYSTEM.md` says it does | reproduced | this plan (§4.7) **FIXED P1.4f** (undeclared names error; `yo build --list-options`; the `comptime_str` blocker is `issues/build-option-value-cannot-feed-an-artifact-field.md`) |
| B5 | the DAG scheduler computes Kahn levels and then runs each level **sequentially** (`execute_dag`, `build_runner.yo:1260-1266`); the docs' rationale ("the Yo evaluator uses global state") is obsolete since artifacts compile in child processes | code | this plan (§4.8) **FIXED P1.4h** (`-j N`; the default stays 1 so output keeps its DAG order) |
| B6 | failures do not stop dependents — a `run` node runs after its artifact failed; `Tests failed (exit n)` / `Executable exited with code n` are computed and never printed (`:1124-1126`, `:1142-1144`); a dependency name that resolves to nothing is silently dropped from the DAG (`:250-252`), so `install.depend_on(<typo>)` is a no-op | code | this plan (§4.7) **FIXED P1.4f** |
| B7 | `--dry-run` prints `[dry-run] Would execute step: X` without building the DAG, validating the step, or detecting cycles (`:1701-1705`); help text says "Resolve the build graph without running it" | reproduced | this plan (§4.7) **FIXED P1.4f** |
| B8 | `ReleaseSmall` ≡ `ReleaseSafe` (`--optimize 2` both); no level passes `-g` although `std/build.yo:19-33` documents `-O0 -g` / `-O2 -g` | code | `issues/build-release-small-is-identical-to-release-safe.md` (pre-existing) |
| B9 | `build.run(exe)` steps cannot receive arguments: `BuildRunStep.args` is always empty, there is no `--` on the CLI (`main.yo:4572-4577`) | code | this plan (§4.7) **FIXED P1.4g** |
| B10 | the Phase-A artifact stamp (`_artifact_input_stamp`, `:404-609`) hashes **every** `.yo` under the project (including `tests/`) and the whole std tree per artifact: any edit anywhere invalidates every artifact; directories whose name contains a `.` are never walked (`:477`) — sources under `my.pkg/` are silently excluded (stale-cache risk); the walk runs even when `YO_BUILD_NO_CACHE=1` | code | this plan (§4.9) — **FIXED P1.4g** (the dotted-directory blind spot and the disabled-cache walk) and **FIXED §4.9** (the over-hashing: `--emit-deps` + a depfile-scoped stamp) |
| B11 | registries are keyed by bare name with first-match resolution artifact → test → run → doc → step (`builtins/build.yo:600-637`); steps/tests/docs/runs have no duplicate check; `Step.link(sys)` before `build.system_library({name: sys})` is misread as an artifact link and dropped (`:1168-1177`) | code | this plan (§4.7) **FIXED P1.4g** |
| B12 | `_dfs_cycle` skips the dependency after a not-in-map one (`:348-350`, missing `continue`); harmless today only because `_walk_dag` never emits such edges | code | fix with B6 **FIXED P1.4f** |
| B13 | write-only state throughout: `BuildDocConfig.include_deps/logo/favicon` accepted and never forwarded (`:1177-1185`), `BuildTestSuite.target/verbose/bail/parallel` hard-coded, `runtime_files`, `ExecutionContext.dry_run`, `StepResult.duration_ms` always 0 — **FIXED P1.4f/B13** | code | clean up with each phase |
| B14 | `yo init`'s `build.yo` imports `{ assert, panic } :: import("std/assert")` and uses neither (`src/init.yo:75-106`) | reproduced | nit, fix in P0 |

### 1.3 Dependency CLI — the half that exists

| # | finding | evidence | issue |
| --- | --- | --- | --- |
| D1 | `yo install user/repo[@tag]` writes `ref: ""` to `deps.yo`, prints none of the `.Git` arm's progress lines, creates no `yo.lock`, exits 0; the next `yo fetch` fails `git checkout failed for commit ` — every CLI-added git dependency is broken. A minimal `io.async` reproduction of the same statement shape works, so the trigger is specific to `run_install`; bisect by body substitution | reproduced (0.2.30; source identical on develop) | `issues/fixed/yo-install-git-dependency-writes-an-empty-ref.md` |
| D2 | `resolve_git_ref` treats an empty `git ls-remote` result as "already a commit SHA" and never checks the exit status (`src/fetch.yo:449-459`): a typo'd tag or a network failure becomes a bogus commit and fails later with a worse message | code | fix in P0 |
| D3 | `yo install` runs `fetch_all_deps` with a one-element list, and the post-fetch prune (`fetch.yo:750-778`) then **deletes every other dependency's lock entry** | code | fix in P0 |
| D4 | integrity is sidecar-trusting: `inspect_cached_dep` recomputes the tree hash only when `.yo-content-hash` is missing (`fetch.yo:407-411`); a modified cache dir is never detected | code | §4.4 |
| D5 | `are_deps_cached` matches lock entries by **name only** (`fetch.yo:808-816`): changing `ref` or `url` in the build file does not re-fetch on `yo build` | code | §4.3 |
| D6 | cache key is `<name>-<commit12>` (`fetch.yo:372-380`): the URL is not part of the identity; same repo under two names is stored twice | code | §4.4 |
| D7 | `deps.yo` is a Yo source file **edited as text** by marker and substring (`install_command.yo:305-440`): a commented-out `// old :: build.dependency(` line is parsed as a live dependency and pushed into the imports list; `name` matching is `contains(name + " :: build.dependency(")` | code | §4.1 |
| D8 | ssh remotes (`git@github.com:user/repo.git`) are mis-parsed by the last-`@` split (`install_command.yo:252-266`); `path:` (subdirectory) cannot be expressed from the CLI; `GIT_TERMINAL_PROMPT=0` is set only in `install`, so `yo fetch`/`yo build` can hang on a credential prompt | code | §4.5 |
| D9 | non-unique temp dir `_tmp_<name>` (no PID/random suffix, not cleaned on failure): a crashed fetch makes the next one fail with "destination path already exists"; concurrent fetches collide | code | §4.4 |
| D10 | `yo cache clean` removes the whole cache root including `versions/` (`main.yo:4347-4353`) while its help says "Remove all cached dependencies" | code | fix in P0 |
| D11 | no transitive dependencies, no duplicate-name rejection, no version-constraint syntax (`ref` is an exact string), path dependencies and the `path:` subdirectory are not recorded in `yo.lock`, lock values are written unescaped, all writes are non-atomic | code | §4 |
| D12 | dead heritage: `ensure_gitignore` still adds `.yo-cache/` on every `yo fetch` although nothing writes there; three files read `YO_ORIGINAL_CWD`, set by a `yo-cli` shim that no longer exists | code | fix in P0 |

### 1.4 What is good and must stay

- **`build.yo` is Yo.** One language for code and build; the whole comptime
  evaluator is available (`cond`, comparisons, `import("./x.yo")`, `ComptimeList`).
  The repo-root `build.yo` picking the allocator per host with `cond` is the
  model.
- **The `Step` API.** Every registration returns a `Step`; `depend_on` /
  `link` wire the graph; no synthetic string names. Zig-aligned and typed.
- **Config structs with defaults**, `-D` options, `yo-out/<triple>/bin|lib`,
  target triples as canonical Rust spellings (`plans/reference/TARGET_TRIPLES.md`).
- **The artifact stamp** (`INCREMENTAL_COMPILATION.md` Phase A) and the
  chunked `.o` cache (`CHUNKED_C_EMISSION.md`) — the second `yo build` of an
  unchanged project compiles nothing.
- **A global, hash-verified store** (`~/.cache/yo`, XDG-resolved, precedence
  pinned by cli-cases) and a committed `yo.lock` — the right shape, wrong
  details (§4.4).
- **`yo build --watch`, `--summary`, `--list-steps`, `yo build test/run/doc`.**

---

## 2. The compile-time context, precisely

### 2.1 How `build.yo` runs

`run_build` → `evaluate_build_file` (`build_runner.yo:1491-1510`):
`clear_build_registry()`, seed `cli_options` from `-D`, `mm_load_yo_file`
(a normal module evaluation against a clone of the cached prelude env with
`is_executing = true`, `module_manager.yo:774-921`), `mm_reset()`, read the
process-global `BuildRegistry`. The 22 `__yo_build_*` builtins
(`src/expr.yo:191-212`, `builtins/build.yo:1016-1429`) are evaluator-only —
there is no codegen emitter for any of them — and each mutates the registry.
Under `check` or in a def-time trial with `UnknownVal` arguments, they return
the right comptime type and touch nothing.

What a build file can observe, exhaustively: `build.target_host` (host
triple, `builtins/build.yo:1043`), `build.option(...)` (the `-D` override or
its default), `__yo_process_platform/arch` and `__yo_pointer_size_bits`
(answered from `--target`), and other `.yo` files through `import`. Not
observable: `--target`/`--cc`/`--sysroot` (applied later by the runner),
environment variables, files that are not Yo source, the clock, the network.
Extern functions never fold (`ctfe/ctfe_analysis.yo:410`), extern globals are
runtime-only (`c_include.yo:286`), so `std/env`, `std/fs`, `std/process` are
inert at compile time. **Compile-time evaluation in Yo is pure by
construction**, not by policy — there is no purity flag, sandbox, or pragma
for compile-time effects (`Pragma` has `AllowUnsafe`, `AllowMacroDef`,
`Skip*`, verification; nothing for I/O).

### 2.2 What compile-time values can be

`EvalValue` (`src/value.yo:45`): unit, bool, int/float/string literals, enum,
struct, tuple, fixed array, type, function, `ComptimeListVal`, `ExprVal`,
`UnknownVal`. Comptime types: `comptime_int`, `comptime_float`, `comptime_str`
(bytes; `+`, comparisons, `len`, `slice`, `to_upper/lower`, `to_expr`),
`ComptimeList(T)` with `car/cdr/append/len/get`, `Expr`. Struct/enum/tuple
constants of those are fine (`tests/import_constants/`). **There is no
compile-time `String`, `ArrayList` or `HashMap`** — they are heap types over
extern allocators — and automatic CTFE promotes only functions whose result is
numeric or `comptime_str` (`ctfe_analysis.yo:71-81`). So `std/encoding/json.yo`
and `toml.yo` cannot run at compile time: their results are `Result(JsonValue,
…)` over `String`. Any compile-time JSON/TOML value has to be a comptime-only
data type with a builtin parser (§5.2).

### 2.3 Caches that compile-time inputs must feed

Three caches would go stale silently if a compile-time read landed without a
recorded dependency edge (`INCREMENTAL_COMPILATION.md`): the module cache and
its `importer → imported` invalidation graph (`module_loader.yo:102-108`, the
LSP and `check --watch` rely on it), the artifact stamp (which hashes `.yo`
files only, `build_runner.yo:472`), and the `--watch` poll set (`.yo` only).
The chunk `.o` cache is keyed on emitted C and is safe by construction. §5.4
is the plumbing.

### 2.4 One existing hazard

`comptime_eval(s : comptime_str)` parses and evaluates arbitrary Yo at
compile time (`builtins/type_fns.yo:1384-1470`). Any builtin that returns
external text as `comptime_str` — a file read, an environment variable, and
above all a network fetch — composes with it into code execution at compile
time from data the author did not write. This is the concrete reason §5 says
no to `comptime_fetch` and puts file reads behind a root boundary.

---

## 3. Reference points — how the systems the maintainer named do it

| | Cargo | pnpm | bun | Zig | Nix | **Yo today** | **Yo proposed** |
| --- | --- | --- | --- | --- | --- | --- | --- |
| manifest (data) | `Cargo.toml` | `package.json` | `package.json` | `build.zig.zon` | `flake.nix` inputs | none — `build.dependency({...})` calls in `deps.yo`, text-edited | `yo.toml`, declarative, read without the evaluator (§4.1) |
| build program (code) | `build.rs` (compiled + run) | scripts | scripts | `build.zig` (compiled + run) | derivations | `build.yo` (comptime-evaluated) | `build.yo` (comptime-evaluated, unchanged) |
| version constraints | semver ranges `^ ~ = >=` | semver ranges | semver ranges | exact URL + content hash | exact rev/hash | exact git ref string | semver ranges over git tags (§4.2) |
| resolver | highest-satisfying, one per semver-major | highest-satisfying, per-dependent | highest-satisfying | none (exact) | none (exact) | none | highest-satisfying, one per semver-major (§4.2) |
| lockfile | `Cargo.lock` (graph + checksums) | `pnpm-lock.yaml` (graph + integrity) | `bun.lock` (text) | hashes in the manifest | `flake.lock` | `yo.lock`: name/url/ref/commit/hash, no edges | `yo.lock` v2 (TOML): graph + integrity (§4.3) |
| store | `~/.cargo/registry/src` + git checkouts | content-addressable store, hard-linked | global cache | `~/.cache/zig/p/<hash>` content-addressed | `/nix/store/<hash>-name` | `~/.cache/yo/deps/<name>-<commit12>` | `~/.cache/yo/store/<sha256>` + bare git mirrors (§4.4) |
| integrity check | checksum on every use | integrity on every link | hash | hash verified on fetch | hash is the identity | trusts a sidecar file | verified on install and stamped per build (§4.4) |
| transitive deps | yes | yes | yes | yes (nested `.zon`) | yes | **no** | yes (§4.2) |
| workspaces | `[workspace]` | `pnpm-workspace.yaml` | `workspaces` | no | no | no | `[workspace]` (§4.6) |
| registry | crates.io / sparse index | npm | npm | none (URLs) | flakes registry | none | none first; static index later (§4.10) |
| dependency's build logic | its `build.rs` runs | its scripts run | its scripts run | its `build.zig` is part of the graph | its derivation | never evaluated | its `build.yo` evaluated in an isolated registry (§4.5) |
| hermetic build eval | build.rs may do anything; convention | scripts may do anything | same | build.zig is a normal program | pure by construction, fixed-output fetches | pure by construction | pure + declared file reads (§5) |

The lesson that all five agree on and Yo currently violates: **dependencies
are data, not code.** A resolver must read every manifest in the transitive
closure without executing anything — for speed (no evaluator, no prelude
clone per package), for safety (resolving must not run a dependency's code),
and for tooling (`yo add` edits a data file; nothing edits Yo source as text).

---

## 4. Dependency system redesign

### 4.1 D-1 — `yo.toml` is the manifest: declarative data, read without the evaluator

```toml
[package]
name = "tetris_yo"
version = "0.3.0"            # semver; what `yo publish`/tagging reads
description = "Tetris in Yo"
license = "MIT"
yo = "0.2.30"                # minimum compiler version (mirrors .yo-version; optional)

[modules]                    # what importers may `import("tetris_yo")` / `import("tetris_yo/board")`
default = "src/lib.yo"
board   = "src/board.yo"

[dependencies]
raylib_yo = { git = "https://github.com/shd101wyy/raylib_yo", version = "^0.0.6" }
json-yo   = { git = "https://github.com/user/json-yo", tag = "v1.2.0" }          # exact
utils     = { git = "https://github.com/user/mono", version = "~2.1", path = "packages/utils" }
mylib     = { path = "../mylib" }

[dev-dependencies]           # only for this package's tests/examples
snapshot  = { git = "https://github.com/user/snapshot-yo", version = "^0.4" }
```

**The rule that matters is that the manifest is data, not a computation.**
The current `deps.yo` violates three requirements that every system in §3
meets, and they are what the design must satisfy whatever the syntax:

- **Read by every consumer without the evaluator.** The resolver reads the
  manifest of every package in the transitive closure — no prelude clone, no
  `std/build`, no code from a package runs before it is chosen. The same
  reader serves `yo add`, `yo build`, `yo doc`, the LSP, and a future index.
- **Edited structurally, never as text.** `yo add` / `yo remove` / `yo update
  --latest` must insert or change an entry in place. That is only possible
  when the dependency table cannot be computed; the marker/substring
  rewriting of D7 and its commented-out-line bug are what "editing code as
  text" produces.
- **A closed grammar**, so the file can be hashed, diffed, resolved offline,
  and rendered as package metadata.

**Syntax decision (maintainer, 2026-09-11): TOML.** Two candidates satisfied
the rule and were weighed:

| | `yo.toml` (chosen) | `package.yo` — one Yo struct literal, read by a restricted parser mode (Zig's `build.zig.zon`) |
| --- | --- | --- |
| readers | anything: `std/encoding/toml` in the toolchain, every other language's TOML library, GitHub's renderer | only the `yo` binary (a new restricted-parse mode of `src/parser.yo`) |
| dependency names | any bare key (`json-yo`) | struct-literal keys must be identifiers — `"json-yo" : {…}` is a parse error today, so names would be identifier-only (Zig's rule) or the table a list of structs |
| comment-preserving edits | needs a small token-level TOML editor (Cargo's `toml_edit` shape); `std/encoding/toml.stringify` drops comments | free: the lexer keeps comment tokens and the formatter reprints them |
| new syntax in a project | one more format next to Yo | none — one syntax for code, build, packages |
| precedent | Cargo, pyproject, Go (`go.mod` is its own DSL) | Zig |

The Yo literal's advantages are identity and free comment preservation; TOML's
are universal readability, dashed names, and no new parser mode. Chosen: TOML,
accepting the cost of a comment-preserving editor in P1 (`toml_edit.yo`: a
token-span editor over `std/encoding/toml`'s lexer that inserts or replaces
one key/value in a named table and leaves every other byte alone).

`build.yo` keeps its role — it is code — and gets the manifest for free:
`build.manifest` is the parsed table injected by the runner as a comptime
struct (`build.manifest.name`, `.version`), and `build.dependency("raylib_yo")`
(a **string name**, Zig's `b.dependency(name, .{})`) returns the handle for a
manifest entry. The struct-literal forms `build.dependency({ url, ref })` and
`build.path_dependency({ ... })` are **removed**, as is `deps.yo`: `yo init`
writes `yo.toml` and a `build.yo` that imports nothing but `std/build`.
A dependency without `yo.toml` gets the defaults: name from the URL,
`default = "src/lib.yo"` → `index.yo` → `<name>.yo`, no dependencies.

### 4.2 D-2 — semver ranges over git tags, Cargo's resolver

- **Versions are git tags** `vX.Y.Z` (Go's model; no registry needed). The
  resolver lists tags with one `git ls-remote --tags` per repository (cached
  in the store for the run), parses strict semver including pre-release
  (`v1.0.0-rc.1` is a version, excluded from ranges unless the range names a
  pre-release — Cargo's rule), and ignores non-semver tags.
- **Constraint grammar** = Cargo's: `^1.2.3` (default when a bare version is
  written), `~1.2`, `=1.2.3`, `>=1, <2`, `*`; plus `tag = "..."`, `branch =
  "..."`, `rev = "<sha>"` for exact refs (a branch is resolved to a commit at
  lock time and only moves on `yo update`).
- **Resolution** = highest satisfying version, **one version per
  semver-compatible range** across the whole graph; incompatible majors of
  the same package coexist (they compile as distinct module paths, so nothing
  in codegen prevents it — Cargo semantics). Conflicts inside one major are
  errors naming both requirers. `[patch]`/`[replace]` come later if needed.
  Go's minimal-version selection was considered — simpler, lock-optional —
  and rejected because the maintainer asked for the pnpm/Cargo/bun behaviour
  and because "highest satisfying" is what a registry-less ecosystem needs
  to pick up fixes.
- **Transitive**: after choosing a version, the resolver fetches that
  package into the store (§4.4) and reads **its** `yo.toml`; breadth-first
  until closed. No `build.yo` is evaluated during resolution.

### 4.3 D-3 — `yo.lock` v2 records the graph and is authoritative

Same format family as the manifest (Cargo.lock's shape), written by
`std/encoding/toml.stringify` — a generated file needs no comment
preservation:

```toml
# yo.lock — generated by `yo add` / `yo update`; commit this file.
version = 2

[[package]]
name = "raylib_yo"
version = "0.0.6"
source = "git+https://github.com/shd101wyy/raylib_yo#v0.0.6"
commit = "973b8cb6c1e362839534df8c16a735aa8a684dc9"
integrity = "sha256-…"           # normalized tree hash, §4.4
dependencies = ["utils 2.1.4"]

[[package]]
name = "mylib"
source = "path+../mylib"         # path deps ARE recorded (no integrity: they are live)
```

- Entries sorted by (name, version); escaping is the TOML serializer's, not
  string concatenation; written atomically (temp + rename). The v1 format is
  not read — a v1 `yo.lock` is regenerated.
- `yo build` **obeys the lock**: if `yo.lock` satisfies `yo.toml` it is used
  without touching the network; if the manifest changed it is re-resolved
  (minimal change: only the affected packages move) and rewritten; with
  `--locked` an out-of-date lock is an error (CI); with `--frozen`/`--offline`
  nothing is fetched. This replaces the name-only `are_deps_cached` (D5).
- `yo update [name...]` re-resolves within ranges; `yo update --latest`
  bumps ranges in the manifest too (pnpm `--latest`).

### 4.4 D-4 — a content-addressed store with verified integrity

```
~/.cache/yo/
├── store/sha256/<64 hex>/        # one extracted tree per content hash; read-only
├── git/<sha256(url)>.git/        # bare mirrors: clone --mirror once, fetch on demand
├── index/<sha256(url)>.tags      # ls-remote results with a TTL (one run, or `--offline` forever)
└── versions/                      # untouched: `yo version` owns it
```

- The identity of a package in the store is the **hash of its normalized
  tree** (the existing `compute_content_hash`, `fetch.yo:207-336`: sorted
  DFS, CRLF-normalized, hidden dirs skipped — keep it, drop the sidecar).
  Fetch = `git -C git/<url>.git fetch origin <commit>` (into the bare
  mirror, incremental after the first time), `git archive <commit> | tar -x`
  into a temp dir named with a random suffix, hash, compare with the lock's
  `integrity` (error on mismatch, delete temp), rename into `store/`. The
  `.git` directory never enters the store; subdirectory `path` is applied
  when the module root is computed, not when hashing.
- **Verification**: on `yo install`/`add`/`update` the tree is hashed as it
  lands. On `yo build`, the artifact stamp (§4.9) includes each dependency's
  `integrity` from the lock plus a cheap per-tree marker file
  (`store/…/.yo-verified` written only after a full hash), so a tampered
  store dir is re-hashed, not trusted (fixes D4).
- Project view: none needed for the compiler — the runner passes the
  resolved module roots to the child compile explicitly (§4.5). For editors,
  `yo-out/deps/<name>` symlinks into the store are created so the LSP can
  open a dependency's source; they are outputs, not inputs.
- `yo cache clean` removes `store/`, `git/`, `index/` and nothing else;
  `yo cache gc` removes store entries no lock in a recorded project set
  references (pnpm `store prune`). Concurrency: one `flock` on
  `~/.cache/yo/store.lock` around store mutations (fixes D9).
- `GIT_TERMINAL_PROMPT=0` and `GIT_ASKPASS=echo` on **every** git child.
  ssh remotes accepted as written (`git@host:path`, `ssh://`); the last-`@`
  version split in the CLI goes away with the manifest (fixes D8).

### 4.5 D-5 — the build consumes dependencies

1. **Import mapping crosses the process boundary explicitly.** The runner
   computes, per artifact, the closed set of `(import_name → absolute root
   file)` — the project's own `[modules]`, each direct dependency's default
   module under its name, each named sub-module as `name/sub`, and
   transitively every dependency's dependencies under **their** names (Cargo
   semantics: a package sees only what it declared; two packages may see
   different versions of a shared dependency). It writes them to
   `yo-out/<triple>/<artifact>.imports` and passes `--imports <file>` to the
   child `yo compile`/`yo test`/`yo check`/`yo lsp`. `resolve_module_path`
   gains rule 0: a bare first segment that names an entry in the mapping
   resolves to that root (or `<root-dir>/<rest>.yo` for `import("dep/sub")`),
   and the mapping's absolute path is the module cache key. Nothing else in
   the resolver changes. This fixes §1.1 for path and git dependencies with
   one mechanism; the dead `_find_project_root`/`_resolve_dependency_entry_point`
   are deleted.
2. **A dependency's `build.yo` is evaluated** (when it has one) in an
   isolated registry — `swap_build_registry` exists for this — with its own
   manifest injected and its own `-D` namespace (`-Ddep.opt=v`), so that
   `dep.module("x").link(sys)` propagates system libraries and
   `dep.artifact("libfoo")` yields a real static-library node compiled to
   `yo-out/<triple>/deps/<name>-<version>/lib/`. Evaluation failures are
   reported with the dependency's name and file, never swallowed (B3).
3. **`Step.link` links.** For every linked static-library node the consumer's
   argv gains `--extern <lib>.a` (transitively through the library's own
   links); for shared libraries `-L <dir> -l<name>` and, on macOS/Linux, an
   rpath to `yo-out/<triple>/lib`. Fixes B1.
4. **`SharedLibrary` becomes real**: `yo compile --shared-library` reuses the
   static-library emission (plain exported names, static-ised runtime, no
   `main`) and links `-shared -fPIC` into `lib<name>.{so,dylib,dll}`; or the
   kind is removed from `std/build.yo` and the docs until it exists. The plan
   proposes the former in P1; the cli-case `dlopen`s the result. Fixes B2.

### 4.6 D-6 — workspaces

```toml
[workspace]
members = ["packages/*", "examples/tetris"]
```

One `yo.lock` at the root, members refer to each other with
`{ path = "../core" }` or `{ workspace = true }`, `yo build -p <member>` /
`yo test --workspace`. This is what `plans/reference/CIRCULAR_DEPENDENCIES.md`
and the std split will want; it is P3, not P1.

### 4.7 D-7 — runner correctness (the P0 list)

Each item is small, independent, and gets a cli-case:

- report `build.yo` evaluation errors and exit 1 (B3; same in `yo fetch`);
- `-D`: unknown names error with the declared list; `build.option` gains a
  typed form `build.option(bool, {...})` / `build.option(i32, {...})` /
  `build.option(enum, {...})` returning the typed comptime value (Zig's
  `b.option(T, name, desc)`), parsed and validated by the runner; `yo build
  --help` and `--list-steps` print the project's options (B4);
- `--dry-run` builds and validates the graph and prints the plan (B7);
- a failed node marks its dependents skipped, and every failure prints its
  message; `depend_on` of an unknown name is an error (B6, B12);
- `yo build run -- <args>` forwards arguments; `build.run(exe, { args })`
  for fixed ones (B9);
- registry keys are `(kind, name)`; duplicate names within a kind are
  errors; `link` resolves its target at graph-build time, not at call time
  (B11);
- `ReleaseSmall` → `--optimize s` (add `s`/`z` to `yo compile`), `Debug` and
  `ReleaseSafe` pass `-g` (B8; the pre-existing issue asked for this
  decision — the plan takes it);
- `yo cache clean` leaves `versions/` alone (D10); `resolve_git_ref` checks
  the exit status and rejects an empty ref (D2); the install-time prune (D3)
  disappears with the lock rewrite, but until then `yo install` passes the
  full dependency list; `.yo-cache/` gitignore logic and `YO_ORIGINAL_CWD`
  reads are deleted (D12); the `std/assert` import leaves the init template
  (B14).

### 4.8 D-8 — the scheduler runs a level in parallel

Artifacts already compile in child processes; the "global state" rationale is
gone. `execute_dag` spawns all ready nodes of a level up to `-j N` (default:
logical cores, but each `yo compile` child evaluates prelude + std and peaks
at 1–2 GB for a small program and 11–20 GB for the self-build, so the runner
also caps by a `YO_BUILD_JOBS_MEM_GB` heuristic and documents it). `--summary`
shows real per-node durations (`duration_ms` was 0 until P1.4f, B13).

### 4.9 D-9 — stamp granularity and inputs

`yo compile` gains `--emit-deps <file>` (the `-MD` idea): the list of every
file the evaluation opened — `.yo` modules and, after §5, `comptime_read_file`
inputs. The artifact stamp hashes **that** list plus argv, compiler version,
and the lock's integrity values of the dependencies the artifact imports,
instead of every `.yo` under the project and std. First build has no depfile
and falls back to today's whole-tree walk (minus the `.`-in-name and `tmp*`
exclusions, which become a stale-cache bug once inputs are exact: B10).

### 4.10 D-10 — later: a registry index and publishing

Not in this plan's phases; shape recorded so P1 does not preclude it. A
**static index** (Cargo's sparse index / Go's module proxy): an HTTPS tree of
`name → { repository, versions[] }` JSON files, mirrored to `index/` in the
store, so `yo add json` resolves a short name to a git URL. Publishing is
`yo publish`: verify `yo.toml`, tag `v<version>`, push the tag, and (with an
index) open a PR against the index repo. No hosted registry service is
proposed.

### 4.11 CLI surface (pnpm/Cargo/bun-convergent)

| command | does |
| --- | --- |
| `yo add <spec>` | edit `yo.toml` in place through `toml_edit` (comments kept), resolve, fetch, write `yo.lock`. Specs: `user/repo`, `user/repo@^1.2`, `https://…`, `git@…`, `./path`, `--dev`, `--path packages/x` (subdir) |
| `yo remove <name>` | inverse |
| `yo install` | fetch everything the lock names (create the lock if absent); `--locked`, `--frozen`, `--offline` |
| `yo update [name…] [--latest]` | re-resolve |
| `yo cache path / clean / gc` | store management |
| `yo build [--locked] [--frozen] [-j N] [-p member] [-- args]` | |

`yo fetch` and `yo install <spec>` are removed, not aliased.

---

## 5. Compile-time functions for the build context

The maintainer's three candidates, judged against §2 (what the evaluator can
represent, what caches must know) and §3's hermeticity column.

### 5.1 `comptime_read_file(path : comptime_str) -> comptime_str` — **yes**

Zig's `@embedFile`, with Zig's boundary rule: the path is relative to the
importing file and **must resolve inside that file's package root** (the
directory of the nearest `yo.toml`/`build.yo`, or the std root for std) —
outside is a compile error, symlinks resolved first. Returns bytes as
`comptime_str` (`len`/`slice` are byte offsets, so binary content is fine);
`comptime_embed_bytes` returning `ComptimeList(u8)`-shaped array constant is
the same builtin with a different result type, added only if a user asks.
Uses in scope: a version string, a shader or SQL file, a sibling
`package.json`,
test fixtures, a generated table — and it is the mechanism §5.2 sits on.
Evaluator: a `BF_COMPTIME_READ_FILE` handler that reads through the same
`_read_file_sync` path modules use, guarded by `ctx.is_executing` so def-time
trials and CTFE-capability probes do not touch the disk, and that records the
edge (§5.4).

### 5.2 `comptime_json_parse` / `comptime_toml_parse` — **yes, as comptime-only data**

Because no runtime container can exist at compile time (§2.2), the result
type is a prelude comptime enum:

```rust
ComptimeValue :: enum(
  Null, Bool(bool), Int(comptime_int), Float(comptime_float), Str(comptime_str),
  List(ComptimeList(ComptimeValue)),
  Table(ComptimeList(ComptimeEntry))     // ComptimeEntry :: struct(key : comptime_str, value : ComptimeValue)
);
```

with `get(key)`, `at(i)`, `as_str/as_int/as_bool` helpers in the prelude
(written in Yo over `ComptimeList`; they promote because they return comptime
types). The parsers are **builtins** (`__yo_comptime_json_parse`,
`__yo_comptime_toml_parse`) implemented in the evaluator by calling
`std/encoding/json` / `toml` at the compiler's runtime and lifting
`JsonValue` / `TomlValue` into `EvalValue.EnumVal` — the same std code, one
implementation, no CTFE promotion problem. Parse errors are compile errors
at the call site with the parser's line/column. Uses: `build.yo` reading a
sibling `package.json`, a generated bindings table, test fixtures, `yo.toml`
fields the runner does not already inject through `build.manifest`. Yo data
files need no parser builtin: `import("./data.yo")` of a file holding one
`::` binding already yields the value at compile time.

### 5.3 `comptime_fetch` — **no**; `build.fetch` as a fixed-output step — later, if needed

Reasons, each sufficient: (1) a compile that needs the network is not
reproducible and not cacheable (§2.3 — nothing can stamp a URL's content);
(2) §2.4 — `comptime_fetch` + `comptime_eval` is remote code execution at
compile time by construction; (3) it is the package manager's job — that is
what §4 builds, with a lock and integrity. Nix's discipline is the one to
copy: network only as a **fixed-output** step, `url + hash`, performed by the
build runner (not the evaluator), stored in the content-addressed store, and
recorded in the lock. If a real need appears (a prebuilt raylib archive, a
model file), it lands as `build.fetch({ url, sha256 })` returning a `Step`
whose output path other steps consume — Zig's tarball dependency with
`.hash`. Not scheduled.

### 5.4 `comptime_env` — **no** as a general builtin; `build.env(name)` in the build context — **yes**

Environment reads make evaluation depend on the invoking shell — wrong for
ordinary modules (the LSP, `check`, tests). In `build.yo` the need is real
(CI detection, `PKG_CONFIG_PATH`, choosing a default for an option), and
Zig exposes it (`b.graph.env_map`). So: `build.env(name : comptime_str) ->
Option(comptime_str)`, a `__yo_build_*` builtin that only answers when the
evaluator is running under `run_build` (elsewhere it is a compile error
naming `-D` as the alternative), and whose every read is appended to the
artifact stamp inputs so a changed variable rebuilds. Prefer `-D` in docs.

### 5.5 Plumbing shared by 5.1/5.2/5.4

- Path canonicalization exactly as `resolve_module_path` does for cache keys.
- Register `(module_abs → data_abs)` in the module loader's import graph so
  Phase-B invalidation, `check --watch` and the LSP re-evaluate when the data
  file changes; add data files to the watch poll set.
- Emit the path in the `--emit-deps` list (§4.9) so the artifact stamp
  covers it.
- `yo fmt`, `yo doc`, the LSP hover: treat the builtins like any other.
- `comptime_assert` inside fn bodies is inert (module-level only), so every
  test of these builtins asserts at module level or at runtime.

### 5.6 The alternative considered: run `build.yo` as a program

Zig and Cargo compile the build script and execute it: full language, full
std, I/O allowed, and the graph is data the program hands back. For Yo this
would mean compiling `build.yo` to a native binary (a `yo compile` costs
seconds even for a small file because prelude + std are re-evaluated, and
the self-build's is ~137 s of evaluation — a cached build-runner binary
amortizes it, as Zig does), serializing the registry across a process
boundary, and giving up the "all comptime" model that lets `yo check` verify
a build file without running anything. Rejected for now: §5.1–§5.4 cover the
concrete needs with two builtins and one build-context function, keep
evaluation pure by construction, and change nothing users have written. It
is the fallback if comptime data types (§2.2) turn out to be too limiting —
the signal would be a build file that needs a `HashMap` at compile time.

---

## 6. Phasing, gates, risks

All gates are offline: git dependencies in tests are `file://` bare
repositories created by the fixture, with semver tags. Each phase ends with
`docs/en-US` + `docs/zh-CN/BUILD_SYSTEM.md` updated for what landed, the
stale sections of `plans/reference/DEPENDENCY_MANAGEMENT.md` replaced by a
pointer here, and `AGENTS.md`'s command table refreshed.

| phase | scope | gates |
| --- | --- | --- |
| **P0 — stop the bleeding** (runner correctness, no design change) | §4.7 items; the five filed issues (B1 link via `--extern`, B2 removal-or-implement decision taken as implement in P1 — P0 rejects `SharedLibrary` with a clear error, B3, D1 root-caused and fixed, D2/D3/D10/D12); docs: `extern` example gains the pragma, ReleaseSmall/`-g`, "`--help` shows options" made true | new cli-cases: `build-link-static` (prints 7), `build-file-syntax-error` (rc 1 + `-->`), `build-unknown-option`, `build-dry-run-graph`, `build-run-args`, `install-git-pinned-ref` (offline `file://` repo; asserts the written ref, `yo.lock`, rc); `tests/internal/build_runner.test.yo` grows the scheduler/failure cases; existing `build-*`/`init*`/`cache-*` goldens stay green |
| **P1 — dependencies work** | §4.1 `yo.toml` + `toml_edit.yo` (comment-preserving key/value editor) + `yo add/remove/install/update`, removal of `deps.yo` and the struct-form `build.dependency`, §4.2 resolver, §4.3 lock v2, §4.4 store, §4.5.1 `--imports` plumbing in compile/test/check/lsp, §4.5.2 dependency `build.yo` evaluation, §4.5.3 linking, §4.5.4 shared libraries | cli-cases: `add-path-dep-import` (the §1.1 reproducer, prints 12), `add-git-dep-semver` (three tags, `^` picks highest), `add-transitive` (A→B, B's module importable from A only), `lock-locked-fails-when-stale`, `install-frozen-offline`, `store-integrity-mismatch` (tampered store dir is re-fetched), `dep-artifact-link`, `shared-library-dlopen`; `tetris_yo` un-vendors `raylib_yo` as the end-to-end proof; `yo check`/LSP resolve `import("dep")` in a fixture |
| **P2 — compile-time inputs** | §5.1 `comptime_read_file`, §5.2 `ComptimeValue` + JSON/TOML parsers, §5.4 `build.env`, §5.5 plumbing (module graph edge, watch set, `--emit-deps`) | `tests/comptime_read_file.test.yo` (root boundary error, byte content, module-level assert), `tests/comptime_json.test.yo`, cli-cases `check-watch-data-file` (editing the read file re-checks the importer), `build-cache-data-input` (second build recompiles only after the data file changes), `build-env-stamped` |
| **P3 — speed and scale** | §4.8 parallel levels + `-j`, §4.9 depfile-based stamps, §4.6 workspaces | `build-parallel-levels` (two independent artifacts overlap in `--summary` timestamps), `build-cache-per-artifact` (editing artifact A's private module does not recompile B), `workspace-members`; the self-build's `yo build` time is unchanged or better (one artifact) |
| **P4 — ecosystem** | §4.10 static index, `yo publish` | designed then, not now |

**Status (2026-09-12).** P0 landed (#577, #578). P1 cuts landed: §4.5.1
`--imports` for direct path dependencies (#581), transitive resolution
(#583), the six `io.async` lowering bugs the install flow tripped over (#592
and its stacked follow-up), and **P1.3 — the manifest** (`p1/yo-toml-manifest`):
`yo.toml` read by `src/manifest.yo` over `std/encoding/toml`; the
`import("name")` closure (own `[modules]`, each dependency's modules under its
name, transitively the dependencies' dependencies) resolved in EVERY command —
`module_manager.yo` discovers the nearest manifest above the entry file and
registers it with rule 0, so `check`/`test`/`doc`/LSP need no build, and the
runner passes the same closure as `--imports`; `yo add`/`yo remove` edit the
manifest in place through `src/toml_edit.yo` (comments kept); `yo install` /
`yo update` decide refs — semver ranges (Cargo grammar, pre-release rule)
matched against `git ls-remote --tags`, exact `tag`/`rev`, `branch` and bare
`git` pinned to commits in the v1 `yo.lock`; `deps.yo`, the struct-form
`build.dependency`/`build.path_dependency`, `add_import`/`ImportEntry`,
`build.module`'s `root`, `yo fetch` and `yo install <spec>` are removed;
`build.dependency("name")` references a manifest entry the runner validates.
Gates: cli-cases `add-path-dep-import`, `install-git-dep-semver` (offline bare
repository, `^1` picks v1.2.0), `install-no-deps`, the rewritten
`build-*-dep-*` cases; `tests/internal/{manifest,toml_edit,install_command}`.
**P1.4a — the resolver and `yo.lock` v2** (`p1/resolver-lock-v2`, stacked
on P1.3): `src/resolver.yo` walks the graph from the root manifest — every
fetched package's `yo.toml` is read, its non-dev dependencies join under
their names — and unifies EVERY requirement on a package into one ref
(`choose_ref`: the highest tag inside all ranges; exact `tag`/`rev`/`branch`
pins must agree, and a version tag pin must fit the ranges; otherwise an
error naming each requirer). One version per dependency NAME (the §4.2
two-majors relaxation is deferred — one flat import namespace). A lock entry
that still satisfies its requirements is reused without the network. Rounds
run to a fixpoint (a later requirer can move an earlier choice, which
re-expands that package). `yo.lock` v2 (`src/lock_file.yo`): `version = 2`,
`[[package]]` with `source = "git+url#ref"` / `"path+rel"`, `commit`,
`integrity`, `dependencies`; sorted, atomic write, v1 rejected and
regenerated. `src/fetch.yo` reduced to `fetch_package` (commit decision,
sidecar/lock integrity check with evict-and-refetch, a still-mismatching
refetch is an error) over the existing `deps/<name>-<commit12>` cache
layout. `--locked` / `--offline` / `--frozen` on `yo install` and `yo build`;
`yo update --latest` rewrites out-of-range `version` ranges to `^X.Y.Z`
through `toml_edit`. Gates: `tests/internal/{resolver,lock_file}.test.yo`
(unification + lock-reuse tables), cli-cases `install-transitive-git`,
`install-unifies-versions`, `install-conflicting-requirements`,
`lock-locked-fails-when-stale`, `install-frozen-offline`,
`update-latest-bumps-range`. Four compiler bugs surfaced and were fixed en
route, each with a red-first gate: a short-circuit operand inside a BARE arm/fn/
loop body dropped its temp after its C block closed
(issues/fixed/short-circuit-rhs-temp-in-bare-arm-body-drops-out-of-scope.md);
an unbound name inside an `io.async` body passed `yo check` (now a hard swallow
class, issues/fixed/async-closure-body-unknown-identifier-passes-check.md);
the async lowering of a match/cond with an awaiting arm handed the other arm's
borrowed value out without a dup — released twice
(issues/fixed/async-match-arm-borrowed-payload-released-twice.md); and
every `io.async` closure leaked its captured values — neither dispose path
released the capture struct the call site had dup'd
(issues/fixed/io-async-closure-captures-never-released.md). The bare-arm fix
itself needed a second round: the pending list it feeds is also what a
may-unwind call's `if (__yo_effect_escaped)` block drains, so the early-exit
path now honours the emitted-once set and both scope-end flushes record a
drop even when its code was written inline (the fast suite's "unwind argument
built by a may-unwind call" caught the double release; a keeper-based test in
`tests/algebraic_effects.test.yo` pins it). Closing that hole exposed a fifth,
PRE-EXISTING bug: develop's compiler already released an enum/Option-shaped
argument temp of a may-unwind call twice on the unwind path (`if(x.to_lowercase()
== "latest", …)` in `src/version.yo` — eleven functions of the compiler's own
emission), because the scope-end flushes never recorded an inline-written
multi-line drop (issues/fixed/escape-path-releases-option-temp-twice.md). **Seed floor: v0.2.31.** A
compiler built by the v0.2.30 seed mislowers `inspect_cached_dep` (a nested
match arm in an `io.async` body — the dead-arm family #592 fixed on develop
after v0.2.30), so its second `yo install` dereferences a null result; built
by develop's tip it passes. The branch therefore merges after the v0.2.31
seed bump, not before. cli-case fixture bare repositories carry a tracked
`refs/.keep` — git does not check out empty directories, and a bare repo
without `refs/` "does not appear to be a git repository".
**P1.4b — the store** (`p1/store`, stacked on P1.4a): §4.4 as designed.
`src/cache.yo` names the layout — `store/sha256/<hash>` trees with a
`.verified` sibling, `git/<sha256(url)>.git` bare mirrors,
`index/<sha256(url)>.tags`, `store.lock`, `projects` — and `src/fetch.yo`'s
`fetch_package` reuses a stored tree the lock names (no network, no hash when
the marker is present; a full hash when it is not, eviction when it fails),
otherwise brings the commit into the mirror (`clone --mirror` once, `fetch`
after, a direct commit fetch as the last resort), extracts through a
throwaway index (`GIT_INDEX_FILE`, so the mirror stays bare), hashes, and
renames the tree to its hash under the store `flock`. `manifest.yo` resolves
`import("dep")` from the lock's `integrity` alone; the runner links
`yo-out/deps/<name>` to the store trees for editors (not on Windows). The tag
index is what `--offline` reads. `yo cache clean` removes `store/`, `git/`,
`index/` and nothing else; `yo cache gc` reads every recorded project's lock
and removes the trees, mirrors and tag lists none references. Every git child
runs `GIT_TERMINAL_PROMPT=0` + `GIT_ASKPASS=echo`; a manifest `git =
"./x.git"` path is made absolute against the manifest's directory before git
(which resolves relative remotes against the child's cwd) sees it. Gates:
`tests/internal/cache.test.yo` (layout table, the integrity value validated
before it becomes a path), `fetch.test.yo` (`git_remote_url`), cli-case
`cache-gc` (install → gc keeps the tree; `yo remove` → gc drops the tree, the
mirror and the tag list), the nine git-backed cases re-recorded on the store
layout (their `ignore` files drop `git/`, `index/` and `projects`, whose names
are keyed by the sandbox path). One compiler bug surfaced: a nested bare block
`{ …await…; }` as a STATEMENT of an async cond/match arm was silently dropped
by the async lowering (the content hasher's file arm vanished and every store
tree hashed alike); the body is now flattened before analysis
(issues/fixed/async-nested-bare-block-in-loop-arm-dropped.md), and the
hasher keeps the flat shape as a seed gate.
**P1.4c — `build.manifest`, generation A** (`p1/build-manifest`, stacked on
P1.4b): the runner injects the `[package]` table into the build registry
(`manifest_fields`) before it evaluates `build.yo`, and the comptime builtin
`__yo_build_manifest_field(field)` reads it — `name` and `version` today, an
absent field and every field outside a build answering `""`. Reading the
manifest needs no evaluator, so `run_build` now loads it BEFORE the build file
rather than after. The friendly `build.manifest.name` spelling in
`std/build.yo` is **seed-gated** and deferred: a module-level binding there is
forced by its own `export(...)`, and `fixpoint-arm64.yml` bootstraps gen-1 by
running `yo build` with the SEED, which would then fail `std/build.yo` with
`Variable "__yo_build_manifest_field" not found` (the v0.2.30 seed does not
even say so — it still swallows build-file errors and prints `No build steps
defined.`). Generation B is queued in
plans/backlog/SEED_VERSION_AUTOMATION.md; until then a build file calls the
builtin directly, as cli-case `build-manifest` does.

**P1.4d — §4.5.2, a dependency's `build.yo` is evaluated** (`p1/dep-build`,
stacked on P1.4c). `build.dependency("d").artifact("lib")` was decorative: the
reference was registered and nothing read it, so the archive was never built
and the consumer's link failed with an undefined symbol. Now the dependency's
own `build.yo` is evaluated in an ISOLATED registry (`swap_build_registry`,
which existed for exactly this) with its own `[package]` table injected and its
own `-D` namespace (`-D<dep>.<opt>=v` reaches it as `<opt>`; the parent's
options do not), and the named static library is merged into this project's
registry stamped with the package it came from. `compile_artifact` then reads
that stamp: the root resolves against the DEPENDENCY's directory, the
`--imports` closure is the dependency's own manifest closure, the output lands
in `yo-out/<triple>/deps/<package>/lib/`, and the "Building …" line names the
package. The existing `--extern` path links it. Only a static library can be
consumed; a missing `build.yo`, a missing artifact and a non-library artifact
each fail with a message naming the dependency.

Two compiler bugs surfaced, both fixed rather than worked around:
`issues/fixed/entry-path-shadowed-by-an-import-root-name.md` — an entry file
whose path's first segment matches a mapped import name (`mathlib/src/lib.yo`
with `mathlib` mapped, which is exactly what this feature generates) had its
module identity rewritten by resolver rule 0, so codegen's entry-module test
matched nothing and `--static-library` exported NO symbols; rule 0 is now
switched off for the entry path (`resolve_module_path_ex`). And
`issues/build-option-value-cannot-feed-an-artifact-field.md` (OPEN, belongs to
§4.7/B4): `build.option` returns `comptime(str)` while every artifact field is
`comptime_str`, and a `fn` returning `comptime_str` does not produce a
compile-time value at its call site — so `-Dname=value` can configure NOTHING
today, and the `-D<dep>.<opt>` plumbing has no end-to-end gate until it is
fixed. Gate: cli-case `build-dep-artifact` (a path dependency whose `build.yo`
defines the library the program calls through `extern("Yo", …)`), verified red
first with `Undefined symbols: "_square"`.

**P1.4e — §4.5.4 shared libraries, and §4.5.3's other half** (`p1/shared-lib`,
stacked on P1.4d). `yo compile --shared-library` reuses the library emission
(plain exported names, no `main` wrapper — the same `is_library` path the
static mode takes) and links `-shared -fPIC` into
`lib<name>.{dylib,so,dll}`, appending the platform extension the way the static
mode appends `.a`. The runner passes the flag for a `SharedLibrary` artifact,
names the output `lib<name>`, and teaches the Building line and the cache's
existence probe the same suffix. A consumer that links one is compiled with
`-L <dir> -l<name>` plus `-Wl,-rpath,<dir>` on macOS and Linux — a shared
library is found by the LOADER at run time, so without the rpath the program
links and then dies with "image not found". The P0 mitigation (a clear
rejection, cli-case `build-shared-library-unsupported`) is replaced by cli-case
`build-shared-library`: it builds the library, links it into a program through
`extern("Yo", …)` and asserts the program's own output.
B2 is closed — `issues/fixed/shared-library-artifact-is-compiled-as-an-executable.md`.

**P1.4f — §4.7, the runner tells the truth** (`p1/runner-correctness`, stacked
on P1.4e). Four of the audit's findings, each one a case where the runner did
something silently:

- **B12** `_dfs_cycle` skipped a dependency that is not a node by bumping its
  loop counter and FALLING THROUGH — bumping it twice, so the dependency AFTER
  a dangling one was never examined. A cycle hiding behind a dangling name went
  undetected. Red-first test in `tests/internal/build_runner.test.yo`.
- **B6** a dependency name that resolves to nothing was dropped from the DAG
  without a word (`install.depend_on(<typo>)` was a no-op and the build exited
  0); a node whose dependency FAILED ran anyway, so a `run` step executed a
  program that had just failed to compile; and the `Tests failed (exit n)` /
  `Executable exited with code n` messages were computed and thrown away.
  `build_dag_checked` reports unresolvable names, `_plan_step` fails the build
  naming them, `_dependency_failed` skips dependents, and the messages print.
- **B7** `--dry-run` printed one line per REQUESTED step without building a
  DAG, validating the step or detecting a cycle, while the help text promised
  "resolve the build graph without running it". It now runs exactly the
  validation a real build runs and prints the resolved graph.
- **B4** a `-D<name>=<value>` no `build.option` declares was accepted in
  silence — a typo looked like a build that ignored you. Undeclared names are
  an error now, in the project and in a dependency's own `-D<dep>.<opt>`
  namespace, and `yo build --list-options` prints what a build file declares
  with each default and the value in force (the docs had promised `yo build
  --help` would, and nothing ever did).
- **B13** (partly) `StepResult.duration_ms` was always 0 while the docs
  described a summary showing durations; each node is timed now. The docs'
  MaxRSS column, which nothing ever measured, is marked as not measured rather
  than left as a promise.

One more compiler bug surfaced and is fixed:
`issues/fixed/nested-template-in-an-interpolation-takes-the-auto-import.md` — a
template nested inside an interpolation (`` `x${`y`}z` ``, or the natural
`` ` <- ${`, `.join(names)}` ``) lowered to
`import("std/fmt/to_string").to_string()`, because the interpolation's
sub-parse took `get_program`'s prepended auto-import as its expression. The
sub-parse uses `get_expression_program` now and propagates `has_template_spec`
upward. It bites the BOOTSTRAP too — the seed parses `src/` — so `src/` keeps
the separator bound to a variable until a seed carries the fix.

**P1.4g — §4.7 continued** (`p1/runner-part2`, stacked on P1.4f):

- **B9** a `run` step could not be given arguments (`BuildRunStep.args` was
  always empty and the CLI had no `--`). Everything after `--` now reaches the
  program, after any arguments the build file declared: `yo build run -- --port
  8080`.
- **B10**, the correctness half: the artifact input stamp walked a directory
  only when its name had NO DOT — a heuristic standing in for "is this a
  file?". Every source under `my.pkg/` or `v1.2/` was therefore invisible to
  the stamp, so editing it left the artifact "cached" and the build silently
  did nothing. The walk now asks the directory ENTRY (`file_type`), and does
  not run at all under `YO_BUILD_NO_CACHE=1`, where its answer is discarded.
  (The over-hashing half — every `.yo` under the project plus the whole std
  tree, per artifact — is §4.9's depfile work and is not addressed here.)
- **B11** build names are ONE namespace, because `resolve_dependency` answers
  artifact → test → run → doc → step and takes the first match. Only artifacts
  were checked, and only against artifacts, so a step/test/doc could take a
  name already in use and silently become unreachable. Every registration
  checks now, naming the kind that holds it; `build.run(exe)` twice names one
  node (its name is derived from the artifact) rather than duplicating it.

Gates: cli-cases `build-run-args`, `build-stamp-dotted-dir` (a `.yo` file is
added under `my.pkg/` BETWEEN two builds — a cache hit on the second is the
bug) and `build-name-collision`.

**P1.4h — §4.8, a level's nodes can overlap** (`p1/parallel-levels`, stacked on
P1.4g). B5: the scheduler computed Kahn levels and then ran every node of a
level one after another, and the docs described concurrency that never
happened. A level's ready nodes now run in batches of `-j N` — each node is an
`io.spawn`ed task, `join_all` collects them, and the results are recorded in
the batch's own order so the DAG bookkeeping is unchanged. The children those
tasks spawn (`yo compile`, a test binary, the program a `run` step runs) are
what actually overlap.

The default is **1**, deliberately: at 1 the nodes' output streams in DAG
order, which every recorded cli-case golden depends on, and a single-artifact
project — the common case, including this compiler's own build — has one node
per level anyway. `-j N` opts into overlap and then output interleaves, the way
`make -j` does; `--summary` is still printed in DAG order afterwards, with each
node's own duration (P1.4f's timing is taken INSIDE the node's task, so it
measures the node and not the batch). A `-j 0`/`-j x` is an error rather than a
silent 1.

Gate: cli-case `build-parallel-jobs` — two libraries with no edge between them
and `-j 2`, comparing only `Build Summary: N/N steps succeeded`, because the
`Building …` lines and the C compiler's chatter interleave by design.

The slice's own first draft collected the batch with `std/async`'s `join_all`,
and that was wrong in a way only one cli-case could see: `join_all` awaits each
handle in turn, and `JoinHandle.await` on an unfinished handle is a blocking
`__yo_async_poll_step` loop — nested inside `run_build`'s resumed continuation.
`async-blocking-await-inside-task` runs under `YO_ASYNC_STRICT=1` and reported
`rc(golden=1,run=134)`: C37's guard aborting every `yo build`. Outside strict
mode it would not have aborted; it would just have serialised the scheduler
this slice exists to parallelise. The batch polls `is_finished()` and awaits
`yield` now — the shape the guard's own message prescribes and the one the
file's stamp helpers already used — and `build-parallel-jobs` carries
`env=YO_ASYNC_STRICT=1` so the case that owns the feature owns its guard
(`issues/fixed/build-scheduler-join-all-nests-the-event-loop.md`).

That fixture surfaced the seventh compiler bug of this campaign:
`issues/fixed/two-externs-of-one-signature-emit-one-prototype.md`. Its program
links two static libraries and so declares two `extern("Yo", … : (fn(n : i32)
-> i32))` symbols — the SAME type — and codegen registered extern callees in a
map keyed by `type_key`, so the second overwrote the first and only one
prototype was emitted. Nothing ever looked an entry up by that key (both
consumers iterate `.values()`), so the collision had one pure effect: a call
with no declaration. It is keyed by the C symbol name now. `-O2` had been
hiding the class: `run_compile` passed `-Wno-everything` and then a bare
`-Wimplicit-function-declaration`, which DOWNGRADES clang's default error to a
warning — it is `-Werror=implicit-function-declaration` now, matching what the
`-O0` arm already gets from clang's defaults.

**B13 — the rest of the write-only state** (`p1/writeonly-state`, stacked on
P1.4h). Every field the audit listed is now either read or gone:

- `TestSuite` grew `verbose`, `bail` and `parallel`. The evaluator's
  `BuildTestSuite` had carried them and the runner had forwarded them to the
  child `yo test` all along — `std/build.yo` simply never surfaced them, so the
  builtin hard-coded `verbose : false, bail : false, parallel : 1` and a build
  file could not ask. (`target` was already read; the audit row was stale.)
  `parallel` is forwarded and still inert at the far end — `yo test` v1 takes
  the flag for CLI compatibility and runs sequentially — so the cli-case can
  only gate `verbose` and `bail`; the field is surfaced so the BUILD FILE is
  not the thing that loses it.
- `DocConfig.logo` and `.favicon` travelled to `BuildDocConfig` and stopped
  there. They reach `DocModel` now: the sidebar gets an `<img class="logo">`
  and the page head a `<link rel="icon">`. `yo doc` grew the matching `--logo`
  and `--favicon` flags, so the two surfaces agree.
- `DocConfig.include_deps` is DELETED. It promised documentation of the
  dependency closure and nothing ever read it; there is no design behind it to
  preserve. The builtin keeps the argument SLOT, passed a literal `false`,
  because the seed's `__yo_build_doc` still requires ten arguments — scheduled
  for removal in `plans/backlog/SEED_VERSION_AUTOMATION.md`.
- `runtime_files` is DELETED, all the way down. `PkgConfigResult` declared it,
  `_merge_into` deduplicated it, `BuildArtifact` carried it and `run_build` ran
  a 25-line dedup loop over it — and NOTHING ever pushed a value into it, at
  any layer. Copying a linked DLL next to the executable is a real feature for
  Windows, and it will be designed when it is built rather than left standing
  as a field that cannot be non-empty.

`ExecutionContext.dry_run` and `StepResult.duration_ms` were the two rows
handled earlier, in P1.4f.

Gates: cli-cases `build-test-suite-flags` (the suite asks for verbose + bail, so
the third test's name must be ABSENT from the output) and `doc-logo-favicon`.

**§4.9 — the stamp hashes what the compile actually read** (`p1/depfile-stamps`,
stacked on B13). This is audit B10's remaining half: the artifact input stamp
hashed **every** `.yo` under the project plus the whole std tree, per artifact,
so an edit anywhere invalidated everything and a two-artifact project paid the
walk twice.

`yo compile --emit-deps <file>` writes the evaluation's real input list — one
path per line, first-open order, no duplicates. The record is kept in
`module_manager.yo` at the two places a source file is actually read: the entry
module in `mm_load_file` and every demand-loaded module in
`_load_module_at_abs`. (`run_compile` reads the ENTRY itself rather than through
`mm_load_file`, so it reports its own open — otherwise the depfile would omit
the one file the artifact is named after.) The list is reset per compile, since
`run_compile` is reached repeatedly in a long-lived process.

`_artifact_input_stamp` then hashes the PREVIOUS build's list instead of walking
anything. Using last build's list is sound because a new input cannot appear
without an old input changing — something has to import it, and that importer is
on the list; a file that LEFT the closure over-invalidates exactly once, and the
next depfile no longer names it. The first build has no depfile and falls back
to the whole-tree walk, which is also what a deleted input falls back to (an
unreadable listed path disables the cache).

`yo.toml` and `yo.lock` are hashed explicitly on both paths. They are inputs to
RESOLUTION, not to evaluation, so no depfile names them — but either one changes
what `import("dep")` means. Both are optional, so an absent one is not an error.

Not addressed: `comptime_read_file` inputs, which do not exist yet — when §5.1
lands, recording them through the same list is what makes
`build-cache-data-input` (P2's gate) possible.

Gate: cli-case `build-depfile-scoped-stamp` — build, `yo init src/added
--no-skills` adds a subtree of `.yo` files nothing imports, build again. The
second build must report `(cached: inputs unchanged, skipping compile)`; before
this slice it recompiled, because the new files were inside the walked tree.

`build-stamp-dotted-dir`'s expectation INVERTS here, and its `opts` say so: the
case was P1.4g's proof that the walk descends a dotted directory, and it asserted
a recompile. The file it adds is not an input, so a cache hit is now the right
answer. The dotted-directory fix stays load-bearing — `_cache_collect_yo_files`
is the first-build fallback — but it can no longer produce a STALE cache, because
the walk's stamp is only ever COMPARED, never recorded; the recorded stamp comes
from the depfile the child just wrote.

**The plan is COMPLETE as of 2026-09-13**: P0, P1, P2 (§5.1, §5.2, §5.4) and
P3 (§4.6, §4.8, §4.9) have all landed. P4 (registry, `yo publish`) stays
designed and deliberately unscheduled — §4.10 records its shape so nothing here
precludes it.

**§5.1 — `comptime_read_file`** (landed). `comptime_read_file(path)` reads a
file during evaluation and yields its bytes as a `comptime_str`, bounded the way
Zig bounds `@embedFile`: the path resolves against the IMPORTING FILE (never the
process cwd, which would give one module different answers depending on where
`yo build` ran), and it must land inside that file's package root — the nearest
`yo.toml` above it, else the nearest `build.yo`, else its own directory. The
check runs on the lexically folded path, so `..` cannot climb out and back in.
Outside the root, and a missing file, are compile errors at the call site.

The read is an INPUT EDGE, which is what makes it safe to cache: it records into
the §4.9 list, so `--emit-deps` names the data file and the artifact stamp
invalidates when it changes. Without that a build would cache over an edited
data file forever.

That edge needed the input record reachable from both the module loader and an
evaluator builtin, which is an import cycle (the module manager imports the
evaluator), so the registry moved out of `module_manager.yo` into
`src/input_record.yo`. A definition-time trial or CTFE probe does not touch the
disk — it computes its path from placeholder arguments — and gets the type with
an unknown value instead.

Gate: `tests/comptime.test.yo` — a module-level `::` binding (so the read really
happens at compile time), a `comptime_assert` on the bytes, runtime asserts on
the content and byte length, a `..` path that stays inside the root, and three
`comptime_expect_error` cases: an absolute path outside the root, a `..` that
climbs out, and a missing file. Verified RED first (`E0401: Variable
"comptime_read_file" not found`).

Note carried into §5.2: `comptime_str.len()` does not fold at compile time —
not for a `comptime_read_file` result and not for a plain literal either — so
the length assert is a runtime one.

**§5.2 — `comptime_json_parse` / `comptime_toml_parse`** (landed). Both take a
compile-time string and return a `ComptimeValue`, the prelude enum modelling a
document with comptime scalars and `ComptimeList`. Composed with §5.1 —
`comptime_json_parse(comptime_read_file("./config.json"))` — a configuration
file becomes constants, and a wrong parse fails to COMPILE rather than at run
time.

Two departures from the design as drafted, both forced by the language and both
verified by probe before any code was written:

- **`ComptimeEntry` is not expressible.** The plan sketched
  `Table(ComptimeList(ComptimeEntry))` with `ComptimeEntry.value :
  ComptimeValue`. Those are mutually recursive TYPE definitions and the
  evaluator rejects them ("cyclic definition: CE → CV → CE"). The landed shape
  is PARALLEL `keys` and `values` lists — exactly what `std/encoding/json`'s
  `JsonValue.Object` and `std/encoding/toml`'s `TomlValue.Table` already use,
  and it needs only `Self`.
- **A recursive enum must say `Self`, not its own name.** `CV ::
  enum(… ComptimeList(CV))` is the same cyclic-definition error.

The parsers are NOT reimplemented: `std/encoding/json` and `std/encoding/toml`
run at the COMPILER's runtime and their `JsonValue` / `TomlValue` results are
lifted into `EvalValue`. One parser, one set of bugs, and the std code never has
to be comptime-evaluable. A parse error is a compile error at the call site
carrying the parser's own position.

JSON has one number type, so a whole-valued number lifts to `.Int` — `{"port":
8080}` reads back as an integer, not `8080.0`. The cut is on the value, not the
spelling, because the document cannot tell them apart.

`ComptimeValue.get` is written in Yo over `ComptimeList` rather than as a
builtin: a prelude binding that names a builtin the SEED lacks fails the
bootstrap (the AGENTS.md pitfall), and the walk needs no evaluator support that
`ComptimeList` does not already have.

Gate: `tests/comptime.test.yo` — both documents describing one configuration,
~12 module-level `comptime_assert`s over `get`/`at`/`len`/`as_str`/`as_int`/
`as_bool`/`is_null` including a missing key and an out-of-range index, a
cross-check that the JSON and TOML trees agree, runtime asserts, and
`comptime_expect_error` on a malformed document of each format (both verified
directly to be real compile errors, not swallowed).

The dogfooding milestone below — un-vendoring `vendor/markdown_yo` — is now
unblocked: every piece it named (the manifest, the resolver, the store,
`--imports` in every command) is on develop.

**§5.4 — `build.env`** (landed). A build file may read environment variables;
nothing else may. `build.env(name, fallback)` gives the value or the fallback,
and `build.env_is_set(name)` answers whether it is set at all.

Two departures from the design as drafted:

- **Two functions, not one returning `Option(comptime_str)`.** The evaluator has
  no helper to instantiate `Option(comptime_str)` from a builtin, and building
  that machinery for one call site is disproportionate. The pair is strictly as
  expressive — `env_is_set` is exactly the distinction an `Option` carries — and
  it reads better at the call site than unwrapping.
- **The `std/build.yo` wrapper landed in the SAME release as the builtin**,
  which the generation-A/B rule says is impossible. Measured: it is impossible
  only for a module-level `::` VALUE binding, which its own `export(...)`
  forces. A FUNCTION wrapper's body is deferred, so the seed evaluates
  `std/build.yo` cleanly and only a build file that CALLS it fails. The
  repository's own `build.yo` therefore must not use `build.env` until
  `SEED_VERSION` carries the builtin — `fixpoint-arm64.yml` bootstraps gen-1
  with the seed — but every other project can use it today. `AGENTS.md`'s
  pitfall is corrected to say which shape breaks.

Both guarantees the section asks for hold. Outside a build file the builtin is a
compile error naming `-D` as the alternative, so an ordinary module cannot make
its meaning depend on the invoking shell. And every read — including an
`env_is_set` probe, since existence is what the build branched on — is folded
into the artifact stamp.

Gate: cli-case `build-env-read` reads a variable the case sets and one it does
not, in both forms, reporting all four through step descriptions. The stamp half
cannot be a cli-case (the harness cannot vary `env=` between steps) and was
verified directly: build, rebuild with the same environment → `(cached: inputs
unchanged, skipping compile)`, rebuild with the variable CHANGED → recompiles.

**§4.6 — workspaces** (landed). A repository-root `yo.toml` declares
`[workspace] members = [...]`; each member is an ordinary package with its own
manifest and build file. `yo build -p <name>` builds one member — resolving it
to that member's build file is the whole implementation, since `project_dir` is
that file's parent and everything downstream derives from it — and `yo test
--workspace` runs every member's tests in ONE run with a single summary.

A member is named by its `[package] name`, not its directory: that is what a
member is called everywhere else (`import("name")`, `build.dependency("name")`).
A name no member declares lists the ones that do, rather than failing with
"build file not found".

Member patterns are relative paths with `*` allowed in the LAST segment only —
a member is a path INTO the workspace, not a tree search, and `packages/*/x/*`
would make "which directory owns the lock" ambiguous. An absolute pattern or one
containing `..` is rejected for the same reason. A literal member without a
`yo.toml` is an error naming the pattern (a typo should not silently build a
smaller workspace); a glob match without one is skipped, because a glob is a
filter by construction. Members are visited in sorted order, so output is stable
across platforms — raw `read_dir` order is not.

Not included, and not needed by anything today: `{ workspace = true }`
dependency inheritance and a single root `yo.lock`. Members refer to each other
as ordinary path dependencies, which has worked since P1.3, and each carries its
own lock. Both are additive when a second version of one dependency across two
members actually becomes a problem.

Gates: cli-cases `build-workspace-member` (a fixture exercising BOTH pattern
forms — `packages/*` and `examples/demo` — whose root build file deliberately
builds nothing, so an ignored `-p` fails the case) and `test-workspace`. The
error paths were verified directly: `-p` with an unknown name lists the members,
and both `-p` and `--workspace` inside a plain package say so rather than
degrading silently.

A codegen defect was filed here and has since been RETRACTED
(`issues/retired/async-body-local-read-by-two-matches-is-emitted-twice.md`). The
claim was that a local bound in an `io.async` `while` body and read by two
separate `match`es is DECLARED twice in the emitted C. It does not reproduce:
three reduced variants emit clean C, and so does the real
`expand_workspace_members` with `_split_member_pattern` inlined back in — 132 MB
of emitted C through `clang -fsyntax-only`, 0 errors, which is decisive because
`redefinition` is exactly what that mode reports.

The build that prompted the file had **two** C errors, and the first was an
`IoExn`-for-`Exception` mismatch at a call site into the same async body. I read
only the error I recognised. The duplicate declaration was a symptom of that
malformed state machine, not an independent defect in local spilling. The
lesson — read the whole error list before attributing one of them — is recorded
in the retired doc. `_split_member_pattern` stays on readability grounds.

**Dogfooding milestone (maintainer, 2026-09-11): un-vendor `vendor/markdown_yo`.**
The compiler itself imports the Markdown renderer by submodule path
(`src/doc/render_html.yo` → `import("../../vendor/markdown_yo/src/lib.yo")`);
the target is `import("markdown_yo")` resolved through the repo-root
`yo.toml` and the store, with the submodule deleted. This is the end-to-end
proof for P1.3/P1.4 on the compiler's own build. It is SEED-GATED twice over:
the seed that compiles `src/main.yo` must resolve the manifest import (or be
handed `--imports markdown_yo=<store path>` by the bootstrap scripts — the
seed gains `--imports` with v0.2.31), and CI must fetch the dependency before
the seed compile. So: land P1.3 first, then un-vendor in a PR that also
teaches `scripts/bootstrap/*` and the workflows to fetch/`--imports` it, once
a seed with `--imports` is published.

Sequencing: P0 is independent and small — land it first, it makes P1's
failures visible. P1 is the campaign; §4.5.1 (`--imports`) is its first cut
because it alone fixes §1.1 for path dependencies and is what every later
gate stands on. P2 needs nothing from P1 except the `--emit-deps` hook it
shares with P3; it can run in parallel with P1's back half. P3 after P1.

Risks and how the plan bounds them:

- **Seed gating.** New `yo compile` flags (`--imports`, `--emit-deps`,
  `--shared-library`, `--optimize s`) are absent from the seed release that
  builds this tree. The repo-root `build.yo` declares no dependencies and uses
  `ReleaseSmall`, so P0's `-Os` mapping must wait one release or be gated on
  `CURRENT_YO_VERSION` in the runner (`plans/backlog/SEED_VERSION_AUTOMATION.md`
  is the scheduling point). Every phase lists its seed-gated items in its PR.
- **`io.async` lowering bugs in CLI code** (D1 is one; `build-smoke-hangs-…`
  was another): the CLI subsystems are the compiler's largest consumers of
  `io.async`, and their bugs surface as silent wrong behaviour. Every P0/P1
  PR runs the full `tests/cli-cases` corpus with a gen-2 binary (the
  bootstrap veil: a codegen fix takes effect one generation later).
- **Memory in the parallel scheduler** (§4.8): default `-j` is capped by a
  memory heuristic; the self-build is one artifact and unaffected.
- **Two majors of one package in one binary** (§4.2): module paths differ so
  compilation works, but `dyn`/trait registries are keyed per type and a type
  from `json 1.x` is not `json 2.x`'s — the same as Cargo, and the diagnostic
  must say so. A cli-case with two majors pins the behaviour.
- **Breaking changes land outright** (maintainer decision 2026-09-11: Yo
  has one user; no deprecation windows, aliases, or migration shims).
  `deps.yo`, struct-form `build.dependency`/`build.path_dependency`, `yo
  install <spec>`, `yo fetch`, and the v1 `yo.lock` format are removed in the
  P1 PR that replaces them; the docs get a one-paragraph migration note. The
  only compatibility constraint that remains is the seed gate above.

## 7. Documents this plan supersedes or corrects

- `plans/reference/DEPENDENCY_MANAGEMENT.md` — §9 (dependency artifacts), §10
  (transitive), §11 (`deps.yo`), §12 items 1–4: describe the TS compiler; to
  be replaced by pointers here when P1 lands. §1–§8 remain accurate for the
  fetch half until §4.1–§4.4 replace them.
- `plans/reference/BUILD_SYSTEM.md` — the runner sections that assume
  in-process compilation and the "artifact compilations are serialized (the
  Yo evaluator uses global state)" rationale.
- `docs/*/BUILD_SYSTEM.md` — "Cross-Module Linking" (needs the pragma; does
  not link today), "Modules" / "Importing a Module from a Dependency" /
  shared-dependency dedup (never runs), `--help` listing options, the
  `Optimize` flag table, `SharedLibrary`.
- `plans/archive/P2_5_RETIRE_EXECUTION.md:420` — the step-11 decision is
  this document.
