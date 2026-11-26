# `--migrate unsized` writes `&(str, static)`, which safe code cannot spell while P12 is blocked

**Retired 2026-11-21:** `yo fix --migrate` was deleted in v0.2.80 (maintainer decision: no external users, so no migration tooling); no mode writes the `str` spelling any more, so the question is moot.

**Kind:** design question

**Status:** RETIRED 2026-11-21 (see above). Also answered by VERDICTS-74 (adopted by the coordinator): P12 lands
`static` as a CHECKED origin and deletes E0922, so any file may spell `&(str, static)` and the spelling is checked
(only values that borrow no place flow into it). Filed 2026-11-16 by the d49-str lane; the branch implemented
option 3 so that it was mergeable as it stood.

## What

VERDICTS-62 decision 4 says `yo fix --migrate unsized` writes a value `str` type as `&(str, static)`, which preserves
its meaning. The flip's branch implements that (the `str` family, kinds 10–12 in `src/main.yo`). But a `static` spelled
outside std and pragma'd files is E0922 until P12's rule lands (VERDICTS-57 §1, `_reject_empty_origin_in_safe_code`
in `src/evaluator/types/function.yo`). The coordinator's handover of 2026-11-14 says P12 is blocked, so v0.2.78 keeps
the v0.2.77 wall. VERDICTS-61 decision 5 lists the checked `static` origin as a prerequisite of the flip.

So the migration's output did not evaluate. Measured on the branch's tree binary before option 3: the second run of
`tests/cli-cases/fix-migrate-unsized-str` reported "does not evaluate", and `check` failed with E0922 at the first
`&(str, static)`.

This is a hazard as well as a red case. In v0.2.79 users run `--migrate unsized` for the `Dyn` family, because S3b-`Dyn`
deletes the `dyn(v)` alias. The same run would rewrite every `str` type in their code into E0922.

## Options

1. **Exempt the exact `&(str, static)` from E0922** (a shared reference to `str` with the `static` origin). The alias
   already gives every literal and every value `str` that type, unchecked until P12. The explicit spelling is the same
   type, so it adds no unchecked surface the alias does not already have. The wall stays for every other pointee: the
   audit hole is `&(Rc(X), static)`. Cost: about ten lines in the three origin readers, and one row in the wall's tests.
2. **Hold the `str` family's rewrite until P12** (record nothing, or list each site as "left as written"). The alias
   keeps the old spelling valid through v0.2.79 and v0.2.80, and the migration is needed only when S3b-`str` deletes
   the alias. Cost: the family lands without its rewrite, and the rewrite is turned on in the P12 PR.
3. **Rewrite only where the file may spell `static`** (std and an unsafe-capable file, the exemption of E0922's wall;
   `_static_spellable_at` in `src/evaluator/utils.yo`). In safe code the written `str` stays, and the alias keeps its
   meaning. The P12 PR drops the condition together with the wall. This is what the branch does. The cli case's
   `main.yo` (pragma'd) is rewritten and its `safe.yo` is not, and both check.
4. **Write `&str` instead.** This is rejected. It changes the meaning: an elided origin at a field needs an origin
   parameter, and a `-> &str` result is a projection.

## Recommendation

Option 3 for v0.2.79, with option 1 as the fallback if the coordinator wants the rewrite live in safe code in the same
release. The migration should never write code that the release running it rejects. Option 3 also changes nothing in
the wall that VERDICTS-57 §1 put up after an audit, and the alias makes the rewrite unnecessary in safe code until
S3b-`str`.

## Resolution (2026-11-21, VERDICTS-74)

VERDICTS-74 ("Option 2: `static` becomes a checked origin (P12) before the value-`str` alias is deleted") adopted the
position this question's option 1 gestured at, one step further: instead of exempting the exact `&(str, static)`
spelling from the wall, P12 deletes the wall (E0922) and CHECKS the spelling everywhere — the static bit enters type
identity (rule 1), the subset check runs at every expected-type site (rule 2), rule 3 lists the introduction forms,
joins widen (rule 4), and every file is checked (rule 5). The migration's `&(str, static)` output therefore evaluates
in any file, and a site where a non-static value reaches a `&(str, static)` slot is E0923 — the hazard this question
feared is a compile error. (`yo fix --migrate` itself is being deleted by the drop-fix-migrate lane; the question's
subject is resolved wholesale, so the doc retires.)
