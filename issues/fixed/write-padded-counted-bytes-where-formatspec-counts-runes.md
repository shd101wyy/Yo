# `write_padded` measured width in BYTES where `FormatSpec` measures RUNES

**Status: FIXED** (2026-09-09) — moved to `std/string/string_builder.yo` with
the rest of `Writer` and corrected there.

## Symptom

Two width bases in one module:

```rust
// std/fmt/writer.yo — BYTES
write_padded : (fn(self, s : str, width, pad, align) -> Self)({
  len := s.len();               // `str.len()` is __yo_str_len — bytes
  ...

// std/fmt/spec.yo — RUNES
_apply_width :: (fn(fill, align, width, text : String, dflt) -> String)(
  // `width` is a CHARACTER count (the field doc says so, and Rust counts
  len := text.chars().count();
```

So `{:8}` and `write_padded(s, 8, …)` disagreed on any text that is not pure
ASCII. `"héllo"` is 6 bytes and 5 runes, so padding it to 8 emitted **two**
spaces where a column needs **three**, and a table built with `write_padded`
came out ragged exactly on the rows with accents.

Rust counts `chars` for `{:width$}`, and `FormatSpec`'s doc already said
CHARACTER — `write_padded` was the one that was wrong.

## Why it went unnoticed

`write_padded` had **no caller and no test** anywhere in `std`, `src` or
`tests`. It was exported, documented, and dead — the same shape as the borrow
backstop that sat unused for two months. ASCII also hides the defect
completely, because there the two counts agree.

## Fix

Count runes by scanning for UTF-8 lead bytes — every byte that is not a
continuation byte (`0b10xxxxxx`) starts a rune:

```rust
_str_rune_count :: (fn(s : str) -> usize)({
  n := usize(0);
  i := usize(0);
  while(i < s.len(), i = (i + usize(1)), {
    if((s.bytes(i) & u8(192)) != u8(128), { n = (n + usize(1)); });
  });
  n
});
```

A scan rather than a decode: `str` has no rune iterator (it exposes `len`,
`ptr` and `bytes(i)`), and counting lead bytes needs no validation pass and no
allocation.

## Tests

`tests/fmt.test.yo` — "StringBuilder.write_padded pads to a RUNE width, not a
byte width": the `"héllo"` case both ways round, an ASCII case (unchanged,
which is why the defect stayed invisible), centre alignment putting the odd pad
on the right, a MULTI-BYTE pad rune counting as one column, and an
already-over-width string passing through untouched.
