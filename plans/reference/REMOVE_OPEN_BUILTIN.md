# Remove the `open(...)` builtin

**Status: LANDED 2026-09-10** — one PR off `develop` @ `3d924b5fb`
(branch `remove-open-builtin`), with the companion commit
shd101wyy/markdown_yo@a46f700 in the vendored library. This is now a closed
record: the migration rules in §3 and the findings in §6 are the reference for
anyone reading a historical `open(...)` in an archived doc.

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
- **Nothing is lost: `open` is pure sugar.** Spread destructuring already
  covers both halves — `{ ... } :: import("std/string")` is a glob import
  (verified 2026-09-09 by compiling and running it), `{ ... } :: SomeModule`
  destructures a module value and `{ ... } :: p` / `{ x, y } := p` a struct.
  So the removal deletes a second spelling, not a capability, and the
  migration has an exact target for every form.

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
4. **Export sets are the source of truth for what a glob brought in**, and a
   directory module's set is what its `index.yo` re-exports — NOT every file
   in the directory. `std/string` → `rune, String, StringError, StringChars,
   StringCharIndices, StringBytes, StringLines, Pattern, FromString,
   ParseIntError, ParseFloatError, ParseBoolError, Alignment, StringBuilder`
   (the `unicode.yo` helpers are NOT in it — `index.yo` spreads only
   `rune`/`string`/`string_builder`); `std/fmt` → `ToString, Debug, Format,
   FormatSpec, StringBuilder, Alignment, println, print, eprintln, eprint`;
   `std/error` → `Error, AnyError, error_is, Context, Exception,
   ResumableException, IoExn`. For any other module read its `export(...)`,
   following `...(m)` spreads.
4b. **A module can export nothing.** `std/math` has no `export(...)` at all —
   it only registers inherent methods — so its open bound zero names and the
   faithful replacement is a bare `import("std/math");` (a form that already
   appears in `tests/math.test.yo`). Same for any open whose export set and
   the file's identifiers do not intersect: replace with a bare import, never
   delete the line, or the module's impls stop being registered.
5. **Name collisions surface, do not vanish.** Three cases, in the order the
   script applies them:
   - **Same module opened twice at file scope** — identical bindings, so the
     names stay on the FIRST open (a use between the two must still resolve)
     and the repeat degrades to a bare re-import.
   - **Two different modules exporting one name, both at file scope** — keep
     it on the LATER open, which is what today's last-wins lookup resolves to.
   - **An INDENTED open** binds inside its own block: never move names between
     it and a file-scope open, in either direction. (Getting this wrong is
     silent: the block keeps compiling because the outer binding is in scope,
     or the outer code breaks while the block still works.)
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

## 4. Sequencing — ONE PR, no seed gate

Named imports are old syntax, so the seed compiler (v0.2.29) compiles the
migrated tree unchanged. There is no two-release dance.

**Deviation from the original two-PR plan (2026-09-09).** The migration and the
deletion shipped as ONE pull request. The split's only benefit was keeping the
first PR's cli-case diff fixture-only; against that, each PR needs the whole
local battery — two self-builds, two `gates_fast`/`fixpoint` runs and two
30-minute suites — on a machine that can only run one at a time, plus a second
CI cycle. Validated as one change instead: the migration was built and proven
green on its own first (`yo build` at f2c99ecf5 + the migration), then the
builtin was deleted on top and the full battery ran once over the result. The
step tables below are the record of what was done, in order.

### Step 1 — migrate every consumer off `open` (compiler still accepts it)

Touches, in this order (each step: `yo check` the tree it touched):

| # | scope | notes |
| --- | --- | --- |
| a | `std/` (66 files) | `yo check ./std` with `YO_STD=<worktree>/std` |
| b | `src/` (266 files) | `yo check ./src`; then `yo build` — note `yo build` resolves std from the SEED bundle unless `YO_STD` is set (memory: build-resolves-std-from-seed) — set it |
| c | `tests/` language files (~393) | run the migrated files via `yo test` with the TREE-BUILT compiler, never the seed |
| d | `tests/cli-cases/*/fixture` (35 files) | same-line replacement; rerun the FULL cli-diff scorecard, not just the touched cases |
| e | `tests/internal/*.yo` | they are compiler-internal tests that themselves `open(import(...))` at the top; migrate, run the touched files one at a time |
| f | `vendor/markdown_yo` (30 files) | COMPANION commit upstream, fetch over https, bump the submodule pointer (memory: vendor companion commits) |
| g | docs: `docs/{en-US,zh-CN}/{DESIGN,STRINGS,DEFINITION_ORDER,STD_SYS_MODULE}.md` | DESIGN.md "Module importing and exporting" drops the `open(import(...))` row; DEFINITION_ORDER drops "opens" from the ordered-statement list; both languages |
| h | `.github/instructions/{yo-syntax,yo-design,debugging}.instructions.md`, `.github/skills/{yo-syntax,yo-core-patterns,yo-async-effects,yo-wasm-integration}/*.md` | editing `.github/skills/*` flips SIX cli-case tree goldens (init*, skills-install*) — re-record with the IN-REPO binary |
| i | `.github/workflows/{install-scripts,release}.yml`, `scripts/{install.sh,install.ps1,bootstrap/probe-stack-sizing.sh,build_site.yo}` | smoke programs `open(import("std/fmt"))` → `{ println } :: import("std/fmt")` — works on the seed AND the candidate, so the release smoke stays green across the removal |
| j | `plans/README.md` | add this doc to the active list |

