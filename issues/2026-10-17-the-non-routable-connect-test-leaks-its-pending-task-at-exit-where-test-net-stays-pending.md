# The non-routable connect test fails LeakSanitizer where TEST-NET-1 stays pending

**Severity:** S3. On a network that leaves a connect to TEST-NET-1 pending, `tests/net/tcp.test.yo` fails under LeakSanitizer. The only loss is a 64-byte block from a task the test leaves running on purpose, and it happens once, at process exit.

**Status:** OPEN. **Found:** 2026-10-17, running the decision 46 Generation B gate (#1421) on Linux x86_64 under WSL2. It reproduces on develop `ed733408c` with the binary `yo-dev-ed733408c`, so the change did not cause it.

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
