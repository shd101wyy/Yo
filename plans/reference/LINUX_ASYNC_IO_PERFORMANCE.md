# Linux async I/O: the 2026-09-28 audit and performance pass

**Status:** LANDED (2026-09-28) — authoritative for how the Linux runtime
(`src/codegen/async/runtime_io_linux.yo`, the Linux sections of
`runtime_io_common.yo`, and the loop step in `runtime_core.yo`) decides where
an operation runs. It supersedes the timer and per-park-registration details
of `plans/reference/DROP_LIBURING.md`; that doc's ring layer, backend ladder
and budgets stand.

**Goal set by the user:** audit the Linux runtime (both backends), fix what is
wrong, make it as fast as possible, and be at least as fast as libuv.

## 1. The rule this pass applies

An operation that can finish now should finish now, without a round trip
through the loop. That round trip — suspend the task, enter the kernel, reap,
resume — costs far more than the syscall itself. Only work the kernel cannot
answer immediately takes the asynchronous path, and when it does, it must not
pay for bookkeeping that does no work (an extra `io_uring_enter`, an
`epoll_ctl` pair, a timerfd).

## 2. What runs where

| Operation | io_uring backend | epoll fallback |
| --- | --- | --- |
| `send`/`recv`/`sendto`/`recvfrom` | inline `MSG_DONTWAIT` first; would-block → SQE | inline first; would-block → park |
| a socket whose last inline `recv` would block | straight to the ring (hint cleared by a recv that completes without the loop waiting) | straight to park (same hint) |
| timers | userspace heap; the wait carries the earliest deadline (`IORING_ENTER_EXT_ARG`, 5.11; a single `IORING_OP_TIMEOUT` before) | same heap; `epoll_pwait2` (5.11) or `epoll_wait` with the deadline |
| `statx`, `mkdirat`, `unlinkat`, `renameat`, `symlinkat`, `linkat` | inline (io_uring always punts them to io-wq) | inline |
| `openat` with `O_CREAT`/`O_TRUNC`/`O_TMPFILE` | inline (always punted) | inline |
| plain `openat`, `read`, `fsync`, `ftruncate`, `close` | ring | inline |
| buffered `write` | `pwritev2(RWF_NOWAIT)` inline; refused → ring, refusal memoized per fd | `pwrite` inline (one syscall, no `fstat`) |
| `accept` | ring, `SOCK_NONBLOCK` in the op | `accept4(SOCK_NONBLOCK)` |
| poll / fs-event watches | watch-set epoll fd with a one-shot `POLL_ADD` | watch-set fd in the epoll set |

The file-op split is the user's decision (2026-09-28): the io-wq hand-off
measured ~57 µs a hop on WSL2 6.6, against 0.3–3 µs for the syscall. The
metadata ops can block the loop on a cold or network filesystem; macOS and
the epoll fallback always had that contract. Reads stay on the ring. On
ext4, cached reads complete inside the enter. On tmpfs (6.6), which has no
nowait reads, they punt.

`RWF_NOWAIT` buffered writes are refused (`EOPNOTSUPP`) by both ext4 and
tmpfs on 6.6 (measured), so on those filesystems writes still punt. The memo
makes the refusal cost one syscall per descriptor. Moving regular-file writes
inline (macOS parity) is the remaining lever. It was offered and not taken.

## 3. Loop mechanics

- **SQ overflow is not an error.** `__yo_io_get_sqe` flushes a full SQ and
  retries. Before, the 1,025th operation of a tick failed with `-EAGAIN`, and
  a full SQ could leave the cross-thread wake channel disarmed.
- **No kernel entry without kernel work.** `__yo_io_poll` enters only when
  SQEs are queued or a non-timer operation is in flight. The epoll poll skips
  `epoll_wait` likewise.
- **One enter per wakeup.** The blocking wait's own enter materializes the
  completions, and `__yo_ring_reap` consumes them from the ring. The old
  "wait, then poll to look again" cost a second enter per wakeup.
- **epoll registrations are one-shot and persistent.** A park re-arms with
  one `EPOLL_CTL_MOD`, and nothing is DELeted until the fd closes: four
  syscalls per parked op, down from five. A persistent edge-triggered
  interest (three syscalls) was rejected. The slot table is per thread, so a
  socket closed on another thread would leave a stale registration that a
  reused number parks on forever. The per-park MOD is the check that
  catches it (`ENOENT` → ADD).
- **A step that is going to block does not poll first** (#981's
  restructure, merged alongside this pass): `__yo_io_wait` drains, submits
  and ticks on every backend, so the zero-timeout poll before it was a wasted
  syscall. It also closes a hang this audit found: a top-level await
  completed by that poll ran no task, and the step went on to block on
  unrelated I/O. The epoll and macOS waits had to start ticking the watches
  for the restructure to hold.

