# `__yo_cleanup_thread_gc` single-pass sweep — use-after-free / glibc heap corruption at thread exit

**Status:** FIXED (both compilers)

## Symptoms

The `bootstrap-fixpoint` CI job's stage-2 self-emit aborted on ubuntu-latest with
glibc `corrupted double-linked list` (exit 134) ~17 min in — after the emit had
effectively completed, during worker-thread teardown. Never reproduced on macOS:
a full stage-2 emit under AddressSanitizer on macOS arm64 was byte-identical
clean (macOS's exit path doesn't run the same thread-destructor cleanup).

Reproduced on Linux with an ASan build of stage-1 (scratch workflow
`debug-stage2-asan`, run 30837532385):

```
ERROR: AddressSanitizer: heap-use-after-free ... READ of size 1 ... thread T1
  #0 __yo_decr_rc
  #1 fn_..._id_151___dispose
  #2 __yo_cleanup_thread_gc
freed by thread T1 here:
  #1 __yo_cleanup_thread_gc
```

## Root cause

The end-of-thread GC cleanup force-disposed and freed every tracked object in a
**single walk**:

```c
__yo_gc_collecting = 1;
while (current != NULL) {
  next = current->gc_next;
  if (current->dispose_fn) current->dispose_fn(current);
  __yo_free(current);
  current = next;
}
```

The `__yo_gc_collecting` flag makes `__yo_decr_rc` skip tracked objects (so the
walk frees each exactly once) — but the skip check itself **reads the target's
header** (`header->gc_flags & __YO_GC_TRACKED`). When a later object's dispose
decremented a reference to a tracked object the walk had **already freed**, that
read hit freed memory. Usually the stale byte still said TRACKED (benign-looking
UAF read); when the allocator had reused the chunk and the bit appeared clear,
`__yo_decr_rc` fell into the untracked path and freed/mutated garbage — glibc's
`corrupted double-linked list`.

Both real collectors (`__yo_gc_collect`, `__yo_gc_collect_incremental`) already
dispose-then-free in **two passes**; only the thread-cleanup sweep was
single-pass. The ref-enum `___dispose` fix (`issues/fixed/ref-enum-missing-dispose-leak.md`)
added disposes to types that previously had none, which widened the exposure —
but the sweep was unsound for any tracked graph whose disposes reference other
tracked objects (ref-struct disposes could hit it too).

## Fix

Two-phase sweep in `__yo_cleanup_thread_gc`, mirroring the collectors:
pass 1 disposes every tracked object while **all** tracked headers are still
allocated (so the collecting-flag skip reads live memory); pass 2 frees them.

- TS: `src/codegen/functions/generation.ts` (the emitted C runtime template)
- yo-self: `yo-self/codegen/functions/gc_runtime.yo` (same template, 1-to-1)

## Verification

- Linux ASan stage-2 emit (scratch `debug-stage2-asan` workflow): clean after the fix.
- `bootstrap-fixpoint` CI job green end-to-end (stage-2 markers 0, clang clean,
  stage-2 ≡ stage-3).
- Local: gc_cleanup_exit / cycle_collector / ref_enum / arc / rc green;
  gates_fast battery + corpus + FIXPOINT_HOLDS revalidated after the runtime change.

## Debugging notes

- glibc `corrupted double-linked list` with a clean macOS ASan run means the
  corrupting path executes only on Linux — for exit-time crashes suspect the
  pthread-destructor cleanup chain, which macOS does not run identically.
- The Linux ASan repro used a scratch branch + push-triggered workflow; note
  that `cmd | tail -200` masks the exit code (use pipefail or a temp file).
