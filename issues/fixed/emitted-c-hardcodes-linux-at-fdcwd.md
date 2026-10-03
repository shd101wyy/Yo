# The emitted C scaffolding hardcodes Linux's `AT_FDCWD` (-100) on every platform

**Severity:** S3 — emitted C hardcodes Linux's AT_FDCWD on every target — latent, correct today only by coincidence

**Status: FIXED (2026-10-03).** (found 2026-08-15 while measuring cross-platform emission for
`plans/reference/PORTABLE_C_DISTRIBUTION.md`.)

## What

The POSIX sync-operation helpers in the emitted C compare `dirfd` against the
literal `-100` — Linux's `AT_FDCWD` — in code that is emitted for **macOS**
too. Twelve sites in a macOS emit, e.g.:

```c
static int32_t __yo_sync_access(int32_t dirfd, const char* path, int32_t mode) {
  int result;
  if (dirfd == -100) {  // AT_FDCWD
  result = access(path, mode);
  } else {
  result = faccessat(dirfd, path, mode, 0);
  }
  return (result < 0) ? -errno : 0;
}
```

Meanwhile the _evaluated Yo program_ folds `AT_FDCWD` to the correct per-OS
value, because `std/` selects it through a comptime `platform ==` branch. In
the same macOS emit the Yo-level call site is `statx((int32_t)(-2), …)`;
the Linux emit has `statx((int32_t)(-100), …)`.

So on macOS the two halves disagree: Yo passes -2, the C helper tests for -100,
and the `dirfd == -100` branch is **dead code**.

## Severity: latent, not user-visible

This does **not** currently produce wrong behaviour, and the issue should not
be filed as if it does. On macOS `AT_FDCWD` _is_ -2, so falling through to the
`else` arm calls `faccessat(-2, path, mode, 0)` — which is exactly
`faccessat(AT_FDCWD, …)` and is correct. The only effect is that the
non-`*at()` fast path is never taken on macOS.

It is worth fixing anyway because it is a platform constant hardcoded to one
platform's value in code emitted for all of them:

