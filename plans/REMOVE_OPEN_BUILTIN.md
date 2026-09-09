# Remove the `open(...)` builtin

**Status: ACTIVE — decided 2026-09-09 (user), nothing landed yet.**
Branch `remove-open-builtin` (worktree `/private/tmp/yo-remove-open`, based on
`develop` @ `3d924b5fb`).

`open(...)` is removed from the language. Every module glob import becomes a
named import (`{ String } :: import("std/string")`), every struct open becomes
the existing runtime destructuring (`{ x, y } := s`), and the builtin, its
evaluator and codegen handlers, its test and its keyword are deleted.

---

## 1. What `open` is today

One keyword, two features, dispatched builtin-first from
`src/evaluator/exprs/_expr.yo` (`evaluate_open`, `src/evaluator/exprs/open.yo`,
336 lines) and `src/codegen/exprs/generation.yo` (`generate_open`,
`src/codegen/exprs/open.yo`, 66 lines):

| form | what it does | scope |
| --- | --- | --- |
| `open(import("m"))` / `open(module_value)` | binds every export of a module value as a fresh comptime variable in the current frame | compile-time only |
| `open(struct_value)` | binds every field as a fresh variable; for a runtime struct records `ExprInfo.runtime_destructurings` so codegen emits field extraction | runtime + comptime |

Measured on `develop` @ `3d924b5fb`:

| tree | files with `open(import` | lines |
| --- | --- | --- |
| `src/` | 266 | 370 |
| `std/` | 66 | 90 |
| `tests/` (incl. `tests/cli-cases` fixtures, 35 files) | 428 | 687 |
| `vendor/markdown_yo` | 30 | 32 |

Of the 370 lines in `src/`, 271 open `std/string` and 74 open `std/fmt`.
Non-import opens: **10 sites, all in tests** — `open(GlobalAllocator)` ×2
(module value), `open(ModuleC)` / `open(my_module)` / `open(SomeModule)` in
`tests/module.test.yo` (module values), and 5 struct opens
(`tests/basic.test.yo` "Test 'open' statements" ×4,
`tests/module_struct_unification.test.yo` "open on struct-typed values").
Zero non-import opens in `std/` or `src/`.

## 2. Why remove it

- **Silent shadowing.** `add_variable_to_env` (`src/env.yo`) never checks for
  an existing name and `find_variable_in_env` is last-wins. Two opens exporting
  the same name, or an open followed by a same-named local definition, pick
  the later binding with no diagnostic.
- **A second resolution path that drifts.** Open rebuilds each export's
  declared type from the module's struct type while the named import reads it
  directly; that split already shipped one bug
  (`issues/fixed/open-import-retypes-integer-constants.md`: every non-`i32`
  exported integer constant was unusable through `open`).
- **Tooling.** Every opened name is bound with `ast_expr_token(arg_expr)` — the
  token of the `import(...)` argument — so LSP definition/rename/references on
  an opened `String` resolve to the `open(` line, not to the definition.
- **Incremental compilation** (`plans/INCREMENTAL_COMPILATION_ZIG_LESSONS.md`).
  A file that opens `std/string` depends on the module's whole export SET:
  adding an export anywhere in it can change name resolution in 266 files.
  Named imports give exact per-definition edges.
- **It squats a common identifier.** Builtin-first dispatch
  (`issues/builtin-name-shadows-user-definition.md`) means a bare `open` can
  never be libc's `open`; `src/module_manager.yo::_read_file_sync` already has
  to write `fcntl.open` for exactly that reason.
- **Struct open is a redundant spelling.** `{ x, y } := point` exists
  (`src/evaluator/exprs/destructuring_assignment.yo`) and shares the same
  `runtime_destructurings` channel. Zero production users.

The compiler itself needs ONE name from the module it opens most (`String`).
Unqualified uses of the other `std/string` exports across `src/`: `rune` 109,
`StringBuilder` 41, `Pattern` 10, spread over 30 files. The `std/fmt` opens
use `println` 204, `eprintln` 88, `print` 29, `ToString` 26, `Format` 12,
`eprint` 4, `FormatSpec` 4 (counts over `src/`+`std/` files that open it).

## 3. Migration rules

Apply mechanically, then let `yo check` find every missed name — a dropped
name is an unbound-identifier error, never a silent behaviour change.

1. **Module glob → named import, one statement, same line.**
   `open(import("P"));` → `{ A, B, ... } :: import("P");` listing exactly the
   names the file uses unqualified from that module's export set. The
   replacement stays on the SAME LINE so line numbers in error goldens
   (`tests/cli-cases/*/expected*`, `comptime_expect_error` line refs) do not
   move.
