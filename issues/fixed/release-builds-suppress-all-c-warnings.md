# `--release` passed a bare `-w`, silencing the diagnostics that catch codegen faults

**Status:** FIXED 2026-08-25 (PR #260).
**Found:** 2026-08-24, while diagnosing
`issues/fixed/specialized-inout-param-loses-ref-with-comptime-arg.md`.

## Symptom

Warning selection was purely a function of the optimization level: any optimized
build (`--release`, or `--optimize` at a nonzero level) passed a bare `-w` to the
C compiler, which disables **every** C diagnostic.

That is defensible for the noise generated C produces — unused temporaries,
redundant parentheses, pointer-sign on string literals — but it also silenced the
three diagnostics that can only mean the code **generator** emitted something
inconsistent with its own prototypes:

- `-Wincompatible-pointer-types`
- `-Wint-conversion`
- `-Wimplicit-function-declaration`

## Why it mattered

Not hypothetical. A specialized generic's `inout` parameter lost its by-ref
binding, so codegen passed a `T**` where its own emitted prototype said `T*`.
That is exactly `-Wincompatible-pointer-types`. With `-w` in force the build
looked clean, and the program returned an uninitialised value — a formatted
string came back as padding with no body, a silent wrong answer rather than a
crash.

The same class of fault had been invisible in every optimized build the project
had ever run.

## Fix

`src/main.yo`: warnings are decoupled from the optimization level. Both `-w`
arms now additionally pass the three diagnostics above, so the noise stays
suppressed while a generator/prototype mismatch is still reported.

## Verification

A full self-build after the change emitted **zero** hits of the three re-enabled
diagnostics — so they are not noisy on real generated C, and no other latent
instance of this class existed in the tree at the time.
