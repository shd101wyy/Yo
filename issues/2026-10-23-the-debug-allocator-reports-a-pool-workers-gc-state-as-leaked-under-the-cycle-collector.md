# The debug allocator reports a pool worker's GC state as leaked under the cycle collector

**Severity:** S3 — a false leak report from `--allocator debug` in programs that use `spawn(pool, …)` with the cycle collector on; `--cycle-collector off` and every program without a pool are unaffected.

**Area:** cycle collector runtime (`src/codegen/functions/gc_runtime.yo`, `__yo_cleanup_thread_gc`), seen through `--allocator debug` (`src/codegen/c/allocator_debug.yo`). The collector is being removed (`plans/backlog/WEAK_AND_UNCOLLECTED_RC.md` §6, W6b), so this record is documentation only, with no fix (maintainer, 2026-10-23: a new cycle-collector issue gets a doc and no fix).

## Symptom

`tests/send_sync.test.yo` under `--allocator debug` with the default `--cycle-collector auto`:

```text
  ✗ a move-only capture crosses spawn(pool, …) and disposes once
    Memory leak detected:
    debug allocator: peak 1.1 KiB, 39 allocations, live at exit: 6 blocks / 488 bytes
    debug allocator:   5 blocks / 400 bytes still reachable from module globals
    debug allocator:   leaked block #38: 88 bytes
    debug allocator: leak check failed: 1 blocks / 88 bytes leaked after main returned (exit status 23); YO_DEBUG_ALLOC_TRAP=<n> aborts at allocation #n
```

The same file passes all 15 tests under `--allocator debug --cycle-collector off`.

## Reproducer

```bash
yo test tests/send_sync.test.yo --allocator debug --parallel 1 -v
# keep the batch (YO_KEEP_BATCH=1) and trap the allocation:
YO_TEST_INDEX=8 YO_DEBUG_ALLOC_TRAP=38 gdb -batch -ex run -ex bt ./.yo_selftest_batch_*.bin
#  __yo_rc_alloc <- __yo_init_thread_gc <- __yo_gc_init_thread <- __yo_worker_thread_entry
```

## Root cause

Block #38 is the pool worker's `__yo_thread_gc_state_t`. Pool workers are
detached, and the atexit pool shutdown sets their flags and returns without
waiting (by design, `issues/fixed/worker-pool-atexit-shutdown-joins-workers-blocked-in-a-task.md`).
The worker then runs `__yo_cleanup_thread_gc`, which UNLINKS its state from
`__yo_all_thread_gcs` and only afterwards calls `__yo_free(my_gc_state)`.
The debug allocator's exit report holds its lock for the whole scan, so a
worker that unlinked its state blocks in `__yo_free` until the report ends:
the state is live and no longer reachable from `__yo_all_thread_gcs` (a root
of the scan since the debug allocator landed), so it is reported as leaked.

## Remedy

None planned: W6b deletes the per-thread GC states with the collector. If the
collector outlived that plan, freeing the state BEFORE unlinking it (both
under `__yo_thread_list_mutex`, with the neighbours read first) would make the
report see either a linked, live state or no state at all.
