# Linux: the recv-parks hint is cleared on every hop of a ping-pong

**Severity:** S3 — performance: a Linux ping-pong paid one doomed `recv` a hop that the hint exists to save

**Status: FIXED (2026-09-29).** Filed 2026-09-28 from the macOS async-runtime pass,
where the same rule was measured on kqueue. **Measured on Linux** 2026-09-29
(GitHub `ubuntu-latest` runners, a temporary measurement workflow, both
backends), below.

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

## Measured on Linux

A two-task socketpair echo, 20,000 rounds (`strace -f -c`, stage 1 of #996's tree):

| backend | `recvfrom` calls | of which `EAGAIN` |
| --- | ---: | ---: |
| epoll | 79,998 | 39,998 |
| io_uring | 39,998 | 39,998 (every inline attempt; the data then arrives through the ring) |

**Why:** the hint was cleared when a recv was delivered in the same
`__yo_io_wait_epoch` it parked in, and the epoch advanced only on a BLOCKING
wait. A ping-pong's loop never blocks: a task ran in every step, so the step
ends in a non-blocking poll, and every delivery landed "in the epoch it parked
in". The hint was cleared on every hop.

## Fix

`__yo_io_harvest` counts kernel harvests: every `epoll_wait`
(`__yo_epoll_drive`) and every `io_uring_enter` (`__yo_uring_enter_arg`). A
recv clears the hint only when it is delivered by the FIRST harvest after it
parked or was issued, the one case where its data was already there when it
was armed. This is the macOS backend's per-pass rule (`__yo_kq_pass`).

Before → after, same workflow, one runner per tree (µs for io_bench's rows;
the two runs had different machine speeds, and both show the same ~20 %):

| row | epoll | io_uring |
| --- | --- | --- |
| `uecho_1` (socketpair echo) | 150,837 → 118,498 | 152,310 → 119,237 |
| `echo_1` (TCP, 1 conn) | 327,482 → 255,767 | 336,124 → 255,709 |
| `echo_conc` (TCP, 64 conns) | 507,780 → 388,379 | 466,392 → 353,880 |

`tests/net`, `tests/sys` and `tests/async` give identical results before and
after under both backends.

## Regression coverage

G3 budget E (`scripts/bench/io_budget.yo`): a 500-round two-task echo must pay
at most 58 inline recvs that would block, counted by the new
`__yo_io_stats_recv_would_block`. After the fix: 3 under both backends. Before,
at 2 per round, it would be about 1000 (the stats counter did not exist yet;
the strace count above is the before measurement).
