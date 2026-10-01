# semanticTokens emits rune columns and value-derived lengths — not the negotiated encoding, not the source span

**Severity:** S3 — `textDocument/semanticTokens/full` violates the negotiated
position encoding (utf-16 by default) and emits lengths that undercount
escape-bearing strings and overflow the line for multi-line tokens. Found
2026-09-30 by the closeout review of the 2026-09-29 audit's §3 item 5
(`plans/archive/LSP_AUDIT_2026-09-29.md`), which landed in #1020.

## Reproduction

Open a document containing an astral-plane character before an identifier and
request semantic tokens from a utf-16 client (the default negotiation — every
VS Code install):

```rust
main :: (fn() -> unit)({
  emoji := "🎉";
  x := 1;
  ()
});
```

The token for `x` is emitted with `deltaStartChar`/`length` counted in RUNES
(`usize(t.column)`, `t.value.chars().count()` — `handle_semantic_tokens`,
`src/lsp/folding.yo`). The `🎉` is two UTF-16 units but one rune, so every
column on that line after it is off by one on the wire: VS Code paints the
highlight shifted past the identifier. The same document gets correct ranges
from hover/references/rename/formatting — they all convert through
`rune_col_to_client`/`j_range_in`; `handle_semantic_tokens` was the one emit
path that never did (`docs/en-US/LSP.md` §Position encoding already promised
"converts every column it sends").

Two length defects share the emit loop:

- **Template strings**: `t.value` is the escape-DECODED text (`` `A` ``
  lexes to `A`), so `chars().count()` undercounts the source width — the
  string paints shorter than it is.
- **Multi-line tokens**: a block comment's single 5-tuple carries its whole
  multi-line rune length at its start position — the length overruns the
  line, which the protocol does not allow (a token cannot span lines).

## Root cause

The §3 item 5 first cut computed positions from the raw lexer token fields
and never threaded the document lines through the wire-conversion helpers,
and it took `length` from `t.value` instead of the source span.

## Fix

Compute every token's exact SOURCE span — `t.byte_offset` up to the next
token's `byte_offset` (EOF for the last), trimmed back over whitespace — walk
it byte-wise closing one segment per newline (so multi-line tokens split into
per-line segments), and convert each segment's start column AND width through
`rune_col_to_client` against the segment's own line. Tested by extending
`tests/cli-cases/lsp-position-encoding-utf16` to the new features and by
tuple-level internal tests (astral columns, escape lengths, multi-line
comment splitting).
