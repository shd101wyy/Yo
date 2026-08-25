# `utf16_to_utf8` reports unpaired surrogates as `EncodingError.InvalidChar(0)`

**Status:** OPEN — found during STD_API_AUDIT D8 (the `EncodingError` move out of
`hex.yo`). Not fixed there: the fix adds a variant to a now-shared error type, so
it is an API change that wants its own test, not a drive-by edit.

## Symptom

`std/encoding/utf16.yo` has two error paths, and both throw a **placeholder**:

```rust
// std/encoding/utf16.yo:81 — high surrogate with no following code unit
exn.throw(dyn(EncodingError.InvalidChar(u8(0))));
// std/encoding/utf16.yo:88 — following code unit is not a low surrogate
exn.throw(dyn(EncodingError.InvalidChar(u8(0))));
```

`EncodingError.InvalidChar(ch : u8)` is documented as *"Invalid character
encountered during decoding"*, and its payload is meant to be the offending
byte. Its `to_string` renders:

```
encoding error: invalid character 0
```

This is wrong in three ways:

1. **The payload is a lie.** The offending datum is a UTF-16 code unit (`u16`,
   e.g. `0xD800`), which does not fit in a `u8`, so the code discards it and
   passes `0`. Callers are told the bad character was NUL — a perfectly valid
   code unit — and the real value is unrecoverable.
2. **The variant is wrong.** Neither site is "invalid character": the first is
   *unpaired high surrogate at end of input*, the second is *high surrogate
   followed by a non-low-surrogate*. Both are structural pairing failures.
3. **The two distinct failures are indistinguishable** to a caller, since both
   produce the byte-identical error value.

The module doc-comment already promises better — it says `utf16_to_utf8`
"Throws via `Exception` on unpaired surrogates" — but no such error exists.

## Why it was not fixed in the D8 move

`EncodingError` now lives in `std/encoding/error.yo` and is shared by `hex`,
`base64` and `utf16`. A correct fix adds a variant carrying the real code unit:

```rust
/// UTF-16 surrogate that could not be paired.
UnpairedSurrogate(unit : u16),
```

plus a `to_string` arm. That widens the public surface of a freshly shared
error type and needs a test in `tests/encoding/utf16.test.yo` asserting the
variant and its payload for both sites. D8 was scoped to a pure move — the
`EncodingError` value is byte-for-byte unchanged by it — so this was left out
deliberately rather than smuggled in.

## Fix sketch

1. Add `UnpairedSurrogate(unit : u16)` to `EncodingError` in
   `std/encoding/error.yo`, with a `to_string` arm naming the code unit in hex.
2. `std/encoding/utf16.yo:81` → throw `UnpairedSurrogate(u16(w))` (the high
   surrogate that has no partner).
3. `std/encoding/utf16.yo:88` → throw `UnpairedSurrogate(u16(w2))` (the code
   unit that should have been a low surrogate).
4. Add tests to `tests/encoding/utf16.test.yo` for both paths, asserting the
   payload is the real code unit and not `0`.

Related: `plans/STD_API_AUDIT.md` D1/D2 (one error style per module) and D8
(the `EncodingError` relocation this was found under).
