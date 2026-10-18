# A fetch that times out leaks an 8 KiB buffer

**Severity:** S2: each `fetch` that ends in `Timeout` while the server holds the connection open leaks one 8192-byte allocation. Inferred from one test, not measured: a client that retries against a hung server would grow without bound.

**Found:** 2026-10-16, during the Tier 1 gate of `fix/downcast-receiver-leak`. With leak verdicts on (the local default), `tests/http/http.test.yo` "fetch throws Timeout when the server never answers" fails, and its other 50 tests pass:

```
Direct leak of 8192 byte(s) in 1 object(s) allocated from:
SUMMARY: AddressSanitizer: 8192 byte(s) leaked in 1 allocation(s).
```

The failure is identical on develop `982b4a685`, built from the tree with `yo build --std-path ./std`, so that branch did not cause it. CI misses it because it runs with `YO_TEST_LEAK_VERDICT=0`.

## Reproducer

`yo test ./tests/http/http.test.yo --parallel 1 --std-path ./std -v`, then read the test above.

## Root cause

Traced 2026-10-18. `read_http_message_buffered` (`std/http/wire.yo`) allocated its read buffer with a raw `malloc(8192)` and freed it with `free` after the read loop. The deadline path aborts the spawned exchange WHILE it is parked in the read's await (`_fetch_deadline` in `std/http/client.yo`: `timeout(&h, limit, e.io)` → `FutureState.Aborted`), and an aborted state machine never resumes its body — the aborted-entry guard releases the pending await's future and the task's own reference, then the state machine's dispose drops its owned slots. A raw `*u8` is not an owned slot: nothing tracked it, so the `free` was unreachable and the 8 KiB buffer leaked. The serve path shares the same reader, so an aborted server-side read had the same hole.

The sibling test "fetch throws Other on a garbage status line, and the aborted task disposes cleanly" passes because its abort arrives while the task is between steps, after the buffer's scope — the buffer had already been freed on the body's normal path.

## Fix

`std/http/wire.yo`: the buffer is now an `ArrayList(u8).with_capacity(8192)` — an owned RC local that is re-read (`_read_buf_ptr(&buf_store)`) at every `read` call, so it is live across every suspension and lives in the state machine itself. The state machine's dispose drops it on every exit path, abort included; the `malloc`/`free` pair and the `GlobalAllocator` import are gone. A first attempt used a fixed `Array(u8, 8192)` value local instead — wrong: the async lowering keeps that array on the resume frame's stack, and every test that suspends and resumes across the read failed with ASan `stack-use-after-return` (the buffer address pointed into the dead first frame).

The regression test is the existing "fetch throws Timeout when the server never answers" with leak verdicts on, plus `tests/http/http.test.yo` joining the `leak-verdict.yml` allowlist so the weekly Linux/Clang leg runs the file with the verdict ON (the file's other 50 tests were already leak-clean). No in-language oracle exists for an internal read buffer: a `Drop` counter cannot reach it, which is exactly what the allowlist entry is for.

Fixed by PR (fix/http-timeout-buffer). Measured: 51/51 with leak verdicts ON and in CI mode, on the branch's std.
