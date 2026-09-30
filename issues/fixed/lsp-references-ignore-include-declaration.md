# `textDocument/references` ignores `context.includeDeclaration`

**Status:** FIXED 2026-09-29 (audit §2 PR, plans/archive/LSP_AUDIT_2026-09-29.md): `handle_references` takes `include_declaration` (default true, read from `params.context` in the dispatch); `collect_symbol_occurrences_with_decl` reports the declaration token and the declaration occurrence is dropped when the client asked for references only. Was: **Severity:** S3 — "Find All References" always includes the declaration even when the client asked to exclude it; minor protocol-conformance defect, no data loss.

## Reproduction

`plans/archive/LSP_AUDIT_2026-09-29.md` probe session A, against the installed v0.2.45
binary. Same document, same position (the `p` declaration at 1:1), both
`context` values:

```json
"context":{"includeDeclaration":true}   → [1:1, 2:35, 2:43]
"context":{"includeDeclaration":false}  → [1:1, 2:35, 2:43]   // identical
```

`server.yo`'s dispatch never reads `params.context`, and
`handle_references` (`src/lsp/references.yo`) always returns every occurrence
`collect_symbol_occurrences` finds, declaration included.

The LSP spec defines the flag precisely for this request; VS Code sends
`includeDeclaration: false` for the "Find All References" command when the
`references` setting disables showing the declaration (default ON, so most
users see no difference — S3, not S2).

## Fix

Read `context.includeDeclaration` in the dispatch and pass it into
`handle_references`. When false, drop the occurrence that sits on the
declaration token itself: `collect_symbol_occurrences` already computes that
token (`_binding_token_of` on the best candidate), so the clean shape is to
have it return `(occurrences, declaration_token)` and let the handler filter
by position, rather than re-deriving the declaration in `server.yo`.

## Test

One more request in the `lsp-handshake` (or `lsp-rename-identity`) cli-case
stdin with `includeDeclaration: false`, golden hand-authored to show the
declaration line absent.
