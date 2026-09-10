# A `\uXXXX` escape with non-hex digits is silently decoded as if they were `0`, and the two string-literal forms disagree

**Status:** OPEN — silent wrong values from a shipped escape decoder. Found
2026-09-11 while writing the TOML parser's `\u` escape tests (the test needed a
control character in the input and `"\u{0007}"` produced something else).

`"\uZZZZ"` compiles and evaluates to a single NUL byte. `"\u{41}"` compiles and
evaluates to U+0410 (Cyrillic А) rather than U+0041, and `"\u{263A}"` to U+0263
followed by the literal text `A}`. No diagnostic at any stage.

And the escape is not recognised in a BACKTICK template AT ALL — not even a
well-formed one: `"x\u0041y"` is the three bytes `xAy`, while `` `x\u0041y` ``
is the eight literal bytes `x \ u 0 0 4 1 y`. One spelling, two meanings, and
no diagnostic for the form that silently does nothing.

## Reproducer

`issues/repros/unicode-escape-accepts-non-hex-digits.yo`

```
yo compile issues/repros/unicode-escape-accepts-non-hex-digits.yo \
  --std-path ./std --optimize 2 -o /tmp/r && /tmp/r
```

Observed (`yo` 0.2.30, macOS arm64):

```
dq   u+ZZZZ     len=1: 0
dq   u+{41}      len=2: 208 144
dq   u+{263A}    len=4: 201 163 65 125
dq   x u+0041 y  len=3: 120 65 121
tmpl x u+0041 y  len=8: 120 92 117 48 48 52 49 121
```

(The reproducer's labels spell `u+XXXX` rather than the escape itself: a label
is a double-quoted literal too, so an escape written there would be decoded by
the very bug under test.)

| input | produced | required |
| --- | --- | --- |
| `"\uZZZZ"` | U+0000 | a compile error |
| `"\u{41}"` | U+0410 | a compile error (Yo's escape is `\uXXXX`, not `\u{XXXX}`) |
| `"\u{263A}"` | U+0263 + `A}` | a compile error |
| `` `x\u{41}y` `` | the literal 8 bytes `x\u{41}y` | a compile error, and in any case the SAME verdict as the `"…"` form |
| `` `x\u0041y` `` — WELL FORMED | the literal 8 bytes `x\u0041y` | `xAy`, which is what the `"…"` form gives |

So the double-quoted form is wrong only for a MALFORMED escape, while the
template form is wrong for every one. `yo fmt` leaves all of these spellings
untouched (measured), so a formatted file keeps whichever meaning it had.

## Root cause

`decode_str_lit_escapes` (`src/evaluator/values/string.yo:47`) decodes a
`\uXXXX` by reading the next four runes unconditionally and folding them with
`_hex4` (`:30`), whose digit helper `_hex_digit_val` (`:20`) ends in

```rust
    true => u32(0)
```

— every non-hex rune contributes zero instead of failing. So `{`, `4`, `1`, `}`
fold to `0*4096 + 4*256 + 1*16 + 0` = `0x410`, exactly the value observed, and
`ZZZZ` folds to `0`. The function's own doc comment claims "JSON.parse
semantics: exactly four hex digits", and `JSON.parse` THROWS on a non-hex digit
— the port kept the arithmetic and dropped the error.

The divergence with template strings has a different site: the template
scanner in `src/lexer.yo` (the `0x5C` arm at `:451`) has its OWN escape table,
and that table has no `\u` entry at all — it covers `` \` ``, `\$`, `\n`,
`\t`, `\r`, `\\`, `\"`, `\'`, `\0`, `\b`, `\f`, `\v`, then falls through to a
`true =>` arm that writes the backslash and the next character verbatim. So a
template string cannot express a unicode escape, and complains about none.

## Fix

1. Give `_hex_digit_val` a failure channel (`Option(u32)` / a sentinel) and
   make `decode_str_lit_escapes` raise a lexer/evaluator error naming the
   offending offset when any of the four runes is not hex — the message Rust
   gives is "invalid character in unicode escape".
2. Give the template-string scanner a `\u` entry (the same decoder) and make
   it reject a malformed one too, so both literal forms agree. Today a
   template cannot spell a unicode escape at all.
3. Decide whether Yo wants Rust's delimited form `\u{...}` at all. It is not
   supported today; if it is added it must be added to BOTH scanners, and the
   TOML/JSON codecs in `std/encoding` must keep rejecting it in their own
   inputs, because neither format admits it.

An unknown escape (`"\q"`) is a separate question: both forms currently keep it
literal, which Rust also rejects. Worth deciding with the above, but it is at
least CONSISTENT between the two forms today, so it is not part of this bug.

## Regression test

A `tests/` case cannot assert a compile error on a string literal directly
(there is no `comptime_expect_error` around a lexer failure in a value
position), so the gate belongs in `tests/cli-cases/`: a fixture whose
`main` contains `"\uZZZZ"`, with the expected rc and stderr recorded. Add a
positive case beside it (`"A"` == `A`) so the fix cannot over-reject.
