# `parse_i32` / `parse_i64` / `parse_u32` / `parse_u64` wrap on overflow

**Severity: wrong value.** Four shipped parsers return `.Some(<wrapped>)` for
inputs outside their type, and they disagree with their own `_radix` siblings,
which reject correctly.

**Found** 2026-09-04 by the std-audit coverage re-measurement.
`tests/string/string_parse.test.yo` had 28 tests and **not one** overflow case.

## Reproducer

```rust
{ println } :: import("std/fmt");
open(import("std/string"));
_p :: (fn(s : str) -> unit)({
  a := match(String.from(s).parse_i32(), .Some(v) => `${v}`, .None => `None`.to_string());
  b := match(String.from(s).parse_u32(), .Some(v) => `${v}`, .None => `None`.to_string());
  c := match(String.from(s).parse_i64(), .Some(v) => `${v}`, .None => `None`.to_string());
  d := match(String.from(s).parse_u64(), .Some(v) => `${v}`, .None => `None`.to_string());
  println(`  ${s}: i32=${a} u32=${b} i64=${c} u64=${d}`)
});
main :: (fn() -> unit)({
  _p("9223372036854775808");
  _p("18446744073709551616");
  _p("99999999999999999999999");
});
export(main);
```

Under v0.2.24 — every one of these should be `None` except `u64` of the first:

```
  9223372036854775808:     i32=None u32=None i64=-9223372036854775808 u64=9223372036854775808
  18446744073709551616:    i32=0    u32=0    i64=0                    u64=0
  99999999999999999999999: i32=None u32=None i64=200376420520689663   u64=200376420520689663
```

And the two spellings of the same operation disagree:

```
parse_i64("9223372036854775808")           -> Some(-9223372036854775808)
parse_i64_radix("9223372036854775808", 10) -> None
```

## Root cause

Each of the four is a hand-rolled digit loop doing `result = result * 10 +
digit` with **no pre-multiply overflow check**:

- `parse_i64` accumulates in `i64` and wraps. Its own doc comment admitted it:
  *"Note: does not detect i64 overflow during accumulation."*
- `parse_u64` accumulates in `u64` and wraps.
- `parse_i32` / `parse_u32` accumulate in `i64` / `u64` and then range-check.
  The range check catches ordinary overflow, but **not** an input that wraps
  the accumulator onto an in-range value: `18446744073709551616` is exactly
  2^64, so the accumulator lands on `0`, the range check passes, and the
  parsers answer `Some(0)` for a 20-digit number.

Meanwhile `_radix_magnitude` — added with `parse_i64_radix` / `parse_u64_radix`
in #398 — already does it correctly:

```rust
// mag * radix + d > u64.MAX  ⇔  mag > (u64.MAX - d) / radix
if(mag > ((u64.MAX - d) / u64(radix)), { return(.None); });
```

`parse_i64` cannot simply grow a guard on its `i64` accumulator, either:
`i64.MIN`'s magnitude (2^63) is not representable in `i64`, and the current
code only gets `-9223372036854775808` right *by accident*, because the wrap
lands on `i64.MIN` and negating `i64.MIN` is `i64.MIN`. A correct signed parse
needs a `u64` magnitude plus the `MIN` special case — which is exactly what
`parse_i64_radix` has.

## Fix

Delegate, rather than grow a fifth copy of the loop:

```rust
parse_i64 : (fn(self : Self) -> Option(i64))(self.parse_i64_radix(u32(10))),
parse_u64 : (fn(self : Self) -> Option(u64))(self.parse_u64_radix(u32(10))),
parse_i32 : ... match(self.parse_i64_radix(u32(10)), .Some(v) => <range-check>, .None => .None),
parse_u32 : ... match(self.parse_u64_radix(u32(10)), .Some(v) => <range-check>, .None => .None),
```

