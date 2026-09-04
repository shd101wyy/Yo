# A verified-FIXED issue doc still sits in `issues/` root, and five references point at the `issues/fixed/` path it does not have

**Found**: 2026-09-04, by the std-API audit re-measurement, when the C36 row's
cross-reference in `plans/STD_API_AUDIT.md` turned out to be a dead path.
**Class**: papercut — bookkeeping, but it corrupts the open-issue tally and
breaks five links, two of them from compiler source comments. **Status**: OPEN.

## What is wrong

`issues/README.md` defines the directory layout unambiguously:

| Location | Meaning |
| --- | --- |
| `./*.md` | **Open** issues — file new issues here |
| `fixed/` | **Verified fixed** — the fix landed with a regression test; move the doc here in the fixing commit |

`issues/async-cond-dispatch-skips-chained-sibling-arm.md` is in the root, i.e.
counted as open, while its own header (`:5-6`) says:

```
**Status**: FIXED in the C33 change — `src/codegen/async/state_machine.yo`.
Verified RED first with the repro below (rc=139), GREEN after.
```

The doc goes on to record the landed fix (`_dispatch_branches`,
`_chain_additional_remaining` carrying the depth's own binding, the `=`
re-assignment cases) and its gate (`issues/repros/async-cond-dispatch-skips-chained-sibling-arm.yo`
plus the new loopback tests in `tests/http/http.test.yo`). It was introduced
in the root by `5ecee4350` (the C33/C36 PR #333) and never moved.

## The dead references

Five places already spell the path as if the move had happened
(`grep -rn 'issues/fixed/async-cond-dispatch-skips-chained-sibling-arm'`):

- `plans/STD_API_AUDIT.md:104` — the C36 row
- `plans/HANDOVER_2026_08_28.md:30` — the C36 handover row
- `issues/fixed/second-cond-internal-await-result-not-stored.md:4`
- `src/codegen/async/state_code_gen.yo:2271` — a comment explaining why a
  result is dropped
- `src/codegen/async/state_machine.yo:1441` — a comment explaining why an
  await would otherwise be silently skipped

and two spell the current (root) path, in the *same file* as one of the
above:

- `src/codegen/async/state_machine.yo:1600`
- `src/codegen/async/state_machine.yo:2552`

So a maintainer who follows the citation from either compiler-source comment
lands on nothing, and the tree contradicts itself about where the doc lives.

## Consequences

- The open-issue count is wrong. `ls issues/*.md | wc -l` reports 89 (88 issue
  docs plus `README.md`); one of those 88 is a closed bug.
- `plans/STD_API_AUDIT.md`'s own C36 row — the record the S5 coverage read is
  driven from — points at a file that does not exist, so the audit cannot be
  followed to its evidence.
- Two compiler source comments cite a nonexistent path, which is the worst of
  the five: they are the ones read while changing the very code the doc
  explains.

## Fix

1. `git mv issues/async-cond-dispatch-skips-chained-sibling-arm.md issues/fixed/`
   — the doc satisfies the `fixed/` criterion (fix landed, verified RED then
   GREEN, regression gate named).
2. Update the two root-path references to `issues/fixed/…`:
   `src/codegen/async/state_machine.yo:1600` and `:2552`. The other five are
   already correct once the file moves.
3. Re-grep to confirm nothing is left:
   `grep -rn 'async-cond-dispatch-skips-chained-sibling-arm'` should show only
   `issues/fixed/…` paths (plus the repro filename in `issues/repros/`, which
   does not move).

This is the `git mv`-in-the-fixing-commit step of `issues/README.md` that PR
#333 skipped; nothing about the bug itself needs re-verification.

## Regression test

None — this is a documentation-layout defect with no runtime behaviour. The
standing guard is `issues/README.md`'s convention plus the "update references
when moving" rule in `AGENTS.md`. If a mechanical guard is wanted, the cheap
one is a CI grep asserting that no `issues/*.md` at the root contains
`**Status**: FIXED`, and that every `issues/fixed/<name>.md` path cited
anywhere in the tree resolves — that would have caught this the day it
landed, and it is the same shape of check as the existing fmt gate.
