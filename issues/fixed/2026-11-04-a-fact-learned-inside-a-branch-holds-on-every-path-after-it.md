# Verifier: a fact learned inside a branch holds on every path after the branch

**Severity:** S1 — `yo verify --strict` proves a false `assert` after a `cond` or `match` whose arm contains a nested arm that breaks: the nested arm's "not taken" fact stays on the path unguarded, so it also holds on the paths that never entered the outer arm.

- **Status:** fixed (filed and fixed 2026-11-04; found while fixing
  `issues/fixed/2026-11-04-the-verifier-walks-past-a-panic-so-a-diverging-path-refutes-or-is-ill-sorted.md`,
  whose `panic` paths use the same dead-arm machinery and would have hit it
  far more often than `break` does).
- **Component:** `src/verifier/vc.yo`, `_unwind_path_guards` (`cond`) and
  `_match_phi_merge` (`match`).
- **Measured with:** yo 0.2.74 and the pinned Z3 5.1.0; both functions
  below report `ok — 2 obligation(s) proved`.

## Reproducer

`tests/spec/fixtures/negative/branch_fact_leak.yo`:

```yo ignore
lc :: (fn(a : bool, b : bool) -> i32)({
  (k : i32) = i32(0);
  while(true, {
    invariant(true);
    if(a, {
      if(b, { break; });
    });
    assert(!(b), "leak");   // a == false, b == true fails here
    break;
  });
  k
});
```

`lm` is the same with `match(p, .A => { if(b, { break; }); }, .B => ())`.
When `a` is false (or `p` is `.B`) and `b` is true, the nested `break` is
never reached, so the assert fails at runtime. The verifier proved it, and a
verify-mode binary erases a proved assert.

## Root cause

Facts the walk of a branch arm pushes onto the path survive the arm: a
callee's `ensures`, and the "this arm was not taken" fact of a nested arm
that exits. A `cond` arm's walk popped its guards and kept those facts bare
(`_unwind_path_guards`), and a `match` arm never bracketed them at all. The
inner `if(b, { break; })` pushes `not b`, which is true only on the path
through the outer arm; kept bare, it held after the outer `if` on every path.
The short-circuit operators already did this right: `_pop_guard_keep_facts`
keeps each fact as `guard ==> fact`.

## Fix

- `cond`: `_unwind_path_guards` keeps each fact as `(guards of the arm) ==> fact`.
- `match`: `_MatchPhi` records the path length before the arms and after
  each one, and `_match_phi_merge` re-pushes each arm's facts as
  `taken ==> fact` (`_match_arm_taken`: the arm's test and no earlier arm's).
- `_guarded_fact` keeps an unenforced fact (a callee's `ensures`, an own
  `requires` with no entry assert) unenforced under its guard. The elision
  check matches path entries by their encoding, so a wrapped fact would
  otherwise let a guard be elided on an assumption no runtime check enforces.
  This also closes the same gap for `&&`, `||` and `==>`, whose
  `_pop_guard_keep_facts` already wrapped facts.

## Test

The fixture above: `lc` and `lm` both refute. Pinned in
`tests/internal/verifier_list_len.test.yo` ("a fact a nested branch learned
holds only where the enclosing branch ran").
