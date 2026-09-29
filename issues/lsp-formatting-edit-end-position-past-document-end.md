# `textDocument/formatting`'s whole-document edit ends one line past EOF

**Severity:** S3 — an out-of-bounds TextEdit range that conforming clients are entitled to reject; VS Code silently clamps, so the visible symptom is none there.

## Reproduction

`plans/LSP_AUDIT_2026-09-29.md` probe session A. A 4-content-line document
(lines 0–3, trailing newline) needing a format returns:

```json
[{"range":{"start":{"line":0,"character":0},"end":{"line":5,"character":0}},
  "newText":"<formatted>"}]
```

`end` is (5,0) on a document whose last valid position is line 4 (the empty
line after the trailing newline), one line past the end. `_format_document`
(`src/lsp/server.yo`) computes `line_count := text.split("\n").len()` and
ends the edit at `(line_count, 0)`, which is past EOF for every text shape
(trailing newline or not). The `lsp-handshake` golden records the same
out-of-bounds `(3,0)` end for its 3-line document — the bug is pinned as
correct behavior in the golden.

The LSP spec allows a client to reject positions outside the document; the
common idiom for whole-document replacement is either the exact last position
or a huge sentinel line, never a line that is exactly one past.

## Fix

End the edit at the true last position:

```rust
last := match(lines.get(line_count - 1), .Some(l) => l, .None => String.new());
j_range(0, 0, line_count - 1, last.chars().count())
```

(column 0 and the final line's rune count need no wire conversion; a line's
rune count equals its UTF-16 count only for BMP-only lines, so route the end
column through the same conversion the server uses elsewhere —
`rune_col_to_client` — for correctness on astral-plane content).

## Test

Update the `lsp-handshake` golden's formatting frame (hand-edit the expected
end position; `refit_lsp_frames` recomputes `Content-Length` on compare) and
add a CJK-emoji last-line case to the same stdin if cheap.
