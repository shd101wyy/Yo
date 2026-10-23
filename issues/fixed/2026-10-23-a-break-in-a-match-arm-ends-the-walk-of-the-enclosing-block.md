# Verifier: a `break` in a `match` arm ends the walk of the enclosing block

**Severity:** S1 — `yo verify --strict` proves a false loop invariant when one arm of a `match` in the loop body breaks: the statements after the `match` are never walked, so the invariant is never checked on the paths through the other arms.

- **Status:** fixed (filed and fixed 2026-10-23; found while fixing
  `issues/fixed/2026-10-23-the-verifier-walk-ignores-an-early-return.md`).
- **Component:** `src/verifier/vc.yo`, `_match_term` and the arm walkers.
- **Measured with:** a develop build at `ef153b749`; reports `ok`.

## Reproducer

`tests/spec/fixtures/negative/match_arm_break.yo`:

```yo ignore
acc_stays_zero :: (fn(n : i32, requires(n >= i32(0), n <= i32(10)), ensures(r >= i32(0))) -> (r : i32))({
  (mut(i) : i32) = i32(0);
  (mut(acc) : i32) = i32(0);
  while(i < n, {
    invariant(acc == i32(0));
    match(i, 7 => { break; }, _ => ());
    acc = (acc + i32(1));
    i = (i + i32(1));
  });
  acc
});
```

The invariant fails on the second iteration (`acc` is 1); develop reports
`ok`.

## Root cause

`break` and `continue` set `ctx.path_dead`, which tells `_begin_term` to
stop walking the rest of the block and tells the loop that the body did not
fall through. `cond` resets the flag after each arm and records the arm as
dead; `match` did not. The arms walk last-first, so when the breaking arm
was the first in source order the flag was still set after the `match`.
The enclosing loop body stopped there, the loop concluded that no path
reached the end of the body, and it skipped the iterate obligation.

## Fix

`_match_phi_capture` records each arm's `path_dead` and clears it, so every
arm walks from a live path. `_match_phi_merge` then treats a dead arm the
way `cond` does. It assumes, permanently, that the arm was not taken on the
fall-through path, which means not (its test and no earlier arm's test).
It leaves the arm out of the merged names, and `_match_arm_conditioned_ir`
leaves its value out of the match's ite. A match whose every arm exits is
a subset error, as for `cond`.

## Test

The fixture above: `acc_stays_zero` refutes, and `find7`, which needs the
break arm, verifies. Pinned in `tests/internal/verifier_list_len.test.yo`
("a break in a match arm leaves the rest of the loop body walked").
