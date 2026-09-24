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

## Expected

After the first round every module involved is cached, so later rounds
should re-analyze in place and the footprint should plateau.
