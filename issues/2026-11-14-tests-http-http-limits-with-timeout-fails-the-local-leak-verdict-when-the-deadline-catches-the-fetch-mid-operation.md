# tests/http/http_limits.test.yo's with_timeout fails the local leak verdict when the deadline catches the fetch mid-operation

**Severity:** S3 — `tests/http/http_limits.test.yo` "with_timeout drives a too-short deadline to HttpError.Timeout" fails under LeakSanitizer with a 16-byte direct leak. Environment- and timing-gated (WSL2, machine load): the same binary flips between clean and 5/5-leaking as the box's load shifts, and CI's language-suite shards run with `YO_TEST_LEAK_VERDICT=0` (`.github/workflows/test.yml`), so this never gates a battery — the same staging the unix/tcp leak debt gets (`issues/2026-10-24-an-aborted-task-never-drops-its-by-value-captures.md`). One small block, once, at process exit — the same family as `issues/2026-10-17-the-non-routable-connect-test-leaks-its-pending-task-at-exit-where-test-net-stays-pending.md` (which measured this box's io_uring backend leaking a 64-byte `__yo_io_future_t` plus a 16-byte block, 2026-10-24).

**Status:** open. Found 2026-11-14 by the full local language suite with the `fix/develop-1932-uninit-capture` tree binary (`yo-fd2`, develop `57fb978f9` + the branch's four commits): the suite's only ✗ outside the three files #1932 broke.

## Symptom

```
  ✗ with_timeout drives a too-short deadline to HttpError.Timeout
    Memory leak detected:
==...==ERROR: LeakSanitizer: detected memory leaks
Direct leak of 16 byte(s) in 1 object(s) allocated from:
    ... (frames inside _resume functions of the fetch state machines, from __yo_user_main)
SUMMARY: AddressSanitizer: 16 byte(s) leaked in 1 allocation(s).
```

The other five tests of the file pass.

## Why it is not the v0.2.78 window's codegen

The test fetches from a listener that never accepts under a 1 ms deadline; the handler `unwind`s `_fetch_error`'s frame, discarding the fetch continuation mid-flight (an unwound task enters `FutureState.Aborted`). Whether anything is left allocated at exit depends on WHERE the deadline fires: if it catches the fetch with an operation in flight, that operation's release needs a completion the dying process never reaps. That is a race against machine timing, which the measurements show:

- 12:20 CST, box under full load: seed v0.2.77 binary of the standalone repro (below) clean 2/2; window binaries (c2 branch `yo-s1e`, `yo-fd2`) leaking.
- 12:44 CST, same binaries, same commands: the SEED binary leaks 5/5 (`YO_IO_BACKEND=auto`), identical 16-byte direct leak; `yo-fd2` leaks 5/5.
- `YO_IO_BACKEND=epoll`: seed 1/5, fd2 3/5 — not io_uring-specific.

The same seed binary flipping clean→leaking with load alone rules out an emitted-code cause. The window's binaries appear to hit the leaking side of the race somewhat more often (3/5 vs 1/5 on epoll), which may be a perf shift (the window re-emits the `PLAIN`/`SECURE` match as a `switch` and moves some async dup sources to `sm->var` slots), but the leak itself is the pre-existing abandonment class below.

## Reproducer

`tests/http/http_limits.test.yo`'s first test, or standalone (bind a listener on an unused loopback port, `fetch_with` a 1 ms `FetchOptions` timeout against it, assert `timed out`):

```yo ignore
listener := io.await(TcpListener.bind(SocketAddr.loopback(u16(19990)), io), ioe);
opts := FetchOptions.new().with_timeout(Duration.from_millis(i64(1)));
err := _fetch_error(`http://127.0.0.1:19990/`, &opts, io); // handler unwinds on the thrown Timeout
```

compiled `--sanitize address --allocator system` and run with `ASAN_OPTIONS=detect_leaks=1`; leak verdict on (`YO_TEST_LEAK_VERDICT` unset), as the suite runs it.

## Direction (from the 2026-10-17 doc, which stays the tracking issue)

Exit teardown aborts every parked waiter (`__yo_io_teardown_abort_waiters`) but, on the backends, an aborted in-flight operation's memory is released only by a completion the loop must live long enough to reap (`__yo_io_cleanup` dropping the ring's reference on each remaining fd-bound future is the named fix there). The http case adds: the abandoned task is a WHOLE fetch state machine unwound by a handler, so whatever it had in flight at the `unwind` is in the same position as the TEST-NET connect. Until the runtime change lands, this test is a known local-leak flake on slow/loaded boxes; CI is unaffected (its shards set `YO_TEST_LEAK_VERDICT=0`; the leak-verdict workflow is the selective oracle). A local suite run that wants CI parity can set the same variable.

## Test

The existing test is correct and unchanged; this doc records why it can fail locally without a product regression in the change under test.
