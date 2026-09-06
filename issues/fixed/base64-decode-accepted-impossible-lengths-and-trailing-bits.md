# `base64_decode` accepted a length of 1 mod 4 and non-canonical trailing bits

**Status: FIXED** (2026-09-06, `std/encoding/base64.yo`,
`std/encoding/error.yo`). Found by the std API audit —
`plans/STD_API_STABILIZATION.md` §3 item 10.

## Symptom

After stripping padding the decoder walked the symbols in groups of four and
emitted whatever it could:

- **`len % 4 == 1`** — a lone trailing sextet (`"QUJDR"`): no encoder produces
  it, since one symbol holds six bits and a byte needs eight. The decoder
  emitted a byte assembled from the sextet and a phantom `A`.
- **Non-canonical trailing bits** — `"QR=="` decoded to `A` exactly like the
  canonical `"QQ=="`: the second symbol's low four bits (`0001`) are unused by
  the one byte a two-symbol group encodes, and were dropped silently. Same for
  a three-symbol group whose last symbol's low two bits are set (`"QUJ="` vs
  `"QUI="`).

Accepting these means two different inputs decode to the same bytes, which
breaks every use of base64 as a canonical identifier (JWT segments, content
hashes, signature inputs). Rust's `base64` crate rejects both
(`InvalidLength`, `InvalidLastSymbol`).

## Fix

Two new `EncodingError` variants, `InvalidLength` and `InvalidLastSymbol(ch)`,
thrown through the caller's `Exception` like `InvalidChar`. Padding stays
optional (accepted when present and trailing) — `"QQ"` and `"QQ=="` both decode.

## Regression tests

`tests/encoding/base64.test.yo` — the three rejections above and a canary that
the canonical short groups still decode, padded or not.
