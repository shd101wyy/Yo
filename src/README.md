# yo-self — Self-Hosted Yo Compiler

This directory holds the **Yo-in-Yo** compiler — the only compiler. It compiles to
a single C file, which can be redistributed as `yo.c` plus a small driver.

It **replaced** the TypeScript implementation that used to live in `src/`: that
tree, its bun/npm toolchain and the `./yo-cli` shims were deleted with P2.5 and
are frozen at the annotated tag **`src-attic-final`** (`git show src-attic-final`
— it is the last commit that still contains them). Every `./yo-cli <args>` in an
older document is `yo <args>` today, `yo` being the native binary a release
bundle puts on `PATH`.

**Done (P2.5 Group F, 2026-08-20):** this directory was renamed `yo-self/` →
`src/`, the name freed by the TypeScript compiler's deletion. Older `plans/` and
`issues/` documents still say `yo-self/` for this tree — and `src/` for the
RETIRED TypeScript one. See the translation note in AGENTS.md.

## Current status (2026-08-03)

- **`s1 test ./tests`: 186/186 GREEN — 0 hollow, 0 red** (honest sweep at
  `65ebcdbb2`; every file's batch `main` verified non-hollow).
- Stage-2 self-emit: rc=0, **0 markers**, clang **0 errors** — and the
  **bootstrap fixpoint HOLDS**: the stage-2 binary re-emits byte-identical
  C (stage-2 ≡ stage-3, 103.7 MB).
- The remaining work queue lives in
  **[`../plans/archive/YO_SELF_STAGE2_HANDOFF.md`](../plans/archive/YO_SELF_STAGE2_HANDOFF.md)** —
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
# Run all the compiler's own tests (22.2 min — measured 2026-08-05, --parallel 1;
# the retired TS compiler took 40.5 min on the same set. See "Test suite layout")
yo test ./tests/internal --parallel 1

# Run a single test file
yo test ./tests/internal/lexer.test.yo --parallel 1

# Run a specific test by name
yo test ./tests/internal/lexer.test.yo --test-name-pattern "tokenize" --parallel 1
```

## Test suite layout

The compiler's own tests live in **`tests/internal/`** — 58 files compiled and run
by `yo`. They were at `yo-self/tests/` until 2026-08-05 (moved because the
TypeScript `src/` was going to be retired and `yo-self/` renamed to `src/`, so
they belong under `tests/` rather than being shuffled twice — both have since
happened); translate the old path when reading older `issues/` and
`plans/` documents. They fall into two live tiers, plus a third that was retired:

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
   the four macro/reflection (macro + reflection, end-to-end through `Evaluator.new`).
3. ~~**End-to-end evaluator tests** — `eval_basics` / `eval_tail_1` /
   `eval_tail_2`~~ **RETIRED 2026-08-05** together with their subject,
   `src/evaluator/eval.yo`. Those three files (337 tests) were the only
   coverage of the legacy "bootstrap proto-evaluator" — an explicit
   bootstrap-only divergence with **no `src/` counterpart**, superseded by
   `evaluator/exprs/*.yo` (23 files mirroring `src/evaluator/exprs/*.ts`) and
   outside `main.yo`'s import closure, so never exercised by the self-compile
   or the fixpoint. Deleting it also retired the divergent 3-arg `for` handler
   that those tests were keeping alive (`issues/fixed/eval-for-loop-3arg-vs-2arg.md`
   prescribed exactly this: "delete the handler + migrate the trio in the same
   change"). It had accumulated 5 real bugs that nothing could catch — see
   `issues/fixed/yo-self-evalresult-value-cell-confusion.md`.

Tests that need macro **dispatch** (executing macro bodies at expansion
time) are gated on `MACRO_DISPATCH_ENABLED` in
`src/evaluator/calls/function.yo`. The flag is **`true`** (dispatch was
re-enabled 2026-06-11 after the heap-corruption fix — see `issues/fixed/`),
so the `macro_expansion/ast_reflection/macro_helpers` macro tests run for real.

The strongest evaluator gate is not the unit suite but the self-hosted
binary itself:

```bash
yo compile src/main.yo --optimize 2 -o /tmp/yo-self-bin         # ~6 min (always --optimize 2; -O0 hits stack ceilings)
/tmp/yo-self-bin check ./std                                     # 153/153
/tmp/yo-self-bin test ./tests --exclude tests/internal --parallel 1   # fast language suite
# Stage-2 self-compile + fixpoint (the strongest gate of all):
bash scripts/bootstrap/fixpoint_only.sh                          # emit + clang + stage-3 + byte-compare
```

## Stack sizing on deep inputs

Compiled Yo programs run `main` on a worker thread with a 1 GiB default
stack, overridable via `YO_MAIN_STACK_MB`. Always build the self-hosted
binary with `--optimize 2`: at `-O0` the big evaluator functions have
multi-MB frames and deep compile-time recursion exhausts the stack
(rc=139) — see the pitfall entry in `AGENTS.md`. If a deep input still
crashes a `--optimize 2` binary, raise the stack:

```bash
YO_MAIN_STACK_MB=4096 /tmp/yo-self-bin check ./src
```
