# Linux `sendto`/`recvfrom` are synchronous and park the whole event loop

**Status:** FIXED (2026-09-13, Linux async I/O audit). **Found:** 2026-09-13,
by the one RED in a 269-file hollow sweep on PR #638.
**Platform:** Linux (io_uring backend) only. Windows was fixed overlapped in
#638 (`issues/fixed/windows-udp-recvfrom-blocks-the-event-loop.md`); macOS was
already task-parked via kqueue. This fix brought Linux to parity.

## The defect

`src/codegen/async/runtime_io_linux.yo`:

```c
// io_uring doesn't have direct sendto, use synchronous
ssize_t result = sendto(sockfd, buf, len, flags, ...);
...
// io_uring doesn't have direct recvfrom, use synchronous
ssize_t result = recvfrom(sockfd, buf, len, flags, ...);
```

Both ran on the LOOP THREAD, and `__yo_async_socket_start` left the socket
BLOCKING on Linux (macOS set `O_NONBLOCK`). A `recv_from` on a quiet socket
therefore blocked every other task in the program until a datagram arrived —
timers never fired, `std/async`'s `timeout` could not fire, the wake-deadlock
detector could not run. With no datagram ever arriving, the process hung
forever.

Reproduced from `issues/repros/linux-udp-datagram-park.yo` (extracted from the
test below): the spawned task's `recv_from` parked the loop at its cold start
— before even the first `println` flushed — and `timeout 15` killed the
process (rc=124) with no output.

## Why no suite caught it before

Nothing awaited a datagram that had not arrived yet. Every other UDP test
sends before it receives, so the synchronous call returns immediately and the
parking is invisible. It takes a QUIET socket plus a concurrent task to see
it, which is exactly the shape #638's test introduced.

## The fix (all in `src/codegen/async/runtime_io_linux.yo`)

1. **`__yo_async_socket_start` sets `O_NONBLOCK`** on the new fd, matching the
   macOS backend. io_uring ops are nonblocking either way; the flag is needed
   by the inline fast paths below.
2. **`__yo_async_sendto_start`/`__yo_async_recvfrom_start` try the syscall
   inline first, then arm `IORING_OP_SENDMSG`/`IORING_OP_RECVMSG`** on
   `-EAGAIN`/`-EWOULDBLOCK` — the same try-then-register shape as the macOS
   kqueue backend. The old comment ("io_uring doesn't have direct sendto")
   was wrong: `SENDMSG`/`RECVMSG` are the direct sendto/recvfrom and have
   been in the kernel since 5.3, well under this runtime's existing floor
   (its `openat`/`close` ops need 5.6+). (There is no `IORING_OP_RECVFROM`
   opcode; `SEND`-with-destination-address would work for `sendto` but needs
   5.19+, so both directions use the `*MSG` pair.)
3. **The msghdr problem**: `SENDMSG`/`RECVMSG` read the `struct msghdr` (and
   RECVMSG writes `msg_name`/`msg_namelen) at COMPLETION time, so it must
   outlive submission. A `__yo_dgram_future_t` places the msghdr, the iovec
   and — for `sendto` — a COPY of the destination address into the same
   allocation as the future, freed together by the RC system; the ring's
   reference keeps it alive until the CQE. `msg_name` for `recvfrom` points
   at the CALLER's `src_addr` buffer (the kernel must write the sender's
   address there), which therefore carries the same lifetime contract as
   every other io_uring buffer.
4. **The address-length writeback**: `recvfrom(2)` updates the caller's
   in/out `addrlen`; RECVMSG writes the length into our msghdr instead.
   `__yo_io_process_cqe` copies it back, keyed on the future's `cancel_fn`
   identity (`__yo_dgram_future_cancel` doubles as the type tag that says
   the completion path may read the `__yo_dgram_future_t` extension).
5. **`__yo_async_accept_start` registers the same cancel hook**
   (`__yo_accept_future_cancel`), which tags accepted-socket futures so
   `__yo_io_process_cqe` sets `O_NONBLOCK` on the accepted fd — POSIX
   `accept(2)` does not inherit the listener's flag on Linux, and every
   other socket this runtime creates is nonblocking. It also gives an
   aborted `accept` a prompt cancel path instead of waiting out a connection
   that may never arrive.

Two adjacent defects found by the same audit and fixed here:

- **Cross-thread wakeup fd TOCTOU at loop shutdown.** `__yo_io_notify`
  loaded `loop->notify_fd` and wrote to it with no synchronization, while
  `__yo_io_cleanup` cleared the pointer and closed the eventfd. The comment
  claimed clearing before closing made a racing foreign wake safe; it does
  not — a foreign thread that loaded a valid fd could be paused across the
  close, and the kernel could reuse the fd number for another file, so the
  wake wrote to the WRONG descriptor. Both sides now take the loop's
  existing mutex (`__yo_loop_t.lock`, the xwake inbox lock) around
  check+write / clear (+ the init-time set), serializing them.
- `sendto`/`recvfrom` futures with a NULL `cancel_fn` could not be
  cancelled; both op families now carry the ring cancel hook.

Verified end to end on Linux 6.16 / liburing 2.12 with a standalone probe
(`tmp/uring_probe.c` scratch): `io_uring_prep_sendmsg`/`recvmsg` on a UDP
loopback pair deliver the datagram, fill `msg_name` and update
`msg_namelen` at completion. The probe also settled that `IORING_OP_WRITE`
with an offset on a PIPE succeeds (the `ESPIPE` check exists only in the
`pwrite` syscall path), so `std/io/stdio`'s positioned async writes to
fd 1/2 were never broken on Linux — that is why only the datagram ops
needed converting.

## Not fixed, noted by the audit

- `io_uring_queue_init`'s ring fd is not `O_CLOEXEC`-guarded, so a spawned
  child (posix_spawn + exec) inherits the ring fd. Harmless today (children
  never touch it; the mapping is replaced by exec) — liburing's
  `io_uring_ring_dontfork` is the standard mitigation if it ever matters.
- An SQ-ring-full condition (`io_uring_get_sqe` == NULL) still surfaces as
  an immediate `-EAGAIN` result on the future — transient, pre-existing, and
  unchanged.

## The regression test

`tests/net/udp.test.yo`'s "a quiet recv_from parks the task, not the event
loop" was added by #638 with a Linux skip whose comment said "un-gate it the
moment Linux gets IORING_OP_SENDTO/RECVFROM, and it becomes that work's
ready-made regression test". The skip is deleted; the test now runs
everywhere and asserts the 200 ms sleep issued after a pending quiet
`recv_from` is not stretched.
