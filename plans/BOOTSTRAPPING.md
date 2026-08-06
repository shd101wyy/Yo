# Bootstrapping the Yo Compiler

> **GOAL ACHIEVED.** The self-hosted compiler (`yo-self/`) is a faithful 1-to-1
> port of the TypeScript reference compiler (`src/`) and passes everything the
> reference passes. This document is the umbrella record of that campaign; the
> detailed phase-by-phase history lives in `git log` of this file and of the
> (now CLOSED) per-slice plan docs listed at the bottom. **What comes next —
> retiring `src/` entirely, full CLI parity, install scripts, LSP — is
> [`SELF_HOSTING_COMPLETION.md`](SELF_HOSTING_COMPLETION.md).**

## Goal (met)

A self-hosted Yo compiler written in Yo (under `yo-self/`), structurally 1-to-1
with the TypeScript reference (under `src/`): same files (`-` ↔ `_`), same
exported functions, same control flow. Success criterion — met 2026-08-03
(`65ebcdbb2`) and CI-gated since 2026-08-06 (`ac85f6cfc`):

```bash
./yo-cli compile yo-self/main.yo --release -o /tmp/yo-stage1   # stage 1 (built by TS)
/tmp/yo-stage1 test ./tests                                     # passes the full suite
```

## Where it stands (2026-08-06)

| Gate                                                 | State                                                                                       |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Full integration suite under the self-hosted binary  | 186/186 test files green                                                                    |
| Differential corpus vs TS ground truth               | 155/155, `DIFF 0`                                                                           |
| `check ./std` / `check ./yo-self`                    | 153/153 / 237/237                                                                           |
| Compiler internal tests (`tests/internal`, 58 files) | 826/826 under BOTH compilers; TS arm runs under ASan/LSan in CI                             |
| **Stage-2/stage-3 fixpoint**                         | **HOLDS** (stage-2 self-compiled binary re-emits byte-identical C)                          |
| CI                                                   | all jobs gate PRs; `compiler-internal-tests` sharded 4-way + a self-hosted differential job |

Operational details — gate commands, measurement rules, honest-sweep
methodology, `scripts/bootstrap/` — live in
[`YO_SELF_STAGE2_HANDOFF.md`](archive/YO_SELF_STAGE2_HANDOFF.md) (CLOSED, still the
best reference for running the gates).

## Architecture

```
Yo source → Lexer → Parser → AST  (yo-self/lexer.yo, parser.yo, expr.yo)
                              ↓
                         Evaluator   (yo-self/evaluator/)
                              ↓
                         ExprInfoTable    (typed AST metadata, keyed by ExprId)
                              ↓
                         Codegen     (yo-self/codegen/)
                              ↓
                         C compiler (clang / gcc / zig)
```

## Operating principles (kept for the next phase)

1. **Strict 1-to-1** while `src/` exists: each TS file/function has a same-named
   Yo counterpart; language-forced divergences get a header comment.
2. **TS-first for bugs**: while `src/` is the reference, fix bugs there first
   (with a failing `tests/` case), then port. This inverts when `src/` retires —
   see `SELF_HOSTING_COMPLETION.md`.
3. **No silent fallback; never regress the gates.** Findings → `issues/`;
   Yo-language surprises → `.github/skills/*` + `.github/instructions/*`.

## Known leftovers (tracked, not blocking)

- `types/flowability.yo` is ported but pending activation (setter/caller
  wiring) — see `plans/archive/REMAINING_EVALUATOR_PORTS.md` (CLOSED) for the exact
  wiring list; carried as a line item in `SELF_HOSTING_COMPLETION.md`.
- Memory levers for the self-hosted binary's compile peak (it completes on
  16 GB but peaks ~2× the TS compiler): root cause and ranked levers in
  [`YO_SELF_ENV_SHARING.md`](YO_SELF_ENV_SHARING.md) (parked at user
  direction); the big peak lever is
  [`TYPEVALUE_HASH_CONSING.md`](TYPEVALUE_HASH_CONSING.md) (design, not
  started). Both become LSP-latency-relevant in the next phase.
- Open async RC-lifetime divergences (D2–D7) and other non-blocking issues:
  see `plans/archive/CI_GATING_HANDOFF.md` §3 and `issues/`.

## Closed per-slice plan docs (historical record)

| Doc                                                             | Covered                                            |
| --------------------------------------------------------------- | -------------------------------------------------- |
| `BOOTSTRAPPING_PREREQUISITES.md`                                | language/std features needed before the port       |
| `BOOTSTRAPPING_EVALUATOR.md`                                    | evaluator + `check` slice (green 2026-06-10)       |
| `EVALUATOR_PORT_REVIEW.md`                                      | evaluator divergence inventory                     |
| `REMAINING_EVALUATOR_PORTS.md`                                  | last unported evaluator files                      |
| `BOOTSTRAPPING_CODEGEN.md`                                      | codegen slice (all 8 phases; complete 2026-08-03)  |
| `BOOTSTRAPPING_CODEGEN_RESUME.md`                               | mid-campaign resume checklist                      |
| `codegen-baseline-scorecard.md`                                 | Phase-0 differential baseline                      |
| `YO_SELF_STAGE2_FIXPOINT_ROADMAP.md`                            | stage-2 clang-error drain                          |
| `YO_SELF_NAMED_LOCAL_DROPS.md` / `YO_SELF_RC_EMISSION_LAYER.md` | RC emission layer port                             |
| `YO_SELF_STAGE2_HANDOFF.md`                                     | the operational record: gates, scripts, rules      |
| `CI_GATING_HANDOFF.md`                                          | making every CI job gate PRs (complete 2026-08-06) |
