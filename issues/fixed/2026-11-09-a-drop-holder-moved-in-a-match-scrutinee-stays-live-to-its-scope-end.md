# A `Drop` holder moved in a `match` scrutinee stays live to its scope's end

**Severity:** S3. A valid program is rejected: `match(e.take(), …)` consumes the `Drop` holder `e`, and the place it borrowed still cannot be used after the `match` (E0911). It is the same rule as `issues/fixed/2026-11-09-a-drop-holder-moved-into-a-call-stays-live-to-its-scope-end.md`, in the shape the entry API uses (`match(entry.take(), …)`).

Filed 2026-11-09 by the drop-holder lane while testing `issues/fixed/2026-11-08-a-drop-holder-yields-a-place-through-its-reference-field.md`'s reproducer after #1852: `lb_holder_moved`'s straight-path test rejected every `match`/`cond`, so a move in the scrutinee (or a `cond`'s first condition), which runs on every path, did not end the holder's liveness.

## Fixed

`_lb_straight_path` (`src/evaluator/utils.yo`) descends into a `match` scrutinee and a `cond`'s first condition; the arms, the later conditions, loops, `&&`/`||` operands and closure bodies stay conditional. Test: `tests/origins/reference_read_rule.test.yo` ("a user-Drop holder moved in a match scrutinee frees its root after the match").
