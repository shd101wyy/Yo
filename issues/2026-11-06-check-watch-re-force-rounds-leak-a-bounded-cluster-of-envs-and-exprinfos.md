# `check --watch` re-force rounds leak a bounded cluster of environments and ExprInfos

**Severity:** S2

Found by the V5 part B gate round (`tests/internal/check_watch.test.yo` fails the
test runner's leak verdict on the part B stage 1; 2026-11-06).

## Symptom

`yo test ./tests/internal/check_watch.test.yo --parallel 1` on the V5 part B
stage-1 compiler fails the test named
`Phase 3b: rule D1 re-judges a re-forced body — the reach memo answers only for the body it walked`
with the runner's leak verdict:

```text
  ✗ Phase 3b: rule D1 re-judges a re-forced body — the reach memo answers only for the body it walked
    Memory leak detected:
```

The two tests after it in the file were also observed dying to SIGKILL (exit
status 9) in earlier runs of the same binary — the machine was running four
heavy jobs at the time, so an OOM kill is the likely sender; the deterministic
reproduction below runs the D1 test alone and leaks without any kill.

## Reproduction (deterministic, ~10 min)

```bash
yo test ./tests/internal/check_watch.test.yo --parallel 1 -v \
  --test-name-pattern "rule D1" --compile-timeout-ms 1800000 --std-path ./std
```

on a V5 part B stage-1 binary (the lane's `yo-env`, built from `082396179` plus
the env ref-count readers). With `--allocator debug` instead of the default
ASan child the same test exits 23 with

```text
debug allocator: leak check failed: 702 blocks / 45664 bytes leaked after main returned
```

The same test PASSES on develop `8d475cd81` (the part B branch's merge base)
and on develop `142a2f972` (the tip): the regression is the part B value
migration's, not develop's.

## What leaks

LSan (`-v` output, `vbd-logs/v5-part-b-s/cwprobe-env-d1c.log`):
44,318 bytes in 677 allocations. The direct roots are small; the indirect
majority is one repeating cluster per watch round. Named by the emitted C's
struct comments:

- `Rc(RefCell(EnvironmentData))` cells (19 leak stacks),
- `Rc(RefCell(ExprInfoData))` cells (19 stacks; 144 B each, 9 per stack),
- `AstExpr` tree nodes (15 stacks),
- one recursive `ArrayList(Self)`, and `Token`s.

So a subgraph of environments, their frames' variables' ExprInfos and the
bodies' `AstExpr` trees becomes UNREACHABLE without being freed — a reference
cycle or a missing drop, not retained-by-design state: the debug allocator
attributes 3,225,288 blocks / 267.6 MB at exit to "still reachable from module
globals or runtime state" (the deliberate `set_retain_walk_contexts(true)`
retention) and only these 702 blocks / 45 KB as leaked.

The allocation stacks sit in the per-def re-force path (`new_expr_info` /
evaluate-expression frames under the watch round driver), and the D1 test is
the one that re-forces a body whose closure reaches a non-Send global through
an imported module — the reach-memo re-judgment path. Tests that re-force
without the Thread-closure reach judgment (Phase C, Phase 3, the rebind tests)
pass with no leak.

## Suspect

`Variable`'s `is_owning_the_same_rc_value_as : Option(V)` (V = `Variable` =
`Rc(VariableData)`) is a mutual handle between variables that own shares of one
RC object — under plain `Rc` a pair (or self) link is an unbreakable cycle,
and the part B migration moved exactly this field into `VariableLive`
(VERDICTS-22 shape 2). Develop's `ref`-shaped `Variable` does not leak the same
cluster, so either the cycle is new to the shapes or the old drop path cleared
the field where the new one does not. A fix must either clear the links at
scope end (where the dup/drop optimizer stops needing them) or make the link
weak — both touch the dup/drop optimizer's bookkeeping and need the
emit-diff gate, so it is not rushed into the part B PR.

## Impact

Bounded (~45 KB per watch session; the count is a function of the re-forced
definitions, not of time), watch mode only, no correctness effect observed. It
fails the one internal test's leak verdict, which is how it was found.

## Test

`tests/internal/check_watch.test.yo`, "Phase 3b: rule D1 re-judges a re-forced
body": fails on the part B stage 1 (leak verdict above), passes on develop
before and at the tip. It stays in the suite as the failing-then-passing
witness for the fix.
