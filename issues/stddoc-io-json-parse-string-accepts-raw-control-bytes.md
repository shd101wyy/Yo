# `json` string scanner accepts raw control bytes and unvalidated UTF-8

**Status:** open. Found while writing `///` docs for `std/encoding/json.yo`
(the 2026-09-11 std doc sweep). Documentation-only PR — filed, not fixed.
Documented at `_Parser.parse_string` and in the module's `## Stability`
section rather than changed, because tightening it is breaking.

## What happens

RFC 8259 §7 defines a JSON string's unescaped range as

```
unescaped = %x20-21 / %x23-5B / %x5D-10FFFF
```

— that is, everything except `"`, `\`, and **U+0000 through U+001F**, which
must be escaped. `_Parser.parse_string`'s catch-all arm pushes any byte that
is not `"` (0x22) or `\` (0x5C):

```rust
true => {
  bytes.push(c);
  self.advance();
}
```

so a raw LF, CR, TAB or NUL inside a string is accepted. `serde_json` rejects
it: `control character (
) found while parsing a string`.

The same arm performs no UTF-8 validation, so invalid UTF-8 in the input is
copied byte-for-byte into the resulting `String` — which then claims to be
UTF-8. (`\uXXXX` escapes ARE validated: surrogate pairing is checked and a
lone surrogate is `.Err(.InvalidUnicode)`. It is only the literal bytes that
go unchecked.)

## Verbatim output

```
$ yo compile issues/repros/stddoc-io-json-parse-string-accepts-raw-control-bytes.yo \
    --std-path ./std --optimize 2 -o /tmp/t && /tmp/t
ACCEPTED raw control byte: {"a":"x\ny"}
```

The input was the 11 bytes `{"a":"x<0x0A>y"}`. Note the round-trip through
`json_stringify` ESCAPES the byte, so the output is valid JSON — the data is
not corrupted, it is just that invalid input was accepted.

## Reproducer

`issues/repros/stddoc-io-json-parse-string-accepts-raw-control-bytes.yo`

Expected: `.Err` — `serde_json`, `JSON.parse` and Go's `encoding/json` all
reject a raw control byte in a string.

## Root cause

`parse_string`'s `cond` has arms for the closing quote and the escape
introducer, and a `true =>` fallback that accepts everything else. There is no
lower bound on `c`. This is the same shape as the already-fixed number bug in
this file — `parse_number` used to scan characters without checking them and
`.Ok(atof(...))` anything, so `"hello"` parsed as the number 0
(`issues/fixed/json-number-parser-accepts-invalid-and-any-garbage.md`). The
string scanner was not part of that fix.

## Suggested fix (not applied)

Add the range check to the fallback arm:

```rust
(c < u8(0x20)) => {
  return(.Err(.UnexpectedChar(c, self.pos)));
},
```

`UnexpectedChar` already carries `(ch, pos)`, so the error can name the
offending byte and its offset without a new variant.

UTF-8 validation is a separate, larger decision: `std/encoding/utf8` has the
decoder, but running it over every string body costs a pass, and the module
would need an error variant for it. Worth deciding at the same time, since
both make today's accepted input an error.

## Why this is breaking, not a bug fix

Input that parses today would start returning `.Err`. Any caller feeding this
parser text from a source that emits raw newlines inside strings — a
hand-written config, a log line — would break. `std/encoding/json.yo`'s
`## Stability` section names it as one of the module's two open questions so
the marker stays honest until it is decided.
