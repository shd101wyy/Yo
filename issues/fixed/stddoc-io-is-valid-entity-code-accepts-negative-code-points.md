# `is_valid_entity_code` answers `true` for a negative code point

**Status: FIXED 2026-09-14.** Both suggested fixes applied (they are
independent, and only doing one leaves the other hole open). Verified
red-then-green with two new tests in `tests/encoding/html.test.yo`.

**Was:** open. Found while writing `///` docs for
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

---

## Fix (applied 2026-09-14)

Both of the suggested one-liners, because they close different holes:

1. **`(c < i32(0)) => false` as the FIRST arm** of `is_valid_entity_code`.
   First is load-bearing, as the original note said: the `0xFFFF` mask arm
   already answers for `-1` and `-2`, so putting the new arm later would leave
   those two taking a different path from every other negative.

2. **`_parse_hex` and `_parse_dec` saturate instead of wrapping.** Each stops
   accumulating once `result` is past `0x10FFFF`. This matters for a reason
   the original write-up understated: `result * 16` on a large `i32` is
   **signed overflow, which is undefined behaviour in C**, not merely a wrap —
   the observed `i32(-65536)` is what this particular compiler and target
   happened to produce. Saturating leaves the value above the range, so the
   pre-existing `(c > i32(0x10FFFF))` arm rejects it for the right reason.

### The behaviour change, and why it is the right one

`html_decode("&#xFFFF0000;")` now yields the literal text `&#xFFFF0000;`
where it previously yielded U+FFFD.

This looks like a regression against WHATWG — which does prescribe U+FFFD for
an out-of-range numeric reference — and it is worth being precise about why it
is not. This module **deliberately does not follow WHATWG here**: its policy
for an invalid code point is to keep the original entity text, and that policy
is pinned by two existing tests (`"invalid code points keep the original
entity text"`, and the multibyte variant), both asserting that `&#xD800;`
survives literally. Before the fix, an over-long reference was the *only*
invalid code point that did not follow that policy — it slipped past the
predicate via the wrap and landed on U+FFFD by luck. So the change makes the
overflow case **consistent with the module's own tested rule** rather than
diverging from it.

Whether this module should adopt WHATWG's U+FFFD policy wholesale is a real
question, but it is a separate one: it would change the answer for surrogates
too and would break two tests that deliberately pin today's behaviour. Not
done here.

## Regression tests (added)

`tests/encoding/html.test.yo`:

1. **`is_valid_entity_code rejects negative code points`** — asserts `-65536`
   and `-0x110000` (the real hole) *and* `-1`/`-2` (which were only ever
   rejected by the `0xFFFF` mask), so the accidental path cannot be mistaken
   for coverage of the real one. Valid neighbours are asserted too, so the new
   first arm cannot be silently rejecting everything.
2. **`an over-long numeric reference saturates instead of wrapping`** —
   over-long hex, just-past-range hex, and over-long decimal all stay literal;
   short references and a valid astral one still decode.

Both fail against the pre-fix `std` (exit code 6) and pass after; the 15
pre-existing tests are unaffected.

### A correction to my own first draft of the test

The first version asserted `is_valid_entity_code(0x10FFFF) == true` as the
"largest valid code point" case. **That is wrong, and the test caught it.**
The last two code points of every plane are Unicode *noncharacters*, so
`0x10FFFF & 0xFFFF == 0xFFFF` is correctly rejected by the noncharacter arm.
The test now uses **U+10FFFD** for the largest-valid case and asserts U+10FFFF
as a noncharacter explicitly. Same lesson as the corrected table in
`issues/fixed/stddoc-io-datetime-day-of-week-wrong-for-non-positive-years.md`:
an expected value is a claim and needs deriving, including when it is your own.

Seed-gated check: both files are clean under the published v0.2.32 seed.

## Not done

The write-up's closing suggestion — that the parameter would be better typed
`u32` or `rune`, making the whole class unrepresentable — still stands and is
still not done. It is a signature change to an exported function and belongs
with the module's next stability pass, not with a bug fix.
