# macOS async I/O: the 2026-09-28 audit and performance pass

**Status:** LANDED (2026-09-28). This doc is authoritative for how the macOS
runtime decides where an operation runs and when the loop enters the kernel.
That covers `src/codegen/async/runtime_io_macos.yo` and the macOS sections of
`runtime_io_common.yo`: sleep, fs events, poll handles, and the tick. It is the
macOS twin of `plans/reference/LINUX_ASYNC_IO_PERFORMANCE.md`.

**Goal set by the user:** audit the macOS runtime, starting from the four items
the Linux pass left open (the `dup2` hang, the 100 ms / 10 ms waits, two
`kevent()` calls per timer, the fs-watch rescan). Document and fix every bug
found, with no workarounds, and be at least as fast as libuv.

## 1. Bugs found and fixed

Each has an `issues/fixed/` record and a regression test that fails before
the fix and passes after.

| Bug | Record |
| --- | --- |
| `dup2` over a descriptor with a parked op hung the op | `issues/fixed/macos-dup2-over-a-descriptor-with-a-parked-op-hangs-the-op.md` |
| An aborted task's parked `recv` kept its FIFO place and took the next bytes | `issues/fixed/macos-an-aborted-tasks-parked-recv-keeps-its-place-and-takes-the-next-bytes.md` |
| An inline `recv` overtook a parked one (FIFO order broken) | `issues/fixed/macos-an-inline-recv-overtakes-a-parked-recv.md` |
| A dropped, still-armed sleep fired into freed memory (SIGSEGV) | `issues/pending-io-future-local-drop-uaf.md` (macOS part) |
| A `std/net` stream write to a closed peer killed the process (SIGPIPE) — Linux too | `issues/fixed/a-std-net-stream-write-to-a-closed-peer-kills-the-process-with-sigpipe.md` |
| The close hook was a process-global written by every loop thread | `issues/fixed/macos-kqueue-close-hook-is-a-process-global-written-by-every-loop-thread.md` |
| An fs watch rescanned its directory on every loop pass (25.7 s CPU for 20,000 passes) | `issues/fixed/macos-fs-watch-rescans-its-directory-on-every-loop-pass.md` |

## 2. What runs where

| Operation | develop (af62bdb28) | now |
| --- | --- | --- |
| `send`/`recv`/`sendto`/`recvfrom`/`accept` | inline, even ahead of a parked op; parked ops not cancellable | inline only when nothing of that direction is parked; parked ops cancellable (`-ECANCELED`) |
| a socket whose last inline `recv` would block | inline attempt, then park | straight to park (hint cleared when the arming pass delivers it) |
| delivered flag-less `recv` | `recv(MSG_DONTWAIT)` | the first waiter uses `read()`: the event's byte count means it cannot block |
| registrations | linked list; `EV_ADD\|EV_ONESHOT` per park (a knote allocated each time) | per-fd slot table; `EV_DISPATCH` knote, re-enabled with `EV_ADD\|EV_ENABLE` |
| regular-file `read`/`write` | `fstat` (+`F_GETFL`) + `pread`/`pwrite` | `pread` (`ESPIPE`/`ENXIO` → readiness); `F_GETFL` + `pwrite` (`O_APPEND` → `write`) |
| `socket` / accepted socket | `F_GETFL` + `F_SETFL` | one `ioctl(FIONBIO)` |
| sleep | one `EVFILT_TIMER` knote each; its cancel another `kevent()` | userspace heap; the wait carries the earliest deadline |
| poll / fs-event watches | polled every tick: a `poll()` per handle, a private kqueue and a directory rescan per fs handle | one watch kqueue nested in the loop's; fs rescans on vnode events plus at most every 50 ms |

## 3. Loop mechanics

- **An empty zero-timeout `kevent()` costs ~12 µs on macOS 26**, against
  0.2 µs when it finds an event. It effectively waits for a kernel timer.
  Develop paid it on every pass that polled with nothing ready. A
  non-blocking pass now asks the kqueue descriptor with a zero-timeout
  `select()` (~0.2 µs) first, and reaps only when something is there.
- **No kernel entry without kernel work**: a pass whose pending work is only
  timers, or nothing, makes no syscall.
