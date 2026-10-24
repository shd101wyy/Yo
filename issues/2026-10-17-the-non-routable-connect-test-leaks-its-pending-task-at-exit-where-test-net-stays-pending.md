# The non-routable connect test fails LeakSanitizer where TEST-NET-1 stays pending

**Severity:** S3. On a network that leaves a connect to TEST-NET-1 pending, `tests/net/tcp.test.yo` fails under LeakSanitizer. The only loss is a 64-byte block from a task the test leaves running on purpose, and it happens once, at process exit.

**Status:** open — the 2026-10-20 mitigation (the test aborts its connect) does NOT hold on Linux io_uring under WSL2: measured 2026-10-24, see "Measured on the Linux box" below. Closing it needs a Linux LeakSanitizer run of `tests/net/tcp.test.yo` on a network where a connect to TEST-NET-1 stays pending; see "What is still open" below. **Found:** 2026-10-17, running the decision 46 Generation B gate (#1421) on Linux x86_64 under WSL2. It reproduces on develop `ed733408c` with the binary `yo-dev-ed733408c`, so the change did not cause it.

## Symptom

```
  ✗ connecting to a non-routable address does not park the event loop
    Memory leak detected:
    ==2995038==ERROR: LeakSanitizer: detected memory leaks
    Direct leak of 64 byte(s) in 1 object(s) allocated from:
        #0 ... (tests/net/.yo_selftest_batch_..._1_0.bin+0x12d0e7)
        ...
```

24 tests pass and this one fails.

## Cause (from the test's own comment)

The test spawns a connect to `192.0.2.1:81` and never awaits it ("the harness does not drain still-pending tasks at exit"). If the network rejects TEST-NET at once, the connect finishes and nothing is left behind, which is presumably what happens on CI. Here the SYN stays pending, so at exit the task's state, and the 64-byte block LeakSanitizer reports, is still allocated.

## Fix options

- Cancel the spawned connect at the end of the test (`h.abort()` or an equivalent), so its state is released before exit.
- Or have the test harness drain or abort the tasks still pending when a test returns, so a test that leaves one behind does not depend on the network.

## Mitigation (2026-10-20)

The test now calls `h.abort()` on the spawned connect right after its
loop-not-parked assertion, and its comment says why. That is the first fix
option above. The second, a harness that drains or aborts every task still
pending when a test returns, was not taken. It would need a runtime change: a
drain cannot wait for an unanswered SYN, which takes 75 s or more on macOS, so
it would have to abort tasks at exit. This one test is the only case that
leaves a task pending on purpose.

What the abort does, per backend (read from the runtime source, not
measured: see below). `JoinHandle.abort` cancels the operation the task is
suspended in when the backend can take the registration back
(`__yo_async_io_cancel`, `src/codegen/async/runtime_core.yo`). An
in-progress connect has a `cancel_fn` on all three POSIX backends, but they
differ in when the operation's `__yo_io_future_t` is released:

- epoll: `__yo_epoll_cancel` unlinks the waiter and finishes it with
  `-ECANCELED` synchronously, so the operation is released at the abort.
- kqueue: `__yo_kq_park` sets `__yo_kq_cancel`, which unlinks the waiter
  and finishes it with `-ECANCELED` synchronously, like epoll.
- io_uring: `__yo_ring_fd_future_cancel` only QUEUES an `ASYNC_CANCEL` SQE
  (`__yo_io_ring_submit_cancel`). Its comment says the operation's own
  `-ECANCELED` CQE is what releases the ring's reference, so the future is
  freed only when a later loop tick reaps that CQE. The abort helps here only
  because the test keeps running after it and gives the loop those ticks.

Two facts make "the abort fixes the leak" unproven. First, the leaked block
is 64 bytes, which matches `sizeof(__yo_io_future_t)` (8-byte ref header plus
seven pointer-size slots, `src/codegen/types/generation.yo`), so the leak is
probably the connect's IoFuture, not the task. Second, exit teardown already
aborts every parked waiter through the same abort path
(`__yo_io_teardown_abort_waiters`, #1200, 2026-10-06), and that predates
`ed733408c`, where the leak was observed. On io_uring, the teardown comment
says it releases "the TASKS, not the operations": the in-flight futures keep
the ring's reference and their CQEs die with the ring. That fits a 64-byte
IoFuture still allocated at exit on WSL2, if that run used the io_uring
backend (Linux falls back to epoll only when the ring cannot be created, and
the original log does not say which ran).

Windows has no cancel path for `ConnectEx`, so there the task stays
`Aborted` and is released when the connect completes; that gap is the
backend's, not this test's.

## What is still open

- Confirm or refute the mitigation: on Linux, with LeakSanitizer and a
  network that leaves the TEST-NET-1 SYN pending, run `tests/net/tcp.test.yo`
  with the abort in place.
- If it still leaks on io_uring, the narrowed direction is the teardown, not
  the test: after the ring is destroyed no CQE can arrive for an in-flight
  operation, so `__yo_io_cleanup` can drop the ring's reference on each
  remaining fd-bound future (`__yo_ring_fd_abort_parked`'s snapshot already
  enumerates them) instead of leaving it to a CQE that never comes.

### Measured on the Mac Mini (darwin arm64, Apple clang)

- The leak does not reproduce here, for two reasons. This network answers a
  connect to TEST-NET-1 at once: a probe that spawns the connect, sleeps
  300 ms and reads `is_finished()` prints `true`. The box routes through a
  TUN proxy (`utun1024`, 198.18.0.1), which takes the SYN. LeakSanitizer is
  not usable on this box either. Apple clang's AddressSanitizer has none, and
  with nix's clang 21.1.7, `ASAN_OPTIONS=detect_leaks=1` on a 64-byte
  `malloc` leak probe spun at 100% CPU for over two minutes without
  reporting anything.
- Aborting a connect that IS pending is prompt: a probe binds a loopback
  listener that never accepts and spawns 400 connects to it. After 300 ms, 272
  were still pending: macOS drops SYNs once the listen backlog is full.
  `abort()` on every handle left 0 unfinished, measured in the same tick
  (0 ms). That shows the handles go terminal at once. That the memory is also
  freed at once rests on the `cancel_fn` reading of the runtime above, since
  LeakSanitizer cannot run here.
- `tests/net/tcp.test.yo` passes 25/25 under the default
  `--sanitize address` with the tree binary.

### Measured on the Linux box (2026-10-24, WSL2 x86_64, io_uring)

The mitigation does not hold here. Runs of this one test with the
`feat/z11-debug-allocator` tree binary, abort in place:

- Default `--sanitize address` with the leak verdict on: `LeakSanitizer:
  detected memory leaks`, a direct leak of 64 bytes plus one of 16 bytes,
  `80 byte(s) leaked in 2 allocation(s)`.
- `--allocator debug`: `leaked block #12: 16 bytes`, `leaked block #13:
  64 bytes`, `leak check failed: 2 blocks / 80 bytes`, exit status 23. The
  whole-file debug run fails this one test and passes the other 24.

The two oracles agree. Each test runs in its own process, so the
io_uring cancel completion that the test's comment expects "the ticks after
this test" to reap never arrives before exit. The teardown direction above
(`__yo_io_cleanup` dropping the ring's reference on each remaining fd-bound
future) is the remaining fix. Until then, `tests/net/tcp.test.yo` is a known
failure of any suite-wide `--allocator debug` run (W6a's corpus
measurement).
