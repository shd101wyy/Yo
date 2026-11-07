# A unary operator on a reference binding is E0610, and `yo fix --migrate deref` stops there

**Severity:** S2 — `-r`, `!r` and `~r` on a reference binding are rejected with "No matching
call found" instead of E0926's "spelled `r.*`", and `yo fix --migrate deref` cannot record
them: the fn's evaluation aborts at the operator, so the rest of the fn is left unmigrated
and the file is reported as "does not evaluate".

Filed 2026-11-07 on `vbd/deref-adoption` (found while regenerating N3's adoption: the tool
stopped at `std/fmt/format.yo`'s `if(neg, -self, self)` on `self : &Self`, 77 std files
"did not evaluate"). Reproduced with a develop build at `e91a5bfc0` on a user file, so it
is independent of the adoption branch.

## Reproducer

```yo
negate :: (fn(self : &f64) -> f64)(if(self < f64(0.0), -self, self));
main :: (fn() -> unit)({
  x := f64(-2.5);
  _y := negate(&x);
});
export(main);
```

`yo check` reports, at the `-`:

```
error[E0610]: No matching call found with arguments:
-(self)
```

The binary operators are judged correctly: `x + i32(1)` and `i32(1) + x` with
`x : &i32` are E0926 ("reading the value it refers to is spelled `x.*`"). Each of the
unary forms `-self` (`&f64`), `!b` (`&bool`) and `~x` (`&i32`) is E0610.

`yo fix <file> --migrate deref --dry-run` applies 1 edit (`self <` → `self.* <`), then
reports the file as not evaluating. The `-self` and the tail `self` are never reached.
After the edit is applied, `check` is E0610 at `-self`.

## Root cause

The prelude's unary operators are generic single-parameter `Call` tuples, for example
`(-)`'s `neg :: (fn(generic(_Self : Type), self : _Self, where(_Self <: Negate)) -> _Self)`.
Under the R1 read rule (#1805) a reference binding passed as the argument for a callee's
unbound binder reads as the reference value, so `_Self` binds to `&f64`. `&f64` has no
`Negate` impl and neither does the comptime candidate, so overload resolution fails
before `_check_reference_argument` (`src/evaluator/calls/helper.yo`) judges the argument.
That judge is the only place E0926 is raised, or recorded in migration mode, for a
by-value operand. A binary operator's other operand binds `_Self` to the value type
first, so the reference operand reaches the judge.

## Fix

`_try_expand_call_overload` (`src/evaluator/calls/function.yo`) retries the candidates
when none accepts the arguments as written and some argument is a bare reference binding
judged by the deref rule. For the retry, those arguments read as their referent at the
binder position (`note_binder_value_read`, consulted by `reference_read_wanted`). If a
candidate then accepts them, that reading stays, and the real call judges the argument
as the by-value read it is. `check` reports E0926 (spelled `x.*`), and
`--migrate deref` records the `.*` and goes on evaluating the fn. If no candidate accepts
them either way, the marks are dropped and the call is still E0610.

## Test

- `tests/cli-cases/check-unary-operator-on-a-reference-is-e0926`: `~x` on `x : &i32` is
  E0926.
- `tests/cli-cases/fix-migrate-deref-unary-operator`: `-self`, `!b` and `~x` migrate, the
  tail `self` too, and the migrated file passes `check`.
