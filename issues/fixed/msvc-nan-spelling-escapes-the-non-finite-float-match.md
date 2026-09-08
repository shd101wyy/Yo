# The MS CRT's `-nan(ind)` escapes the non-finite float match, emitting `-nan(ind).0`

**Status: FIXED** (2026-09-09) — `src/codegen/exprs/comptime_value.yo`.

## Symptom (Windows only)

A comptime NaN constant reached the C compiler as:

```c
bool _file___D__a__temp_17067 = yo_id_10435(-nan(ind).0);
```

```
tests/.yo_selftest_batch_139_0.bin.c:5652:78: error: use of undeclared identifier 'ind'; did you mean 'bind'?
 5652 |                             bool _file___D__a__temp_17067 = yo_id_10435(-nan(ind).0);
      |                                                                              ^~~
      |                                                                              bind
C:\...\um\winsock2.h:1655:1: note: 'bind' declared here
```

macOS and Linux were green on the same commit. The suggestion of `bind` from
`winsock2.h` is a coincidence of the payload's spelling, and a good reminder
that a C-level diagnostic can point somewhere unrelated to the cause.

## Root cause

`generate_comptime_value`'s `.FloatLit(raw)` arm turns the three non-finite
doubles into their C11 spellings (`HUGE_VAL`, `(-HUGE_VAL)`, `NAN`) before the
"append `.0` if there is no radix point" rule can run — that rule is what
produced `inf.0` in
`issues/fixed/comptime-float-infinity-emits-invalid-c.md`.

It recognised them by **string equality**:

```rust
((lowered == "nan") || (lowered == "-nan")) => …
```

But the raw comes from the HOST C library's `%g`, and the libraries disagree:

| library | NaN renders as |
| --- | --- |
| glibc, Apple libc, musl | `nan`, `-nan` |
| MS CRT | `-nan(ind)` (indefinite), `nan(snan)` (signalling) |

So the equality test passed everywhere the developer looked and failed on the
one platform that spells the payload.

The value that reached it was `f64.NAN`, whose definition is `∞ - ∞`; on x86
that produces the *indefinite* NaN with the sign bit set, which is exactly the
case the MS CRT spells `-nan(ind)`.

## Fix

Match by PREFIX rather than equality, for both the infinities and the NaNs, and
accept an explicit `+` sign:

```rust
non_finite := cond(
  (lowered.starts_with("inf") || lowered.starts_with("+inf")) => …,
  lowered.starts_with("-inf") => …,
  ((lowered.starts_with("nan") || lowered.starts_with("+nan")) || lowered.starts_with("-nan")) => …,
  true => String.from("")
);
```

No finite raw can collide: `%g` renders one starting with a digit, `-`, `+` or
`.`, never with `i` or `n` after an optional sign.

The NaN's SIGN and PAYLOAD are dropped on purpose. C offers no portable
constant expression for either, `NAN` is the canonical quiet NaN, and no
operation except `copysign` / `signbit` can observe the difference.

## Tests

`tests/math.test.yo`'s two non-finite-constant tests are the reproducer — they
pass on macOS and Linux and fail the whole `tests/` batch on Windows before
this fix. There is no way to exercise the MSVC spelling from a macOS or Linux
host, because the raw string comes from the HOST's `%g` at comptime and not
from the target: the Windows CI leg IS the gate for this one.

## Related, still open

`f64.to_string()` on a non-finite value is likewise the host library's
spelling, so the same `f64.NAN` prints `-nan` on macOS and `-nan(ind)` on
Windows. Rust prints `NaN` everywhere. That is a std-level portability
inconsistency in its own right — see
`issues/float-to-string-is-platform-dependent-for-non-finite-values.md`.
