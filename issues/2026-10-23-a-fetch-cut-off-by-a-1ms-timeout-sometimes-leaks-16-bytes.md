# A fetch cut off by a 1 ms timeout sometimes leaks 16 bytes

**Severity:** S3. Sometimes, when the 1 ms deadline interrupts a fetch, the
fetch leaks one 16-byte allocation. That makes
`tests/http/http_limits.test.yo` fail its LeakSanitizer verdict
intermittently. CI runs with `YO_TEST_LEAK_VERDICT=0` and cannot see the leak.

> Found 2026-10-23 by B3's Tier 1 gate (`feat/v2b-b3-std-explicit-copies`).
> It is not caused by B3: it reproduces with develop's own std under both
> the develop `e30c0d8ed` tree binary and the develop `95162303d` tree
> binary. Machine: Linux x86_64 under WSL2, kernel
> 6.18.54.1-microsoft-standard-WSL2.

## Symptom

`yo test tests/http/http_limits.test.yo --parallel 1 -v`:

```text
  ✗ with_timeout drives a too-short deadline to HttpError.Timeout
    Memory leak detected:
    ==4017130==ERROR: LeakSanitizer: detected memory leaks
    Direct leak of 16 byte(s) in 1 object(s) allocated from:
    ...
    SUMMARY: AddressSanitizer: 16 byte(s) leaked in 1 allocation(s).
```

| binary | std | runs | failed |
| --- | --- | --- | --- |
| develop `95162303d` tree | develop | 2 | 2 |
| develop `95162303d` tree | B3 branch | 3 | 3 |
| develop `e30c0d8ed` tree | develop | 2 | 1 |
| develop `e30c0d8ed` tree | B3 branch | 1 | 0 |

The failure depends on timing: the 1 ms deadline can fire during the
connect, the send or the receive.

## What is known

The test binds a listener that never accepts. It fetches from it with
`FetchOptions.new().with_timeout(Duration.from_millis(i64(1)))`, so the
deadline aborts whichever operation is pending at that moment. The leaked
block was not symbolized; the stack in the report is raw offsets into the
test binary. Its size, 16 bytes, is the size of a `sockaddr_in`. The likely
class is the one in
`issues/2026-10-22-an-aborted-accept-leaks-its-peer-address-buffers.md`: a
buffer that is held across an await and freed only after the await, so an
aborted task never frees it. That is not confirmed. Rebuild the batch with
symbols (`YO_KEEP_BATCH=1`, then compile the kept `.c` with `-g`) to name the
allocation site.

The test itself is the regression test: it must pass its leak verdict
repeatedly after the fix.
