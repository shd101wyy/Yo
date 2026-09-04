# `--release` passes `-w`, hiding warnings that mean the compiler miscompiled

**Status:** FIXED 2026-08-25 (PR #260) — **but that fix was a NO-OP until
2026-08-25 (`fix/ftt-silent-stub`), which is when it actually started working.**

PR #260 re-enabled three diagnostics AFTER `-w`. Measured on clang 21.1.7, `-w`
is ABSOLUTE — nothing later can bring a diagnostic back, not even `-Werror=`:

| flags (two-line file passing `char *` to an `int *` parameter) | result |
| --- | --- |
| `-Wincompatible-pointer-types` | warning |
| `-w -Wincompatible-pointer-types` | **SILENT** |
| `-w -Werror=incompatible-pointer-types` | **SILENT** |
| `-Wno-everything -Wincompatible-pointer-types` | warning (comes back) |

So the exact diagnostic this issue was written to preserve — the one that turned
the `inout` miscompile into a silent wrong answer — was STILL suppressed in
release builds after the "fix". The other two entries
(`-Wint-conversion`, `-Wimplicit-function-declaration`) appeared to work only
because clang 16+ makes them errors BY DEFAULT and `-w` cannot suppress an
error; they fired with or without the list.

The real fix is one word: the blanket flag is now `-Wno-everything`, which later
`-W…` flags DO override. Found while adding `-Werror=return-type` for
issues/ftt-stub-in-live-closure-falls-off-non-void-function.md — that flag was
also silently doing nothing behind `-w`.
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

## Fix (PR #260)

`src/main.yo`: warning selection is decoupled from the optimization level. Both
`-w` arms additionally pass `-Wincompatible-pointer-types`, `-Wint-conversion`
and `-Wimplicit-function-declaration`, so the style noise stays suppressed while
a generator/prototype mismatch is still reported.

**Verification:** a full self-build after the change emitted **zero** hits of the
three re-enabled diagnostics — so they are not noisy on real generated C, and no
other latent instance of this class existed in the tree at the time.
