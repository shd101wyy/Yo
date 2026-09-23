# A template interpolation body was scanned as template text, not as code

**Status: FIXED.** Found while auditing `yo context` (`plans/reference/YO_CONTEXT.md`),
whose `src/context_command.yo` worked around it by building every escape
sequence from raw bytes ("backslash escape literals stacked through generators
are where E0004s come from"). Every mechanism below was measured with a
tree-built binary on 2026-09-23.

## Symptoms

Three scanners each decided where a `${...}` body ends by counting every brace,
and the lexer decoded template escapes inside the body as well as in the
literal text around it:

```rust
a := `x`;
println(`[${a.concat(String.from("\n"))}]`);  // E0004 unterminated string literal
println(`[${"q\"q"}]`);                         // E0004: the body became "q"q"
println(`[${id("}")}]`);                        // E0004: the body ended at the inner }
println(`[${id("{")}]`);                        // E0004 unterminated template string
```

1. **Lexer** (`src/lexer.yo`, template arm). The escape arm ran before the
   interpolation arms, at ANY brace depth, so `"\n"` inside the body was
   decoded to a real newline before the parser re-lexed the body — an
   unterminated `"` literal. A `{` or `}` inside a string literal in the body
   moved the brace depth.
2. **Parser** (`parse_template_string`). The same naive brace count split the
   token value into parts, so `${id("}")}` was cut at the first `}`.
3. **Formatter** (`read_raw_template_string`). Same count over the raw
   source: `${id("{")}` never returned to depth 0, so the "template" ran to the
   next backtick in the file.

A fourth defect sat in the same place: the parser lexed each body as a
**standalone string** (`Parser.new(expr_text, …)`), so every token in an
interpolation — and every diagnostic about it, from the lexer, the parser or
the evaluator — reported row 1, column 1 of the body text, and printed the body
alone as the source line:

```text
error[E0401]: Variable "nope" not found.
  --> w4.yo:1:1        // the name is at w4.yo:4:21
  |
1 | nope + x
```

## Fix

- `interpolation_body_end` (`src/utils.yo`) is the one scanner. From just past
  `${` it returns the index of the closing `}`, treating the body as code: it
  skips `"..."` and `'...'` literals (with their backslash escapes) and nested
  backtick templates (with their own escapes and `${}`), and counts `{ }`
  groups. It is byte-level — every delimiter is ASCII and no UTF-8
  continuation byte is.
- The lexer copies each body VERBATIM up to that `}`; escape decoding applies to
  the literal text only. The parser and the formatter use the same scanner, so
  the three cannot disagree.
- `tokenize_span` (`src/lexer.yo`) lexes a byte range of a file with a base
  row/column/rune index; `tokenize` is the whole-file case. The parser finds
  each body's origin in the raw source (`_template_body_origins`, from the
  token's `byte_offset`) and parses it with `Parser.new_span`, so body tokens
  and diagnostics carry file positions. A synthetic template token (no backtick
  at its offset) keeps the standalone lex.

## Tests

- `tests/template_string_specs.test.yo` — "an interpolation body is scanned as
  code, not template text": escapes, quotes, both braces and a backtick inside
  a body's string literal, a nested template, and the literal text still
  decoding. Fails to lex before the fix.
- `tests/cli-cases/check-template-interpolation-error-position` — the E0401
  inside `${...}` reports `bad.yo:4:21`.
