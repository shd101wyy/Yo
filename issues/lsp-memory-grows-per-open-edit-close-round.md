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

Still open: ~0.18 GB per round remains. One known contributor is
`g_funcval_cap_vars`, which gained ~83 K handle lists over four rounds under
fresh `env_key`s that no invalidation purges.

## Expected

After the first round every module involved is cached, so later rounds
should re-analyze in place and the footprint should plateau.
