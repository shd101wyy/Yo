# `FromStr` is implemented for 6 of the 13 numeric primitives

**Status: OPEN.** Found 2026-09-09 while writing `JsonValue.pointer`.

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

`std/string/string.yo` has exactly six `FromStr` impls (lines 3115, 3124,
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

## Fix sketch

One generic impl is not possible today (there is no `Integer`-marker-bounded
`FromStr` blanket that can name its own width), so this is seven impls plus a
test per width covering: a value, the exact `MAX`, `MAX + 1` → `PosOverflow`,
the exact `MIN`, `MIN - 1` → `NegOverflow` for the signed ones, an empty
string, and a `+`/`-` sign.

Related: D12 (`FromStr` parsing returns `Result`) is LANDED — this is a
coverage gap in that decision, not a shape disagreement.
