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
# Run all yo-self tests
./yo-cli test ./yo-self/tests/

# Run a single test file
./yo-cli test ./yo-self/tests/eval.test.yo

# Run a specific test by name
./yo-cli test ./yo-self/tests/eval.test.yo --test-name-pattern "fib"
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
