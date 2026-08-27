# S3 fs wrappers on Windows: hard child crash + no Windows-semantics story

**Found**: 2026-08-27, PR #309 run 4 — both Windows test legs died at
`tests/fs/fs_convenience.test.yo`'s S3-wrapper section with the RUNNER
reporting `yo: error: unknown I/O error` (the test child dies hard mid-run,
right after the pre-S3 tests pass). **Status**: OPEN. The section is skipped
on Windows (`platform == Platform.Windows`, the tests/fs convention) so CI
stays honest about the rest; the debt is recorded here.

## What is untested/broken on Windows

The `plans/STD_API_AUDIT.md` §7 P0 item 4 wrappers (PR #303):

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
