# A lone `\uXXXX` surrogate escape is silently accepted — a template loses the whole literal, a quoted literal gets invalid bytes

> **FIXED 2026-10-02.** The lexer now rejects a lone surrogate half in BOTH
> literal forms with the braced form's own diagnostic ("unicode escape names
> a surrogate, which is not a character; write the astral code point itself",
> shared via `surrogate_escape_error_message`, src/utils.yo): the template
> `\u` arm after its pair attempt (src/lexer.yo), and the double-quoted
> validation `.Ok` arm with the same pairing lookahead (src/lexer.yo). The
> evaluator's decoder (src/evaluator/values/string.yo), now
> unreachable-from-source for a lone half, copies the escape text through
> instead of encoding CESU-8. Pinned by "A lone surrogate escape in a
> template / double-quoted literal is a lex error" in
> `tests/internal/lexer.test.yo` (the PAIR test beside them stays green).

**Severity:** S2 — wrong String values, silently: `` `x\uDC00y` `` evaluates
to the EMPTY String; `"x\uD800y"` carries three invalid CESU-8 bytes

Found 2026-10-02 by the post-#1092 lexer/parser/formatter audit workflow.

## Reproducer (pre-fix)

```rust
main :: (fn() -> unit)({
  t := `x\uDC00y`;    // String of length 0 — x and y lost too
  q := "x\uD800y";    // 5 bytes: 'x', ED A0 80 (CESU-8 of U+D800), 'y'
  b := `x\u{D800}y`;  // REJECTED — the braced spelling always was
});
export(main);
```

## Root cause

`scan_unicode_escape`'s four-digit form deliberately returns `.Ok` for a
surrogate (a HIGH+LOW PAIR is how that form spells an astral code point), and
both consumers pair only a HIGH half directly followed by a LOW half's
`\uXXXX`; a half that does not pair fell through to `write_rune(rune(code))`.
`encode_into` encodes any code below 0x10000 — surrogates included — as its
3-byte "UTF-8" shape, which for a surrogate is CESU-8: not UTF-8. In a
template the decoded bytes were re-split by the parser into a synthetic
quoted literal whose decoder (`String.chars()` stops at the first
undecodable sequence) read ZERO characters — hence the empty String with the
surrounding literal text lost. Identical on seed v0.2.48 (pre-existing).
