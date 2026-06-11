# yo-self — Self-Hosted Yo Compiler

This directory holds the **Yo-in-Yo** port of the compiler. The goal is to replace
the TypeScript implementation in `src/` with a Yo implementation that compiles to
a single C file, which can be redistributed as `yo.c` plus a small driver.

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
   expr_info / expr_traversal, naming_checker, target, logger, error,
   doc pipeline (`doc_*`), and the CLI modules (cache, fetch, init,
   install_command, lock_file, pkg_config, version).
2. **Evaluator seam + registry tests** (1–10 min each — every file that
   imports evaluator internals pays a large Yo-compile cost): assignment,
   binding, initialization_assignment, open, runtime, typeof, unwind,
   identifier_and_operator, type_of, context, evaluator_index,
   macro_registry, type_trait_methods, await/effect/suspension analyses,
   `phase6*` (macro + reflection, end-to-end through `Evaluator.new`).
3. **End-to-end evaluator tests** — `eval_basics.test.yo` (123 tests),
   `eval_tail_1.test.yo` (107), `eval_tail_2.test.yo` (107). Each batch
   compiles the *entire* self-hosted evaluator and currently **exceeds the
   test runner's 1800 s isolated-process limit**, so these three are
   known-heavy and excluded from routine runs. They still `./yo-cli check`
   clean (evaluator OK), and the same code paths are exercised continuously
   by the self-hosted binary sweeps below.

Tests that need macro **dispatch** (executing macro bodies at expansion
time) are gated on `MACRO_DISPATCH_ENABLED` in
`yo-self/evaluator/calls/function.yo` — dispatch is disabled in committed
builds (heap corruption, `issues/yo-self-macro-dispatch-corruption.md`).
They pass vacuously today and re-arm automatically when the flag flips.

The strongest evaluator gate is not the unit suite but the self-hosted
binary itself:

```bash
./yo-cli compile yo-self/main.yo -o /tmp/yo-self-bin   # ~10 min
YO_MAIN_STACK_MB=4096 /tmp/yo-self-bin check ./std      # 152/152
YO_MAIN_STACK_MB=4096 /tmp/yo-self-bin check ./tests    # 147/149 (2 circular-import fixtures match TS errors)
YO_MAIN_STACK_MB=4096 /tmp/yo-self-bin check ./yo-self  # all green
```

## Running yo-self-bin on prelude/large files

The recursive evaluator can exceed the default macOS 8 MB main-thread stack on
non-trivial inputs. Raise the soft stack limit before invoking the binary:

```bash
ulimit -s 65520
./yo-cli compile yo-self/main.yo -o /tmp/yo-self-bin
/tmp/yo-self-bin check std/prelude.yo
```

See [`issues/yo-self-evaluator-stack-overflow.md`](../issues/yo-self-evaluator-stack-overflow.md)
for the diagnosis.
