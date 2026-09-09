# `yield` resumption order diverges on macOS CI legs (and the queue is NOT the cause) — "Test basic spawn of two futures" fails intermittently

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

## The stated fix is REFUTED — there is already a FIFO ready-queue

The 2026-09-06 report proposed:

> either make it FIFO (a ready-queue, not a kevent completion) or rewrite the
> test not to assume interleaving order

**The first option is already implemented, so it cannot be the fix.** Read of
`src/codegen/async/runtime_core.yo` on 2026-09-09 (code read, NOT executed —
see "Why it does not reproduce locally"):

1. `yield` never touches kqueue. `__yo_async_yield` returns a future already in
   `state = -1` (Completed), so there is no kevent whose completion order could
   vary.
2. `__yo_async_enqueue_continuation` appends at `tail`;
   `__yo_async_run_ready_tasks` takes from `head`. That is strict FIFO.
3. The per-step budget (`budget = count` at entry) keeps a continuation
   enqueued DURING a step from running in that same step, so a yielding task
   cannot jump ahead of a sibling queued before it.

Hand-tracing the test's queue confirms the intended order falls out by
construction: `[t1, t2]` → t1 runs and enqueues t1', t2 runs and enqueues t2'
→ `[t1', t2']`, so t1 resumes first and sees 11.

So the divergence is NOT queue ordering. The remaining candidates, in the order
worth checking:

1. **The `io.spawn` codegen path** — whether both spawns are really enqueued
   before anything starts draining, or whether the first `handle.await` can
   drive a step between them.
2. **How an await of an ALREADY-COMPLETED future suspends.** This is the
   unusual shape here: a normal await parks on I/O, but `yield`'s future is
   born Completed, so the state-machine step transition is what defers it. A
   path that completes inline on one target and defers on another would produce
   exactly this.
3. **Memory corruption** — the first report's alternative hypothesis, NOT
   excluded. The continuation free list is LIFO
   (`cont->next = __yo_cont_free_list`) and blocks are recycled immediately
   after `resume_fn` returns; a stale `cont` or state-machine pointer would
   surface as a wrong-looking resume order. Run the test under GuardMalloc
   (`yo-macos-guardmalloc-debug-recipe`) on a leg that reproduces.

**Do NOT delete or weaken the assertion to get green.** It encodes the
documented cooperative-scheduling contract (`docs/en-US/ASYNC_AWAIT.md`): two
tasks that yield in submission order must resume in submission order, or the
contract means nothing. A test rewritten to accept either order would make the
contract untestable and hide every future ordering regression in the runtime.

## Why it does not reproduce locally

`aarch64-apple-darwin`, 3/3 consecutive passes at the first report; still
passing locally at the second. Both CI sightings are on x86_64 macOS images.
Local `arch -x86_64` is unavailable on this machine (no Rosetta), so an x86
macOS repro needs CI or another host — which is why this is diagnosed from job
logs rather than a local run.
