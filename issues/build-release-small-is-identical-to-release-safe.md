# `ReleaseSmall` builds exactly like `ReleaseSafe`, and `std/build.yo` documents `-g` that is never passed

**Status:** OPEN
**Found:** 2026-08-25, auditing the `yo compile` optimization flags.
**Severity:** low-but-dishonest — the build system advertises two optimization
modes that produce identical output, and documents a debug flag it never passes.

## 1. `release-small` and `release-safe` emit identical flags

`src/build_runner.yo` maps the artifact optimization level to `--optimize`:

```rust
release-safe  -> "2"
release-fast  -> "3"
release-small -> "2"      // <-- same as release-safe
```

So `ReleaseSmall` and `ReleaseSafe` produce byte-identical `cc` argv.
`std/build.yo` spends six comment lines justifying when to choose `ReleaseSmall`
over `ReleaseSafe`, on a distinction that does not exist in the emitted build.

The natural mapping is `-Os` (or `-Oz`), but `yo compile --optimize` **rejects**
`s` and `z`: its validator accepts only `0|1|2|3`. (Its help text used to
advertise `s|z` anyway — that lie is fixed in the same change as this filing.)

Fixing it properly means deciding what `s`/`z` mean across the toolchain's C
compilers: clang has both `-Os` and `-Oz`; gcc has `-Os` but no `-Oz`. So
accepting `s` is straightforward, `z` needs either a clang-only gate or a
documented fallback to `-Os`.

## 2. `std/build.yo` documents `-g` that is never passed

`std/build.yo` documents the levels as, in effect, `Debug -> -O0 -g` and
`ReleaseSafe -> -O2 -g`. `build_runner` never emits `-g` for any level — debug
symbols come only from an explicit `yo compile -g`. Either the build system
should pass `-g` for the levels that promise it, or the doc comment should stop
promising it.

## Why this was not fixed in the same change

Both are behaviour changes to build output, not documentation slips:
adding `-Os` changes what `ReleaseSmall` produces, and adding `-g` changes
artifact size for every debug build. They deserve their own change and their own
battery, rather than riding along with a CLI flag collapse.
