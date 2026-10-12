# A move inside an overloaded operator's operand is a use after move

**Severity:** S2: a valid program is rejected. `x := i32(3) + take(d)`, where
`take` consumes a move-only `d`, reports E0901 "use of moved value: `d`" at
the move itself. Any operator whose right operand moves a value hits it; V3
async A1 made it common (`p.n + io.await(task, io)` consumes `task`).

> Found 2026-10-12 by `tests/async_generic_future_return.test.yo` on the A1
> branch. Pre-existing: the v0.2.59 seed rejects the same program.

## Reproducer

```yo ignore
_D :: struct(n : i32);
impl(_D, Dispose(dispose : (fn(self : &Self) -> unit)(())));
_eat :: (fn(sink(x) : _D) -> i32)(x.n);
main :: (fn(io : Io) -> unit)({
  d := _D(n : i32(8));
  x := (i32(3) + _eat(d)); // error[E0901]: use of moved value: `d`
});
```

## Root cause

`+` resolves among several prelude overloads. When there is more than one,
`src/evaluator/calls/function.yo` picks one by the right operand's type, which
`_try_eval_operand_type` found by evaluating the operand in the live
environment. That evaluation recorded the move (`consumed_at_token` on `d`),
and the call's own evaluation of the same operand then found `d` moved.

## Fix

The probe saves every visible binding's move state and puts it back after the
type is read (`_probe_operand_type` runs the evaluation, so the restore runs
whether it succeeds or unwinds).

Regression: `tests/move_only.test.yo`, "a move inside an operator's operand
moves once".
