# Three language tests fail in a nix-shell sandbox

**Severity:** S3 — the full language suite reports failures that come from
the machine, not the compiler, so a local Tier 1 run has to tell them apart by
hand.

**Status:** FIXED 2026-10-20 for the `env` and `datetime` cases (branch `fix/nix-shell-env-tests`). The `tcp` case is tracked by the still-open `issues/2026-10-17-the-non-routable-connect-test-leaks-its-pending-task-at-exit-where-test-net-stays-pending.md` (mitigated, unverified; below). Found 2026-10-18 while running the full suite for
`issues/fixed/a-field-write-through-a-shared-borrow-parameter-is-accepted-and-lost.md`
(Linux x86_64 under WSL2, inside `nix-shell`). The `tcp` case fails the same
way with the develop binary `5425cd7bf`; the other two depend only on the
environment variables and libc named below.

## The failures

`yo test ./tests --exclude tests/internal --exclude tests/cli-cases --parallel 4`:

- `tests/os/env.test.yo`, "temp_dir returns /tmp on Linux": exit code 6.
  `nix-shell` sets `TMPDIR=/tmp/nix-shell.XXXXXX`, and `temp_dir()` honours
  `TMPDIR`, which is correct. The test asserts `/tmp` without clearing it.
- `tests/time/datetime.test.yo`, "DateTime.now honours TZ: Asia/Tokyo is
  +09:00": exit code 6. The test sets `TZ=Asia/Tokyo` and expects
  `utc_offset_secs == 32400`. The binary links nix's glibc, which looks up
  zones under its own store path rather than `/usr/share/zoneinfo`, so the
  offset comes back 0. `TZDIR` is unset in the shell.
- `tests/net/tcp.test.yo`, "connecting to a non-routable address does not park
  the event loop": LeakSanitizer reports 64 + 16 bytes. The test leaves its
  connect to `192.0.2.1` (TEST-NET-1) un-awaited on purpose. Where the network
  drops that SYN instead of refusing it, the task is still pending at exit, and
  its frame is reported as a leak.

## Fix direction

- `env.test.yo`: unset `TMPDIR` (and `TMP`/`TEMP`) before the call, or assert
  that `temp_dir()` equals `TMPDIR` when it is set and `/tmp` otherwise.
- `datetime.test.yo`: skip the fixed-offset assertion when the zone database
  cannot resolve `Asia/Tokyo` (for example when `/usr/share/zoneinfo` is not
  where the libc looks), or set `TZDIR` from a probe.
- `tcp.test.yo`: cancel or drain the pending connect task before the test
  returns, so the result does not depend on how the network treats TEST-NET.

Test: the three cases above, run inside `nix-shell`.

## Resolution (2026-10-20)

All three cases depended on the environment, not the compiler. The `env` and
`datetime` tests now supply the condition they rely on instead of reading it
from the shell; the `tcp` case is tracked by its own open doc.

- **`env.test.yo`**: the test is "temp_dir is $TMPDIR when set and /tmp
  otherwise on Unix". It clears `TMPDIR` and asserts `/tmp`, sets it and
  asserts the value comes back, then restores what the runner had. It runs on
  every Unix target, not only Linux. `temp_dir()` honouring `TMPDIR` is the
  documented behaviour (`std/env.yo`), so the test was wrong, not the
  function.
- **`datetime.test.yo`**: the test is "DateTime.now honours TZ: JST-9 is
  +09:00". It sets the POSIX TZ rule `JST-9` instead of the zone name
  `Asia/Tokyo`. The C library parses a rule from the string itself and needs
  no zone database, so the result no longer depends on where that libc looks
  for one. The property under test is unchanged: `now()` is local time, not
  UTC.
- **`tcp.test.yo`**: this is the same leak as
  `issues/2026-10-17-the-non-routable-connect-test-leaks-its-pending-task-at-exit-where-test-net-stays-pending.md`,
  which stays open. Its branch, `fix/tcp-nonroutable-connect-leak`, aborts the
  pending connect once its assertion has run; that is a mitigation, not yet
  confirmed by a Linux LeakSanitizer run on a network where TEST-NET-1 stays
  pending (the open doc says why, and what would close it).

### Measured on the Mac Mini (darwin arm64, inside a nix shell)

This session's shell is a nix shell: `TMPDIR` is
`/var/folders/.../T/nix-shell.lTuzhH` and `cc` is nix's clang 21.1.7. The
binaries still link Apple's libSystem.

- The new `env.test.yo` case passes with that `TMPDIR` set (7/7). The old case
  was Linux-only, so this box never ran it.
- `datetime.test.yo` passes 22/22 with `JST-9`. A C probe against libSystem
  gives `tm_gmtoff = 32400` for both `Asia/Tokyo` and `JST-9`, whether or not
  `TZDIR=/nonexistent` is set: macOS ignores `TZDIR`. The nix-glibc failure
  therefore cannot be reproduced on this box. The fix rests on the C library
  contract: a TZ value that names no loadable zone file is parsed as a POSIX
  rule, so `JST-9` resolves without a database.
