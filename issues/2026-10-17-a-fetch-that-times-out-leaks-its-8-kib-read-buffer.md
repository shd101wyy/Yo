# A `fetch` that times out leaks an 8 KiB allocation

**Severity:** S2. Every `fetch` whose deadline fires leaks one 8,192-byte block, so a long-running client that hits timeouts grows without bound. `tests/http/http.test.yo` fails under LeakSanitizer.

**Status:** OPEN. **Found:** 2026-10-17, running the decision 46 Generation B gate (#1421). It reproduces on develop `ed733408c` (the binary `yo-dev-ed733408c` with that tree's std), so the change did not cause it. It was not found in CI.

## Symptom

`yo test ./tests/http/http.test.yo --parallel 1` on Linux x86_64 (WSL2, clang 21, the default ASan + LSan run):

```
  ✗ fetch throws Timeout when the server never answers
    Memory leak detected:
    ==2423855==ERROR: LeakSanitizer: detected memory leaks
    Direct leak of 8192 byte(s) in 1 object(s) allocated from:
        #0 ... (.yo_selftest_batch_..._1_0.bin+0x137267)
        ...
    SUMMARY: AddressSanitizer: 8192 byte(s) leaked in 1 allocation(s).
```

50 tests pass and this one fails. The test points `fetch_with` at a server that accepts and never answers, with a 100 ms timeout. The fetch throws `Timeout` as expected, and the handler `unwind`s.

## Suspected cause (not measured)

8,192 bytes is the size of the HTTP client's read buffer (`std/http/wire.yo` / `std/http/client.yo`, `read_http_message_buffered`). The deadline race aborts the read future while it is parked. The buffer is a raw allocation held across that suspension, and the aborted state machine's teardown does not free it. The next step is to symbolize the stack (`ASAN_SYMBOLIZER_PATH`, or `--keep-batch` plus `addr2line`) and confirm which allocation it is.
