# `is_valid_entity_code` answers `true` for a negative code point

**Status:** open. Found while writing `///` docs for
`std/encoding/html_char_utils.yo` (the 2026-09-11 std doc sweep).
Documentation-only PR — filed, not fixed; the behaviour is documented at the
function and named in the module's `## Stability` section.

## What happens

`is_valid_entity_code` is an EXPORTED predicate (from both
`std/encoding/html_char_utils` and, re-exported, `std/encoding/html`) whose
doc reads "is a valid HTML entity value". Every one of its range checks is
written against positive values:

```rust
is_valid_entity_code :: (fn(c : i32) -> bool)(
  cond(
    ((c >= i32(0xD800)) && (c <= i32(0xDFFF))) => false,
    ((c >= i32(0xFDD0)) && (c <= i32(0xFDEF))) => false,
    (((c & i32(0xFFFF)) == i32(0xFFFF)) || ((c & i32(0xFFFF)) == i32(0xFFFE))) => false,
    ((c >= i32(0x00)) && (c <= i32(0x08))) => false,
    (c == i32(0x0B)) => false,
    ((c >= i32(0x0E)) && (c <= i32(0x1F))) => false,
    ((c >= i32(0x7F)) && (c <= i32(0x9F))) => false,
    (c > i32(0x10FFFF)) => false,
    true => true
  )
);
```

so a negative `c` fails every arm and reaches `true => true`. There is no
`c < i32(0)` check, and the upper bound is one-sided.

Some negatives are caught by ACCIDENT: the noncharacter test masks with
`0xFFFF`, so anything whose low 16 bits are `0xFFFE`/`0xFFFF` — `-1` and
`-2` included — is rejected. Anything else is not.

## Verbatim output

```
$ yo compile issues/repros/stddoc-io-is-valid-entity-code-accepts-negative-code-points.yo \
    --std-path ./std --optimize 2 -o /tmp/t && /tmp/t
is_valid_entity_code(-65536)  = true      (expected false)
is_valid_entity_code(-1)      = false     (correct, but only by the 0xFFFF mask)
html_decode("[&#xFFFF0000;]") -> 5 bytes  ("[" + U+FFFD + "]")
```

## How a negative gets there

`html_decode`'s hex parser accumulates into an `i32`:

```rust
_parse_hex :: (fn(s : String) -> i32)({
  (result : i32) = i32(0);
  ...
  result = (result * i32(16));
```

with no overflow guard, so a numeric reference of eight or more hex digits
wraps. `&#xFFFF0000;` yields `i32(-65536)`, which this predicate then calls
valid.

## Why the end-to-end damage is contained (and why that is not a defence)

`html_decode` passes the code point to `from_code_point`, which is LOSSY —
`rune(u32(c))` interpolated into a template substitutes U+FFFD for any
non-scalar (verified: a surrogate and U+110000 both render as 3 bytes). And
U+FFFD is exactly what WHATWG prescribes for an out-of-range numeric
reference, so `html_decode`'s OUTPUT happens to be spec-correct here.

That is luck, not design, and it does not cover the exported predicate: a
caller using `is_valid_entity_code` to validate its own input — which is what
an exported validity predicate is for — gets `true` for a value that is not a
code point at all.

## Reproducer

`issues/repros/stddoc-io-is-valid-entity-code-accepts-negative-code-points.yo`

## Suggested fix (not applied)

Two independent one-liners:

1. Add `(c < i32(0)) => false,` as the FIRST arm of the `cond`. It has to be
   first, because the `0xFFFF` mask arm currently answers for some negatives
   and would keep doing so.
2. Guard `_parse_hex`'s accumulation (and the decimal one beside it) so an
   over-long reference saturates above `0x10FFFF` instead of wrapping — then
   the existing `(c > i32(0x10FFFF))` arm catches it for the right reason.

Fix (1) changes the predicate's answer for negative inputs, so it is a
behaviour change to an exported function rather than a pure bug fix; the
module's `## Stability` marker names it.

Worth considering at the same time: the parameter would be better as a `u32`
or a `rune`, which makes the whole class unrepresentable. Rust's
`char::from_u32` takes a `u32` and returns `Option<char>`.
