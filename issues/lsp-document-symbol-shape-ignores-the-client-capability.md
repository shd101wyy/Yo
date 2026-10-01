# documentSymbol always answers the hierarchical shape, ignoring `hierarchicalDocumentSymbolSupport`

**Severity:** S3 — `textDocument/documentSymbol` replied hierarchical
`DocumentSymbol[]` to every client, including clients that did not declare
`textDocument.documentSymbol.hierarchicalDocumentSymbolSupport`. Such
clients expect the flat `SymbolInformation[]` and cannot render the
hierarchical shape (an outline shows nothing). VS Code's client always
declares the capability, which is why it never showed there. Found 2026-09-30
by the closeout review of the 2026-09-29 audit's documentSymbol work.

## Reproduction

```
initialize params: {"capabilities":{}}           ← no documentSymbol capability
→ textDocument/documentSymbol
```

Pre-fix reply: `[{"name":…,"kind":…,"range":…,"selectionRange":…}, …]` —
the hierarchical shape, unconditionally.

## Fix

`initialize` records whether the client declared the capability
(`_client_wants_hierarchical_symbols`, module-level
`g_hierarchical_symbols`); the dispatch answers
`handle_document_symbols` (hierarchical) only when it did, else the new
`handle_document_symbols_flat` (`src/lsp/symbols.yo`) — the same collected
entries as `{name, kind, location : {uri, range}}` `SymbolInformation`
items. The lsp cli-cases (whose driver declares no capabilities) now pin the
flat shape.
