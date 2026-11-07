# The `ThreadPool` docs describe CPU affinity and a sentinel barrier the runtime does not have

**Severity:** S3 — misleading documentation. A reader, or an LLM writing Yo,
would rely on behaviour that does not exist: pinning to a core, `join_all`
draining other pools' work, and a collector heap.

**Status:** FIXED 2026-11-07 on `plans/io-interface-and-std-runtime`
(VERDICTS-32 §3.3), in `docs/en-US/PARALLELISM.md`,
`docs/zh-CN/PARALLELISM.md` and `std/thread.yo`'s doc comments. No test:
documentation only.

## What was stale

| Where | Said | True |
| --- | --- | --- |
| `PARALLELISM.md`, "Thread Pool Design" diagram | Each worker sits on "(CPU n)"; "Thread-per-core: one OS thread per CPU core"; "No work stealing: predictable, cache-friendly" | No affinity syscall exists under `src/codegen`. The default worker count is the number of hardware threads, and nothing pins a thread to a core |
| `PARALLELISM.md`, ThreadPool intro | Two `ThreadPool` values "drain each other's work" | Each pool counts its own tasks (`std/thread.yo`, the `ThreadPool` type doc) |
| `PARALLELISM.md`, after the usage example | "`join_all` is a **barrier** … one sentinel task per worker" | A completion counter since 2026-09-26 |
| `PARALLELISM.md`, comparison section | "Neither `Thread.join` nor `ThreadPool.join_all` carries a value" | `Thread(T).join()` returns `T` |
| `PARALLELISM.md`, API block | `self : ThreadPool`, `pool : ThreadPool`, and `spawn(pool, …)` in the example | `self : &Self`, `pool : &ThreadPool`, `spawn(&pool, …)` |
| `std/thread.yo`, module doc and `ThreadPool` type doc | Each thread has its own "GC heap" | The cycle collector is gone (decision 48). Reference counting is per-thread and non-atomic |

The docs now also state the head-of-line behaviour, with a pointer to
`issues/2026-11-07-a-pool-task-that-awaits-blocks-every-task-queued-behind-it-on-its-worker.md`
and to the redesign that fixes it.
