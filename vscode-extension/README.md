# Yo

This VS Code extension supports the syntax highlighting for the Yo language:

https://github.com/shd101wyy/Yo

With a `yo` binary on `PATH` (or `yo.binPath` set), it also starts the
language server (`yo lsp`) for diagnostics, hover (types, values, doc
comments — and a function's contracts: requires/ensures, the return
label, `ghost_fn` markers, the file's verification mode), completion,
navigation, rename and formatting.

## Tasks

The extension contributes workspace tasks — **Terminal → Run Task…**:

- **yo verify** — formal verification: prove every verify-mode function
  (contracts, AoRTE obligations) with the pinned Z3. Counter-examples
  print inline; the Problems panel collects each failure's location.
- **yo check** — type-check the workspace (evaluator only, no codegen).
- **yo test** — run the test suite.

Failures parse through the `yo` problem matcher (the compiler's
`error[Exxxx]` + `--> path:line:col` output shape).
