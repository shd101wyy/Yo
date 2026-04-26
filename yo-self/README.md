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