2. **Module value open → destructure the module.**
   `open(GlobalAllocator);` → `{ malloc, free } :: GlobalAllocator;` (already
   the idiom in `src/module_manager.yo`). Same for `open(ModuleC)` etc.
3. **Struct open → destructuring.** `open(s);` → `{ x, y } := s;` for runtime
   structs; for the comptime `anony :: { x : 12, y : 13 }; open(anony);` case
   use the comptime destructuring form the same test file already exercises
   (`{ x } := v1` at `tests/basic.test.yo:1055`). If a comptime
   `{ a, b } :: struct_const` spelling turns out not to exist, the test
   documents `anony.x` field access instead — do NOT add a new feature to
   replace `open`.
4. **Export sets are the source of truth for what a glob brought in.**
   `std/string` → `String, StringError, StringChars, StringCharIndices,
   StringBytes, StringLines, Pattern, StringBuilder, rune,
   to_lowercase_bytes, to_uppercase_bytes, to_upper_code_point,
   to_lower_code_point`; `std/fmt` → `ToString, Format, FormatSpec, println,
   print, eprintln, eprint`; `std/error` → `Error, AnyError, error_is,
   Context, Exception, ResumableException, IoExn`;
   `std/collections/array_list` → its export list. For any other module read
   its `export(...)`.
5. **Name collisions surface, do not vanish.** If a file used a name that two
   opens both exported (currently last-wins), the named import will make the
   ambiguity explicit; resolve it by importing from the module the code
   actually meant, and note it in §6 — that is a latent bug found, not
   migration noise.
6. **Formatting.** `yo fmt` twice on every touched `.yo` file, then
   `yo fmt --check` (one path per call). fmt is not a syntax gate; the check
   gates below are.

### Script sketch (PR 1 bulk step)

For each `.yo` file: for each `open(import("P"))` line, compute
`used = exports(P) ∩ identifiers_used_unqualified(file)`, emit
`{ used... } :: import("P");` in place (or delete the line if `used` is
empty — replacing with a blank line if a later golden depends on the line
count, which only matters inside `tests/cli-cases/*/fixture`). Identifier
scan is a word-boundary token scan minus string/comment contents; over-approx
is fine (an unused named import is legal), under-approx is caught by `check`.
Keep the script in the scratchpad, not the repo.

## 4. Sequencing — two PRs, no seed gate

Named imports are old syntax, so the seed compiler (v0.2.29) compiles the
migrated tree unchanged. There is no two-release dance.

### PR 1 — migrate every consumer off `open` (compiler still accepts it)

Touches, in this order (each step: `yo check` the tree it touched):

| # | scope | notes |
| --- | --- | --- |
| 1a | `std/` (66 files) | `yo check ./std` with `YO_STD=<worktree>/std` |
| 1b | `src/` (266 files) | `yo check ./src`; then `yo build` — note `yo build` resolves std from the SEED bundle unless `YO_STD` is set (memory: build-resolves-std-from-seed) — set it |
| 1c | `tests/` language files (~393) | run the migrated files via `yo test` with the TREE-BUILT compiler, never the seed |
| 1d | `tests/cli-cases/*/fixture` (35 files) | same-line replacement; rerun the FULL cli-diff scorecard, not just the touched cases |
| 1e | `tests/internal/*.yo` | they are compiler-internal tests that themselves `open(import(...))` at the top; migrate, run the touched files one at a time |
| 1f | `vendor/markdown_yo` (30 files) | COMPANION commit upstream, fetch over https, bump the submodule pointer (memory: vendor companion commits) |
| 1g | docs: `docs/{en-US,zh-CN}/{DESIGN,STRINGS,DEFINITION_ORDER,STD_SYS_MODULE}.md` | DESIGN.md "Module importing and exporting" drops the `open(import(...))` row; DEFINITION_ORDER drops "opens" from the ordered-statement list; both languages |
| 1h | `.github/instructions/{yo-syntax,yo-design,debugging}.instructions.md`, `.github/skills/{yo-syntax,yo-core-patterns,yo-async-effects,yo-wasm-integration}/*.md` | editing `.github/skills/*` flips SIX cli-case tree goldens (init*, skills-install*) — re-record with the IN-REPO binary |
| 1i | `.github/workflows/{install-scripts,release}.yml`, `scripts/{install.sh,install.ps1,bootstrap/probe-stack-sizing.sh,build_site.yo}` | smoke programs `open(import("std/fmt"))` → `{ println } :: import("std/fmt")` — works on the seed AND the candidate, so the release smoke stays green across the removal |
| 1j | `plans/README.md` | add this doc to the active list |

PR 1 exit gates (all with a tree-built `--optimize 2` binary, one heavy job at
a time):

