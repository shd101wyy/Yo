# A brace or quote inside a comment inside an interpolation mis-cuts the body

> **FIXED 2026-10-02.** `interpolation_body_end` (src/utils.yo) gained
> comment modes in its CODE/GROUP states: `//` skips to the newline, `/*`
> skips past its matching `*/` with the lexer's own nesting depth. Pinned by
> "A comment inside an interpolation does not close the body" in
> `tests/internal/lexer.test.yo` and "a comment inside an interpolation body
> does not close it" in `tests/template_string_specs.test.yo`.

**Severity:** S2 — valid programs rejected: `` s := `a ${x /* } */} b`; ``
fails with "unterminated block comment", `` `a ${x // don't} b` `` with
"unterminated template string"

Found 2026-10-02 by the post-#1092 lexer/parser/formatter audit workflow.

## Reproducer (pre-fix)

```rust
main :: (fn() -> unit)({
  x := 1;
  s := `a ${x /* } */} b`;   // error: unterminated block comment
  t := `a ${x // don't} b`;  // error: unterminated template string
});
export(main);
```

## Root cause

`interpolation_body_end` — the scanner shared by the lexer, the parser and
the formatter so the three cannot disagree where a `${...}` body ends —
skipped string, char and nested-template literals but had no comment mode:
the commented `}` ended the body early (the body then re-lexed as code and
died on the unterminated `/*`), and an apostrophe inside a line comment was
taken as a char-literal opener whose `_skip_quoted_literal` ran to the
newline, swallowing the real closing brace. Comments containing no `}`, quote
or backtick always worked. Identical on seed v0.2.48 (pre-existing).