Step-1 gate actually run: a full `yo build` from the migrated tree (green —
it type-checks and compiles the whole closure, `vendor/markdown_yo` included).
The remaining gates below ran once, after step 2:

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

### Step 2 — delete the builtin

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

Combined exit gates: `yo check ./src`, `yo build`, `gates_fast.sh` +
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
- **The forward-ref message change flips the `check-forward-ref-*` cli-case
  goldens**, and the `.github/skills/*` edits flip the six init/skills-install
  tree goldens; everything else in the cli corpus must be untouched.
- **Two `yo test` runs in one worktree collide** on `tests/.yo_selftest_batch_*`;
  canaries go in a different worktree while the suite runs.
- **Never edit std/src/tests while a gate runs there.**
- **Squash-merge with `--delete-branch`**; check `mergeable` before deleting.

## 6. Findings en route

- **Every `StringBuilder`/`Alignment` collision is benign**: `std/fmt`
  re-exports `std/string`'s, so the two paths name one type. Eight files in
  `src/` and two in `tests/internal/` hit it; the name now comes from
  `std/fmt` in those, exactly as last-wins resolved it before.
- **`tests/dyn.test.yo` opened `std/string` twice** at file scope (lines 4 and
  140). Names stay on line 4; line 140 is a bare re-import.
- **Opens that brought in nothing used**: 14 in `std/`, 20 in `src/`, ~40 in
  `tests/`, 12 of 32 in `vendor/markdown_yo`. The vendor ones are real: those
  files work in `str`, never `String`. All became bare imports, so
  impl registration is unchanged.
- **`std/math` exports nothing at all** — an impl-registration-only module.
- **`open` was pure sugar for spread destructuring** (§2), so every site had an
  exact replacement and no feature was added to cover the removal.
- **Fixture and test names that said "open"** were renamed with their
  subjects: `tests/open_import_constants.test.yo` →
  `tests/import_constants.test.yo` (fixture dir `tests/open_import/` →
  `tests/import_constants/`), `tests/codegen-bootstrap/open_import_println.yo`
  → `named_import_println.yo` (+ its golden),
  `tests/circular_deps/circular_open_{a,b}.yo` → `circular_use_{a,b}.yo`
  (the case is "A uses B's type in a definition", which is what survives the
  glob's removal). The two `issues/fixed/*.md` records that cite the old
  paths were updated in place.
- **`issues/repros/*.yo` ARE gate inputs, not just records** — the first
  assumption here was that they could stay frozen. `gates_fast.sh` GATE 0
  compiles two of them by name, and `arc-spawn-capture-split` failed with
  `Variable "open" not found` the moment the builtin went. All 96 repro files
  were migrated (94 carried an open header). The `.md` files under `issues/`
  are left alone: they are dated prose records, and their code blocks are
  quotations of how the bug looked at the time.

## 7. What actually ran

| gate | result |
| --- | --- |
| `yo build` (migration only, then again after the deletion) | green both times |
| `yo check ./std` | 173/173 |
| `yo check ./src` | 269/269 (two files fewer — the deleted handlers) |
| `gates_fast.sh` T1 GATE 0–8 | green after the repro fix; corpus 156/156, fmt clean and idempotent |
| `fixpoint_only.sh` | `STAGE2_RC=0`, stage2 hollow=0, `STAGE3_RC=0`, **FIXPOINT_HOLDS** |
| `cli-diff-test.sh` (full) | PASS 90, GOLDEN-DIFF 0, NO-GOLDEN 0, 1 network SKIP |
| language suite (`tests`, minus `internal`/`cli-cases`) | 3927 passed, rc 0 |
| `tests/internal` | 71 files one at a time, 1010 passed, rc 0 |

Everything above ran twice: once on the migration+deletion, and again after
`origin/develop` moved under the branch (#524, std/net + std/http). The merge
conflicted only in the six generated skill/init tree goldens, which were
re-recorded; the second run is the one whose numbers are in the table.

CI's first attempt is not evidence either way: `apt-get update` failed on the
runners (exit 100), which killed every Linux job and, through the missing
`suite-c-*` artifacts, every macOS and Windows leg that consumes them. The one
leg that got a working runner — `test (ubuntu-24.04-arm)` — passed the whole
suite, and the failed jobs were re-run.

36 cli goldens were re-recorded: 35 `expected_tree` manifests (they hash the
fixture and bundled-skill files this change edited, and the `init` scaffold that
`src/init.yo` now emits with named imports) and one `expected_stdout` — the LSP
case, whose only semantic change is `"open"` leaving the completion keyword
list. An audit of the 1188 names the migration introduced found exactly one
that the file never uses again, and that one is the pre-existing
circular-import probe in `tests/circular_deps/circular_use_b.yo`.

Still true after the removal, and worth saying out loud: **`{ ... } :: import(...)`
is still a glob** with the same silent-shadowing property. Nothing in this
change constrains it; if that spelling should also go, it is a separate
decision with a separate migration (and `tests/module.test.yo` documents the
form today).
