# `yield` resumption order differed on a `macos-latest` CI leg — "Test basic spawn of two futures" failed once

**Status: OPEN — observed once on CI, not reproduced locally.** 2026-09-06.

## Evidence

PR #449's first `test.yml` run (run `34014524807`, job `test (macos-latest)`
id `101441185697`, head `48ebed985`) failed exactly one test:

```
✗ Test basic spawn of two futures
  Test failed with exit code 6
  counter should be 12 after yield in task2 (at std/assert.yo:25:17)
```

`tests/async_await.test.yo`'s test spawns two cold tasks that each bump a
shared counter, `yield`, and assert the OTHER task ran in between:
task1 0→1, yield; task2 1→11, yield; task1 resumes expecting 11 → 12;
task2 resumes expecting 12. The failure says task2 resumed while the counter
was still 11 — i.e. **task2's yield completed before task1's**, the reverse
of submission order.

#449 touches `std/path`, `std/glob`, `std/encoding/base64`, `std/time`,
`std/libc/time` — nothing in the async runtime or `std/async`. The same head
passed `test (macos-26-intel)` and the Linux legs. Locally
(`aarch64-apple-darwin`, `/tmp/yo-send3`) the test passed 3/3 consecutive
runs.

## What to establish

1. Does #449's rerun (after `1281bd788` / `c8de17627`) pass `macos-latest`?
   If yes, this is a scheduler-order flake and the runtime's `yield` on macOS
   (kqueue-based, `src/codegen/async/runtime_io_macos.yo`) does not guarantee
   FIFO resumption — either make it FIFO (a ready-queue, not a kevent
   completion) or rewrite the test not to assume interleaving order.
2. If the rerun fails the same test, bisect against develop at `c733b1a92`
   (which has #447/#448 but not #449): a std change that alters allocation
   patterns could be exposing a use-after-free in the async runtime instead.

Do not delete or weaken the assertion to get green: the test encodes the
documented cooperative-scheduling contract (`docs/en-US/ASYNC_AWAIT.md`).
