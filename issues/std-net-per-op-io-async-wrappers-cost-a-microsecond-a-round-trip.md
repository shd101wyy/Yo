# `std/net` per-operation `io.async` wrappers cost ~1 µs a round trip

**Status: OPEN.** Filed 2026-09-28 from the macOS async-runtime performance
pass. All numbers are **measured** on macOS 26.6 (M4). The mechanism counts
come from instrumented emitted C. The cause assignment (codegen/std, not the
backend) is from the counts, not from a fix.

## Symptom

A std-level `TcpStream` ping-pong (`scripts/bench/async-vs-libuv/bench.yo`,
`pingpong`) is ~17% behind libuv (14.3 vs 12.0 µs a round trip). The same
workload written against the raw runtime ops (`scripts/bench/io_bench.yo`,
`echo_1`) is at parity (1.09 vs 1.08 s for 100,000 round trips).

## Mechanism

After this pass the kqueue backend's syscalls are identical to libuv's: 2
`kevent`, 2 `send`/`write` and 2 `read` a round trip, and nothing else
(counted with a `DYLD_INSERT_LIBRARIES` interposer). The difference is on the
Yo side of the event loop. Counters compiled into the emitted C give, per
round trip:

| | count |
| --- | ---: |
| loop steps | 8 |
| task resumes | 6 |
| blocking waits | 2 |

`TcpStream.read` and `.write` are each an `io.async` wrapper around the raw
`IO_tcp.recv`/`send` future (for `NetError.check`). So one echo hop is:

1. resume the read wrapper (woken by the I/O completion);
2. resume the task (woken by the wrapper's completion, one step later);
3. resume the task again after the write wrapper completed synchronously
   (the cold-start "yield for fairness" in `_emit_await_suspension_core`,
   `src/codegen/async/state_machine.yo`).

Each wrapper also allocates its state machine and copies the `IoExn` bundle
in. `getrusage` shows the result: ~0.55 µs more user CPU per round trip than
libuv, and the critical path from a completion to the next `send` is two loop
steps long.

Letting the synchronous cold-start completion continue inline under the
existing `__yo_inline_budget` (the "already complete" path's rule) was tried
on the emitted C and did **not** move the benchmark (13.3–13.7 vs
13.0–13.7 µs). So the yield alone is not the cost.

## The 8-connection row (measured 2026-09-29)

`bench.yo multi` (8 connections ping-ponging at once) is the widest std gap:
3.62–3.70 vs 3.17–3.20 µs a round trip. `sample` over 1.5 M round trips puts the
kernel side at parity. The loop thread's leaf samples are `sendto` 1032 /
`read` 281 / `kevent` 153 for Yo, and `write` 1032 / `read` 337 / `kevent` 157
for libuv. `getrusage` agrees: 0.95 vs 0.91 s system, 0.20 vs 0.11 s user,
over 320,000 round trips. The whole gap is user CPU, spread thin: `malloc`/`free`
(a wrapper state machine and a raw future per operation, 4 operations a round
trip), `__yo_decr_rc`, the resumes, `_tlv_get_addr`, the loop step. No
function is more than 1% of the thread.

Yo also makes 50% more `kevent()` calls (133,662 vs 88,621; ~4.8 vs ~7 events
each), all of them blocking waits. Running continuations queued during a drain
in the same step (the second direction below, prototyped on the emitted C:
budget = queue length + 64, yields drained after the loop) did **not** move
the row (3.61–3.70 µs, before and after). So the step count is not the cost;
the per-operation work is.

## Directions

- Let a std wrapper that only maps an error await the raw future without its
  own state machine (a synchronous result mapping on the raw future), or give
  `io.async` blocks that consist of one await plus a pure tail an inline
  lowering.
- ~~Run a continuation that becomes ready during a drain within the same step
  (bounded), instead of one step later.~~ Prototyped; no change on either std
  row (above).
- Fewer allocations per operation: the raw future and the wrapper's state
  machine are two `__yo_rc_alloc`s that live exactly as long as one await. An
  await of a future the caller created and never shares could keep it inline
  in the caller's frame.
