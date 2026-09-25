# Windows: a spawned thread's GC state is never released at thread exit

**Found:** 2026-09-25, parallelism-soundness audit (`plans/PARALLELISM_SOUNDNESS.md`, finding P-24;
raised by the runtime sub-audit, verified by reading).
**Status:** FIXED 2026-09-26 (`plans/PARALLELISM_SOUNDNESS.md` Phase 6). Was: OPEN. **Leak, Windows only, cycle-GC programs** (unbounded for thread-heavy
programs; no unsafety — nothing frees the state, so nothing dangles).
**Where:** `src/codegen/functions/gc_runtime.yo` — `__yo_cleanup_thread_gc` (~1015) is called
from exactly two places: the POSIX `pthread_key` destructor (~608-613) and `__yo_process_cleanup`
(~1075-1080, the current thread only).

## Mechanism

The Windows branch allocates the cleanup key with `TlsAlloc` / `TlsSetValue` (~586-604,
~629-633). `TlsAlloc` has no destructor callback (that is `FlsAlloc`), and the thread entry points
(`src/codegen/parallelism/runtime.yo`) run `__yo_gc_collect()` but not the cleanup, so every
`Thread` and every pool worker that exits on Windows leaks its `__yo_thread_gc_state_t`, its
whole tracked-object list, and stays on `__yo_all_thread_gcs` (which the process cleanup then
walks).

## Fix direction

Either `FlsAlloc(__yo_fls_cleanup)` in place of `TlsAlloc` (fiber-local storage callbacks run at
thread exit on every supported Windows), or call `__yo_cleanup_thread_gc()` explicitly at the end
of `__yo_thread_entry` / `__yo_worker_thread_entry` on every platform (simpler, and then the
POSIX key destructor becomes a no-op backstop). Test: `tests/thread.test.yo` spawns a few hundred
threads that each allocate a cycle-capable object; assert the process RSS or the
`__yo_all_thread_gcs` length via a debug knob on the Windows legs.

## Fix (2026-09-26)

Both thread entry points (`__yo_thread_entry`, `__yo_worker_thread_entry`,
`src/codegen/parallelism/runtime.yo`) call `__yo_cleanup_thread_gc()` last, after the loop
teardown, on every platform. It is idempotent (it clears `__yo_current_thread_gc`), so the POSIX
key destructor that also runs it at thread exit finds nothing left. Gate: the Windows legs and
the local `zig cc` compile.
