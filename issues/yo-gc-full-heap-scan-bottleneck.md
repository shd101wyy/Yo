# Cycle-GC is a full-heap mark-sweep → bottleneck on alloc-heavy runs (compiler)

## Audit: when/why the GC becomes the bottleneck

The emitted cycle collector (`__yo_gc_collect`, `yo-self/codegen/functions/gc_runtime.yo`
~line 594; mirror in `src/codegen/functions/generation.ts` ~2150+) is a **full-heap
trial-deletion mark-sweep**. Every collection walks the ENTIRE `tracked_objects`
intrusive list, multiple times:

- Phase 1: mark all tracked as candidate + `traverse_fn` trial-delete (decrement
  internal tracked→tracked refs) — O(tracked + edges).
- Phase 2: classify all tracked (RC>0 ⇒ live root).
- Phase 3: scan-restore from live roots over all tracked.
- Phase 4a/4b: dispose + free garbage over all tracked.

Trigger (`__yo_gc_register`): when `tracked_count >= __yo_gc_collect_threshold`
(starts 256, adaptive to 2× live after each GC).

**It becomes the bottleneck precisely when there are MANY tracked (RC/`object`)
objects that are MOSTLY LIVE with FEW real cycles, under high allocation churn** —
exactly the compiler's profile (yo-self compiling yo-self builds millions of live
AST / TypeValue / EvalValue / env-frame / String nodes). Each collection re-scans
the whole live set even though almost nothing is collectable. Measured on the
self-compile: the process **STALLED at ~8.7% CPU**, the `sample` profile dominated
by `__yo_gc_trial_delete_visitor` / `__yo_traverse_*` / `__yo_gc_collect`. With the
collector disabled (`YO_GC_THRESHOLD=0`, commit c4462d8dd) the same run jumped to
**100% CPU** (no stalls) — confirming the GC, not the evaluator, was the throttle.

(The adaptive 2× threshold bounds frequency as live GROWS, but does nothing for the
per-collection O(live) cost under steady-state churn, and nothing about the fact
that the vast majority of scanned objects are live and uncollectable.)

## The right optimization (Bacon-Rajan synchronous cycle collection)

Only an object whose refcount is **decremented to a non-zero value** can be the
root of a garbage cycle ("possible root"). Standard Bacon-Rajan:

1. Thread GC keeps a `possible_roots` buffer. In the GC-tracked `__yo_decr_rc`,
   when `--ref_count` leaves it > 0, add `header` to `possible_roots` (guard with a
   "buffered" flag bit so each object is added once).
2. Auto-collect when `possible_roots` length (NOT `tracked_count`) hits a threshold.
3. Collection processes ONLY the subgraph reachable from `possible_roots`
   (trial-delete → scan → collect over that closure), then clears the buffer.

This makes collection **O(possible_roots + their reachable subgraph)** instead of
O(all tracked). For the compiler (few cycles, few decrements-to-nonzero relative to
the live set) collections become cheap/rare, so the GC can stay ON by default.

Colors (purple=candidate/buffered, gray=trial-deleted, black=live, white=garbage)
are the usual bookkeeping; the existing trial-delete/scan-restore visitors already
implement most of the per-object logic — the change is WHAT SET they iterate
(possible_roots closure vs all tracked) and adding the decr-rc candidate buffering.

## Status / plan

- **NOW:** unblocked via `YO_GC_THRESHOLD` env knob (c4462d8dd) — default keeps the
  adaptive 256 collector; `=0` disables; any value raises the threshold+floor. Use
  `YO_GC_THRESHOLD=0` for the P1 self-compile / alloc-heavy compiler runs.
- **TO DO (re-enable optimized):** implement the Bacon-Rajan possible-roots buffer
  in BOTH emitters, validate (corpus 96/96, check ./std 152, the cycle-GC tests +
  no double-free under ASan), then make it the default so the env knob is no longer
  needed for the compiler. This is a correctness-critical rewrite deserving its own
  focused pass with full validation.