- It is fragile by construction — the correctness depends on a coincidence
  (that macOS's `AT_FDCWD` happens to be a value `faccessat` accepts), not on
  the code being right.
- It breaks the moment the fallback arm is not semantically identical to the
  fast arm, or on a platform whose `AT_FDCWD` the `*at()` call rejects.
- It is an obstacle to `plans/reference/PORTABLE_C_DISTRIBUTION.md`: a single C file for
  all platforms cannot carry one platform's magic number.

Affected helpers (macOS emit): `__yo_sync_access` and the sites around
lines 2256/2271/2285/3379/3439/3469/3495, plus the two-fd forms
`if (olddirfd == -100 && newdirfd == -100)` (rename) and
`if (newdirfd == -100)` (link).

## This is one instance of a general "shadow constant table" hazard

**Do not fix only the Yo half — that would make things worse.** These platform
constants are authored **twice**, independently:

| constant              | Yo half (`std/sys/constants.yo`)            | C half (codegen)                                                          |
| --------------------- | ------------------------------------------- | ------------------------------------------------------------------------- |
| `AT_FDCWD`            | `:12-15` — `-2` macOS / `-100` otherwise    | `-100` hardcoded (`runtime-io-common.ts:191,774`, `-macos.ts:1104`)       |
| `AT_REMOVEDIR`        | `:16-19` — `0x80` macOS / `0x200` otherwise | `0x80` hardcoded (`runtime-io-macos.ts:1222`, comment says "macOS value") |
| `AT_SYMLINK_NOFOLLOW` | `:21-24` — `0x20` macOS / `0x100` otherwise | the **macro** (`runtime-io-macos.ts:1160`), i.e. 0x20 on macOS            |

The two halves agree today **only because a single emitter run selects both
for the same target**. `AT_FDCWD` is the case where the mismatch is harmless by
luck; `AT_REMOVEDIR` and `AT_SYMLINK_NOFOLLOW` are not, and they are decided by
the same coincidence.

Migrating the Yo half to `c_include` (so it emits the macro name and the C
compiler supplies the value) while leaving the C half's hardcoded literal would
**convert today's accidental agreement into silent divergence**: the Yo value
would become the compiling platform's, the C value would stay macOS's.

This matters most for `plans/reference/PORTABLE_C_DISTRIBUTION.md`. Under any `#if`
merging, the Yo half freezes at emit time while the C half is chosen at
C-compile time, permanently decoupling them — e.g. emit for Linux, compile on
macOS, and `0x100 & 0x20 == 0` makes `std/fs/metadata.yo`'s
`symlink_metadata` call `stat()` instead of `lstat()`, so every symlink
silently reports its target's metadata. It compiles, links, and runs.

## Fix

Single-source each constant, changing **both halves in the same commit**:

1. Yo half: `c_include` it so the emitted C carries the **macro name**, not a
   folded integer. The mechanism and a working precedent already exist —
   `std/libc/fcntl.yo:4-11` does this for `O_RDONLY`/`O_WRONLY`/…, and the
   emitted C shows `((O_RDONLY) | (O_CLOEXEC))`. `std/sys/constants.yo` does
   not use it, and is where the folded values come from.
2. C half: delete the hardcoded literals in
   `src/codegen/async/runtime-io-{common,macos,linux}.ts` in favour of the same
   macro names.

Do both compilers (`src/codegen/` and `yo-self/codegen/`).

A regression test should assert that no emitted C contains a bare `-100`/`0x80`
sentinel for these flags — otherwise the next hand-written helper reintroduces
the shadow table.

## Reproduce

```bash
./yo-cli compile src/tests/fixme.yo --release --allocator mimalloc \
  --target x86_64-macos --skip-c-compiler -o /tmp/m
grep -c "dirfd == -100" /tmp/m.c      # 12 — Linux's value, in a macOS emit
grep -o "statx((int32_t)(-[0-9]*)" /tmp/m.c   # -2 — macOS's value
```

(2026-10-03 modernization, at fix time: `./yo-cli` is `yo`, `src/tests/fixme.yo`
is `tmp/fixme.yo`, and the triple is `x86_64-apple-darwin` — the canonical
Rust spelling; `x86_64-macos` is rejected. The `.ts` paths above are the
retired TypeScript compiler; today's equivalents are the `src/codegen/async/
runtime_io_*.yo` emitters. `yo-self/codegen/` is today's `src/codegen/`, so
the "do both compilers" line needs no second half any more.)

## Fixed

Fixed 2026-10-03 on branch `s3/batch-1-fixes`. Root cause exactly as filed: the three per-platform constants were authored twice — `std/sys/constants.yo` folded `cond(platform…)` literals while the runtime templates compared against Linux's bare `-100` (and macOS's bare `0x80`, wasm's bare `0x100`/`0x200`), so the halves agreed only because one emitter run selected both for one target. Both halves were single-sourced onto the `<fcntl.h>` macro names in one commit. Yo half: `std/libc/fcntl.yo`'s `c_include` declares `AT_FDCWD`/`AT_REMOVEDIR`/`AT_SYMLINK_NOFOLLOW` (the existing `O_*` pattern), and `std/sys/constants.yo` drops its three `cond(platform…)` folds (and the now-orphaned `platform` import) in favour of importing them from `std/libc/fcntl`; a macOS emit's Yo call site now reads `statx((int32_t)(AT_FDCWD), …)` instead of the folded `-2`. C half: `src/codegen/async/runtime_io_{common,macos,wasm}.yo` spell `AT_FDCWD` (24 sites incl. the two-fd rename/linkat forms), `AT_REMOVEDIR` and `AT_SYMLINK_NOFOLLOW` instead of the literals, the shared POSIX helper block gains `#include <fcntl.h>` (a program that never touches `std/fs` registers no header of its own), and `runtime_io_windows.yo`'s `__yo_is_at_fdcwd` tests `AT_FDCWD` too — resolved by the template's existing `#ifndef AT_FDCWD` fallback block, which stays as the one sanctioned literal (the Windows CRT defines none of these; verified by probe, as was their presence in glibc/musl/wasi-libc/emscripten/macOS headers). The regression tests are `tests/internal/uring_runtime.test.yo`'s "runtime: the *at() dirfd sentinel is the AT_FDCWD macro on every platform" and "runtime: AT_REMOVEDIR and AT_SYMLINK_NOFOLLOW are macros, not per-platform literals" — they call the emitters for every target and assert the macro spellings (and the Windows fallback's survival); both failed before the fix and pass after, and `tests/fs/{metadata,dir,file,fs_convenience}.test.yo` (10+18+29+16 cases) stay green, as does the whole pre-existing `uring_runtime` file (24/24).
