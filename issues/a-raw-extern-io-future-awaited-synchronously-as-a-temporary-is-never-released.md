# A raw extern I/O future awaited synchronously as a temporary is never released

**Severity:** S3 — unsafe code only: each synchronous `io.await` of a raw `__yo_async_*_start` call leaks its future (64 B, 80 B since #991's shared future header); std's futures are not affected

**Status: OPEN.** Found 2026-09-29 while measuring
`issues/fixed/a-loop-driven-only-by-synchronous-awaits-never-releases-its-io-backend.md`.
**Measured** on macOS 26.6 with `leaks --atExit`.

## Symptom

```rust
pragma(Pragma.AllowUnsafe);
{ __yo_async_send_start } :: import("std/sys/externs");
main :: (fn(io : Io) -> unit)({
  // ... a, buf from a socketpair ...
  io.await(__yo_async_send_start(a, buf, usize(8), i32(0)), io);
});
export(main);
```

`leaks` reports one `ROOT LEAK` from `__yo_kq_done_future` per await: 64 B before #991, 80 B after (its future header grew; re-measured 2026-09-29 with a seed-built stage 1 of #999).
The same loop over std's `sleep(...)` and `read(...)` (100 synchronous awaits
each) reports 0 leaks.

## Mechanism (read from the emitted C)

The synchronous await (`src/codegen/exprs/await.yo`, "Synchronous await (io.await
outside state machine)") binds the future to `__sync_future_<id>`, polls until it
completes and reads `->result`. It never releases the future. A named local
(`r := __yo_async_recv_start(...)`) is released at scope end. A temporary has
no owner: the raw externs return an I/O future the evaluator does not treat as
an RC temp with a deferred drop. Inside `io.async` the state machine owns the
awaited future's reference, so only the synchronous path leaks.

## Direction

Give the synchronous path the state machine's rule: a future that is not a
named binding is released after its result is read. That needs the evaluator
to mark the call as an owned temporary, since codegen cannot tell a borrowed
future from an owned one.