- `yo check ./std`, `yo check ./src` green.
- `yo build` green; `S1=/tmp/yo-s1 P=local bash scripts/bootstrap/gates_fast.sh`
  and `fixpoint_only.sh` green (S1 copied OUTSIDE the repo).
- `yo test ./tests --exclude tests/internal --exclude tests/cli-cases --bail`
  green (~30 min).
- `tests/internal` — run every migrated file (all of them open std/string at
  the top), ONE AT A TIME.
- Full `scripts/cli-diff-test.sh` scorecard: only the six skill-tracking tree
  goldens may change, and only in the skill-file content.
- `grep -rn 'open(' --include='*.yo' std src tests vendor` returns only the
  libc `open(` calls inside `src/codegen/async/runtime_io_*.yo` C strings and
  method calls (`File.open`, `fcntl.open`).

### PR 2 — delete the builtin

Deletion inventory (every site that names the builtin; `grep -rn BK_OPEN`):

| file | change |
| --- | --- |
| `src/evaluator/exprs/open.yo` | delete |
| `src/codegen/exprs/open.yo` | delete |
| `src/evaluator/exprs/_expr.yo` | drop the `BK_OPEN` import (l.55), the `evaluate_open` import (l.226) and the dispatch arm (l.861–862) |
| `src/codegen/exprs/generation.yo` | drop the `BK_OPEN` import (l.98), `generate_open` import (l.134), dispatch (l.812) |
| `src/expr.yo` | delete `BK_OPEN :: "open"` (l.21) and its export (l.542) |
| `src/main.yo` | test-runner import scan: drop the `open import "path"` pattern (l.41 import, l.170–176) |
| `src/lsp/completion.yo` | drop the `"open"` keyword (l.144) |
| `src/value.yo:942` | fix the doc comment that cites `evaluate_open` |
| `src/diagnostics_registry.yo:448`, `src/evaluator/context.yo:1006,1222` | forward-reference message: "imports, opens, pragmas and runtime bindings" → "imports, pragmas and runtime bindings"; re-record the cli-case goldens that carry the text (`check-forward-ref-*`) and update `docs/*/DEFINITION_ORDER.md` + `yo-syntax.instructions.md` which quote it |
| `tests/internal/open.test.yo` | delete (its single test covers `evaluate_open`) |
| `tests/basic.test.yo`, `tests/module.test.yo`, `tests/module_struct_unification.test.yo`, `tests/ptr.test.yo` | already migrated in PR 1; in PR 2 add ONE `comptime_expect_error` test asserting `open(x)` is now an ordinary unknown-function error (prefer `comptime_expect_error` over gate tests) |
| `src/expr_info.yo` `runtime_destructurings` | **KEEP** — still fed by `destructuring_assignment.yo` and read by `codegen/types/collection.yo` and `codegen/exprs/init_assignment.yo` |

PR 2 exit gates: `yo check ./src`, `yo build`, `gates_fast.sh` +
`fixpoint_only.sh`, the four edited language test files, `tests/internal` files
that import `_expr.yo`/`generation.yo` closures, the full cli-diff scorecard,
`grep -rn BK_OPEN src` empty. The diff must be pure deletion plus the message
text; no new mechanism.

## 5. Risks and rules that bite

- **Main checkout is shared with a peer session** — all work happens in the
  `/private/tmp/yo-remove-open` worktree; never `checkout -b` in the main tree.
- **Fresh worktree vendor submodules are empty** — done
  (`git -c protocol.file.allow=always submodule update --init`).
- **Line-number goldens.** Same-line replacement everywhere inside
  `tests/cli-cases/*/fixture`; a blank line rather than a deleted line if an
  open brought in nothing the file uses.
- **Over-long named-import lines.** `yo fmt` wraps `{ a, b, c } :: import`
  across lines when long; inside fixtures that would move line numbers — keep
  fixture imports short (only names actually used) so they stay on one line,
  and re-record the golden if fmt still wraps.
- **The forward-ref message change lands in PR 2, not PR 1**, so PR 1's
  cli-case diff is fixture-only.
- **Two `yo test` runs in one worktree collide** on `tests/.yo_selftest_batch_*`;
  canaries go in a different worktree while the suite runs.
- **Never edit std/src/tests while a gate runs there.**
- **Squash-merge with `--delete-branch`**; check `mergeable` before deleting.

## 6. Findings en route

(Append here: every name collision §3.5 surfaced, every file whose open
turned out to bring in nothing, any test that only passed because of
last-wins shadowing.)

## 7. Closing

When PR 2 lands: banner this doc `LANDED <date>`, move it to
`plans/reference/`, update `plans/README.md`, and add the removal to the
syntax cheatsheet's "removed forms" note so a future session does not
reintroduce `open`.
