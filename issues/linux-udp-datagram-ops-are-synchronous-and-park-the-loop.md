# Linux `sendto`/`recvfrom` are synchronous and park the whole event loop

**Status:** OPEN. **Found:** 2026-09-13, by the one RED in a 269-file hollow
sweep on PR #638.
**Platform:** Linux (io_uring backend) only. Windows is overlapped as of #638;
macOS was already task-parked.

## The defect

`src/codegen/async/runtime_io_linux.yo`:

```c
// io_uring doesn't have direct sendto, use synchronous
ssize_t result = sendto(sockfd, buf, len, flags, ...);
...
// io_uring doesn't have direct recvfrom, use synchronous
ssize_t result = recvfrom(sockfd, buf, len, flags, ...);
```

Both run on the LOOP THREAD. A `recv_from` on a quiet socket therefore blocks
every other task in the program until a datagram arrives — the same defect
`issues/fixed/windows-udp-recvfrom-blocks-the-event-loop.md` fixed on Windows,
and the sibling of the D6 accept hang.

The comment is also out of date: modern io_uring has `IORING_OP_SENDTO` and
`IORING_OP_RECVFROM` (Linux 5.19+).

## How it surfaced

`tests/net/udp.test.yo`'s "a quiet recv_from parks the task, not the event
loop" — added by #638 to pin the Windows fix — spawns a task that awaits
`recv_from`, then sleeps 200 ms on the main task and asserts the sleep was not
stretched. On Linux the spawned `recv_from` parks the loop, so the sleep never
runs, the datagram is never sent, and the test DEADLOCKS until the harness
kills it:

```
=== hollow sweep scorecard ===
    268 GREEN
      1 RED
  tests/net/udp.test.yo	RED
```

That test is SKIPPED on Linux for now, with the reason at the skip. It is
already the regression test this fix needs: delete the skip and it must pass.

## Why no suite caught it before

Nothing awaited a datagram that had not arrived yet. Every other UDP test sends
before it receives, so the synchronous call returns immediately and the parking
is invisible. It takes a QUIET socket plus a concurrent task to see it, which
is exactly the shape #638's test introduced.

## Fix

Convert both to io_uring submissions in the shape the landed `send`/`recv`
already use (`IORING_OP_SENDTO` / `IORING_OP_RECVFROM`), with the source-address
length riding in the completion like the Windows `WSARecvFrom` fix does. Then
remove the Linux skip from the test above.
