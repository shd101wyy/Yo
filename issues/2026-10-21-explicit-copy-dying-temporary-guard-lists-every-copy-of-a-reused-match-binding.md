# The explicit-copy dying-temporary guard lists every copy of a reused `match` binding

**Severity:** S3. No wrong code: `yo fix --migrate explicit-copy` leaves genuine copies as written and lists them with the text "the copy is usually a move", so the user has to spell `.clone()` by hand where the tool could have inserted it.

**Status:** OPEN. Filed 2026-10-21 by the adversarial review of
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
