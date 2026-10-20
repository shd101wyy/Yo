# The non-routable connect test fails LeakSanitizer where TEST-NET-1 stays pending

**Severity:** S3. On a network that leaves a connect to TEST-NET-1 pending, `tests/net/tcp.test.yo` fails under LeakSanitizer. The only loss is a 64-byte block from a task the test leaves running on purpose, and it happens once, at process exit.

**Status:** FIXED 2026-10-20 (branch `fix/tcp-nonroutable-connect-leak`). **Found:** 2026-10-17, running the decision 46 Generation B gate (#1421) on Linux x86_64 under WSL2. It reproduces on develop `ed733408c` with the binary `yo-dev-ed733408c`, so the change did not cause it.

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

## Resolution (2026-10-20)

The test now calls `h.abort()` on the spawned connect right after its
loop-not-parked assertion, and its comment says why. That is the first fix
option above. The second, a harness that drains or aborts every task still
pending when a test returns, was not taken. It would need a runtime change: a
drain cannot wait for an unanswered SYN, which takes 75 s or more on macOS, so
it would have to abort tasks at exit. This one test is the only case that
leaves a task pending on purpose.

Why the abort releases the leaked block: `JoinHandle.abort` cancels the
operation the task is suspended in when the backend can take the registration
back (`__yo_async_io_cancel`, `src/codegen/async/runtime_core.yo`). A connect
that is still in progress has a `cancel_fn` on all three POSIX backends: epoll
(`__yo_epoll_connect_start` sets `__yo_epoll_cancel`), io_uring
(`__yo_ring_fd_future_cancel`) and kqueue (`__yo_kq_park` sets
`__yo_kq_cancel`). The task's state machine and its connect future are
therefore freed at the abort, before the test returns. Windows has no cancel
path for `ConnectEx`, so there the task stays `Aborted` and is released when
the connect completes; that gap is the backend's, not this test's.

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
