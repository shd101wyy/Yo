# Bounding `g_frame_indexes` frees 1.8 GB but broke the stage-2/3 fixpoint

**Status: FIXED — 2026-08-07.** Both hypotheses resolved by the two-step
experiment this doc prescribed:

1. **Step 1 (H1 test):** invalidating the frame's index entry at the
   `comptime_expect_error` `variables.pop()` site, with NO bound —
   **FIXPOINT_HOLDS**. The shrunk-frame staleness was NOT load-bearing
   for today's output; the index is sound once shrink sites invalidate.
2. **Step 2 (re-land):** the original 3-line bound
   (`g_frame_indexes.len() > 2048 → clear`) PLUS the step-1 invalidation
   — **FIXPOINT_HOLDS**, battery green, corpus 155/155 DIFF 0,
   `check ./std` 153/153. The original break was the wholesale clear
   dropping SHRUNK frames' stale entries at arbitrary times (H1's
   mechanism at H2's timing); with the shrink-site invalidation keeping
   those entries fresh, the clear is behavior-neutral and deterministic.

Landed: `invalidate_frame_index` (env.yo) called from
`comptime_expect_error.yo`'s stranded-variable pop, and the size bound in
`_frame_positions`. The memory win is the doc's measured −1.8 GB touched;
the +26 s wall observed in the original attempt was not re-measured in
isolation — if the self-compile regresses noticeably, the bound constant
(2048) is the tuning knob.

Historical content below is frozen at its writing date.

## The memory problem (measured, still present)

`yo-self/env.yo`'s lazy per-frame name index (`g_frame_indexes`, keyed by
`Frame.index_key`, which is minted fresh per Frame construction) is **never
evicted**. A live-object census of one self-emit
(`scripts/bootstrap/live_census.py`) shows the cost:

- 10,295 live `FrameNameIndex`
- **6.79 M live `ArrayList(usize)` (543 MB)** — one position list per distinct
  NAME per indexed frame — plus the per-frame `HashMap`s and buffers.

~660 names per index says these are the memoised closure-capture frames
(`capture_env_for`): that cache is bounded at 512 entries, but when it is
cleared the _frames_ die while their index entries live on for the whole
compile.

## The change (reverted)

In `_frame_positions`, before inserting a new entry:

```rust
if(g_frame_indexes.len() > usize(2048), {
  g_frame_indexes.clear();
});
```

Measured on `compile yo-self/main.yo --release --emit-c` (mimalloc, GC ON):

|                | volume    | wall    | peak footprint |
| -------------- | --------- | ------- | -------------- |
| r9 (baseline)  | 119.7 GiB | 157.1 s | 13.12 GB       |
| with the bound | 120.5 GiB | 183.0 s | **11.30 GB**   |

So **−1.8 GB touched memory for +26 s wall** — the memory win is much larger
than the 543 MB of position lists alone (the per-frame HashMaps and buffers
ride along).

## Why it is not landable yet

- `gates_fast` was GREEN: battery all rc=0/hollow=0, corpus **PASS 155 DIFF 0**,
  `check ./std` 153/153, stage-2 markers 0, clang clean.
- **`R10_FIXPOINT_BROKEN`**: stage-2 and stage-3 differ from line 336 — the
  `__yo_tN` forward-declaration numbering diverges and the files differ by
  ~3 KB. Same signature as the r3 bool-match miscompile (dedup-failed type
  numbering), which means the two runs COLLECTED TYPES IN A DIFFERENT ORDER.

## Two hypotheses, neither confirmed

1. **The index is genuinely stale today, and the rebuild "fixes" it.**
   `yo-self/evaluator/builtins/comptime_expect_error.yo:213` does
   `rfv_f.variables.pop()` — frames DO shrink. A pop alone is caught by
   `_frame_index_refresh`'s defensive `indexed_len > n` rebuild, but a
   pop-then-push leaves `indexed_len == n` with the popped name still mapped
   and the new name missing, so the indexed path and the linear scan can
   disagree. Clearing the table forces a correct rebuild — a behavior change.
   (Note `Frame.index_key`'s doc explicitly assumes "frames only ever append".)
2. **Clear TIMING differs between the two binaries.** Both compile the same
   input with the same algorithm, so `g_frame_indexes.len()` should evolve
   identically; if it does not, something upstream is already nondeterministic
   and the bound merely amplifies it. (`HashMap.clear` was checked — it does
   reset `size`, so `len()` is not the problem.)

The +26 s is itself unexplained: ~5 clears at 2048 entries should cost far less
than that, which is weak evidence for hypothesis 1 (every post-clear lookup
rebuilding a 660-name index for the still-live capture frames).

## Next steps

1. Test hypothesis 1 in isolation: invalidate the frame's index entry at the
   `variables.pop()` site (`comptime_expect_error.yo:213`) with NO bound, and
   run the fixpoint. If that alone breaks it, the stale index is load-bearing
   for today's output — a latent correctness bug worth its own fix (TS has no
   such index; it deleted its equivalent for the same heap reason).
2. If the index is confirmed sound, land the SAFE eviction instead of a
   wholesale clear: when `capture_env_for` evicts its cache, remove exactly
   those frames' `index_key`s (iterate the cached entries' `env.frames`), so
   live frames never lose their index and no rebuild happens at all.
