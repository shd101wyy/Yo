# `ReleaseSmall` builds exactly like `ReleaseSafe`, and `std/build.yo` documents `-g` that is never passed

**Severity:** S3 — ReleaseSmall emits byte-identical cc argv to ReleaseSafe — the advertised build-mode distinctions do not exist

**Status: FIXED (2026-10-03).**
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

## Fixed

**2026-10-03, branch `s3/batch-0-fixes`.** Root cause: `src/build_runner.yo`'s child-argv construction mapped BOTH `release-safe` and `release-small` to `--optimize 2` (reproduced on the current binary: flipping the field in one project left the `.inputs-sha256` stamp and emitted C byte-identical and even served a `(cached: inputs unchanged, skipping compile)` HIT), and `yo compile`'s `--optimize` validator accepted only `0|1|2|3`, so the size-oriented `-Os` was unreachable; no level ever forwarded `-g` although `std/build.yo` documented Debug as `-O0 -g` and ReleaseSafe as `-O2 -g` (a build file had NO channel to the child's `-g`). The fix: the validator accepts `s` (`src/main.yo` — clang, gcc, zig cc and emcc all take `-Os`, so unlike `z` it needs no per-compiler gate; gcc has no `-Oz`); a new exported `optimize_level_for` maps the levels (release-safe→`2`, release-fast→`3`, release-small→`s`, debug→no flag) and `level_wants_debug_symbols` forwards `--debug-symbols` for the Debug level only (`src/build_runner.yo`) — Debug's "full debug info" contract is now real, while the release levels stay lean and ReleaseSafe's stale `-O2 -g` doc line was corrected to `-O2` rather than bloating every release artifact with debug info. Docs updated together: `std/build.yo`'s `Optimize` doc comments, the tables in `docs/en-US/BUILD_SYSTEM.md` + `docs/zh-CN/BUILD_SYSTEM.md`, both `yo compile --help` languages, and the `help-compile` cli-case golden. The repo's own `build.yo` moved from ReleaseSmall to ReleaseSafe so the compiler's own build keeps byte-identical flags (plain `-O2`, still no `-g`), with its comment rewritten (and the stale `ReleaseSmall` mention in `.github/workflows/test.yml`'s self-build comment with it). Tests: `tests/internal/build_runner.test.yo` gained "child compile flags: the four levels map to four distinct --optimize values" and "child compile flags: Debug forwards --debug-symbols, the release levels do not" (red before — the new exports did not exist — green after). Verified behaviorally after the rebuild: `yo compile --optimize s` is accepted (was rc=1 `invalid --optimize "s". Choices: 0, 1, 2, 3`), the release-safe and release-small builds of one project now produce DIFFERENT stamps and emitted C, and a Debug-level build's stamp changes (the `--debug-symbols` argv) while the repo's own ReleaseSafe self-build argv is unchanged.
