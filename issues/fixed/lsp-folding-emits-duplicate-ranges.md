# `textDocument/foldingRange` emits every function body twice

**Status:** FIXED 2026-09-08. Found 2026-09-08 reading the `lsp-handshake`
golden during the LSP audit. **Severity:** cosmetic (the editor shows one
fold marker; the duplicate is wasted work and a wrong golden).

## Symptom

For `main :: (fn() -> unit)({ … });` spanning lines 2–5 the server answered

```json
[{"startLine":2,"endLine":5,"kind":"region"},{"startLine":2,"endLine":5,"kind":"region"}]
```

## Root cause

`src/lsp/folding.yo` pushes a region for every multi-line `(`…`)` AND every
multi-line `{`…`}` pair. The universal function-definition shape
`(fn(...) -> T)({ ... })` opens a `(` and a `{` on the same line and closes
them on the same line, so both pairs describe the same fold.

## Fix

`_push_fold` deduplicates on `(startLine, endLine, kind)`.

## Verification

`lsp-handshake` frame 8 and `lsp-rename-identity`'s folding request now carry
one region each.
