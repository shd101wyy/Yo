# E0915's repair hint names the type or the witness instead of the value

**Severity:** S3 — for `Fd.drop(&mut a)`, `(Fd <: Drop).drop(&mut a)` and `Drop.drop(&mut a)` the hint suggests `drop(Fd)`, `drop(Fd <: Drop)` or `drop(Drop)`, which does not compile.

**Status:** Fixed (v0.2.63). Found by the v0.2.62 adversarial review; new with E0915 in decision 45 Generation A (#1343).

## Symptom

```
help: to end the value now, write drop(Drop)
help: to end the value now, write drop(Fd <: Drop)
help: to end the value now, write drop(Fd)
```

Only `myval.drop()` printed the right `write drop(myval)`.

## Root cause

`_reject_explicit_destructor_call` (`src/evaluator/calls/function.yo`) printed
the dot's object for the repair. In the type-qualified and witness forms the
object is a type or a trait (`oi.value` is a `TypeVal`); the value being
destroyed is the call's first argument.

## Fix

The check now takes the call's arguments. When the dot's object is a type, the
repair names the first argument with its `&`/`&mut` stripped
(`_lent_argument_place`); a member read as a value, which has no argument,
says "write drop(x) on the value".

## Test

`tests/move_only.test.yo`, "Drop: the destructor read as a value is E0915, and
the repair names the value": `myval.drop()`, `_MoDropFd.drop(&mut myval)`,
`(_MoDropFd <: Drop).drop(&mut myval)` and `Drop.drop(&mut myval)` each expect
`write drop(myval)`. Before the fix the last three print the type or the
witness.
