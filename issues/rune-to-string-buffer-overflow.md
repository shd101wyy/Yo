# rune ToString buffer overflow for 4-byte UTF-8 codepoints

## Status: Fixed

## Problem

`rune.to_string()` in `std/fmt/to_string.yo` used a 4-byte `Array(u8, usize(4))` buffer
for UTF-8 encoding, then passed it to `String.from_cstr()` which reads until a null byte.

For 4-byte UTF-8 characters (codepoints >= U+10000, e.g., mathematical symbols at U+1D504),
all 4 bytes are filled with non-zero data, leaving no room for a null terminator.
`String.from_cstr()` reads past the end of the stack buffer → **stack-buffer-overflow**.

## Reproduction

Any code that converts a high Unicode codepoint to a string:

```rust
(r : rune) = rune(u32(120068));  // U+1D504 (𝔄)
s := `${r}`;                      // crashes
```

Detected via AddressSanitizer:

```
ERROR: AddressSanitizer: stack-buffer-overflow
[32, 36) 'buffer' <== Memory access at offset 36 overflows this variable
```

## Fix

Changed the buffer from `Array(u8, usize(4))` to `Array(u8, usize(5))` in all branches,
ensuring there is always at least one zero byte after the UTF-8 encoded data for the
null terminator that `from_cstr` requires.

## Files Changed

- `std/fmt/to_string.yo` — `impl(rune, ToString(...))`: buffer size 4 → 5
