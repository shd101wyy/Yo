# `yo-self/tests`: the 18 failures — 14 FIXED, 1 real divergence, 3 uncovered

**Status (2026-08-05): RESOLVED except for one genuine codegen bug.**

The original triage (full-directory run at `e1e004a84`, **787 passed / 18 failed**)
treated these as 18 problems in ~6 independent groups. They were not. The final
accounting:

| original failures                                                               | count | outcome                                                                                                           |
| ------------------------------------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------- |
| `value.test.yo`                                                                 | 5     | **FIXED** — `PtrVal`'s first field is the shared `ArrayList(EvalValue)` CELL; the tests passed a bare `EvalValue` |
| `type_trait_methods.test.yo`                                                    | 3     | **FIXED** — `resolved_concrete` is `ArrayList(Self)`, not `Option`; 5 sites                                       |
| `types_guards.test.yo`                                                          | 1     | **FIXED** — same root as above                                                                                    |
| `env.test.yo`                                                                   | 1     | **FIXED** — `.None` arms returned a `String` where `Variable.id` is a `usize`                                     |
| `phase6_verify`, `phase6c_macro`, `phase6d_reflection`, `phase6f_macro_helpers` | 4     | **FIXED** — all one root (below)                                                                                  |
| `evaluator_index.test.yo`                                                       | 1     | **FIXED** — same root; now ts 18/18, self 18/18                                                                   |
| `eval_basics`, `eval_tail_1`, `eval_tail_2`                                     | 3     | **UNCOVERED** — now `check` clean, but still exceed the runner's process limit                                    |

Plus one failure the original triage could not have seen, because nobody had ever run
the self-hosted binary's `test` subcommand over this directory:

| new                       | outcome                                                                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `effect_analysis.test.yo` | **OPEN** — real yo-self codegen divergence (TS 19/19; yo-self emits C clang rejects). `issues/yo-self-selftest-codegen-divergences.md` |

## Three lessons, each of which had produced a wrong conclusion

### 1. Most of the "no nested cause" failures were ONE bug

`phase6*` × 4 and `evaluator_index` all import `../evaluator/index.yo`, whose sole
purpose here was to import `evaluator/eval.yo` — and `eval.yo` failed to evaluate
because of five `.get(usize(0))` calls on `EvalResult.value`, which is a plain
`EvalValue`, not a one-element cell. One fix (`9741db482`) flipped all five files and
took `check ./yo-self` from **295/305 to 305/305**. The handoff doc had labelled these
"9 cascading circular-import" for months; that was wrong.
See `issues/yo-self-evalresult-value-cell-confusion.md`.

### 2. Several "failures" were PHANTOMS created by the measurement itself

`phase6c_macro` alone needs **6.52 GB** peak and ~335 s. The original sweep ran
`--parallel 2`, putting ~13 GB in flight on a 16 GB machine; it swapped, and the
swapping tripped the runner's own **600 s evaluator deadline**, reporting
`✗ Module evaluation failed` for files that pass cleanly in isolation.

**Run this directory one file at a time.** The self-hosted runner ignores `--parallel`
anyway (`yo-self/main.yo:1387` — "Accepted for CLI compatibility; v1 runs
sequentially"), so a parallel TS run is not even comparing like with like.

### 3. Stale-test drift is the single most common failure mode here

Four of the 18 were tests constructing a compiler struct/enum with a field shape that a
landed change had moved — and each reported only
`Failed to import module ".yo_test_batch_*"` with **no nested cause**, because one
mismatched arm fails the whole generated batch file's compile. That is why a single
stale line shows up as one failing test surrounded by passes.

Two habits that work:

- **`-v` prints the nested cause**; the non-verbose runner swallows it. You rarely need
  the kept batch file.
- **Classify by the match ARMS, not by the variable name.** A name-based pass produced
  false positives on `var_m` and `recv_var` (genuine `Variable`s from `env.lookup`)
  while missing `cv` and `bv` (`EvalResult`s from `recur`).

## Reproducing

```bash
# per-file TS-vs-yo-self differential, strictly sequential (the only honest way)
DIR=./yo-self/tests TAG=ystests TO=1500 BIN=/tmp/re/s1r16 \
  SKIP="eval_basics eval_tail_1 eval_tail_2" bash <scratch>/difftest_dir.sh

# single file with the real error surfaced
YO_MAIN_STACK_MB=4096 ./yo-cli test ./yo-self/tests/<f>.test.yo --parallel 1 -v
```

Traps worth knowing:

- `yo-cli test` takes exactly ONE path; extra paths make yargs exit 1 with
  "Unknown arguments", which looks exactly like a test failure.
- `rm -f yo-self/tests/.yo_test_batch_*` **aborts under zsh** when the glob matches
  nothing ("no matches found"), silently skipping the rest of the command line. Use
  `find yo-self/tests -name '.yo_test_batch_*' -delete`.
- `YO_KEEP_BATCH=1` is read by the **self-hosted** runner (`yo-self/main.yo:1522`), not
  by `src/`. Grepping only `src/` makes it look dead; removing it from a gate script
  deletes the artifacts hollow detection depends on.
- `sed` on PATH here is **GNU**: `sed -i '' 'script' f` fails. Use `sed -i 'script' f`
  or `/usr/bin/sed -i '' ...`.
