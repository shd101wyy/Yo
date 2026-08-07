# `_patch_self_shell` walks shared type graphs as trees — exponential re-visits / allocation runaway

**Status:** OPEN (2026-07-02). Under active bisect — the emit-C self-compile of
`yo-self/main.yo` explodes at ~500 MB/s and never completes on recent HEADs;
the sampled stack at explosion is dominated by this walk.

## Symptom

`/tmp/yo-self-bin compile yo-self/main.yo --emit-c --skip-c-compiler` (any
recent -O0/-O2 build): footprint stable ~5.4 GB for the first ~90-150 s, then
grows ~500 MB/s to 18/36/70 GB, never completes. `sample` at explosion onset:

- `fn_..._patch_self_shell` — ~10,900 stack occurrences (deep self-recursion),
  the top leaf (~1,000 leaf samples),
- under `evaluate_struct_type` ← `evaluate_initialization_assignment` ←
  `demand_load_module` (i.e., def-evaluating a module-level struct type),
- allocation storm through `ArrayList(TypeValue).push` +
  `__yo_incr_rc`/`__yo_gc_register`,
- `intern_type` / `type_intern_key` frames also present.

**NOT a GC failure:** running with `YO_GC_FULL_PCT=100` (full-heap collection
at maximum frequency) does not bound the growth — the allocated objects are
reachable, i.e. this is live allocation by a runaway walk, not uncollected
garbage.

## Root cause (analysis)

`_patch_self_shell` (`yo-self/types/creators.yo`) rewrites a type tree,
replacing an empty self-shell (matched by `shell_id` + emptiness) with the
finalized type. It recurses structurally (`recur`) with **no memoization, no
visited set, and no depth cap**, rebuilding every compound node (fresh
`ArrayList`s per node).

That is fine on a **tree**. But yo-self type values increasingly form shared
**DAGs**:

- `TypeValue` is `ref(enum)` — children are shared handles;
- `TypeValue.clone` RC-shares all nested collections (and briefly shared whole
  nodes);
- hash-consing (`intern_type` at `substitute`, commit `7f547078d`) canonicalizes
  structurally-equal types to ONE shared node across the whole program.

Walking a shared DAG as a tree re-visits every shared subnode **once per
path**. With heavy sharing the path count grows combinatorially, and since
each visit allocates a rebuilt copy, the walk turns into an allocation
explosion that looks like an infinite loop (it is astronomically finite).

## Why a memo is not trivial

- Yo has no direct pointer identity to key a memo on.
- Keying by `Struct.id`/`EnumT.id` is UNSOUND: generic instantiations share the
  definition id while differing in field types (the same wrong-merge class as
  the hash-consing key lesson — see `plans/backlog/TYPEVALUE_HASH_CONSING.md` §4.8).
- A sound memo key exists — `type_intern_key` (injective, cycle-guarded) — but
  computing it per visited node is itself a full walk per node; total cost
  O(nodes × key size). Linear, but with large constants.

Cheap sound prune candidates (to evaluate):

1. **Skip nodes that predate the shell**: the shell id is minted during the
   CURRENT definition's evaluation; interned/shared nodes created earlier can
   never contain it. Needs a cheap "creation era" mark on TypeValue (e.g. a
   monotonically increasing construction counter captured at shell mint time —
   walk only into nodes with `era >= shell_era`).
2. **Memo keyed by `type_intern_key`** (correct today, heavier).
3. TS needs no walk at all — it mutates the definition object in place. A
   faithful-er mirror would be to route shell resolution entirely through the
   existing `resolve_enum_shell`/`resolve_struct_shell` registries at use
   sites and drop the eager patch walk (the registries already exist:
   `g_enum_finals` / `g_struct_finals`).

## Bisect state (2026-07-02)

Exonerated as SOLE causes (reverting each from HEAD still explodes):
`f8eaaa9c7` clone-returns-self, the `intern_type` wire at `substitute`
(unwired → still explodes), the frame name-index shape (Frame-field vs
side-table both explode; the index only accelerates reaching the trigger
phase). Anchor `796437d67` (P1-COMPLETE era) shows flat 5.9 GB / 100% CPU with
no explosion — bisecting forward from there.

## Repro

```bash
./yo-cli compile yo-self/main.yo -o /tmp/yo-self-bin
/tmp/yo-self-bin compile yo-self/main.yo --emit-c --skip-c-compiler -o /tmp/x &
# watch: footprint -p <pid> — explodes past 12 GB within ~3 min on bad builds
```
