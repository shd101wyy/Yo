# A `& &T` binding passed on to a named callee's `& &T` parameter is E0601

**Severity:** S2 — valid programs are rejected: every trait default over a reference type that forwards its `&&T`
parameters to another member fails, so an `impl(&C, Eq(&C))` that takes `Eq`'s default `!=` does not evaluate

Found 2026-11-13 by the `g2` lane while landing P3b gap 1 (an operator's reference-binding operand selects with its
reference type, VERDICTS-49). Pre-existing on develop `6c90536aa` and in the v0.2.77 seed; gap 1 does not change it.

## Reproducer

```yo
_g :: (fn(v : & &i32) -> i32)(v.*.*);
_f :: (fn(lhs : & &i32) -> i32)(_g(lhs));
main :: (fn() -> unit)({
  a := i32(3);
  ra := &a;
  _n := _f(&ra);
  ()
});
export(main);
```

```
error[E0601]: Cannot unify incompatible types:
Expected: "&i32"
Given: "&&i32"
  --> tmp/fixme.yo:2:35
```

The same error for a qualified trait-method call, `(&C).(==)(rra, rrb)` with `rra, rrb : & &C`, and for the trait
default of `!=` on any `impl(&C, Eq(&C))` that provides only `==`:

```yo
_C :: struct(n : i32);
impl(&_C, Eq(&_C)((==) : (fn(lhs : &Self, rhs : &Self) -> bool)(lhs.*.*.n == rhs.*.*.n)));
```

```
error[E0610]: No matching call found with arguments:
not((Self.(==))(lhs, rhs))
note: raised in the default body of "!=", which trait (== : fn(lhs : &Self, rhs : &&_C) -> bool, ...) gives &_C
```

`_f(&ra)` itself, a function VALUE called with `rr` (`tests/ref_of_ref.test.yo`), and `_g(&ra)` are accepted.

## Root cause

The named (non-generic) callee's argument loop in `src/evaluator/calls/function.yo` (the inline `FuncVal` path, beside
`reference_argument_as_referent`) installs the borrow slot's POINTEE as the argument's expected type: for `v : & &i32`
that is `&i32`. The read rule (`reference_read_wanted`) then reads the reference binding `lhs` (slot `& &i32`) as its
reference VALUE, one level deeper than the slot's pointee. This is the bug
`issues/fixed/2026-11-08-a-function-value-call-reads-a-borrow-slot-over-a-reference-as-a-by-value-reference.md` fixed
in `check_if_function_parameter_matches_argument` (helper.yo's `slot_of_reference`: a borrow slot whose pointee is a
reference takes a PLACE of that reference type, so no expected type is installed); the inline loop was not given the
same rule.

## Fix (not in the reporting PR)

The inline loop reads the same predicate as helper.yo: a non-owning, non-`&mut`-marker slot whose resolved pointee is a
reference installs no expected type, and a written `&r` at it is forced to lend `r` itself. The file belongs to the
`calls` lane (VERDICTS-58 decision 21), so the `g2` lane files this and hands the hunk over.

## Test that will pin it

`tests/ref_of_ref.test.yo`: a `& &i32` parameter passed on to a named function's `& &i32` parameter; an
`impl(&C, Eq(&C))` providing only `==`, whose `!=` (the trait default) runs.
