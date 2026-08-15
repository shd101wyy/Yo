# The emitted C scaffolding hardcodes Linux's `AT_FDCWD` (-100) on every platform

**Status: OPEN** (found 2026-08-15 while measuring cross-platform emission for
`plans/PORTABLE_C_DISTRIBUTION.md`.)

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
- It is an obstacle to `plans/PORTABLE_C_DISTRIBUTION.md`: a single C file for
  all platforms cannot carry one platform's magic number.

Affected helpers (macOS emit): `__yo_sync_access` and the sites around
lines 2256/2271/2285/3379/3439/3469/3495, plus the two-fd forms
`if (olddirfd == -100 && newdirfd == -100)` (rename) and
`if (newdirfd == -100)` (link).

## Fix

Emit the **C macro name** `AT_FDCWD` instead of a numeric literal, so the C
compiler's own `<fcntl.h>` supplies the value. The codebase already has the
mechanism and a working precedent for exactly this: `c_include` binds a
constant to its C macro name rather than folding it to an integer —
`std/libc/fcntl.yo:4-11` does this for `O_RDONLY`/`O_WRONLY`/…, and the
emitted C shows macro names (`((O_RDONLY) | (O_CLOEXEC))`), not literals.

`std/sys/constants.yo` does **not** use `c_include` and is where the folded
`AT_FDCWD` comes from. Migrating it is the same change that
`PORTABLE_C_DISTRIBUTION.md` needs for its ~50 integer-constant sites, so do
them together.

Fix in both compilers (`src/codegen/` and `yo-self/codegen/`).

## Reproduce

```bash
./yo-cli compile src/tests/fixme.yo --release --allocator mimalloc \
  --target x86_64-macos --skip-c-compiler -o /tmp/m
grep -c "dirfd == -100" /tmp/m.c      # 12 — Linux's value, in a macOS emit
grep -o "statx((int32_t)(-[0-9]*)" /tmp/m.c   # -2 — macOS's value
```
