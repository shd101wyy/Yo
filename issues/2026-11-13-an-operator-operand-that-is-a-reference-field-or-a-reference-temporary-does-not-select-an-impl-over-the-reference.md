# An operator operand that is a reference field or a reference temporary does not select an impl over the reference

**Severity:** S3 — a valid comparison is rejected with E0926, and its suggested repair (`h.r.*`) selects the
referent's impl, which may not exist: `h.r == h2.r` on two `&C` fields cannot use `impl(&C, Eq(&C))` without first
binding each reference to a local

Found 2026-11-13 by the `g2` lane landing P3b gap 1 (VERDICTS-49 §"The four gaps" 1, which names this case and routes
it here when the storage it needs is not a reuse).

## Reproducer

```yo
_C :: struct(n : i32);
impl(
  &_C,
  Eq(&_C)(
    (==) : (fn(lhs : &Self, rhs : &Self) -> bool)(lhs.*.*.n == rhs.*.*.n),
    (!=) : (fn(lhs : &Self, rhs : &Self) -> bool)(lhs.*.*.n != rhs.*.*.n)
  )
);
_H :: struct(r : &_C);
main :: (fn() -> unit)({
  a := _C(n : i32(1));
  d := _C(n : i32(2));
  h := _H(r : &a);
  h2 := _H(r : &d);
  _x := (h.r == h2.r);
  ra := &a;
  _y := (ra == &d);
  ()
});
export(main);
```

```
error[E0926]: `h.r` is a reference (`&_C`): reading the value it refers to is spelled `h.r.*`
```

and, for the second comparison, `error[E0926]: \`ra\` is a reference (\`&_C\`) ...` at `ra`.

A reference BINDING operand selects the impl over `&C` (gap 1: `ra == rb` lends each binding's own storage to the
`&&C` slots), and so does `rra.* == rrb.*` with `rra, rrb : & &C`, whose operands are places of type `&C`. A field read
`h.r` and a temporary `&d` are reference VALUES with no storage of their own to lend to a `&&C` slot.

## Root cause

`_operator_reference_operand` (src/evaluator/calls/function.yo) selects an impl over `&T` only for an operand that is a
reference binding atom, and requires the right operand at a `&&T` slot to be one too: an operator has no hidden local
to hold a reference value while its address is lent. This is the same gap as a reference temporary receiver at a `&&C`
receiver slot (P3b gap 3's call-site error, `plans/backlog/BORROW_CHECKER_COMPLETENESS.md` §7 P3b).

## Fix

O-5's statement temporaries (R-TEMP): bind the operand's reference value to a hidden statement local and lend that
local's storage, as for a receiver temporary. Until then the operand keeps today's E0926.

## Test that will pin it

`tests/impl_ref.test.yo`: `h.r == h2.r` and `ra == &d` against `impl(&C, Eq(&C))`, true for equal referents.