- **No poll before a blocking step**: when nothing is runnable after a pass,
  the next step's blocking `kevent()` submits and reaps in one call. With tasks
  still queued, the kernel is polled every 61 such passes (tokio's
  `event_interval`).
- **Waits are bounded only by deadlines**: the next timer and the next watch
  rescan. There is no fixed 100 ms cap and no 10 ms `nanosleep`. The
  `EVFILT_USER` wake channel is the only thing that can end an unbounded wait
  from another thread, so failing to create it is now fatal.
- **Hot waits**: while the last wait was answered within 50 µs, the next wait
  is bounded by 50 µs. Measured in C on a loopback-TCP ping-pong: 10.3 vs
  11.1 µs a round trip, with less CPU. A near deadline wakes the thread
  sooner, most likely because the core idles in a shallower state (the
  mechanism is the kernel's and is not proven). A hot wait that times out empty
  ends the hot state. A hot wait with no deadline reads no clock: one that
  returns events within its 50 µs bound was answered inside the window by
  construction. The two `clock_gettime_nsec_np` calls it used to make were
  ~15 ns of a ~750 ns socketpair echo hop (1.52 → 1.49 s for 2,000,000 hops;
  `sample` put them at 2% of the loop thread).

## 4. Measurements

macOS 26.6, Apple M4 (10 cores, 16 GB), libuv 1.52.1 (Homebrew). Binaries were
built by the tree compiler; "develop" is af62bdb28's runtime and std. 9
interleaved rounds, medians, ops/s (std rows: round trips or fires per second).
The ratio is Yo/libuv (> 1: Yo is faster). Measured while no other session's
battery was running.

| workload | libuv | develop | now | develop/uv | now/uv |
| --- | ---: | ---: | ---: | ---: | ---: |
| socketpair echo | 3,045,415 | 1,936,202 | 2,621,146 | 0.64 | 0.86 |
| TCP echo, 1 conn | 300,212 | 316,321 | 331,591 | 1.05 | 1.10 |
| TCP echo, 64 conns | 1,094,447 | 785,642 | 1,043,424 | 0.72 | 0.95 |
| zero-delay timers | 77,809 | 2,270,921 | 4,294,610 | 29.2 | 55.2 |
| 16 KiB file cycle | 28,256 | 11,919 | 38,608 | 0.42 | 1.37 |
| std TCP ping-pong | 71,422 | 27,865 | 64,276 | 0.39 | 0.90 |
| std 8 connections | 318,087 | 210,969 | 272,589 | 0.66 | 0.86 |
| std 500 × 1 ms timers | 379,151 | 317,254 | 382,161 | 0.84 | 1.01 |

**Re-measured 2026-09-29 with #991's await rewrite** (seed-built stage 1 of
#999 on #988 + #996; 9 interleaved rounds, medians, ops/s):

| workload | libuv | #988 | #988 + #991 | #988/uv | +#991/uv |
| --- | ---: | ---: | ---: | ---: | ---: |
| socketpair echo | 3,042,172 | 2,607,562 | 2,671,832 | 0.86 | 0.88 |
| TCP echo, 1 conn | 300,085 | 331,630 | 334,914 | 1.11 | 1.12 |
| TCP echo, 64 conns | 1,077,922 | 1,046,718 | 1,039,966 | 0.97 | 0.96 |
| zero-delay timers | 78,000 | 4,252,605 | 4,293,688 | 54.5 | 55.1 |
| 16 KiB file cycle | 27,303 | 36,723 | 37,171 | 1.35 | 1.36 |
| std TCP ping-pong | 71,852 | 64,528 | 65,728 | 0.90 | 0.91 |
| std 8 connections | 316,760 | 272,675 | 267,868 | 0.86 | 0.85 |
| std 500 × 1 ms timers | 379,344 | 382,300 | 384,253 | 1.01 | 1.01 |

#991 did not move the std rows, and neither did `--allocator mimalloc`
(std 8 connections: 3.60–3.87 vs 3.44–3.78 µs a round trip). Per round trip
of the std 8-connection row (`sample`, leaf time):

| | Yo | libuv |
| --- | ---: | ---: |
| `sendto` / `write` | 1.88 µs | 1.67 µs |
| `read` | 0.55 µs | 0.55 µs |
| `kevent` | 0.28 µs | 0.25 µs |
| user code | ~0.35 µs | ~0.03 µs |

The send line is the entry point, not the flags. A TCP loopback ping-pong in
C timing only the call (medians of 9) gives `write` 1.40 µs, `send(0)` 1.51,
`send(MSG_DONTWAIT|MSG_NOSIGNAL)` 1.48 and `send(MSG_NOSIGNAL)` 1.46. So ~0.2 µs
of the ~0.5 µs std gap is `send` over `write`, kept for the reason below, and
the rest is std's per-operation wrapper work
(`issues/std-net-per-op-io-async-wrappers-cost-a-microsecond-a-round-trip.md`).

Both halves have a fix underway. For `send` over `write`, std owns its stream
sockets, so it can make them non-blocking and `SO_NOSIGPIPE` and then write
them with `write(2)`, as libuv does. The runtime op exists (stage 1), and std
adopts it once the seed carries it
(`issues/std-net-stream-writes-take-send-where-write-is-cheaper.md`;
prototyped on the emitted C: 3,582 → 3,450 ns a round trip on the std
8-connection row). The wrapper half is `plans/backlog/ASYNC_AWAIT_SITE_FUSION.md`.

Reading the rows:

- **Syscalls per round trip now equal libuv's** on every socket row: 2
  `kevent`, 2 `send`/`write` and 2 `read`, counted with an interposer. The
  socketpair gap that remains is the entry points. `send`, which the documented
  `MSG_DONTWAIT` / `MSG_NOSIGNAL` contract needs, costs 0.033 µs more than
  `write` on a socketpair (0.08–0.11 µs on TCP loopback), and each park's `EV_ENABLE` costs ~0.02 µs. That re-enable is what
  keeps a park correct after a close on another thread, the same choice as
  Linux's per-park `EPOLL_CTL_MOD`. The 64-connection row is the same two
  costs: over 1,280,000 sends Yo spends 2.24 s in the kernel and libuv 2.16 s,
  and 1,280,000 × (40 ns for `sendto` + 28 ns for the re-enable) predicts
  87 ms of that 80 ms gap. User time differs by 0.02 s.
- **The std rows** are behind by the std layer, not the backend: 8 loop steps
  and 6 task resumes per round trip
  (`issues/std-net-per-op-io-async-wrappers-cost-a-microsecond-a-round-trip.md`).
- **Timers** are bounded by the OS's timer coalescing on both sides: a 1 ms
  wait wakes after ~1.25 ms. Only `NOTE_CRITICAL` avoids that, and it is not
  used, because of the energy cost.
- **File**: 3 `pread`s per 16 KiB read (the new `Reader.read_to_end` reads
  into spare capacity), and no `fstat`.

## 5. Rejected, with measurements

- **Persistent level-triggered knotes** (libuv's registration): "7.1 µs" on the
  std ping-pong, but that was a busy-spin. A writable socket's WRITE knote
  fired every pass: 7.5 `kevent`s a hop at 100% CPU.
- **Spinning or probing before blocking** (a `select()` probe, 1–10 µs spins,
  a 1 µs userspace spin): 5–40% slower on the TCP echo, and more CPU.
- **`write` instead of `send`** for inline sends: `write` takes no
  `MSG_NOSIGNAL`, and it would block the loop on a caller's blocking socket.
- **Level knotes disabled lazily** (keep a knote enabled after its FIFO
  drains, disable it on the first delivery that finds no waiter): saves the
  per-park `EV_ENABLE`, 28 ns a socketpair hop in C (0.602 vs 0.574 µs). It
  makes the slot table the record of what the kernel holds, so a descriptor
  closed outside the runtime (a raw `close` through FFI) and reused hangs its
  next park, which today's per-park `EV_ADD|EV_ENABLE` re-creates.
- **Inline continuation after a synchronous cold-start completion** (codegen):
  no measurable change (see the std issue).
- **`NOTE_CRITICAL` timers**: precise (1.03 ms for 1 ms), but they opt out of
  the OS's power management.
