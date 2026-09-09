# `yield` resumption order is not FIFO on macOS CI legs — "Test basic spawn of two futures" fails intermittently

**Status: OPEN — observed TWICE on CI, on two DIFFERENT macOS legs, from two
unrelated PRs. Never reproduced locally on `aarch64-apple-darwin`.**
First seen 2026-09-06, again 2026-09-09.

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

## Second occurrence — 2026-09-09, and what it settles

PR #515 (`std-rand-batteries`), run `34319643179`, job
`test (macos-26-intel)` id `102383084927`, head `33fef268b`. Byte-identical
failure:

```
✗ Test basic spawn of two futures
  Test failed with exit code 6
  counter should be 12 after yield in task2 (at std/assert.yo:25:17)
```

Three things follow from the pair of sightings:

1. **It is not leg-specific.** The 2026-09-06 report notes that the same head
   PASSED `macos-26-intel` while `macos-latest` failed. This time
   `macos-26-intel` is the leg that failed. So both macOS legs can produce
   either order — which is what "no FIFO guarantee" looks like, and rules out
   a quirk of one runner image.
2. **It is not caused by the PR under test.** #449 touched `std/path`,
   `std/glob`, `std/encoding/base64`, `std/time`, `std/libc/time`. #515
   touches `std/rand`, `std/crypto/random`, `std/collections/btree_map` and
   their tests. Neither touches the async runtime, `std/async`, or anything
   scheduling-related. Two unrelated change-sets producing the identical
   assertion failure is a property of the runtime, not of either PR.
3. **Open question 1 below is therefore answered "yes"** — this is
   scheduler-order nondeterminism, so the remaining work is the FIX, not more
   observation.

## The fix

`__yo_async_yield` (`src/codegen/async/runtime_core.yo`) returns a future that
is ALREADY `state = -1` (Completed), so `io.await(yield(io), io)` does not park
on a kevent — the ordering is decided by where the awaiting state machine's
continuation is queued and in what order those deferrals are drained. Making
that a genuine FIFO ready-queue is the fix the 2026-09-06 report already
identified:

> either make it FIFO (a ready-queue, not a kevent completion) or rewrite the
> test not to assume interleaving order

**Take the first option.** Do NOT delete or weaken the assertion to get green:
it encodes the documented cooperative-scheduling contract
(`docs/en-US/ASYNC_AWAIT.md`), and two tasks that yield in submission order
must resume in submission order for that contract to mean anything. A test
rewritten to accept either order would make the contract untestable and would
hide a real ordering bug in every future change to the runtime.

The residual hypothesis from the first report — that a std change altering
allocation patterns exposes a use-after-free — is NOT excluded by the second
sighting and should be checked while fixing: run the test under GuardMalloc
(`yo-macos-guardmalloc-debug-recipe`) on a leg that reproduces it.

## Why it does not reproduce locally

`aarch64-apple-darwin`, 3/3 consecutive passes at the first report; still
passing locally at the second. Both CI sightings are on x86_64 macOS images.
Local `arch -x86_64` is unavailable on this machine (no Rosetta), so an x86
macOS repro needs CI or another host — which is why this is diagnosed from job
logs rather than a local run.
