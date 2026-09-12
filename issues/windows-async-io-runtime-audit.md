# Windows async I/O runtime audit — findings register

**Status: OPEN (audit 2026-09-12, branch `audit/windows-async-io`).** A
full read of `src/codegen/async/runtime_io_windows.yo` (both emitted
sections) against `runtime_io_linux.yo`, `runtime_io_macos.yo`,
`runtime_core.yo` and the std call sites, with every suspected bug
reproduced (or explicitly dispositioned) before fixing. Five defects were
fixed in the same branch; this register records them and everything
inspected and deliberately NOT changed, so the next audit starts from
evidence rather than re-derivation.

## Fixed in this audit

| # | Issue | Severity | Disposition |
| --- | --- | --- | --- |
| 1 | [Sync file close leaks the CRT fd until Winsock is started](fixed/windows-file-close-leaks-fd-until-wsa-is-started.md) | HIGH (reproduced: EMFILE after ~8192 open/close rounds in a socket-free program) | socket-fd registry replaces the closesocket probe |
| 2 | [Blocking `connect()` parks the event loop](fixed/windows-blocking-connect-parks-the-event-loop.md) | HIGH (reproduced: a 300 ms sleep took 21.3 s while a TEST-NET connect was in flight) | overlapped ConnectEx for INET/INET6 stream sockets |
| 3 | [UDP `recvfrom`/`sendto` run blocking calls on the loop thread](fixed/windows-udp-recvfrom-blocks-the-event-loop.md) | HIGH (reproduced: quiet `recv_from` deadlocks the whole loop) | overlapped WSARecvFrom/WSASendTo, mirroring recv/send |
| 4 | [fs.watch re-arm drops the recursive flag](fixed/windows-fs-watch-rearm-drops-recursive-flag.md) | LOW (masked by the kernel keeping the first arm's handle scope; probed) | re-arm replays the caller's choice |
| 5 | [Unbounded `wcscpy` into `dir_part[MAX_PATH]` in the single-file watch path](fixed/windows-fs-event-dir-part-unbounded-wcscpy.md) | LOW (by inspection; >260-char watch path smashes the stack) | bounded copy |

## Inspected and deliberately NOT changed (with reasons)

- **`__yo_async_waitpid_start` blocks in `WaitForSingleObject(INFINITE)`.**
  A long-running child parks the loop, and two awaited children serialize.
  Cross-platform as designed: the Linux backend calls plain blocking
  `waitpid(2)` (`runtime_io_common.yo`), so this is the shared stance, not
  a Windows divergence. A real fix wants RegisterWaitForSingleObject
  (Windows) / pidfd or waitid (Linux) — a cross-platform design decision,
  not a Windows patch. Command.output avoids the worst interaction today
  because parked pipe reads only retry from the tick, and the tick is not
  reached while waitpid blocks — worth revisiting TOGETHER with the fix.
- **Linux `sendto`/`recvfrom` are synchronous** (the io_uring backend
  comments "no direct sendto"). Modern io_uring has
  `IORING_OP_SENDTO/RECVFROM`; with Windows now overlapped, Linux is the
  divergent side. The blocking-recvfrom freeze reproduces there the same
  way it did on Windows before fix #3.
- **`__yo_io_cleanup` frees the timer list but not**: parked pipe reads
  (`__yo_win_pipe_reads`), dir states (`__yo_dir_state_head`), the
  overlapped free list, fs-event handles, or the socket-fd registry —
  process-exit leaks only, invisible unless `--debug-heap` is the oracle;
  none of those allocations are RC-tracked so they are not reported
  either.
- **`__yo_wsa_initialized` is not reset by `__yo_io_cleanup`** (which does
  call `WSACleanup`): a sync socket helper that runs after an async
  runtime teardown would use Winsock without a startup. Reachable only in
  a program that tears the loop down and then does sync socket I/O — no
  std path does; noted for whoever next touches teardown.
- **`__yo_async_getdents_start` maps every `FindFirstFileW` failure to
  "no entries" (EOF)**, including access-denied. Error-masking, not
  loop-blocking; same on the scandir path.
- **The QPC deadline clock** (landed the same day as this audit, #627)
  was re-read and left alone.
- **`__yo_win_overlapped_t` mixing**: socket ops `__yo_rc_alloc` their
  overlapped structs but return them via `__yo_win_free_overlapped`'s
  free list (never `__yo_free`d). Consistent one-way recycling — the
  free list hands the block to a later file op which re-zeroes it; no
  double-free is possible. Not pretty, not wrong.
- **The RDCW consume/re-arm pattern** (poll `GetOverlappedResult`, re-use
  OVERLAPPED + buffer) can deliver stale/duplicate records on machines
  where a post-creation scanner (Defender, indexer) touches freshly
  written files — observed in raw-C probes on this host under BOTH the
  old and the new re-arm scope, i.e. not caused by fix #4 and not
  reliably attributable to the runtime. The structural hardening (IOCP-
  associate the directory handle and consume completions as packets, like
  every other op) is the right follow-up if duplicates are ever reported
  by a real user.
- **`tests/net/unix.test.yo` "bind, connect, accept, echo round-trip"
  fails on THIS host (exit 22) under the unmodified CI-equivalent seed
  binary** — pre-existing, environmental (AF_UNIX), unchanged by this
  audit's patches; recorded so the next Windows session doesn't chase it
  as a new regression.
