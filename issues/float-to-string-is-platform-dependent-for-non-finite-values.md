# `f64.to_string()` spells infinity and NaN differently per platform

**Status: OPEN.** Found 2026-09-09 while fixing
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
