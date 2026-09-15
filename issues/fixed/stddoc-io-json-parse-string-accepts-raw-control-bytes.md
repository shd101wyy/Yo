# `json` string scanner accepts raw control bytes and unvalidated UTF-8

**Status: FIXED** 2026-09-15 — BOTH halves, the control bytes and the UTF-8
validation. Found while writing `///` docs for `std/encoding/json.yo` (the
2026-09-11 std doc sweep) and originally filed rather than fixed, on the
grounds that tightening it is breaking. It is breaking, and it was taken
anyway: the alternative was a `String` that claims to be UTF-8 while holding
bytes that are not.

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

## Fix as applied

Two changes in `_Parser.parse_string`, and no new error variant for either.

**1. Control bytes** — exactly the arm this doc suggested, placed immediately
BEFORE the catch-all. Order matters: `cond` arms are tried in sequence, and the
`"` (0x22) and `\` (0x5C) arms must keep answering first.

```rust
(c < u8(0x20)) => {
  return(.Err(.UnexpectedChar(c, self.pos)));
},
```

`UnexpectedChar` already carries `(ch, pos)`, so the error names the offending
byte and its offset.

**2. UTF-8 validation** — which this doc called "a separate, larger decision".
It turned out to be three lines, because `std/encoding/utf8` already exports
`validate(bytes : ArrayList(u8)) -> Result(unit, Utf8Error)`. The pass runs
ONCE, over the finished output buffer, just before `String.from_bytes`:

```rust
match(
  utf8.validate(bytes),
  .Err(_) => { return(.Err(.InvalidUnicode)); },
  .Ok(_) => ()
);
```

Validating the OUTPUT rather than the input is what makes it both cheap and
exact, and it is the part worth remembering. Everything a `\uXXXX` escape
contributed was written by `encode_lossy_into` from an already-surrogate-checked
scalar, so it is valid by construction; the only thing this pass can reject is a
literal byte copied from the input, which is precisely the population at issue.
One pass per string, not one decode per byte — which is what made the doc's
estimate of the cost too high.

`.InvalidUnicode` is reused rather than a new variant being added: callers
`match` `JsonError`, so a new variant would be a second breaking change stacked
on the behavioural one, and "invalid unicode" describes an invalid UTF-8 run
accurately.

## Why this is breaking — and why it was taken anyway

Input that parsed before now returns `.Err`. A caller feeding this parser text
from a source that emits raw newlines inside strings — a hand-written config, a
log line — will see errors it did not see before. That is the real cost.

Against it: the UTF-8 half was not merely lenient, it was unsound. `String`
claims to be UTF-8, and the scanner was copying arbitrary input bytes into one,
so the parser could hand back a value that lied about its own type. Every
comparable implementation (`serde_json`, `JSON.parse`, Go's `encoding/json`)
rejects both shapes. The module is marked unstable, which is the window for
exactly this change.

`std/encoding/json.yo`'s `## Stability` section previously named this as one of
the module's two open questions; it now records the question as settled and
which way, leaving the `json_parse_*` → `json.parse` rename as the one
remaining item.

## Verification

Boundary and non-regression, measured 2026-09-15:

```
-- raw bytes inside a string --
  LF   0x0A: rejected (unexpected character at position 7)
  NUL  0x00: rejected (unexpected character at position 7)
  TAB  0x09: rejected (unexpected character at position 7)
  CR   0x0D: rejected (unexpected character at position 7)
  0x1F     : rejected (unexpected character at position 7)
  SPACE 0x20: ACCEPTED -> {"a":"x y"}
  lone 0x80 : rejected (invalid unicode)
  lone 0xFF : rejected (invalid unicode)
-- valid input must still parse --
  escapes    : Ok -> {"a":"x\ny\tzé"}
  utf8 direct: Ok -> {"a":"héllo ☃ 𝄞"}
  empty      : Ok -> {"a":""}
  surrogate  : Ok -> {"a":"𝄞"}
  lone surrog: Err (invalid unicode)
```

The `SPACE 0x20` row is the over-rejection canary and is the reason the guard is
`< 0x20` and not `<= 0x20`: RFC 8259's `unescaped` production STARTS at 0x20, so
a literal space is legal and rejecting it would break ordinary JSON.

Regression tests are four cases in `tests/encoding/json.test.yo`, and
`issues/repros/stddoc-io-json-parse-string-accepts-raw-control-bytes.yo` now
ASSERTS instead of printing — as filed it printed its finding and exited 0
either way, so it could not tell a fixed tree from a broken one.
