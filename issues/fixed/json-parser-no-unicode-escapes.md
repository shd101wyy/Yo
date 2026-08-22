# std json parser rejected `\uXXXX` escapes (JSON-spec violation; broke LSP didOpen on real files)

**Found:** 2026-08-22, measuring LSP re-analysis latency on a compiler-sized
module. A scripted `didOpen` of `src/lsp/hover.yo` produced ZERO
publishDiagnostics and `yo-lsp: skipping malformed message: invalid escape
sequence` on stderr — the server silently dropped every message carrying
the file's text.

## Root cause

`_Parser.parse_string` (std/encoding/json.yo) handled `\n \t \r \" \\ \/
\b \f` and returned `.Err(.InvalidEscape)` for everything else — including
`\uXXXX`, which RFC 8259 §7 REQUIRES a parser to accept. Any JSON writer
that escapes non-ASCII (Python's `json.dumps` default, many LSP clients)
produced payloads std json could not parse. The `JsonError.InvalidUnicode`
variant existed but nothing ever produced it.

## Fix

`parse_hex4` (four hex digits → code unit) + `_push_utf8` (code point →
UTF-8 bytes, division/modulo since the closed operator set has no shifts),
with full surrogate handling: a high surrogate must be followed by
`\uDC00`–`\uDFFF` (combined per UTF-16), and a lone surrogate in either
direction is `.Err(.InvalidUnicode)`.

En route, the escape `cond` arms were braced: the original unbraced arms
returned `bytes.push(...)`'s value, so a new block-shaped arm (unit) made
the arms' types incompatible — the same "brace arms with push" rule the
syntax cheatsheet records for match.

## Verification

- 5 new tests in `tests/encoding/json.test.yo`: BMP escapes byte-for-byte
  (`A`/`é`/`中`), the surrogate pair `😀` → 4-byte
  UTF-8, lone high / lone low surrogate errors, non-hex `\uZZZZ` error.
  40/40 pass. (Pre-fix red established live: the LSP probe printed
  `invalid escape sequence` for `A`-bearing payloads.)
- The original symptom is the regression gate: a `didOpen` of hover.yo
  (unicode in doc comments → `\u` escapes under ensure_ascii encoding)
  must publish diagnostics instead of dropping the message.
