# RC-header split: the measured path from 12.2 GB to sub-7 GB self-emit

**Status: PLANNED, deliberately sequenced AFTER `src/` retirement (P2 Group E).**
The change rewrites every emitted object's layout; under the strict-1:1 rule it
would have to land in BOTH compilers and re-prove fixpoint across both, then
one copy is deleted. Post-retirement it is a single-codebase change. Nothing
gates on it: the release chain's macOS legs are cross-emitted (P2.5 step-24
option A), so the 7 GB macOS-runner ceiling no longer blocks anything — this
campaign is a platform-wide win, not an unblocker.

## The census that scoped it (2026-08-17)

Method: `scripts/bootstrap/live_census_v2`-style injection into the emitted C
(per-type +1 at each `__yo_new___yo_tN`, −1 at its `dispose_fn` mapped from
the ctor's `header.dispose_fn = …` assignment; 396 types, 375 disposes, 21
NODISPOSE overcounted), dump at exit. Job: self-emit of yo-self/main.yo on the
PR #133 tree. Raw dump: issues/repros/census-v2-2026-08-17.tsv (top rows below).

**Exit-live total: 12.36 GB ≈ the 12.21 GB peak footprint — the footprint is
RETENTION, not transients.** 120M live objects: 88.8M untracked / 31.2M
tracked. Gross constructions: 1.50 BILLION (volume is absorbed by the
allocator; it is not the footprint story).

| type                                            | live      | sizeof  | live bytes        |
| ----------------------------------------------- | --------- | ------- | ----------------- |
| `ArrayList(u8)` (`__yo_t2`)                     | 42.7M     | 80      | 3.26 GB           |
| ExprInfo (TRACKED)                              | 5.64M     | **456** | 2.40 GB           |
| Variable (TRACKED)                              | 10.40M    | 192     | 1.86 GB           |
| `ArrayList(TypeValue)` (`__yo_t78`)             | 12.5M     | 80      | 0.96 GB           |
| `ArrayList` (id 4042)                           | 10.2M     | 80      | 0.78 GB           |
| `ArrayList` (id 26065)                          | 8.7M      | 80      | 0.67 GB           |
| Environment (TRACKED)                           | 5.68M     | 112     | 0.59 GB           |
| Token                                           | 3.55M     | 136     | 0.46 GB           |
| (80-byte ArrayList army, all 10 instantiations) | **92.6M** | 80      | **6.90 GB (56%)** |

The RC header is 56 of every 80-byte ArrayList — **70% of the majority class
is header**.

## The header (current 56 B)

```c
uint32_t ref_count; u8 gc_flags; u8 gc_mark; u16 borrow_count;   // 8 B packed
__yo_ref_header_t *gc_next, *gc_prev, *roots_next, *roots_prev;  // 32 B — GC intrusive lists
void (*dispose_fn)(void*); void (*traverse_fn)(void*, ...);      // 16 B — per-TYPE constants
```

The 4 GC pointers are used ONLY by tracked (cycle-capable) types — the
`__yo_decr_rc` fast path already branches on `gc_flags & __YO_GC_TRACKED` and
never touches them. `traverse_fn` is only called by the GC on tracked objects.

## The split (measured savings)

1. **Small header for untracked types (16 B: packed word + `dispose_fn`)**:
   −40 B on 88.8M objects = **−3.31 GB** (exact, from the census).
   - Codegen picks the header struct per type — trackedness is already a
     static per-type property (the 82 tracked types are the ones whose ctors
     call `__yo_gc_register`).
   - `__yo_incr_rc`/borrow checks touch only the first packed word — offset
     identical in both layouts, no change.
   - `__yo_decr_rc` must read `dispose_fn` at a layout-dependent offset: gate
     on a new `gc_flags & __YO_GC_SMALL` bit (the flags byte is in the shared
     first word). One predictable branch in the hottest function (profiled at
     54% of a self-compile) — measure, but the untracked path already branches
     on the same flags load.
2. **Tracked types: `traverse_fn` → type registry** (u32 type_id in the
   padding of… the packed word is full; place type_id where traverse_fn was
   and shrink 56→48): −8 B on 31.2M = **−0.23 GB**.
3. **`Variable.value` inline** (~−0.8-1 GB): 10.4M Variables each carry an
   `ArrayList(EvalValue)` value cell holding ≤1 element (`value_cell_of` is
   already the accessor choke point) — an inline single-slot representation
   deletes ~10M list objects.
4. **ExprInfo diet** (~−1-1.5 GB, needs a field census first): 456 B/entry ×
   5.64M; apply the proven `VariableRare` side-table pattern to the
   rarely-populated fields. Its 1:1 Environment snapshot (5.68M × 112 B +
   frames lists) is part of the same cluster — an env-snapshot intern is the
   follow-on if the diet is not enough.

Expected landing: 12.2 − 3.3 − 0.2 − 0.9 − 1.2 ≈ **6.6 GB**, under the 7 GB
free-macOS-runner ceiling — at which point the cross-emit legs COULD flip back
to native seed builds if ever desired.

## Gates (same battery as env-sharing)

fixpoint_only + gates_fast + full-corpus hollow sweep + peak-footprint A/B +
the emitted-C multiset discipline (expect universal renumbering; the header
struct change is layout-only, so the multiset check runs on the
POST-header-normalized form), plus an ASan run of the fast suite (header
layout bugs present as immediate UAF/OOB, which is the friendly failure mode).

## History that de-risks it

The header already survived one shrink (64→56 B: the packed first word — see
the comment in the emitted header). The GC's TRACKED/untracked split is
long-established and ASan/LSan-validated; this campaign extends an existing
seam rather than cutting a new one.
