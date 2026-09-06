# `Child.kill -> i32` handed back a raw `-errno`

**Status: FIXED** (2026-09-06, `std/process/command.yo`). Found by the std
API audit — `plans/STD_API_STABILIZATION.md` §3 item 17.

## Symptom

```rust
k := child.kill(i32(9));   // 0, or -ESRCH / -EPERM … as a bare i32
```

Every other io-path function in `std/process` and `std/fs` reports failure as
an `IoError` through the caller's `Exception` (or as `IoExn` when async).
`kill` alone leaked the C convention — a negative errno the caller had to
recognize and decode by hand, and that most callers ignored.

## Fix

`kill : (fn(self : Self, signum : i32, exn : Exception) -> unit)` — the
result goes through `IoError.check`, so `ESRCH` (the child was already
reaped) or `EPERM` is thrown as an `IoError`, Rust's
`Child::kill -> io::Result<()>`.

## Regression tests

`tests/process/command.test.yo` — the existing SIGKILL test now passes `exn`;
a new test reaps a child with `wait` and then `kill`s it, which must throw.
