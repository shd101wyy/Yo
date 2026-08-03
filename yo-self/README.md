# yo-self — Self-Hosted Yo Compiler

This directory holds the **Yo-in-Yo** port of the compiler. The goal is to replace
the TypeScript implementation in `src/` with a Yo implementation that compiles to
a single C file, which can be redistributed as `yo.c` plus a small driver.

## Current status (2026-08-03)

- **`s1 test ./tests`: 186/186 GREEN — 0 hollow, 0 red** (honest sweep at
  `65ebcdbb2`; every file's batch `main` verified non-hollow).
- Stage-2 self-emit: rc=0, **0 markers**, clang **0 errors** — and the
  **bootstrap fixpoint HOLDS**: the stage-2 binary re-emits byte-identical
  C (stage-2 ≡ stage-3, 103.7 MB).
- The remaining work queue lives in
  **[`../plans/YO_SELF_STAGE2_HANDOFF.md`](../plans/YO_SELF_STAGE2_HANDOFF.md)** —
  read that first; it carries THE METHOD (gate battery, hollow-green hygiene,
  phantom-kill protocol) and the measured dead ends not worth repeating.

See **[`../plans/BOOTSTRAPPING.md`](../plans/BOOTSTRAPPING.md)** for:

- Current status and test counts per phase
- File mapping table (TypeScript source → Yo target)
- Directory layout
- Translation guidelines
- Architecture decisions
- Risk assessment and success criteria

## Quick start

```bash
# Run all yo-self tests (slow: ~90 min total; see "Test suite layout" below)
./yo-cli test ./yo-self/tests/

# Run a single test file
./yo-cli test ./yo-self/tests/lexer.test.yo --parallel 1

# Run a specific test by name
./yo-cli test ./yo-self/tests/lexer.test.yo --test-name-pattern "tokenize" --parallel 1
```

## Test suite layout

`yo-self/tests/` holds ~60 test files (~900 tests) compiled and run by the
TypeScript `yo-cli`. They fall into three tiers:

1. **Fast unit tests** (seconds–1 min each): lexer, parser, token/env/value,
   `types_*` (tags, guards, utils, compound, string-compat, value),
   expr*info / expr_traversal, naming_checker, target, logger, error,
   doc pipeline (`doc*\*`), and the CLI modules (cache, fetch, init,
   install_command, lock_file, pkg_config, version).
2. **Evaluator seam + registry tests** (1–10 min each — every file that
   imports evaluator internals pays a large Yo-compile cost): assignment,
   binding, initialization_assignment, open, runtime, typeof, unwind,
   identifier_and_operator, type_of, context, evaluator_index,
   macro_registry, type_trait_methods, await/effect/suspension analyses,
   `phase6*` (macro + reflection, end-to-end through `Evaluator.new`).
3. **End-to-end evaluator tests** — `eval_basics.test.yo` (123 tests),
   `eval_tail_1.test.yo` (107), `eval_tail_2.test.yo` (107). Each batch
   compiles the _entire_ self-hosted evaluator, so a batch compile costs
   ~1 min — but the files run green in **~90 s each** (337/337 total).
   (They previously blew the runner's 1800 s limit; that was never inherent
   cost — hundreds of stale-API tests made every batch fail and the
   runner's bisection-on-failure recompiled the whole evaluator dozens of
   times. Migrated 2026-07-17; if these files ever slow down drastically
   again, suspect NEW stale tests triggering bisection storms, not size.)

Tests that need macro **dispatch** (executing macro bodies at expansion
time) are gated on `MACRO_DISPATCH_ENABLED` in
`yo-self/evaluator/calls/function.yo`. The flag is **`true`** (dispatch was
re-enabled 2026-06-11 after the heap-corruption fix — see `issues/fixed/`),
so the `phase6c/6d/6f` macro tests run for real.

The strongest evaluator gate is not the unit suite but the self-hosted
binary itself:

```bash
./yo-cli compile yo-self/main.yo --release -o /tmp/yo-self-bin   # ~6 min (always --release; -O0 hits stack ceilings)
/tmp/yo-self-bin check ./std                                     # 153/153
/tmp/yo-self-bin test ./tests --parallel 1                       # 186/186 test files green
# Stage-2 self-compile + fixpoint (the strongest gate of all):
bash scripts/bootstrap/fixpoint_only.sh                          # emit + clang + stage-3 + byte-compare
```

## Stack sizing on deep inputs

Compiled Yo programs run `main` on a worker thread with a 1 GiB default
stack, overridable via `YO_MAIN_STACK_MB`. Always build the self-hosted
binary with `--release`: at `-O0` the big evaluator functions have
multi-MB frames and deep compile-time recursion exhausts the stack
(rc=139) — see the pitfall entry in `AGENTS.md`. If a deep input still
crashes a `--release` binary, raise the stack:

```bash
YO_MAIN_STACK_MB=4096 /tmp/yo-self-bin check ./yo-self
```
