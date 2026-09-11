# `StringBuilder.write_f64` silently truncates at 63 bytes

**Status:** open (found by the `std/` `///` doc sweep, 2026-09-11)
**File:** `std/string/string_builder.yo` — `write_f64`, and the same shape in `write_hex`

## Behaviour

`write_f64` formats into a 64-byte stack array with `snprintf("%.*f", …)`:

```rust
write_f64 : (fn(self : Self, n : f64, precision : i32) -> unit)({
  buf := Array(u8, usize(64)).fill(u8(0));
  buf_ptr := &buf(usize(0));
  unsafe(snprintf((*char)(buf_ptr), usize(64), "%.*f", precision, n));
  self.write_string(String.from_cstr(buf_ptr).unwrap());
}),
```

`%f` is FIXED point, so the rendering of a large `f64` is as long as the
value's magnitude: `f64.MAX` with two decimals is 312 characters. `snprintf`
truncates safely (it NUL-terminates), so nothing crashes — the builder just
receives a prefix of the number, which reads as a completely different value.

Verbatim output of the reproducer (`yo compile … --optimize 2`, macOS arm64):

```
len=63
100000000000000005250476025520442024870446858110815915491585411
```

The correct rendering is 302 integer digits plus `.00`. The truncated string
is ~1e62 — wrong by 238 orders of magnitude, with no error, no panic, and no
indication to the caller.

## Reproducer

`issues/repros/stddoc-str-string-builder-write-f64-truncates.yo`

## Root cause

The buffer size is a constant chosen for ordinary magnitudes, and there is no
check on `snprintf`'s return value — which is exactly the information needed:
`snprintf` returns the number of bytes the full rendering WOULD have taken, so
a `>= 64` return means the output was cut.

## It has a public caller

`std/fmt/format.yo`'s `_f64_fixed` is the only body behind `.N` precision on a
float, and it goes straight through `write_f64`:

```rust
_f64_fixed :: (fn(v : f64, p : usize) -> String)({
  sb := StringBuilder.new();
  sb.write_f64(v, i32(p));
  sb.to_string()
});
```

So `f64(1.0e300).format(".2")` also returns 63 characters (verified the same
way). The truncation is reachable from the public `Format` protocol, not only
from the builder method.

`write_hex` has the same shape with a 20-byte buffer. That one happens to be
sufficient (a `u64` in hex is at most 16 digits plus NUL), so it is not a live
defect — but it is the same unchecked pattern one edit away from becoming one.

Both methods were transplanted from `std/fmt`'s `Writer` when it retired into
`StringBuilder` (#511), so the cliff predates that move.

## Suggested fix

Call `snprintf` once with the fixed buffer, and when the return value does not
fit, allocate `ret + 1` bytes and render again — the standard two-pass
`snprintf` idiom. `std/fmt/to_string.yo`'s `_snprintf_to_string` has the same
single-pass shape but with a 32-byte buffer and the `%g` family, which is
bounded by construction; only the `%f`/`%x` paths need the second pass.

## Not fixed here

Found during a documentation-only sweep; `write_f64`'s doc comment and the
module's `## Stability` section now name the truncation, but the behaviour is
untouched.
