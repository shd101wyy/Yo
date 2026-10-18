# Three language tests fail in a nix-shell sandbox

**Severity:** S3 — the full language suite reports failures that come from
the machine, not the compiler, so a local Tier 1 run has to tell them apart by
hand.

**Status:** open. Found 2026-10-18 while running the full suite for
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
