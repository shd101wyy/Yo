# `FromString` is implemented for 6 of the 13 numeric primitives

**Status: FIXED** (2026-09-09) — all thirteen numeric primitives now
implement `FromString` (renamed from `FromStr` in the same PR — see below). Found while writing `JsonValue.pointer`.

## Symptom

`s.parse(usize)` does not compile:

```
error[E0602]: Type usize does not implement required trait FromStr.
     --> std/string/string.yo:3198:56
     |
3198 |   parse : (fn(self : Self, comptime(T) : Type, where(T <: FromStr)) -> Result(T, T.Err))(
     |                                                        ^^
```

## Measurement

`std/string/string.yo` had exactly six `FromStr` impls (lines 3115, 3124,
3133, 3150, 3166, 3178):

| implemented | missing |
| --- | --- |
| `i64`, `u64`, `i32`, `u32`, `f64`, `bool` | `usize`, `isize`, `i8`, `i16`, `u8`, `u16`, `f32` |

Rust implements `FromStr` for **every** integer and float primitive, so
`"12".parse::<usize>()` is the ordinary spelling there. In Yo the caller has to
know which of the widths happens to be covered and convert:

```rust
match(token.parse(u64), .Ok(idx) => items.get(usize(idx)), .Err(_) => …)
```

`usize` is the width most likely to be parsed from text — it is what indexes
every collection — so its absence is the sharpest of the seven.

The first caller to hit it, `JsonValue.pointer`, had to parse a `u64` and
narrow; it now says `token.parse(usize)`.

## Why it is not just a missing line

The existing impls delegate to `_parse_i64_radix_res` / the `u64` scanner and
then narrow. A `usize` impl must narrow to the target width and report
`PosOverflow` when the value does not fit — `usize` is 64-bit on the targets in
`plans/reference/TARGET_TRIPLES.md` today but is defined as pointer-width, so
the impl has to go through the width-checked path rather than casting. The same
holds for `i8`/`i16`/`u8`/`u16`, where overflow is reachable with three-digit
input.

`f32` needs the `f64` grammar plus a range check against the `f32` finite
range (Rust returns `inf` for an overflowing `f32` literal rather than an
error — the impl must match that, not reject it).

## Fix

Seven impls in `std/string/string.yo`, beside the six that were there. One
generic impl is not possible today — there is no `Integer`-marker-bounded
`FromStr` blanket that can name its own width — so each narrows the shared
`_parse_i64_radix_res` / `_parse_u64_radix_res` result and reports the
side-specific overflow variant.

`usize` and `isize` take their bounds from the width-aware `MIN`/`MAX`
associated constants (which are already `cond`ed on
`__yo_pointer_size_bits()`), not from a literal, so a 32-bit target rejects
`4294967296` where a 64-bit one accepts it.

`f32` shares `f64`'s grammar and then narrows, and an over-large literal
becomes an INFINITY rather than an error — `"1e39".parse::<f32>()` is
`Ok(inf)` in Rust too. The narrowing is C's double-to-float conversion, which
saturates per IEC 60559 (C Annex F) on every target here.

Tests in `tests/string/string_parse.test.yo`: for each width a value, the exact
`MAX` (round-tripped through `to_string()` so the assertion cannot disagree with
the constant), `MAX + 1` → `PosOverflow`, and for the signed ones the exact
`MIN` and `MIN - 1` → `NegOverflow`; plus an empty string, a rejected sign on
`usize`, and `f32`'s empty / garbage / saturating cases.

Related: D12 (`FromStr` parsing returns `Result`) is LANDED — this is a
coverage gap in that decision, not a shape disagreement.

## The name was wrong too

`FromStr`/`from_str` was a mis-transliteration of Rust's name. Rust's is
ACCURATE — `fn from_str(s: &str)` takes a `&str` — and the pattern behind it is
"name the trait after the type it converts FROM". Yo's took a `String`, and its
own doc comment said so one line above the signature.

The alternative reading (make it take a `str` so the name becomes true) is not
available: `as_str()` was deleted in the slice rework, no method in
`std/string/string.yo` returns `str`, and `String.parse(T)` — the primary
caller — has a `String` receiver. `String` is the only parameter this trait can
take, so the name had to move.

Renamed in the same PR, along with two other sites that made the same mistake:

| before | after |
| --- | --- |
| `FromStr` / `from_str` | `FromString` / `from_string` |
| `log.level_from_str(name : String)` | `level_from_string` |
| `HttpMethod.from_str(s : String)` | `HttpMethod.from_string` |

`std/imm/string.yo` already had `from_string(s : String)` — the tree was
inconsistent with itself, not just with the types. Rust CITATIONS in doc
comments (`core::str::FromStr`, `i64::from_str`, `from_str_radix`) keep Rust's
spelling, because they name Rust's API and not Yo's.

Breaking: an `impl(T, FromStr(...))` in user code must be renamed. A
`FromStr :: FromString` alias would only half-bridge it — `where(T <: FromStr)`
would keep working, but the field name inside an impl is part of the trait, so
`from_str : …` would still fail. A half-bridge that covers one of the two ways
people use a trait is worse than a clean rename in the release notes.

`HttpMethod.from_string` returns `Option`, not `Result`, which is a D12
violation independent of its name — filed as
`issues/httpmethod-from-string-returns-option-not-result.md`.
