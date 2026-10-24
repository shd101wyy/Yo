# Verifier: a write in one `match` arm holds on every path

**Severity:** S1 — `yo verify --strict` proves a false `ensures` when one arm of a `match` assigns a variable or changes a list: the write is kept on the paths through the other arms.

- **Status:** fixed (filed and fixed 2026-10-23, found while extending the
  havoc scan for
  `issues/fixed/2026-10-23-a-loop-or-branch-misses-a-list-a-free-function-call-changes.md`).
- **Component:** `src/verifier/vc.yo`, `_match_term` and the arm walkers.

## Reproducer

`tests/spec/fixtures/negative/match_arm_write_merge.yo`:

```yo ignore
match_assign :: (fn(p : Pick, ensures(r == i32(1))) -> (r : i32))({
  (mut(y) : i32) = i32(0);
  match(
    p,
    .A => {
      y = i32(1);
    },
    .B => ()
  );
  y
});
```

Before the fix `match_assign` and its list twin `match_grow` (`.A => {
grow1(ys); }`, `ensures(r == usize(1))` over `ys.len()`) both reported
`ok`; each returns the pre-match value when `p` is `.B`.

## Root cause

`_match_arms_ir` builds the ite tree of the arms' VALUES, walking the last
arm first and each earlier arm after it, all against the same `ctx.vars`.
An arm that rebinds a name (an assignment, a mutating call) left the new
term in place for the arms walked after it and for everything after the
`match`. `cond` merges such names with an ite over its conditions
(`_cond_ite`'s phi set); `match` had no merge.

## Fix

`_MatchPhi`: before the arms, `_scan_assigned_in` collects the names any
arm's guard or body may change and their pre-match terms. Each arm walks
from those terms, its test and the names' post terms are recorded, and
after the last arm each name is the ite over the arm tests of its per-arm
terms (first matching arm wins). A name bound only inside an arm goes out
of scope.

## Test

`tests/spec/fixtures/negative/match_arm_write_merge.yo`: both functions
refute; pinned in `tests/internal/verifier_list_len.test.yo`.
