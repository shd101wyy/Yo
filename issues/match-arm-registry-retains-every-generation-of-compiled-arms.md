# `g_match_arms` retains every generation of compiled match arms (≈35 K Pattern IR graphs at `check` exit)

Found 2026-09-27 by the first completed Linux holder census
(`plans/EVALUATOR_MEMORY_REDUCTION.md` §0.18; develop @ 3f7bbb79b).
**FIXED same day** — see the correction below; the first read of the census
rows was wrong about the mechanism.

## Correction (2026-09-27, before any fix landed)

The initial interpretation — "one systematic missing release per Pattern
(the `+1` R-row)" — was WRONG. The census's own `L` row settles it:

```
L 18102 g_match_arms_m18240126896049193810
```

`g_match_arms` held **18,102 match→arms entries at exit** (≈2 arms each ≈
the 35,119 Patterns). The Patterns are RETAINED BY THE REGISTRY (their `+1`
is the registry's own ownership reference), not missing releases: the
process-lifetime map keeps every compiled match's arms with nothing left to
read them — retention, the §3.2/Phase-1-step-5 family, not the dup/drop
family.

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
(`issues/fixed/local-binding-of-an-indexed-read-never-releases-its-element.md`,
the drop-liburing agent's param-interior fix).

## Likely shape

A match arm's pattern is built (pattern IR, `src/pattern.yo` / the arm's
codegen in `src/codegen/exprs/match.yo`) and stored on the arm; the arm's
own dispose releases the arm's other fields but not the pattern binding —
or the pattern is dup'd once for the binder and the drop is elided by the
same deferred-drop gates that lost the two known bugs.

## Fix (landed on `mem/census`, PR #957)

`register_match_arms` now takes the owning module's path and records a side
index (`g_match_arm_owners : HashMap(String, ArrayList(usize))`);
`purge_match_arms_owned_by(owner)` retires a module's entries;
`mm_invalidate_document` calls it in the Phase B2 purge loop, so a
watch/LSP edit's re-evaluation registers a fresh generation instead of
accumulating. One-shot commands still hold their generation until exit
(process-lifetime cache, same as the memo tables).

Implementation note (a real footgun hit here): seeding the side index with
`g_match_arm_owners.insert(owner, fresh.clone())` stored a DETACHED snapshot
— `ArrayList.clone()` is a deep copy, so the `ids.push` never reached the
stored list and the first purge was a no-op (caught by the standalone probe:
`after purge: true`). Insert the handle itself and re-`get` it.

Test: `tests/internal/module_invalidation.test.yo` "match-arm registry:
purging a module drops its compiled arms" — red before (the purge did not
exist), 10/10 green after.
