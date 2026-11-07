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
negate :: (fn(self : &f64) -> f64)(if((self < f64(0.0)), -self, self));
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

## Fix direction

When every candidate fails and an argument is a reference binding read as a reference
by R1's unbound-binder case, retry the resolution with that argument read as its
referent. If the retry resolves, the read is a whole-value read without `.*`: raise
E0926 there, or record it under `--migrate deref` and continue with the referent type.

## Test

The fix adds the three unary shapes to `tests/origins/reference_read_rule.test.yo` as
E0926 expectations, and adds a `tests/cli-cases/fix-migrate-deref-unary-operator` case
in which the reproducer migrates to `if(self.* < f64(0.0), -self.*, self.*)` and passes
`check`. Then this doc moves to `issues/fixed/`.
