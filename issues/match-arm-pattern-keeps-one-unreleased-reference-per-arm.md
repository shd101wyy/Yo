# Every `Pattern` keeps exactly one unreleased reference — 35,119 leak roots at `check src/main.yo` exit

Found 2026-09-27 by the first completed Linux holder census
(`plans/EVALUATOR_MEMORY_REDUCTION.md` §0.18; develop @ 3f7bbb79b). **Open.**

## Evidence

The attribution census's R rows (leak roots: refcount above what the
unreached set itself explains):

```
R 35119 35119 Pattern          ← +1 unexplained ref on EVERY one
```

The count is exact and stable across the pre-Phase-3 census (the handover's
§3.1 saw the same row: "Pattern (35 K, one external ref each, held by Arm)")
and the 2026-09-27 tree — every `Pattern` allocated for a match arm retains
exactly one reference nobody releases. 35,119 × (a Pattern + its fields) is
a modest byte count, but it is ONE systematic codegen site, the same family
as the two open missing-drop bugs
(`issues/local-binding-of-an-indexed-read-never-releases-its-element.md`,
the drop-liburing agent's param-interior fix).

## Likely shape

A match arm's pattern is built (pattern IR, `src/pattern.yo` / the arm's
codegen in `src/codegen/exprs/match.yo`) and stored on the arm; the arm's
own dispose releases the arm's other fields but not the pattern binding —
or the pattern is dup'd once for the binder and the drop is elided by the
same deferred-drop gates that lost the two known bugs.

## Fix protocol

Same as the open missing-drop bugs: failing test first (a match over an
RC-payload enum with a Dispose counter / `rc(...)` assertion), fix in the
drop path, gate with the dup/drop emit-diff plus an over-cancellation
canary. Coordinate with the drop-liburing agent's in-flight
`fv-leak-fix` — it edits `_schedule_scope_end_drops`, the same function
this fix may need; land after theirs rebases.
