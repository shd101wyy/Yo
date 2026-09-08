# `publishDiagnostics` reports every diagnostic as an error with no code

**Status:** FIXED 2026-09-08. Found 2026-09-08 during the LSP audit against
`origin/develop` (44f1370c4). **Severity:** wrong-value (a `warning`/`note`
shows as a red error; `yo explain E0401` cannot be reached from the editor).

## Symptom

`j_diagnostic` (`src/lsp/protocol.yo`) hard-coded `"severity": 1`, and
`LspDiag` (`src/lsp/diagnostics.yo`) had no severity or code field — even
though the typed `Diagnostic` the evaluator produces (P1–P3 of
`plans/reference/ERROR_DIAGNOSTICS_OVERHAUL.md`) carries both, and the
text-parsing fallback already recognised `error[E0401]: ` headers only to
strip them.

## Fix

`LspDiag` gains `severity` (LSP `DiagnosticSeverity`: error 1, warning 2,
note → information 3, help → hint 4) and `code : Option(String)`. The typed
channel maps `Diagnostic.severity` / `.code` directly; the text fallback's
header split (`_strip_severity_prefix` → `SevPrefix`) yields the same two
fields. `j_diagnostic` emits `"code"` when present.

## Verification

Every `lsp-*` golden's diagnostics now carry `"code":"E0401"` (variable not
found) or `"code":"E0001"` (parse error); see `lsp-handshake` frame 1.
