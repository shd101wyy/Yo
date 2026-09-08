# A parse error's diagnostic is re-published after the document is fixed

**Status:** FIXED 2026-09-08. Found 2026-09-08 while recording
`tests/cli-cases/lsp-analysis-resilience`: after a parse error was corrected,
the next `publishDiagnostics` for the clean text still carried
`unexpected token: }` (at a line the document no longer had). Latent since
the LSP MVP; the pre-existing `lsp-handshake` case only exercised an
EVALUATION error, which does not hit it. **Severity:** wrong-value (a phantom
squiggle that persists until the next parse error).

## Root cause

`analyze_document` (`src/lsp/diagnostics.yo`) drains its error channels
conditionally. The parse handler stashes the error TWICE — as typed
diagnostics (`stash_error_diagnostics`) and as rendered text
(`_stash_parse_error`). The typed channel is taken first and, being non-empty,
the text channel is never drained. On the next round nothing throws, the typed
channel is empty, and the analysis falls back to the STALE text stash, which
still holds the previous round's parse error. The load-error stash
(`_take_load_error`) has the same shape.

## Fix

Every round drains all three channels unconditionally (typed, parse text,
load text) and only then decides what to report: the typed diagnostics when
present, else the text fallbacks. A stash can no longer outlive the analysis
that filled it.

## Verification

`tests/cli-cases/lsp-analysis-resilience`: the `publishDiagnostics` after the
fixed text is `[]`.