## 4. Measurements

Box: WSL2 6.6.87, 32 vCPU, clang 21, `--optimize 2`, shared with another
session's test batteries, so single runs vary by ±30%. Every number below
is a median over repeated alternating runs.

**Yo vs libuv 1.52.1** (`scripts/bench-vs-libuv.sh`, 7 rounds, ops/s; ratio
> 1 means Yo is faster):

| workload | Yo ring | Yo epoll | libuv | ring/uv | epoll/uv |
| --- | ---: | ---: | ---: | ---: | ---: |
| socketpair echo, 2×20,000 msgs | 1,384,299 | 1,334,201 | 1,139,471 | 1.21 | 1.17 |
| TCP echo, 1 connection | 13,196 | 13,260 | 13,190 | 1.00 | 1.01 |
| TCP echo, 64 connections | 267,650 | 262,423 | 261,064 | 1.03 | 1.01 |
| 20,000 zero-delay timers | 8,496,177 | 10,695,187 | 7,074,637 | 1.20 | 1.51 |
| 16 KiB file write+read, tmpfs | 3,472 | 29,943 | 3,143 | 1.10 | 9.53 |
| same, ext4 (3 runs) | ~5,400 | ~7,000 | ~2,850 | ~1.9 | ~2.5 |

The std-level pair #981 added (`scripts/bench/async-vs-libuv/bench.yo` and
`bench_uv.c`) measures the same way once its two fairness bugs are fixed
(`scripts/bench/async-vs-libuv/README.md`, "Corrections"): 1 ms timers
459 K vs 427 K fires/s (1.07; #981 reported "~40×" against libuv timers
averaging 25 ms), and 8-connection TCP at parity.

Both loopback-TCP rows are bound by WSL2's loopback delivery (~300 µs per
single-connection round trip for every runtime); the socketpair row is the
runtime's own per-hop cost. libuv's timer loop re-arms inside the same loop
iteration, while Yo's `sleep(0)` takes a loop turn, and Yo is faster anyway.

**Before → after, this pass** (`io_bench.yo`, pinned, 7-run medians, ops/s):

| case | ring before | ring after | epoll before | epoll after |
| --- | ---: | ---: | ---: | ---: |
| inline ping-pong | 796,654 | 1,057,082 | 1,110,032 | 1,190,122 |
| parked ping-pong | 736,377 | 769,009 | 355,429 | 601,504 |
| timers | 133,520 | (heap) | 81,087 | 2,202,643 |

**File-op microbenchmarks** (2,000 each, ext4, µs total, before):
cached read 882 (ring) / 833 (epoll); `statx` 114,371 / 863; buffered write
122,042 / 1,548; `O_TRUNC` open+close 152,026 / 5,749. After, the ring's
`statx` and truncating open run the same inline code as epoll.

**Syscall budgets** (`scripts/io-budget-check.sh`, 200 rounds / 50 ticks):

| budget | ring before | ring after | epoll before | epoll after |
| --- | ---: | ---: | ---: | ---: |
| A inline ping-pong | 801 enters | 801 inline syscalls, 1 enter | 800 | 800 |
| D parked ping-pong | 400 | 1,200 | 2,400 | 2,000 |
| B timer ticks | 150 | 100 | 200 | 100 |
| C 150 ms blocked window | 3 | 3 | 4 | 2 |

Budget D's ring count tripled while its wall clock improved (+4%): each recv
now makes a doomed inline attempt before it parks. The recv-parks hint
removes that for a socket whose peer answers after the loop has blocked (a
real server). In the synthetic parked ping-pong the reply arrives before the
loop ever waits, so the hint clears every round.

## 5. Records

- `issues/fixed/io-uring-full-submission-queue-fails-operations-with-eagain.md`
- `issues/fixed/poll-and-fs-event-watches-starve-while-the-loop-waits.md`
- `issues/fixed/linux-copyfile-truncates-files-over-2-gib-and-empties-proc-files.md`
- `issues/fixed/dup2-over-a-descriptor-with-a-parked-op-hangs-the-op.md`
- `issues/fixed/a-top-level-await-completed-by-the-io-poll-blocks-on-unrelated-io.md`

Found and left, by design or scope:

- io_uring does not order concurrent RECVs on one socket (a later one's
  attempt at submission can run before an earlier one's deferred wakeup);
  epoll and kqueue complete them FIFO. Documented in `docs/*/ASYNC_AWAIT.md`
  and pinned by `tests/sys/socketpair.test.yo`.
- `__yo_io_cleanup` tears the ring down with submitted operations still in
  flight when async `main` returns early (a parked accept). Their futures
  are not released, which only matters at process exit: thread and worker
  loops drain through `__yo_async_wait_all` first.
- A descriptor closed with a raw `libc` `close` is invisible to the backend.
  The docs now say to close through std.
