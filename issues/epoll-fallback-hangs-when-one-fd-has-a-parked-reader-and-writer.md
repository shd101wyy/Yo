# The epoll fallback hangs when one fd has both a parked reader and a parked writer

**Status: OPEN.** Filed 2026-09-27 from the DROP_LIBURING audit. The mechanism was
**read from the code**. It has **not been run**: the audit box has no Linux or
Docker. Introduced by Phase 5 (#948). It does not regress v0.2.44, where the same
environments `exit(1)` at the first I/O.

## Mechanism

`src/codegen/async/runtime_io_linux.yo`, the epoll section
(`__yo_epoll_arm` / `__yo_epoll_disarm` / `__yo_epoll_park`):

- The backend keeps one registration per **(fd, direction)**:
  `while (reg && !(reg->fd == fd && reg->events == events))`. That is the kqueue
  model it was ported from, where (ident, filter) pairs are independent.
- epoll allows exactly **one** interest entry per fd per epoll instance. When a
  reader is parked (EPOLLIN) and a writer on the same fd hits EAGAIN, the second
  `EPOLL_CTL_ADD` fails with `EEXIST`.
- The fallback then calls `EPOLL_CTL_MOD`, which **replaces** both the event mask
  and `data.ptr`. The reader's registration is no longer watched.
- When the writer drains, `__yo_epoll_disarm(fd)` issues `EPOLL_CTL_DEL` for the
  whole fd. The reader stays parked with `pending_io_count > 0`, and the loop
  blocks in `epoll_wait(-1)` forever.

Trigger: any full-duplex socket with a pending read and a backpressured write. For
example, a request body being uploaded while the response is awaited, or a proxy.
This happens in exactly the environments the fallback exists for (Docker's default
seccomp, gVisor).

## Why no gate saw it

Nothing in CI parks an op on the epoll backend:

- The Docker leg's probe (`test.yml`, "Docker default-seccomp epoll fallback") does
  only `sleep` plus a regular-file write, and both complete synchronously. Plan
  Phase 5 asked for socket + file + sleep.
- `scripts/bench/io_budget.yo`'s echo always sends before it receives, so every op
  completes inline. Budget C's "one parked socket" parks nothing.
- The plan's forced-epoll corpus (`YO_IO_BACKEND=epoll yo test` over async/io/net)
  is not in any workflow.

## Fix direction

1. Keep one registration per **fd**, holding separate read and write waiter lists
   and a combined mask. Use `EPOLL_CTL_MOD` when the mask changes, dispatch on
   `revents & (EPOLLIN|EPOLLOUT|EPOLLERR|EPOLLHUP)`, and `EPOLL_CTL_DEL` only when
   both lists are empty.
2. Regression test (Linux, `YO_IO_BACKEND=epoll`): a socketpair with a parked
   `recv` on one end, and a `send` on the same fd that fills the buffer and parks.
   Drain from the peer, then complete the recv. It must finish instead of hanging
   (use a runner deadline).
3. Add the forced-epoll corpus as a CI leg, and give the Docker probe a real socket
   accept/recv.
