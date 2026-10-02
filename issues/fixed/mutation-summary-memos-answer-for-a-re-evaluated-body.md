# The D1 / StrictBorrow / RC-mutation memos answer for a body `--watch` or the LSP re-evaluated, with the old body's verdict

**Severity:** S2 — in `check --watch` and `yo lsp`, a caller re-judged after its callee's body was re-evaluated reads the verdict computed for the callee's PREVIOUS body. An edit that makes the callee reach a non-Send global (or mutate its argument) therefore passes the round, while a cold `check` rejects it

**Status:** FIXED 2026-10-01 on `fix/check-foreign-bodies`. Found while making `check` summarize
each module's function bodies (`issues/fixed/check-cannot-see-function-bodies-from-other-modules.md`),
which memoizes every function and so made the stale answer the normal case. Regression test:
`tests/internal/check_watch.test.yo` "Phase 3b: rule D1 re-judges a re-forced body — the reach memo
answers only for the body it walked"; `tests/internal/module_invalidation.test.yo`'s B2 memo plateau
now counts these memos.

## Scope

This fix covers the re-evaluated-body half of "a round accepts what a cold `check` rejects": the
memo answers for a body other than the one it walked. It does not cover a caller that the round never
re-judges at all, such as a same-module caller with no recorded def edge to the edited definition.
That case is `issues/fixed/watch-per-def-round-skips-same-module-callers.md`, fixed separately on
the same branch.

## Root cause

The three memos in `src/evaluator/effects/mutation_summary.yo` — `g_ms_summary_by_fid` (may mutate
RC storage), `g_msp_by_fid` (per-parameter mutation mask), `g_gr_by_fid` (D1 reach) — are keyed by
func id alone, never invalidated, and documented as safe because "`random_id` … ids are unique for
the life of the process". Definition ids are not random: they are `stable_func_id(module, row,
column)`, so a definition the Phase 3b per-definition round re-forces (a fresh-id body) or a module
`mm_invalidate_document` drops and reloads keeps its id. The re-judged caller then reads the old
body's verdict: `work` edited to push to a non-Send global, its thread-closure caller re-forced, the
walk hits `work`'s memo "clean".

## Fix

Every memo stores the id of the body it was computed from and answers only for that body; any
other body is a miss and is walked afresh. `mm_invalidate_document` purges the memos of a dropped
module's func ids with its other per-function tables (`purge_mutation_summaries`), and a per-def
round re-summarizes the definitions it re-forces against the module's retained context, as the
module's load did.

## Red before

The watch test fails on the compiler built from develop `5567a7796` already at its first step (the
cross-module reach was "never evaluated" there); the stale-memo step is pinned by the second
round, whose expected failure needs the body-matched memo, and the third, whose expected pass needs
the re-summary.
