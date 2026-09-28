# `yo lsp` memory grows with every open/edit/close round of the same documents

> Found 2026-09-24 by the plateau gate of `plans/EVALUATOR_MEMORY_REDUCTION.md`
> Phase 1 step 3. Open — root cause under investigation.

## Reproduction

A JSON-RPC driver (`initialize`, then per document `didOpen` → wait for
`publishDiagnostics` → `didChange` (append a comment line) → wait → `didClose`
→ wait) over the same 10 files under `std/`, run with `/usr/bin/time -l`:

| session | peak footprint |
| --- | --- |
| 10 documents × 1 round | 0.63 GB |
| 10 documents × 5 rounds | 1.89 GB (develop: 1.92 GB) |

A long-lived editor session that keeps editing the same files therefore grows
without bound. Present on develop before the open-document retention change
and after it (the retention change releases walk contexts; this is a
different holder).

## Progress

2026-09-25: most of the growth was the HashMap rehash leak
(`issues/fixed/cond-unit-arm-statement-is-dropped.md`, `plans/EVALUATOR_MEMORY_REDUCTION.md` §0.8):

| session (stage-2 compilers) | before | after |
| --- | --- | --- |
| 10 documents × 1 round | 0.61 GB | 0.40 GB |
| 10 documents × 5 rounds | 1.83 GB | 1.14 GB |

2026-09-25, second step: the FuncVal capture-handle registry
(`g_funcval_cap_vars`) is purged per owner on invalidation (Phase 1 step 5):

| session (stage-2 compilers) | before | after |
| --- | --- | --- |
| 10 documents × 1 round | 0.44 GB | 0.42 GB |
| 10 documents × 5 rounds | 1.19 GB | 0.98 GB |

Third and fourth steps (plans §5 Phase 1 step 5, batches 1–2): the
per-function side tables (#883) and the ExprId-keyed side tables:

| session (stage-2 compilers) | before | after |
| --- | --- | --- |
| 10 documents × 5 rounds, batch 1 | 0.98 GB | 0.97 GB |
| 10 documents × 5 rounds, batch 2 | 0.96 GB | 0.90 GB |
| 10 documents × 5 rounds, batch 3 (memo, trait defaults, type intern) | 0.90 GB | 0.79 GB |

Still open: 56 registries grew per round before these batches; the
`HOLDER_DEEP` census ranks what remains (`g_ifc_memo`, the type-id
registries, `g_frame_indexes`, unreachable objects).

2026-09-28: re-measured on develop `2b50ef1a8` with the new driver
`scripts/bootstrap/lsp_plateau.py` (10 std documents, open → edit → close
each, per round):

| round | 1 | 2 | 3 | 4 | 5 | 6 |
| --- | --- | --- | --- | --- | --- | --- |
| RSS, MB (shipped mimalloc stage-1) | 179 | 242 | 309 | 368 | 427 | 486 |

That is about 60 MB a round, linear, with no plateau.

A holder census of the LSP (system allocator, about 25 MB a round) after 1
and after 3 rounds, diffed by root:

| root | growth over 2 rounds | what |
| --- | --- | --- |
| `g_struct_finals` | +14.4 MB, 194 K objects | type-id keyed |
| `g_frame_indexes` | +9.9 MB | a bounded cache (cleared at 2,048 entries), so it saturates |
| LEAK (unreachable) | +9.6 MB | re-parsed ASTs: `AstExpr` +43 K, `Token` +27 K, `Variable`, `Frame` |
| `g_enum_finals`, `g_type_display_names`, `g_struct_field_registry`, `g_type_decl_modules`, `g_struct_ctor_fids`, `g_recursive_type_refs`, `g_stable_type_id_owner`, `g_type_trait_registry`, `g_type_ctor_values` | +0.2 to 1.4 MB each | type-id keyed |

**The type-id keyed registries grow by design.** `stable_type_id` never
re-counts `k` (the `_n<k>` occurrence suffix; see its doc in `src/utils.yo`,
and `issues/fixed/warm-test-batches-doc-stability-genericimplentry.md`), so
every re-analysis of a module mints a new generation of ids. Nothing purges
the previous generation's entries, so a plateau needs an owner purge
(`OwnedKeys`, the §0.15 pattern) for each of these tables.

The open design point is cross-module reuse. An instantiation of a std
generic (`List(i32)`) first minted while module A was evaluated is owned by
A, but a cached, non-dependent module B can hold the same interned
instance. Purging A's entries would then break B's id-keyed lookups:
`resolve_struct_shell` for recursive types, field and trait lookups. The
purge must key ownership on what the id depends on, not on the module
current at insert.

**The LEAK group survives a full collection** (`HOLDER_COLLECT=1`). It is
unreachable and not freed, and almost every object in it is pointed at by
another: only 460 of the 29 K leaked `Token`s are zero-hit. The raw ≤64 B
holders in the `KH` rows are container element buffers, so they do not
identify a root either. The shape is a cycle the collector cannot see: an
edge through an RC type classified cycle-incapable (untracked, 16 B
header, no traverse function). The candidate loop is Environment → its
frames list → Frame → Variable → a FuncVal value → Environment.

`--rc-balance` on `AstExpr` (2 documents, 1 vs 4 rounds: 107,625 → 120,837
live) confirms the growth, but the per-function balance is dominated by
balanced high-volume sites (`ArrayList.get`, `merge_and_check_envs`) and
does not isolate it. A balance run needs `#define __HS_NB 256` in the
instrumented C: the default 8,192-slot per-object table reached 29 GB.
Next step: find the untracked type on the loop (the census `T` rows plus
the type's `needs_cycle_gc` classification).

## Expected

After the first round every module involved is cached, so later rounds
should re-analyze in place and the footprint should plateau.
