# `f64.to_string()` spells infinity and NaN differently per platform

**Status: FIXED 2026-09-15.** Normalised in `to_string` as the fix sketch
proposed; `NaN` / `inf` / `-inf` on every platform. Verified red-then-green.
See "Fix" below — including what this does NOT fix.

**Was: OPEN.** Found 2026-09-09 while fixing
`issues/fixed/msvc-nan-spelling-escapes-the-non-finite-float-match.md`.

## Symptom

`to_string()` on a non-finite float hands back whatever the host C library's
`%g` produced:

| library | `f64.NAN.to_string()` | `f64.INFINITY.to_string()` |
| --- | --- | --- |
| glibc, Apple libc, musl | `nan` or `-nan` | `inf` |
| MS CRT | `-nan(ind)`, or `nan(snan)` | `inf` |

So a program that logs a NaN, writes one into JSON, or compares a rendered
number against a fixture produces different output on Windows than on macOS or
Linux — with no warning, and no way for the caller to normalise it without
knowing every spelling.

Rust prints `NaN`, `inf` and `-inf` on every platform, because `Display for
f64` is implemented in Rust rather than delegated to the C library.

## Why it is not just a formatting nit

1. It is a silent cross-platform behaviour difference in `std`, which is
   exactly the class the `## Stability` markers are meant to rule out.
2. It already caused one compiler bug: the codegen's non-finite-float match
   compared the raw against `"nan"` / `"-nan"` and emitted `-nan(ind).0` — not
   valid C — on Windows (fixed, see above). Any other consumer of the raw
   string has the same trap available to it.
3. JSON has no non-finite literal, so `json_stringify` on a NaN currently emits
   a bare `nan` / `-nan(ind)` token that no JSON parser accepts. Deciding the
   spelling is a prerequisite for deciding what `json_stringify` should do
   there (serde_json emits `null`).

## Fix sketch

Normalise in `to_string` rather than at each consumer: check `is_nan()` /
`is_infinite()` first and return `NaN` / `inf` / `-inf` directly, only falling
through to `%g` for finite values. That is a one-place change with a wide blast
radius on golden output, so it wants its own PR and a sweep of any test or
cli-case golden that currently contains a platform-spelled non-finite.

Note the SEED GATE: `std` is compiled by the previous release, so a `std`-side
change here is usable immediately (it is ordinary Yo, not a new runtime macro),
but any test that pins the new spelling must land with it.

---

## Fix (2026-09-15)

`_non_finite_str(v : f64) -> Option(str)` in `std/fmt/to_string.yo`, consulted
by both the `f32` and `f64` `ToString` impls before `%g` is reached. `.None`
means finite, and `%g` renders it exactly as before.

Spellings are Rust's `Display for f64`. Worth stating precisely, because the
change is narrower than the table above suggests: **`inf` and `-inf` already
matched on POSIX** — `NaN` is the only spelling that changes there, and Windows
is normalised on all three.

`isnan`/`isinf` are imported straight from `std/libc/math.yo` rather than via
`std/math`: that module registers METHODS on `f64`/`f32`, and importing it from
`std/fmt` for two predicates would be a cycle. NaN is tested first because it
is neither finite nor comparable and `isinf` is false for it; the sign of an
infinity is a plain `< 0.0` test, since an infinity compares below every finite
double and needs no `signbit`.

## Regression test

`tests/fmt.test.yo`, one test, red against the un-wired normaliser (exit 6).

**Every value is built at RUNTIME**, and that is not incidental: a comptime
`0.0/0.0` is a hard error, and `x*y - x*y` contracts to an FMA that yields
`-inf` rather than NaN — so both of the obvious ways to write a NaN literal
would have tested something other than what they appear to.

Covers NaN / inf / -inf for BOTH `f64` and `f32` (the f32 impl widens and goes
through the same normaliser), plus four FINITE assertions including `%g`'s
exponent form. The finite rows matter: the guard now runs on every float
render, so a mistake would silently reformat ordinary numbers, and a test that
only checked the non-finite cases would not notice.

Gates: `check ./std` clean, clean under the published v0.2.32 seed (ordinary
Yo, no new runtime macro), and math / float_non_finite_constants / json / toml
suites unchanged.

## What this does NOT fix

**JSON is still wrong.** `json_stringify` on a non-finite now emits a bare
`NaN` token where it used to emit a bare `nan` — both are invalid JSON, since
the grammar has no non-finite literal. This fix only makes the token
*consistent*; deciding what the serializer should do (serde_json emits `null`)
belongs to
`issues/json-stringify-renders-numbers-with-percent-g-and-loses-them.md`, which
stays open. This doc's point 3 correctly framed the spelling as a
*prerequisite* for that decision rather than as the decision itself.
