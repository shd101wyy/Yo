# `std/sys/mmap` gives FreeBSD the Linux `MAP_ANONYMOUS` and `MS_SYNC`

**Severity:** S3: on a FreeBSD target `mmap_io.MAP_ANONYMOUS` was `0x20` (FreeBSD's is `0x1000`) and `mmap_io.MS_SYNC` was `4` (FreeBSD's is `0`); latent, because the FreeBSD target emits no I/O backend yet, so a program that calls `std/sys/mmap` there does not link.

Found 2026-11-24 by the VERDICTS-79 consultation (Q3, "`MAP_ANONYMOUS` is `0x20` for every platform but macOS"), read from the source; confirmed and fixed for this document on develop `34359627e`.

## Reproducer

```yo
pragma(Pragma.AllowUnsafe);
{ platform, Platform } :: import("std/process");
mmap_io :: import("std/sys/mmap");
// FreeBSD <sys/mman.h>: MAP_ANON 0x1000, MS_SYNC 0x0000.
comptime_assert(mmap_io.MAP_ANONYMOUS == i32(0x1000), "FreeBSD MAP_ANONYMOUS is 0x1000");
comptime_assert(mmap_io.MS_SYNC == i32(0), "FreeBSD MS_SYNC is 0");
main :: (fn() -> unit)(());
export(main);
```

`yo compile <file> --target x86_64-unknown-freebsd --skip-c-compiler` before the fix:

```text
error: FreeBSD MAP_ANONYMOUS is 0x1000
  --> bsd.yo:5:1
  |
5 | comptime_assert(mmap_io.MAP_ANONYMOUS == i32(0x1000), "FreeBSD MAP_ANONYMOUS is 0x1000");
  | ^^^^^^^^^^^^^^^
```

and, with the first assert removed, `error: FreeBSD MS_SYNC is 0`.

## Root cause

Both constants are a `cond` with an arm for macOS and Linux's value for every other platform
(`std/sys/mmap.yo`). FreeBSD's `<sys/mman.h>` (FreeBSD 14, as shipped in zig 0.16's
`lib/libc/include/generic-freebsd/sys/mman.h`):

```c
#define	MAP_ANON	 0x1000	/* allocated from memory, swap space */
#define	MAP_ANONYMOUS	 MAP_ANON /* For compatibility. */
#define	MS_SYNC		0x0000	/* msync synchronously */
#define	MS_ASYNC	0x0001	/* return immediately */
#define	MS_INVALIDATE	0x0002	/* invalidate all cached data */
```

FreeBSD's `0x20` is a reserved bit (formerly `MAP_RENAME`), and `4` is no `msync` flag, so both calls would fail
with `EINVAL` once a FreeBSD backend passes the flags through. The other constants of the module (`PROT_*`,
`MAP_SHARED`, `MAP_PRIVATE`, `MS_ASYNC`, `MS_INVALIDATE`) have the same value on FreeBSD.

Why it is latent: `src/codegen/async/runtime.yo` emits a platform I/O backend for Linux, macOS, Windows and wasm
only (`is_target_linux` and `is_target_macos` test `Os.Linux` and `Os.Macos`), and `__yo_sync_mmap` lives in
those backends. A FreeBSD build of a program that calls `mmap_io.mmap` emits the call and no definition
(`--emit-c`: `return __yo_sync_mmap(...)` at the call site, no `static uint8_t* __yo_sync_mmap` body).
`docs/en-US/STD_SYS_MODULE.md` lists FreeBSD's kqueue backend as planned.

## Fix

`MAP_ANONYMOUS` and `MS_SYNC` gain a `Platform.FreeBSD` arm (`0x1000`, `0`); their doc comments name the
FreeBSD value. `tests/sys/mmap.test.yo` checks both constants against the target's `<sys/mman.h>` value at
compile time ("the mapping flags are the target's <sys/mman.h> values").

## Verification

- The reproducer: `--target x86_64-unknown-freebsd --skip-c-compiler` fails on both asserts before the fix and
  compiles (rc 0) after it.
- `yo test tests/sys/mmap.test.yo` on Linux; `yo check ./std`.

The same pattern elsewhere in std (FreeBSD read as Linux in other per-platform constants) is
`issues/2026-11-24-std-per-platform-constants-read-freebsd-as-linux.md`.
