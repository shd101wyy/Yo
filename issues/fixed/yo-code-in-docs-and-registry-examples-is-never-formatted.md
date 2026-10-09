# Yo code in the docs and the registry examples was never formatted

**Severity:** S3: documentation quality. Code that `yo explain`, the docs and the agent skills teach drifted from how `yo fmt` writes code: E0003's good example (the fix a reader copies) read `(fn(a : i32, b : i32, c : i32) -> i32)((a + (b * c)))`, with a redundant pair `yo fmt` removes from real code.

## Root cause

`yo fmt` only formatted `.yo` files' code. Yo examples live in three places
it never read: Markdown fences (tagged ```rust for GitHub's highlighter, so no
tool could even tell them from Rust), `///` / `//!` doc comments, and the
diagnostics registry's example strings.

## Fix

- `yo fmt` formats ```yo blocks: in `.md` files, and in a `.yo` file's doc
  comments (`format_yo_fences`, `src/formatter.yo`). A ```yo block must parse;
  ```yo ignore opts a fragment or an intentionally invalid example out.
- Every Yo fence in `docs/`, `.github/`, `README.md` and the doc comments is
  ```yo (1,168 relabelled from ```rust, 40 of them ```yo ignore) and was
  formatted once; CI's fmt step and `gates_fast.sh` check those paths.
- `tests/internal/diagnostics_registry_examples.test.yo` asserts every good
  example is `yo fmt`-clean.

Tests: `tests/internal/formatter.test.yo` ("format_yo_fences: …", four cases)
and the registry assertion.
