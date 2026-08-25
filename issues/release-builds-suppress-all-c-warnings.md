# `--release` passes `-w`, hiding warnings that mean the compiler miscompiled

**Status:** OPEN
**Found:** 2026-08-25, while fixing
issues/fixed/specialized-inout-param-loses-ref-with-comptime-arg.md, where `-w`
is precisely what turned a miscompile into a silent wrong answer.

## What happens

`src/main.yo` chooses C warning flags by optimization level:

- default / `--optimize 0` → `-Wall -Wextra` (with targeted `-Wno-…` for the
  noisy ones)
- `--release` or any `--optimize N` → **`-w`**, which disables every warning

The intent is reasonable: at `-O2` the generated C produces noise nobody reads.
But `-w` does not distinguish "noise about generated code style" from "the code
generator emitted something inconsistent with its own prototype".

## Why it matters

The `inout`-ref bug had two manifestations. One was a hard clang error and was
caught immediately. The other passed a `T**` where the callee's prototype said
`T*` — which clang reports as `-Wincompatible-pointer-types`, a **warning**. Under
`--release` that warning is suppressed, so the program built cleanly and returned
an uninitialised value. The visible symptom was a formatted string that came back
as ten spaces instead of `   Some(4)`; nothing in the build said a word.

A pointer-type mismatch between generated code and its own generated prototype is
never acceptable output. It cannot be "noise", because both sides are written by
the compiler.

## Suggested fix

Keep `-w` for genuine noise, but re-enable the diagnostics that can only mean a
codegen defect — clang honours later flags, so appending after `-w` works:

```
-w -Wincompatible-pointer-types -Wint-conversion -Wimplicit-function-declaration
```

`-Wimplicit-function-declaration` is worth including for the same reason: it is
how the where-bound GC-trace bug (`issues/fixed/`) announced itself, and that one
was found only because it happened to be an error rather than a warning in that
context.

Consider promoting them to `-Werror=` once the tree is known clean under them —
run the full corpus first, since any existing instance would then break the build.
