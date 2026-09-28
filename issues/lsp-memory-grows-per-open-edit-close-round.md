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

2026-09-28, develop `59ef41250` (#979), with the driver
`scripts/bootstrap/lsp_plateau.py`. **Measure a stage-2 compiler.** A
seed-built binary (`yo build` / `yo compile` with the installed v0.2.45)
runs the seed's codegen and grew ~100 MB a round on every workload. That
growth was a seed codegen leak the tree has already fixed, and allocator
(mimalloc vs system) and `-O1`/`-O2` made no difference. Releases ship stage-2
(`release.yml`, "Yo -> C, stage 2"). RSS in MB after each round:

| binary | documents | 1 | 2 | 3 | 4 | 5 | 6 | s / round |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| stage-1 (seed-built) | 4 test files | 238 | 349 | 441 | 534 | | | 2.4 |
| stage-2 | 4 test files | 196 | 215 | 215 | 231 | | | 4.3 |
| stage-1 (seed-built) | 10 std files | 175 | 236 | 302 | 361 | 421 | 480 | 4.6 |
| stage-2 | 10 std files | 136 | 157 | 178 | 202 | 213 | 232 | 7.5 |

(4 test files: `algebraic_effects`, `async_await`, `rand`,
`specialized_inout_comptime_arg`; 10 std files: the driver's defaults.)

A document the user edits (a leaf, imported by nothing cached) is now
essentially flat. What still grows is editing a std module the cached prelude
imports: ~19 MB a round. A holder census of that workload (stage-2 of
`2b50ef1a8`, 1 vs 3 rounds) ranks `g_struct_finals` first (+14.4 MB), then
`g_frame_indexes` (+9.9 MB, count-bounded at 2,048 entries, so it saturates),
then unreachable objects (+9.6 MB: `AstExpr`, `Token`, `Variable`, `Frame`).
On the leaf workload the unreachable group is +0.3 MB.

**Tried and rejected: an owner purge of the type-id registries.** Every
id-keyed table (`g_struct_finals`, `g_enum_finals`, the field, display-name,
decl-module, ctor, comptime-flag and trait registries, and the comptime-fn
result caches) was purged when any module an id depends on was invalidated.
Branch `mem/lsp-type-registry-purge` (`31ec506f4`), not merged. On stage-2
with the 10 std files it made both memory and time worse: 158 → 311 MB over
6 rounds, 13 s a round, against 136 → 232 MB at 7.5 s. On leaf files it
changed nothing. Purging the comptime-fn caches turns a cache hit
(`ArrayList(Token)` reused across rounds) into a re-instantiation after every
invalidation. Meanwhile the cached prelude env, which invalidation never
removes, keeps the old generation alive. So each round pays for a new
generation and frees nothing. A purge that works has to treat the prelude's
imports as never-invalidated, or re-analyze the prelude with them.

## Expected

After the first round every module involved is cached, so later rounds
should re-analyze in place and the footprint should plateau.
