# A multiline TemplateString token carries the END row and the START column — every diagnostic it anchors mispoints

> **FIXED 2026-10-02.** The template branch captures `tpl_start_ln` at entry
> (the `bc_start_ln` pattern the block-comment branch already used) and both
> pushes the token with `row : u32(tpl_start_ln)` and reports
> "unterminated template string" from it (src/lexer.yo). This also repairs
> `_template_body_origins` (src/parser.yo), which seeds each interpolation
> body's row from `tok.row` — those rows were shifted by the template's
> newline count. Pinned by "A multiline template token carries its START row"
> in `tests/internal/lexer.test.yo`.

**Severity:** S3 — misleading diagnostics: positions and carets for template
errors and interpolation-body errors point at the wrong line, or past EOF

Found 2026-10-02 by the post-#1092 lexer/parser/formatter audit workflow.

## Reproducer (pre-fix)

A template opening at 2:15 whose type error is reported at 3:15 (END line,
START column — a caret that lands off the end of the line); an interpolation
body on line 5 diagnosed at 7:5; an unterminated template on line 2 of a
7-line file reported at 8:11 — row 8 of a 7-line file.

## Root cause

The template scan loop mutates `line` for every newline (literal text and
interpolation bodies) but never the column; the token push used the loop's
final `line` with the entry `col`. Whitespace (`ws_start_ln`) and block
comments (`bc_start_ln`) already captured their start line; the template
branch was the only multiline token that did not. Because
`_template_body_origins` seeds from `tok.row` and advances row-by-byte, the
shift propagated to every diagnostic inside an interpolation body — even past
EOF. Identical on seed v0.2.48 (pre-existing).
