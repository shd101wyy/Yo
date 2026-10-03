# S3 fs wrappers on Windows: hard child crash + no Windows-semantics story

**Severity:** S3 — fs/process/net wrappers unverified on Windows; `fs_file.copy` crashes the test child outright

**Found**: 2026-08-27, PR #309 run 4 — both Windows test legs died at
`tests/fs/fs_convenience.test.yo`'s S3-wrapper section with the RUNNER
reporting `yo: error: unknown I/O error` (the test child dies hard mid-run,
right after the pre-S3 tests pass). **Status**: FIXED (2026-10-03, branch
`s3/batch-0-fixes`). The section is no longer skipped wholesale: the parts
whose semantics EXIST on Windows now run there, and the genuinely
POSIX-only parts (mode-bit round-trips, symlink-as-link removal,
denied-parent throws) are folded into `if(platform != Windows)` arms.

## What is untested/broken on Windows

The `plans/archive/STD_API_AUDIT.md` §7 P0 item 4 wrappers (PR #303):

- `fs_file.copy` — copies contents + PERMISSION BITS (fchmod). On Windows,
  `_chmod` supports only the read-only bit; the mode round-trip assertion
  (`md.mode() & 0o7777 == 0o600`) is meaningless there — and something in
  this path (chmod shim? `__yo_errno` plumbing? metadata mode readback)
  crashes the child outright before any assert fires.
- `fs_file.set_permissions` — same chmod semantics gap.
- `fs_dir.read_link` — `__yo_sync_readlinkat` shim; Windows has no
  readlinkat (junctions/symlinks go through DeviceIoControl /
  GetFinalPathNameByHandle). The Windows emission linked, so SOME symbol
  exists — its behavior is unverified.
- `fs_walker.remove_dir_all` — symlink-as-link removal semantics.
- `try_exists`'s denied-parent contract — built on POSIX mode-0 directories,
  which Windows ACLs do not express this way.

## Also recorded here: process Child/spawn Windows coverage

`std/process/command`'s PR #308 surface (`spawn`/`Child`, `Stdio` pipes,
`env_clear`, signal-death `code() -> .None`) is plumbed with posix_spawn +
pipe(2) + fcntl and tested against `/bin/*` binaries — all POSIX-only. The
four PR #308 tests in `tests/process/command.test.yo` skip on Windows the
same way; the Windows process story (CreateProcess, handles instead of fds,
job objects for kill) is part of this same audit.

## Also: winsock errno translation

`tests/net/unix.test.yo`'s AddressInUse pin aborts on Windows: AF_UNIX
itself WORKS there (the echo round-trip passes), but the second-bind failure
comes back as an untranslated winsock error ("unknown I/O error") instead of
`AddressInUse` — the sys error mapping needs a WSA* table. The two tests
skip on Windows until then.

## What a fix needs

A Windows-semantics pass over the PR #303 wrappers: real Windows
implementations (attributes for permissions, reparse points for links), a
crash diagnosis for the copy path (the child dies with no test output — run
one test at a time on a Windows box or CI debug leg to bisect), and the
tests re-expressed per-platform (mode-bit assertions POSIX-only). Until
then, the wrappers should be treated as POSIX-only API surface.

## Fixed

**2026-10-03, branch `s3/batch-0-fixes`.** The 2026-08-27 hard child crash no
longer reproduces on develop — `fs_file.copy` runs clean on Windows (the
post-filing Windows async-runtime race fixes, #974 2026-09-28 and #1005
2026-09-30, fit it). What remained broken had two real defects, both fixed
in `src/codegen/async/runtime_io_windows.yo`:

1. **`fs_dir.read_link` was functionally wrong on Windows.**
   `__yo_sync_readlinkat` opened the path with `FILE_FLAG_OPEN_REPARSE_POINT`
   and then called `GetFinalPathNameByHandleW` ON THE REPARSE-POINT HANDLE —
   which answers the LINK'S OWN path: a junction read back its own name, and
   a regular file answered its own `\?\`-prefixed path instead of throwing
   EINVAL. Rewritten to read the reparse data (`DeviceIoControl` +
   `FSCTL_GET_REPARSE_POINT`): the substitute name is decoded (the
   object-manager prefix stripped, the UNC marker rewritten), junction
   (`IO_REPARSE_TAG_MOUNT_POINT`) and symlink (`IO_REPARSE_TAG_SYMLINK`) are
   both handled, and a non-reparse point maps `ERROR_NOT_A_REPARSE_POINT`
   (new case in `__yo_win_last_error_to_errno`) to EINVAL — the readlink(2)
   contract `std/fs/dir.yo` documents. `REPARSE_DATA_BUFFER` is spelled in
   the runtime (it lives only in the driver-kit `<ntifs.h>`): Tag(4) +
   DataLength USHORT(2) + Reserved USHORT(2), name block at offset 8, the
   symlink variant's `ULONG Flags` before `PathBuffer` — verified byte-level
   against a `mklink /J` junction and a system junction.
2. **Winsock errors never reached errno.** Every socket-error site in the
   Windows runtime returned `-WSAGetLastError()` raw, so `IoError.from_errno`
   could not classify them: the AF_UNIX double-bind pin aborted the test
   child with "unknown I/O error (os error 10048)" instead of AddressInUse,
   and `std/sys/socketpair`'s failures landed in `.Other`. Added
   `__yo_wsa_error_to_errno` (the full same-name WSAE→errno table the UCRT
   defines, WSAEWOULDBLOCK→EAGAIN) and routed all 33 socket-error sites
   through it; the three socketpair validation returns are now plain
   `-ENOTSUP`/`-EAFNOSUPPORT`/`-EPROTONOSUPPORT`.

Tests — `tests/fs/fs_convenience.test.yo`'s S3 section re-expressed
per-platform: copy contents/byte-count, remove_dir_all on a plain tree,
read_link on a junction (created through `cmd /c mklink /J`, the
unprivileged link form), read_link's EINVAL on a non-link and try_exists
present/absent now run on EVERY platform (all five failed or were skipped
on Windows before); the mode-bit assert, the symlink-as-link arm and the
denied-parent throws stay in POSIX-only arms with comments saying why.
`tests/net/unix.test.yo`'s AddressInUse pin and its cleanup test are
un-skipped on Windows (the pin failed before the WSA table: "expected
AddressInUse, got: unknown I/O error (os error 10048)"). Docs updated in
both languages (`docs/{en-US,zh-CN}/STD_SYS_MODULE.md`: readlink row + two
Windows-runtime bullets), plus `std/sys/socketpair.yo` / `std/sys/sockinfo.yo`
doc comments that described the raw-WSA behaviour.

Left open on purpose (recorded here, not fixed): the denied-parent
try_exists contract is not expressible under Windows ACLs (a chmod-0 dir
still allows enumeration), symlink creation still needs
SeCreateSymbolicLinkPrivilege, and the walker's junction-following behavior
is untested. A NEW, separate bug found while reproducing this one — a
`canonicalize` throw handled by an unwinding handler inside an `io.async`
fn corrupts the heap on Windows — is filed as
`issues/canonicalize-throw-inside-io-async-corrupts-the-heap-on-windows.md`.
