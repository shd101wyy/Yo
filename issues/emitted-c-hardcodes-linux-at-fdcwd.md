# The emitted C scaffolding hardcodes Linux's `AT_FDCWD` (-100) on every platform

**Status: OPEN** (found 2026-08-15 while measuring cross-platform emission for
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
