# `yo lsp` drops its analysis state on every error: a parse error empties the outline and silences hover/completion, an evaluation error drops every type

**Status:** FIXED 2026-09-08. Found 2026-09-08 during the LSP audit against
`origin/develop` (44f1370c4), reproduced at runtime by driving `yo lsp` over
stdio. **Severity:** wrong-value / feature outage on the most common editing
state — a document mid-keystroke does not parse, and most documents that parse
have some evaluation error while being written.

## Symptom

Driving the server with `src/lsp/hover.yo` as the document:

| state of the text                    | `documentSymbol` | `hover` on a typed local |
| ------------------------------------ | ---------------- | ------------------------ |
| clean                                | 5 symbols        | typed                    |
| an `undefined_qq()` call appended    | 6 symbols        | **null**                 |
| a dangling `foo.` appended           | **0 symbols**    | **null**                 |

So while typing `p.` (a parse error until the member is typed) the outline
vanishes, hover, definition, references, rename, signature help and identifier
completion all answer nothing — the only completion mode still working was the
import-path one, which does not consult the AST.

## Root cause

Two independent losses in `src/lsp/diagnostics.yo` + `src/module_manager.yo`:

1. **Parse error → program discarded.** `_analyze_eval` parsed AND evaluated
   inside one swallowing frame whose `unwind` value was a fresh
   `AnalyzeOutcome` with `exprs : ArrayList(AstExpr).new()`. The handler cannot
   reference the outer `exprs`, so a throw from `parse` lost nothing the frame
   still had — but the SERVER then stored that empty outcome over the previous
   good one (`docs.insert(uri, DocState(... outcome : oc))`) and every feature
   request read an empty program. The attic TypeScript server kept a
   "last good module" for exactly this; `completion.yo`'s header recorded its
   removal as a deliberate v1 divergence.
2. **Evaluation error → ExprInfo discarded.** `mm_eval_entry_exprs` captures
   evaluation errors inside `_eval_module_exprs_capturing_error` and, on
   failure, returned `_failed_outcome()` — a throwaway `eval_context_new(...)`
   with an EMPTY `expr_info_table`. The real ctx, holding the ExprInfo of every
   expression evaluated before the error, was dropped on the floor, so the LSP
   stored `info_table : outcome.ctx.expr_info_table` = nothing.

## Fix

- `mm_eval_entry_exprs` returns `ok : false` with the REAL `env`/`ctx` on
  failure (`check`/`build` read only `ok` on that path).
- `diagnostics.yo` splits the analysis into two frames: `_parse_document`
  (`Option(ArrayList(AstExpr))`, `.None` on a parse error) and `_analyze_eval`
  (`EvalOutcome { ok, info_table }`). `AnalyzeOutcome` gains `parsed : bool`;
  `parsed && !ok` carries the full program plus the partial table.
- `server.yo` keeps the LAST PARSED outcome per document: an outcome with
  `parsed == false` does not replace the previous one (the text and lines are
  still updated, so positions are matched against the current text by token
  and a stale outcome answers only where the two still agree).

## Verification

`tests/cli-cases/lsp-analysis-resilience`: clean → evaluation error (hover
still `total : i32`, outline gains `later`, signature help answers) → parse
error (outline, hover and completion still answer while the diagnostic reports
`unexpected token: }`) → clean again. `tests/internal/lsp_protocol.test.yo`
("analysis state survives evaluation and parse errors") asserts `parsed`/`ok`,
the retained program length, and that `handle_hover` is typed after an
evaluation error.
