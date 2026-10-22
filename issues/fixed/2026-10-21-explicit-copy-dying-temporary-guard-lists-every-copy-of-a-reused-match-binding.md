# The explicit-copy dying-temporary guard lists every copy of a reused `match` binding

**Severity:** S3. No wrong code: `yo fix --migrate explicit-copy` leaves genuine copies as written and lists them with the text "the copy is usually a move", so the user has to spell `.clone()` by hand where the tool could have inserted it.

**Status:** FIXED 2026-10-22 on `fix/explicit-copy-migration-defects`. Filed 2026-10-21 by the adversarial review of
`feat/explicit-copy-guards`, which adds the dying-temporary guard
(`issues/fixed/2026-10-20-explicit-copy-migration-clones-a-copy-out-of-a-dying-temporary.md`).

## Reproducer

```yo
{ String } :: import("std/string");
{ ArrayList } :: import("std/collections/array_list");
{ println } :: import("std/fmt");
make_opt :: (fn() -> Option(String))(.Some(String.from("t")));
main :: (fn() -> unit)({
  hs := ArrayList(String).new();
  b := match(
    make_opt(),
    .Some(z) => {
      hs.push(z);
      hs.push(z);
      z
    },
    .None => String.new()
  );
  println(`${b} ${hs.len().to_string()}`);
});
export(main);
```

`yo fix reuse.yo --migrate explicit-copy --dry-run` with the branch's tree
binary lists all three sites:

```text
fix: reuse.yo:10:15: `z` is a `match` binding of a temporary that dies after the copy, so the copy is usually a move; left as written (spell `.clone()` by hand if the value is read again)
fix: reuse.yo:11:15: `z` is a `match` binding of a temporary that dies after the copy, so the copy is usually a move; left as written (spell `.clone()` by hand if the value is read again)
fix: reuse.yo:12:7: `z` is a `match` binding of a temporary that dies after the copy, so the copy is usually a move; left as written (spell `.clone()` by hand if the value is read again)
fix: would insert 0 `.clone()` call(s); 3 site(s) left as written (listed above); 0 file(s) did not evaluate
```

The v0.2.67 seed, which has no guard, clones all three. The right result is
two insertions (10:15 and 11:15, made while `z` is read again) and no edit
at 12:7, the last use.

## Root cause

`_ic_dying_temp_source` (`src/evaluator/utils.yo`) judges a `match` binding
by its root alone (the copy-trait audit's `temp` kind), with no liveness: it
cannot tell a copy made while the binding is still read later in the arm
from its last use. The explicit-copy audit reports a `temp-payload` source at
once, not as a pending site, so the frame-end judge
(`_audit_judge_implicit_copies`, `src/evaluator/exprs/begin.yo`) never sees
it.

## Recommendation

Record a temp-rooted binding's copies as pending sites keyed by the binding,
and judge them where the binding's frame ends, as a `match-local` source is
judged: a copy with a later read is cloned, the last use is a move. The
judge today runs at the end of a begin block, which an expression-bodied arm
(`.Some(z) => z`) does not have, so the arm's own frame needs a judging
point. Add the reproducer to
`tests/cli-cases/fix-migrate-explicit-copy-dying-temp` with the fix.

## Fix

As the recommendation says, in three places:

- `audit_record_implicit_copy` (`src/evaluator/utils.yo`) prints a
  `temp-payload` copy's audit line at once (the copy is real today, so
  `YO_AUDIT_IMPLICIT_COPY` is unchanged), but holds its migration site
  pending under the binding's own id (`_audit_hold_implicit_copy`).
- `evaluate_match` (`src/evaluator/exprs/match.yo`) judges the arm frame's
  pending copies against the arm's body before it pops the frame
  (`_judge_arm_copies` → `audit_judge_arm_copies`, the begin block's
  `_audit_judge_implicit_copies` exported). That is the judging point an
  expression-bodied arm lacked. A copy with a later read of the binding is
  recorded and cloned; the last use is a move and is neither rewritten nor
  listed.
- A copy made in the arm's guard is not judged by last use: when the guard
  fails, the later arms bind the same payload again, so the guard's copy is
  never the value's last use. Right after the guard evaluates,
  `_commit_guard_copies` reports every copy the arm's bindings hold pending
  (`audit_commit_arm_copies`), and each is cloned. `keep(g)` in
  `(.Some(g) && keep(g)) => …` becomes `keep(g.clone())`.
- `_ic_dying_temp_source` no longer judges a `match` binding by its root:
  it keeps only the field and element walk.

The dry run of the reproducer now prints two insertions (10:15 and 11:15)
and nothing for 12:7.

## Test

`tests/cli-cases/fix-migrate-explicit-copy-reused-binding`, whose fixture is
the reproducer plus a guard form (`(.Some(g) && keep(g))` followed by an arm
binding the same payload): its goldens expect the two `.clone()` insertions
in the body, one in the guard, and no listing. `tests/cli-cases/fix-migrate-explicit-copy-dying-temp` was
re-recorded: its three single-use bindings (`z`, `v`, `w`, each used once at
the arm's tail) were listed as "usually a move" and are now silent moves (the
summary goes from 5 sites left to 2; the rewritten tree is unchanged).
