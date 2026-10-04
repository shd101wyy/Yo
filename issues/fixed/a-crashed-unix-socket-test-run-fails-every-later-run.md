# A crashed unix-socket test run fails every later run

**Severity:** S3 (a test-harness defect: a false failure, no wrong code shipped)

## Symptom

`tests/net/unix.test.yo` "bind, connect, accept, echo round-trip" failed
deterministically with `unexpected exception` (exit code 6) on develop and on
every branch, 2026-10-05. The fast suite reported 5027 passed / 1 failed.

## Root cause

The echo test and the `AddressInUse` test bind fixed paths
(`$TMPDIR/yo_unix_echo.sock`, `$TMPDIR/yo_unix_dup.sock`) and remove them only
at the end of the test. A run that dies in between (here an earlier run of a
branch that segfaulted in `write_str`) leaves the socket file behind. Every
later `bind` of that path then throws `AddressInUse`. The tests further down the
file already call `_remove_stale` before binding; these two did not.

## Fix

Both tests call `_remove_stale(path, io)` before their first `bind`.

## Test

Fails before: create a socket file at the path (any run killed after its
`bind`), then run the file; the echo test throws. Passes after: the same
sequence runs 6/6.
