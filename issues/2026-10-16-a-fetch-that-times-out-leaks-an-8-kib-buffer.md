# A fetch that times out leaks an 8 KiB buffer

**Severity:** S2: each `fetch` that ends in `Timeout` while the server holds the connection open leaks one 8192-byte allocation. A client that retries against a hung server grows without bound.

**Found:** 2026-10-16, during the Tier 1 gate of `fix/downcast-receiver-leak`. With leak verdicts on (the local default), `tests/http/http.test.yo` "fetch throws Timeout when the server never answers" fails, and its other 50 tests pass:

```
Direct leak of 8192 byte(s) in 1 object(s) allocated from:
SUMMARY: AddressSanitizer: 8192 byte(s) leaked in 1 allocation(s).
```

The failure is identical on develop `982b4a685`, built from the tree with `yo build --std-path ./std`, so that branch did not cause it. CI misses it because it runs with `YO_TEST_LEAK_VERDICT=0`.

## Reproducer

`yo test ./tests/http/http.test.yo --parallel 1 --std-path ./std -v`, then read the test above.

## Root cause

Not traced yet. The local LSan stack was not symbolized. The size matches a read buffer, and the test is the one path where `fetch_with`'s deadline aborts an exchange parked in a read (`timeout(&h, limit, e.io)` in `std/http/client.yo`). An aborted task's dispose that skips the buffer is the first suspect. The sibling test "fetch throws Other on a garbage status line, and the aborted task disposes cleanly" passes.

## Fix

TBD. The regression test is the existing test with leak verdicts on. A fix should also add an in-language observation, for example a `Drop` counter on whatever owns the buffer, so CI sees it.
