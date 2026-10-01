# A raw extern I/O future awaited synchronously as a temporary is never released

**Severity:** S3 — unsafe code only: each synchronous `io.await` of a raw `__yo_async_*_start` call leaks its future (64 B, 80 B since #991's shared future header); std's futures are not affected

**Status: FIXED (2026-10-01, #1089).** The mechanism below was wrong; see
"Root cause (measured)" at the end. Found 2026-09-29 while measuring
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

## Root cause (measured), and the fix (2026-10-01)

The evaluator is not where the temp is lost. An extern call with an RC
result DOES get an owning temp: `attach_temp_variable_to_expr` runs in the
call arm externs take, since they bind as an `UnknownVal` of the extern
`Func` type, and it registers the temp's scope-end drop.

The leak is in codegen:
- The extern fast path in `src/codegen/exprs/other_fn_call.yo` returned the
  bare `__yo_async_send_start(...)` call string and never read
  `ExprInfo.variable_name`, so the temp was never declared in C.
- The scope-end drop survived, but `generate_deferred_drop_expressions`
  skips a drop whose temp was never declared ("Safe: a never-declared C
  variable … holds no value to leak"). That assumption fails here, because
  the value still exists as the inline call.

The emitted C showed it: `io.await(IO_tcp.send(...))` declared
`_file____User_temp_N` and dropped it; the raw extern had neither.

**Fix:** the extern path declares the temp, the way the ordinary call path
does, when the result type contains RC. It records the temp in
`declared_temp_vars` and `declared_c_var_names`, so the existing drop fires.
Every other extern call's C is unchanged.

**Measured:**
- `leaks --atExit` on 100 sync awaits of the raw extern plus 100 of the
  wrapper: 102 leaks with the v0.2.47 seed, 2 with the fix. The 2 are the
  probe's own `malloc`s.
- `tests/cli-cases/raw-extern-future-sync-await-releases` does 5,000 such
  awaits on a 64 KiB fixed heap. With the fix it prints `sent 5000`. With
  the seed it panics:
  `out of memory: requested 64 bytes (fixed heap 65536 bytes, live 57104 bytes in 715 blocks)`.
- The full gate passes: the fast suite (4,884), `gates_fast` (CLI 331/331)
  and `FIXPOINT_HOLDS`.
