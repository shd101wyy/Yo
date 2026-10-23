# Verifier: after a `cond`, an arm that exits the loop is assumed to have a false guard

**Severity:** S1 — `yo verify --strict` proves a false `assert` after a `cond` whose breaking arm overlaps an earlier arm: the walk assumes the breaking arm's bare guard is false after the `cond`, although an earlier arm with an overlapping guard runs instead and falls through.

- **Status:** fixed (filed and fixed 2026-10-23; found while porting
  `cond`'s dead-arm rule to `match`,
  `issues/fixed/2026-10-23-a-break-in-a-match-arm-ends-the-walk-of-the-enclosing-block.md`).
- **Component:** `src/verifier/vc.yo`, `_cond_ite`.
- **Measured with:** a develop build at `ef153b749`; reports `ok`.

## Reproducer

`tests/spec/fixtures/negative/cond_dead_arm_overlap.yo`:

```yo ignore
while(i < n, {
  invariant(i >= i32(0), i <= n);
  cond(
    (i > i32(5)) => (),
    (i == i32(7)) => { break; },
    true => ()
  );
  assert(i != i32(7));
  i = (i + i32(1));
});
```

When `i` is 7 the first arm runs and the `assert` fails. Develop reports
`ok`, and the verify-mode binary erases the assert.

## Root cause

An arm whose walk exits the loop pushes the negation of its guard onto the
path for everything after the `cond`. The guard it negated was the arm's
bare condition, but `cond` runs the FIRST arm whose condition holds, so the
arm runs only when its condition holds and no earlier one does. Negating
the bare condition dropped the states where an earlier arm also matches.

## Fix

The pushed fact is `not (c_k and not c_1 and ... and not c_{k-1})`, the
negation of "arm k is taken" (`_arm_taken_term`, shared with `match`'s
dead-arm rule).

## Test

The fixture above: `overlap` refutes, and `exclusive`, whose breaking arm
has no earlier arm that overlaps it, verifies. Pinned in
`tests/internal/verifier_list_len.test.yo` ("after a cond, a dead arm is
assumed not TAKEN, not its guard false").
