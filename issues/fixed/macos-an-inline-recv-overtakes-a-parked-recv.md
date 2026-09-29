# macOS: an inline recv overtakes a parked recv on the same socket

**Status: FIXED (2026-09-28).** Found by reading `runtime_io_macos.yo` (every
`*_start` tried its syscall inline without looking at the descriptor's waiter
list), then **reproduced** on macOS 26.6 (M4) with the seed v0.2.45.

## Symptom

```
r1 := tcp.recv(fd, b1, 1, 0)   // parks: nothing to read yet
peer sends "A"                 // the byte is in fd's buffer; the loop has not polled
r2 := tcp.recv(fd, b2, 1, 0)   // must queue behind r1
peer sends "B"
```

Result on macOS: `r1 got B, r2 got A`. `docs/en-US/ASYNC_AWAIT.md` promised
that "kqueue and epoll complete them in the order they were issued". The same
overtake applied to `send`, `sendto`, `recvfrom`, `accept`, and `read`/`write`
on pipes: an operation started while an earlier one of the same direction was
parked took the readiness (or buffer space) owed to the earlier one.

## Root cause

The inline fast path (`recv(..., MSG_DONTWAIT)` before parking) ran
unconditionally. The Linux epoll backend guards the same path with
`__yo_epoll_dir_busy`. macOS had no such check, and its registration lookup
was a linked-list walk, so a check would have cost a walk per operation.

## Fix

A per-thread slot table indexed by fd (`__yo_kq_slot_t`) holds each
direction's registration. Every inline attempt first asks
`__yo_kq_dir_busy(fd, dir)` (O(1)) and parks behind an existing waiter
instead of racing it.

## Test

`tests/sys/socketpair.test.yo`: "an inline recv does not overtake a parked
recv whose bytes already arrived" (macOS, plus an epoll-fallback twin). Before
the fix it fails with `r1 got B, r2 got A`. After, `r1 got A, r2 got B`.
