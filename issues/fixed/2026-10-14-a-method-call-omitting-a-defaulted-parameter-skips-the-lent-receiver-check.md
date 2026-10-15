# A method call that omits a defaulted parameter skips the lent-receiver check

**Severity:** S1 — `a.peek_d(eat(a))` was accepted, and the method read its
`&self` receiver after `eat` had moved it out and dropped it (a use after
`Dispose`).

Found 2026-10-14 by the v0.2.62 adversarial review (dimension "lent-move").
v0.2.61 accepts it too (it had no receiver check at all); the receiver check
added by
`issues/fixed/a-later-argument-can-move-the-place-an-earlier-argument-lends-to-a-call.md`
missed this form.

## Symptom

```yo ignore
Res :: struct(n : i32);
impl(Res, Dispose(dispose : (fn(self : &Self) -> unit)(println(`dropped ${self.n}`))));
impl(Res, peek_d : (fn(self : &Self, k : i32, (extra : i32) ?= i32(0)) -> i32)({
  println(`peek_d reads ${self.n}`);
  self.n + k + extra
}));
eat :: (fn(r : Res) -> i32)(r.n);
main :: (fn() -> unit)({
  a := Res(n : i32(1));
  r := a.peek_d(eat(a));   // accepted
  println(&r);
});
```

It printed `dropped 1`, `peek_d reads 1`, `2`: the destructor ran inside
`eat` before the method read `self`. Passing the default explicitly,
`a.peek_d(eat(a), i32(0))`, was rejected with E0910, as was the type-qualified
`Res.peek_d(&a, eat(a))`.

## Root cause

`_check_call_lent_place_moves` (`src/evaluator/calls/function.yo`) treated
the receiver as lent only when the method's parameter count was exactly the
written argument count plus one, a proxy for "the receiver is passed as
`self`". `peek_d` has three parameters; the call writes one argument, so the
test failed and the receiver was never checked.

## Fix

The test is now `written arguments + 1 <= parameters`: a call may omit
defaulted parameters, and a call that passes too many arguments is already an
arity error. The only calls the relaxed test newly admits are type-qualified
calls (`Res.peek_d(&a, k)`), where the "receiver" is a type name that no
argument moves or writes, so checking it is a no-op; their `&a` argument is
checked as before.

Regression test: `tests/parameter_modes.test.yo`, "a later argument cannot
move the receiver of a call that omits a defaulted parameter".
