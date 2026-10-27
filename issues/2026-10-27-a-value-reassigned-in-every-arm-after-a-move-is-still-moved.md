# A value reassigned in every arm after a move is still moved where the arms meet

**Severity:** S2 — a valid program is rejected (E0901 "use of moved value"): a move-only or explicit-copy value that is moved and then reassigned on every path of an `if`/else (or every continuing arm of a `cond`/`match`) is still treated as moved after the branch. Straight-line reassignment works; the branch join forgot the arms' reinitialization. Rust accepts the same program. Decision 17 (V2c, `plans/VALUES_BY_DEFAULT.md`) makes every `Rc`/`Arc` value explicit-copy, so the rc-clone sweep of `src/` hit it at `src/evaluator/types/field.yo` (a consuming `match(field_type, …)` followed by `field_type = …` in both arms of an `if`).

**Status:** FIXED 2026-10-27 (V2c branch). Test: `tests/move_only.test.yo`, "move-only: a value reassigned in every arm after a move is initialized where the arms meet" — fails before the fix (E0901 at `x.n`), passes after.

## Reproducer (before the fix)

```yo
Fd :: struct(n : i32);
f :: (fn(c : bool) -> i32)({
  mut(x) := Fd(n : i32(1));
  y := x;
  if(c, {
    x = Fd(n : i32(2));
  }, {
    x = Fd(n : i32(3));
  });
  x.n + y.n
});
main :: (fn() -> unit)({ f(true); });
export(main);
```

```text
error[E0901]: use of moved value: `x`
  --> f.yo:10:3
   |
10 |   x.n + y.n
   |   ^
```

Measured with the v0.2.70 seed and with develop 476cfb700. `x = Fd(...)` with no branch around it (`y := x; x = Fd(n : i32(2)); x.n`) is accepted.

## Root cause

`merge_and_check_envs` (`src/evaluator/utils.yo`) joins a branch from the flow log: it resets the variable to its pre-branch state (`flow_pre_consumed`, here the move `y := x`) and then propagates a move only when every arm moved. Nothing propagated the opposite case: every continuing arm ending UNconsumed (each reassigned the value), so the pre-branch move survived the join.

## Fix

After the per-arm states are read from the flow log, a variable consumed before the branch whose every continuing arm ends unconsumed has its `consumed_at_token` cleared at the join. An arm with no flow record for the variable keeps the pre-branch move, so reassigning in only some arms still leaves it moved (the test's `comptime_expect_error` case).
