# A static method miss says `No method "m" on Type` instead of naming the type

**Severity:** S3 — the diagnostic is coded (E0610) and points at the right call,
but it names the receiver's kind, `Type`, rather than the type the method was
looked up on, so the user is not told which type lacks the method.
**Found:** 2026-10-05, while testing decision 32 of `plans/VALUES_BY_DEFAULT.md`
(`Box.nope(b)` through an unapplied type constructor).
**Measured:** yo 0.2.52 seed.
**Fixed:** `#1241`.

## Repro

```rust
{ String } :: import("std/string");
main :: (fn() -> unit)({
  s := `abc`;
  n := String.nope(s);
  b := box(i32(1));
  m := Box(i32).nope(b);
});
export(main);
```

Both calls reported:

```
error[E0610]: No method "nope" on Type: the type has no field or method with that name.
```

## Root cause

`_no_method_message` (`src/evaluator/calls/function.yo`) printed the receiver
expression's `ExprInfo.ty`. For a static call `T.m(...)` the receiver is a type
VALUE, so its type is `Type`; the type the method lookup used is the receiver's
value, `.TypeVal(T)` (the same split `_try_find_receiver_method` makes with
`is_static`).

## Fix

When the receiver's recorded value is a `TypeVal`, the message names that type:
`No method "nope" on String`, `No method "nope" on Box(i32)`.

Test: `tests/unapplied_constructor_method.test.yo`, "a static call's E0610
names the type it was called on" (and the `Box.nope(b)` / `Box(i32).nope(b)`
cases beside it).
