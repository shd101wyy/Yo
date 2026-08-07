# yo-self: `EvalResult.value` treated as a one-element cell — 5 sites, gated 10 files

**Status:** FIXED — all 5 sites corrected, and BOTH source links in the cascade now
check clean:

```
./yo-cli check yo-self/evaluator/eval.yo   -> rc=0, "evaluator OK"
./yo-cli check yo-self/evaluator/index.yo  -> rc=0, "evaluator OK"
```

**`check ./yo-self` is now 305/305** (was 295/305 — zero remaining FAILED files), and
the dependent tests are confirmed green under BOTH compilers:

| file                    | before             | after                |
| ----------------------- | ------------------ | -------------------- |
| `phase6_verify`         | whole-file failure | ts 3/3, self 3/3     |
| `phase6c_macro`         | whole-file failure | ts 2/2, self 2/2     |
| `phase6d_reflection`    | whole-file failure | ts 3/3, self 3/3     |
| `phase6f_macro_helpers` | whole-file failure | ts 3/3, self 3/3     |
| `evaluator_index`       | whole-file failure | ts 18/18, self 18/18 |

The `eval_*` trio now checks clean too, but it still exceeds the test runner's process
limit, so those three remain **uncovered rather than passing** — a capacity issue
unrelated to this bug.
**Found:** 2026-08-05, by the first per-file TS-vs-yo-self differential of the
`test` subcommand over `tests/internal`.

## The confusion

Two different types in yo-self both have a field called `value`, and only one of
them is a cell:

| type                          | field                          | shape                                                               |
| ----------------------------- | ------------------------------ | ------------------------------------------------------------------- |
| `Variable` (`env.yo`)         | `value : ArrayList(EvalValue)` | a one-element **shared mutable CELL** — `.get(usize(0))` is correct |
| `EvalResult` (`value.yo:915`) | `value : EvalValue`            | a plain value — `.get(usize(0))` is a TYPE ERROR                    |

`EvalValue` has no `get` method and no `Index` impl (only `Eq`), so
`someEvalResult.value.get(usize(0))` cannot resolve. `git log -S` confirms
`EvalResult.value` was **never** an `ArrayList` — it has been `EvalValue` since
`6caa9cb89`. These sites were wrong from the day they were written.

## Why it went unnoticed for so long

`check` fails a file at its FIRST bad definition and stops, so only one of the five
was ever visible, and the file has been written off as a known-baseline failure
(`check ./yo-self` **295/305**, described in `plans/archive/YO_SELF_STAGE2_HANDOFF.md` as
"`evaluator/eval.yo` + 9 cascading circular-import"). It is not a circular-import
problem at all.

Nothing else masked it because **the code is unreachable from the compiler build**:
`main.yo` imports `evaluator/context.yo`, `exprs/_expr.yo`,
`values/anonymous_module.yo`, `exprs/import.yo` and `module_loader.yo` directly, and
never `evaluator/index.yo` (the only importer of `eval.yo`). So the self-compile and
the stage-2/stage-3 fixpoint never touch these functions, and `check` — which
evaluates every definition including never-called ones — was the only thing that
could see them.

## The cascade this one root caused

All 10 `check ./yo-self` failures are this bug plus its import cascade:

```
evaluator/eval.yo            <- the root (5 bad call sites)
evaluator/index.yo           <- imports eval.yo
tests/eval_basics            <- import ../evaluator/index.yo
tests/eval_tail_1
tests/eval_tail_2
tests/evaluator_index
tests/phase6_verify
tests/phase6c_macro
tests/phase6d_reflection
tests/phase6f_macro_helpers
```

So the four `phase6*` "whole-file, no nested cause" failures were never four separate
bugs, and the `eval_*` trio is not merely "too heavy for the runner" — they fail
`check` too.

## The 5 sites

All bind their receiver from `recur(...)` (which returns `Option(EvalResult)`), then
match `EvalValue` variants directly:

| line (post-fix) | receiver                                         | arms                      |
| --------------- | ------------------------------------------------ | ------------------------- |
| 4461            | `v : EvalResult` (parameter of `eval_float_neg`) | `.FloatLit(raw)`          |
| 6364            | `v` from `recur`                                 | `.BoolVal(b)`             |
| 6391            | `v` from `recur`                                 | `.IntLit(raw)`            |
| 6788            | `cv` from `recur`                                | `.BoolVal(b)`             |
| 6803            | `bv` from `recur`                                | `.ReturnVal`, `.BreakVal` |

Fix in every case: drop `.get(usize(0))` and match `v.value` directly.

## The reliable way to tell the two apart

**Classify by the MATCH ARMS, not by the variable name.** Naming is misleading —
`cv`, `bv`, `mv`, `var_m`, `recv_var` look alike but are different types, and a
name-based pass produced false positives on `var_m` (796) and `recv_var` (876), both
of which are genuine `Variable`s from `env.lookup`.

- arms are `EvalValue` variants (`.BoolVal` / `.IntLit` / `.FloatLit` / `.ReturnVal`
  / `.BreakVal`) ⇒ receiver is an `EvalResult` ⇒ `.get(usize(0))` is a BUG
- arms are `.None` / `.Some` ⇒ receiver is a `Variable` ⇒ `.get(usize(0))` is correct
  (it is unwrapping the cell's `Option(EvalValue)`)

Applied to all 14 occurrences in `eval.yo`, this classifies 12 as correct and exactly
the 5 above as broken (3 found first, 2 more revealed once `check` got past them).

```bash
# the classifier, reusable if more turn up elsewhere
grep -n -A1 "\.value\.get(usize(0))" yo-self/evaluator/eval.yo
```

## Environment gotcha hit while fixing this

`sed` on PATH here is **GNU** sed, not BSD: `sed -i '' 'script' file` fails with
`sed: can't read script: No such file or directory` because GNU `-i` takes no
separate argument, so `''` is consumed as the script. Use `sed -i 'script' file`, or
`/usr/bin/sed -i '' ...` for the BSD binary. Silent no-op risk if unnoticed.

## Follow-up — all closed

- `evaluator_index` re-tested after the fix: **ts 18/18, self 18/18**. Its earlier
  `BOTH-FAIL-DIFF` verdict was stale (swept before the last two fixes landed).
- `check ./yo-self` confirmed at **305/305**, zero remaining FAILED files, and the
  baseline in `plans/archive/YO_SELF_STAGE2_HANDOFF.md` updated — the "circular-import"
  description is gone, replaced with the real cause.
- Gates re-verified green with the fix in the tree: TIER 1 `failures=0` (battery 20/20
  `hollow=0`, corpus PASS 155 / DIFF 0, `check ./std` 153/153) and the stage-2/stage-3
  **FIXPOINT_HOLDS**. As expected — this code is not in the compiler build, so it
  cannot affect the fixpoint.

Still open, and NOT caused by this bug: the `eval_*` trio exceeds the test runner's
process limit, so those three files are **uncovered rather than passing**. That is a
capacity issue.
