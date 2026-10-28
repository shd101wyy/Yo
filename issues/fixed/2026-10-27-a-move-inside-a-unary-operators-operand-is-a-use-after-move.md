# A move inside a unary operator's operand is a use after move

**Severity:** S2: a valid program is rejected. `!match(o, …)`, `-match(o, …)` or
`not(match(o, …))`, where the match consumes an owned `o` (a move-only value,
or, under decision 17, a value holding a counted handle), reports E0901 "use of
moved value: `o`" with the move and the use at the same position.

> Found 2026-10-27 by the V2c rc-clone sweep (`src/evaluator/exprs/property_access.yo:904`,
> `if(v.is_ref && !match(obj_ty_deref, …), …)`). Pre-existing: the v0.2.70 seed rejects the
> move-only reproducer below.

## Reproducer

```yo ignore
_D :: struct(n : i32);
impl(_D, Drop(drop : (fn(self : &mut Self) -> unit)(())));
g :: (fn(o : Option(_D)) -> bool)(!match(o, .Some(d) => (d.n == i32(3)), .None => false));
// error[E0901]: use of moved value: `o` (moved and used at the same `o`)
```

## Root cause

`!`, unary `-` and `not` are prelude operator modules whose `Call` holds two
candidates (`(not, comptime_not)`). `_try_expand_call_overload`
(`src/evaluator/calls/function.yo`) picks one by trial-calling each candidate
(`_trial_call_overload_candidate`), which evaluates fresh-id clones of the
arguments in the caller's live environment. The match in the operand consumed
`o` there (`consumed_at_token`), and the real call's evaluation of the same
operand then found `o` moved. The binary-operator probe had the same bug and
was fixed by restoring every binding's move state after the probe
(`issues/fixed/a-move-inside-an-overloaded-operators-operand-is-a-use-after-move.md`);
the candidate trial was missed.

## Fix

The trial saves every binding's move state before `_run_overload_trial` and
restores it afterwards, the same save/restore the operand probe uses (now
shared as `_save_move_states` / `_restore_move_states`).

## Test

`tests/move_only.test.yo`, "a move inside a unary operator's operand moves
once": fails with E0901 before the fix, passes after.
