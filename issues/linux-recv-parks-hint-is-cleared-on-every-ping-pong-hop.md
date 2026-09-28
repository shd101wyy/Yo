# Linux: the recv-parks hint is cleared on every hop of a ping-pong

**Status: OPEN.** Filed 2026-09-28 from the macOS async-runtime pass. **Measured
on macOS**, with the same rule ported to kqueue. **Read, not run on Linux**:
the loop driver (`runtime_core.yo`) is shared, so the mechanism should carry
over. Nothing has confirmed that on Linux yet.

## Mechanism

Both Linux backends park a socket's next `recv` directly when its last inline
`recv` would have blocked (the recv-parks hint), and clear the hint when a
parked recv is delivered in the same `__yo_io_wait_epoch` it parked in, i.e.
"before the loop next blocked". The idea: the data was already there, so the
inline attempt would have won.

In a ping-pong the loop almost never blocks between a park and its delivery.
The peer's task runs in the same step (or the next), sends, and the delivery
arrives through the next non-blocking poll, still in the same epoch. So the
hint is cleared on every hop, set again by the next hop's failed inline
`recv`, and never saves a syscall.

Ported unchanged to the macOS backend, it cost exactly that: 80,000 `recv`
for 40,000 receives in the socketpair echo (half of them `EAGAIN`). The
macOS backend now uses a per-pass rule: the hint is cleared only when the recv
is delivered by the very `kevent()` pass that submitted its arm, the one case
where the data really was already there. That gives 40,003 `recv`, and the
echo went from 37.7 to 30.6 ms.

## Direction

Measure `recv` counts under `YO_IO_BACKEND=epoll` for
`scripts/bench/io_bench.yo`'s `uecho_1` (a `DYLD`/`LD_PRELOAD` counter, or
the G3 counters extended to `recv`). If it reproduces, apply the same rule:
epoll's arm is the `EPOLL_CTL_MOD` issued at park, so "delivered by the
first `epoll_wait` after the park" is the per-pass equivalent. For the ring,
it is the first CQE reap after the SQE's submission.
