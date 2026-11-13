# An operator impl over a reference with by-value operands is not selected for reference bindings

**Severity:** S3 — a valid operator call is rejected with E0926, and the suggested `ra.*` selects the referent's impl,
which may not exist: with `impl(&C, Add(&C))` (Rust's `impl Add<&B> for &A`), `ra + rb` on `ra, rb : &C` does not
compile; `(&C).(+)(ra, rb)` does

Found 2026-11-13 by the `g2` lane landing P3b gap 1 (VERDICTS-49), which covers the `&&T` slots (`Eq`, `Ord`: `lhs :
&Self`, `rhs : &Rhs`) only.

## Reproducer

```yo
_C :: struct(n : i32);
impl(
  &_C,
  Add(&_C)(
    Output : i32,
    (+) : (fn(lhs : Self, rhs : Self) -> Self.Output)(lhs.n + rhs.n)
  )
);
main :: (fn() -> unit)({
  a := _C(n : i32(1));
  d := _C(n : i32(2));
  ra := &a;
  rd := &d;
  _s := (ra + rd);
  ()
});
export(main);
```

```
error[E0926]: `ra` is a reference (`&_C`): reading the value it refers to is spelled `ra.*`
```

## Root cause

`Add`'s slots are by value (`lhs : Self`, `rhs : Rhs`); at `Self = &_C` the slot is the `&_C` itself, which the
evaluator does not tell apart from a borrow of `_C` (R3 keeps the declared shape only for a binder `T`, not for `Self`
at a written reference). Gap 1 (`_operator_reference_operand`, `src/evaluator/calls/function.yo`) selects only impls
whose slots are `&&T`. Measured while landing gap 1 (stage-1 builds g1b, g1c): selecting the by-value impl and reading
the left operand as the reference value is E0601 at the argument check (`_C` vs `&_C`); lending the left operand's
place instead passes it, and the right operand, which the argument binder evaluates against an owning slot, is then
E0926 at `rd`.

## Fix

Teach the argument binder that an owning slot whose type is a reference takes a reference binding as the reference
(the read rule's binder position, as for `v : T` at `T := &U`), then let `_operator_reference_operand` select such an
impl with both operands read as references.

## Test that will pin it

`tests/impl_ref.test.yo`: `(ra + rd) == i32(3)` with `impl(&_PgC, Add(&_PgC))` (today a `comptime_expect_error` pinning
E0926).