This removed **306 lines** of duplicated hand-rolled parsing for ~40 lines of
delegation, leaving one overflow-correct path. Semantics are otherwise
preserved exactly: an optional `+`/`-` on the signed pair, `+` but not `-` on
the unsigned pair, `.None` on an empty digit run or any non-digit.

The four methods moved into the later `impl(String, …)` block (the one that
already holds `parse_f64` / `parse_i64_radix` / `parse_u64_radix`) so the
callee is registered before the caller — a same-module forward reference across
`impl` blocks is not legal until `plans/LAZY_TOPLEVEL_BINDINGS.md` lands.

`String._is_digit_byte` was orphaned by the rewrite (those four loops were its
only callers) and is removed. `src/lsp/diagnostics.yo` has its own private
`_is_digit_byte`, unrelated and untouched.

## Breaking change (call out in the release notes)

An out-of-range input now answers `.None` where it used to answer
`.Some(<wrapped garbage>)`. Callers that relied on the wrap were relying on a
bug, but the change is observable. `parse_i64`'s doc comment no longer
disclaims overflow, because it no longer has the flaw.

## Regression tests

Six tests in `tests/string/string_parse.test.yo`: per-type boundary +
just-past-boundary, the 2^64 accumulator-wrap case for all four, `i64.MIN`
accepted and `i64.MIN - 1` rejected, and a differential test asserting
`parse_i64` and `parse_i64_radix(10)` agree on ten inputs.

**Verified RED first** on the shipped v0.2.24 binary: all six fail there.

**FIXED 2026-09-04.**

## The compiler DEPENDED on the wrap — `parse_raw_int` had to be separated

Making `parse_i64` reject overflow broke the compiler itself, in a way worth
recording because it is the general lesson of this fix.

`parse_raw_int` (`src/evaluator/utils.yo`) is the parser for **every integer
literal in every Yo program**, and its decimal path was `stripped.parse_i64()`.
It relies on that call **wrapping**: comptime integers are carried as `i64`, so
a `u64`/`usize` literal above `i64.MAX` is represented by its negative
two's-complement pattern — `18446744073709551615` has to come back as
`i64(-1)`. Its own caller says so, three lines away:

> *"parse_raw_int wraps on overflow (e.g. u64::MAX = 2^64 - 1 → i64(-1)) and
> would falsely report out-of-range."*

With `parse_i64` rejecting overflow, `parse_raw_int` returned `.None` for those
literals, `try_to_convert_to_numeric_type` found no `ExprInfo`, and the whole
prelude died — reported, unhelpfully, as `Variable "Send" not found` at
`std/prelude.yo:3151`, the expression *after* `impl(u64, MIN, MAX)`. Bisecting
by neutering `MAX : u64(18446744073709551615)` moved the failure to
`usize.MAX`, and neutering both made it vanish; feeding the stage-1 literals
directly then isolated it exactly:

```
u64(18446744073709551615)   FAIL: Failed to evaluate argument
u64(9223372036854775808)    FAIL: Failed to evaluate argument
u64(9223372036854775807)    OK
i64(9223372036854775807)    OK
```

**Two different contracts were sharing one function.** They are now separate:

- `String.parse_i64` — the public std API. Rust semantics: **rejects** anything
  outside `i64`.
- `parse_raw_int` — the compiler's internal **bit-pattern** parser, documented
  as such. Its decimal path parses the magnitude with `parse_u64` and
  reinterprets it, which reproduces the old wrapping answer for everything up
  to `u64.MAX` and answers `.None` beyond it (no integer type can hold that,
  and every caller treats `.None` as "not representable"). A leading `-` still
  goes through `parse_i64`, which is in range by construction. The prefixed
  hex/binary/octal paths were already bit-pattern parsers and are untouched.

The other 45 `parse_i32`/`parse_i64`/`parse_u32`/`parse_u64` call sites in
`src/` were audited: they parse semver components, CLI and env numbers, HTTP
status codes and comptime indexes, none of which want a wrap — for those,
rejecting overflow is a strict improvement.
