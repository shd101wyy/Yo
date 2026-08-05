# yo-self/tests TS baseline (#70 prerequisite) + suite audit — 2026-07-17

> **PATH NOTE (2026-08-05):** this directory is now `tests/internal/`. Every
> `yo-self/tests` path below is historical — read it as `tests/internal`. The
> timings here are also superseded: 40.5 min under TS / 22.2 min self-hosted at
> `--parallel 1` for 58 files (the `eval_*` trio was retired). See
> `.github/instructions/testing.instructions.md`.

Status: suite AUDITED and REPAIRED; TS baseline established. This documents
what the next agent can rely on before running `s2 test ./yo-self/tests`.

## The baseline run

Full run: `./yo-cli test ./yo-self/tests/ --parallel 2` — ~100 min on the
Mac mini M4 (the eval trio burns most of it before timing out).

Raw first pass (before repairs): **769 passed / 48 failed / 817 total.**
The 48 broke down as:

- **3 known-heavy timeouts** — `eval_basics`, `eval_tail_1`, `eval_tail_2`
  hit the runner's 1800 s isolated-process limit (documented in
  `yo-self/README.md`; they `check` clean and are validated by compile
  sweeps — NOT failures to fix).
- **1 phantom** — a deleted untracked scratch file (`test_ops_scratch`)
  enumerated before cleanup.
- **~20 collateral** — concurrent `yo-cli test` invocations race each
  other's `.yo_test_batch_*` temp files in the shared tests directory
  (cleanup deletes the other runner's pending batches → spurious "Failed to
  import module" errors). **Never run two test invocations that touch the
  same directory simultaneously**; re-verify any suspicious failure with a
  solo run.
- **24 REAL failures across 11 files** — ALL stale tests, none TS-compiler
  bugs. Fixed in this audit (commits `25761e121` + the follow-up audit
  commit). Verified solo: every repaired file passes fully under TS.

## The staleness classes (what was actually wrong)

All from two refactors the suite predated:

1. **ref-enum reference semantics** (recursive variant fields became direct
   `Self` handles): `box(X)` / `Box(TypeValue)(X)` constructor wrappers,
   `Option(Box(TypeValue))` field types, and `x.*` match-scrutinee derefs
   all became invalid. ~60 sites across value, env_lookup, hierarchy,
   type_trait_methods, types_guards, types_type_guards, typeof,
   types_value, eval_basics, eval_tail_1.
2. **FuncMeta factoring** (`TypeValue.Func` went from ~17 flat fields to
   6 fields + `Box(FuncMeta)`): old flat constructions in types_guards and
   context (rewritten to the new shape / `t_func_simple`).

Plus three one-offs: env.test.yo's `std/assert` import had been inserted
INSIDE one test's body (so every other test in the file lost it under
batching — the runner collects only top-level non-test exprs as shared
content); a body-local duplicate import then shadowed the hoisted one; and
assignment.test.yo asserted the pre-port behavior (reassignment ExprInfo =
UnitVal) where the faithful port carries the OLD value/type
(assignment.ts:759-800).

## Suite changes beyond repairs

- NEW: `type_key.test.yo` (5), `synthesizer.test.yo` (3 — includes the
  structural through-Func-param forall binding, the 702de11c9 class),
  `formatter.test.yo` (5 — format_yo_source idempotency).
- phase6c/6d/6f stale "macro dispatch disabled / vacuous" comments fixed
  (`MACRO_DISPATCH_ENABLED` is true since 2026-06-11); phase6f 3/3.
- phase6f test 1 re-enabled then re-skipped (`if(false, ...)`) on a REAL
  yo-self divergence: `__yo_expr_eq(quote(x), quote(x))` is false inside a
  macro body under yo-self's proper Evaluator, true under TS —
  `issues/yo-self-expr-eq-macro-body-false.md`.
- Deleted: `_leak_test.yo` (memory-safety-era probe harness) + untracked
  debris (compiled binaries, scratch test file).

## Effective TS baseline for #70

With repairs in: **every file passes fully under TS except the documented
eval-trio timeouts.** So the #70 comparison is: `s2 test ./yo-self/tests`
must pass all files except eval_basics / eval_tail_1 / eval_tail_2, which
are validated by `check` + compile sweeps instead.

Final solo-verified numbers for every repaired/new file:

| File                          | Result                       |
| ----------------------------- | ---------------------------- |
| value.test.yo                 | 31/31                        |
| env_lookup.test.yo            | 7/7                          |
| env.test.yo                   | 11/11                        |
| hierarchy.test.yo             | 22/22                        |
| context.test.yo               | 15/15                        |
| typeof.test.yo                | 1/1                          |
| assignment.test.yo            | 9/9                          |
| types_guards.test.yo          | 45/45                        |
| types_type_guards.test.yo     | 7/7                          |
| types_value.test.yo           | 3/3                          |
| type_trait_methods.test.yo    | 17/17                        |
| phase6f_macro_helpers.test.yo | 3/3 (test 1 documented-skip) |
| type_key.test.yo (NEW)        | 5/5                          |
| synthesizer.test.yo (NEW)     | 3/3                          |
| formatter.test.yo (NEW)       | 5/5                          |

## UPDATE 2026-07-17: the eval trio is MIGRATED and GREEN — no exclusion needed

The trio's timeouts were never inherent cost. Root cause (measured):
extraction is 23 s and one batch compile ~21-60 s — a healthy full file is
**~90 s**. The >1800 s walls came from ~2500 stale-API sites (str literals
to `String` params incl. `src :=` strings and `BK_*` constants; flat
9-field `.FuncVal(...)` patterns → `FuncVal(Box(FuncValData), cap_vals)`;
`ModuleVal` → module `StructVal` [removed in `4fc9c673e`]; 7-positional
`.Struct(...)` patterns → curly destructuring; one obsolete-semantics test
[comptime `a.*` deref — TS rejects it too; migrated to the runtime
`box(42)` form with shape asserts]) — every batch failed to compile, and
the runner's bisection-on-failure recompiled the whole-evaluator import
graph dozens of times until the 1800 s kill.

Also fixed en route: `check` never surfaces any of this (the def-eval wall
swallows body errors by design), which is WHY the staleness accumulated
invisibly. Compile-and-run is the only real gate for test bodies.

**Final: eval_basics 123/123 (89 s), eval_tail_1 107/107 (87 s),
eval_tail_2 107/107 (88 s).** The #70 TS baseline is now simply: EVERY
file in yo-self/tests passes.
