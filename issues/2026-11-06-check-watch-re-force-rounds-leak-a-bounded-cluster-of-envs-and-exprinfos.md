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

Not `Variable`: no `Rc(VariableData)` constructor appears in any leak stack.
The cluster — an `EnvironmentData` cell, `ExprInfoData` cells and `AstExpr`
trees together — is the field set of a retained `ModuleWalk`
(`Rc(ModuleWalkData)` with `begin_exprs` and the ctx cell that holds the
evaluation context: its environments and the `ExprInfoTable`). The leaked
graphs are UNREACHABLE, so either a reference cycle among those shapes or —
the likelier family, given the exact field match — a MISSING DROP when a
retained walk (or a per-round container of the re-force path) is replaced:
the dup/drop pair optimizer cancels a `___dup`/`___drop` pair it must not
when the container outlives the local
(`issues/fixed/spawn-closure-captures-never-dropped-leak.md`,
`issues/fixed/a-local-stored-in-a-struct-field-is-dangling-after-the-container-dies.md`
document the two known unsoundnesses of exactly this cancellation). The part B
migration reworked `ModuleWalk`/`PendingDef`/the ctx cells into those shapes.
Pinning the site needs the emitted-C drop walk of the re-force round (the LSan
stacks are anonymized `yo_id_*` names; the emitted C carries no per-fn name
comments); the fix then needs the dup/drop emit-diff gate plus an
over-cancellation canary before it lands.

## Impact

Bounded (~45 KB per watch session; the count is a function of the re-forced
definitions, not of time), watch mode only, no correctness effect observed. It
fails two internal tests' leak verdicts, which is how it was found.

## Test

Two tests in `tests/internal/check_watch.test.yo` fail on the part B stage 1
with the leak verdict and pass on develop before and at the tip:

- "Phase 3b: rule D1 re-judges a re-forced body — the reach memo answers only
  for the body it walked" (44,318 B / 677 allocations),
- "Phase 3b: an edit re-judges the edited definition's same-module callers,
  transitively" (43,662 B / 671 allocations, standalone reproduction).

Both re-judge a re-forced body whose Thread-spawned closure reaches a non-Send
global — the reach-memo re-judgment path. The test after them
("build --watch: invalidate_changed_files") passes standalone; its exit-9 in
the earlier batch run was an OOM kill under a four-heavy-job load, not the
leak. They stay in the suite as the failing-then-passing witnesses for the
fix.
