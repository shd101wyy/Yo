# E0908 calls an untyped `self ->` receiver "a `match` or `for` binding"

**Severity:** S3: misleading diagnostic. The rejection is correct; the noun and the suggested repair are wrong.

**Status: OPEN.** Found 2026-10-14 by the v0.2.62 batch review. It became reachable with #1347, which makes `Clone`, `ToString`, `Hash`, `Debug`, `Format`, `ToJson` and `Error.source` take `self : &Self`.

## Symptom

```yo
Big :: struct(n : i32);
impl(Big, bump : (fn(self : &mut Self) -> unit)({ self.n = (self.n + i32(1)); }));
impl(Big, Clone(clone : (self -> { self.bump(); Big(n : self.n) })));
```

`error[E0908]: Cannot pass self as the self : &mut Self receiver: self is a match or for binding ... to write a for element in place, loop with for(&mut xs, self => ...)`.

The same member written `(fn(self : &Self) -> Self)` correctly says "`self` is a `&T` parameter".

## Cause

An untyped lambda parameter, which is the prelude's own style for `clone`, binds `self` without `is_parameter`. The noun choice `cond(bv.is_parameter => "a &T parameter", true => "a match or for binding")` in `src/evaluator/exprs/assignment.yo` (about lines 526, 1215 and 1232) and `_write_through_borrow_fix` therefore misdescribe it.

## Fix direction

Mark lambda parameters `is_parameter`, or test for a lambda parameter explicitly. The help should say the trait lends `self` read-only, so either drop the write or declare a method outside the trait. Add a test asserting the message.
