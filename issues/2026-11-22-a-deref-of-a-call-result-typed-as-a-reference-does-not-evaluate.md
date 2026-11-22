# A `.*` of a call result typed as a reference (`o.unwrap().*`) does not evaluate

**Severity:** S2: a valid program is rejected. The only dereference spelling (`.*`, VERDICTS-73) cannot read through a reference that a call returns unless the result is bound first (`k := o.unwrap(); k.*.len()`). The messages are internal-looking: they print the expression where a type belongs.

Found 2026-11-22 while closing `issues/fixed/2026-11-10-a-method-call-on-a-call-result-typed-as-a-reference-is-e0610.md` (VERDICTS-75 rider r1). That document named `o.unwrap().*.len()` as the workaround; it is not one. Reproduces identically on the v0.2.79 seed and on develop `f06ff5889`.

## Reproducer

```yo
pragma(Pragma.AllowUnsafe);
{ String } :: import("std/string");
pick :: (fn(s : &String) -> Option(&String))(.Some(s));
main :: (fn() -> unit)({
  y := String.from("hello");
  a := pick(&y).unwrap().*.len();     // E0610
  b := pick(&y).unwrap().*.clone();   // E0610
  c := pick(&y).unwrap().*;           // "Failed to evaluate"
  d := String.len(&pick(&y).unwrap().*);   // "arg not evaluated"
  ()
});
export(main);
```

```text
error[E0610]: No method "len" on ((pick(&(y)).unwrap)().(*)): the type has no field or method with that name.
error: Failed to evaluate, got ((pick(&(y)).unwrap)().(*))
error: evaluate_function_call: arg not evaluated
```

The same spellings over a bound result (`k := pick(&y).unwrap(); k.*.len()`) and over a `Deref` handle's call result (`w.upgrade().unwrap().*`, `tests/rc.test.yo`) work.

## Root cause

The `.*` branch of `evaluate_property_access` (`src/evaluator/exprs/property-access.yo`) answers a reference operand only in named forms: a reference binding, a CTFE reference parameter, a projection call, a reference-typed place, and the E0920 branch. The closing "`.*` on a plain value" arm assumes every other legal `.*` has already returned. A NON-projection call whose result type is `&T` (a reference VALUE, VERDICTS-23 R3) is none of these forms. Its type is dereferenceable, so that arm lets it through to the ordinary field lookup, which looks for a field named `*`, leaves no ExprInfo and surfaces as one of the three messages above. R-PROBE's deref retry builds the same node (`make_deref_expr`), so before rider r1 it was also why `o.unwrap().len()` lost its method.

## Fix direction

Give the `.*` branch the reference-VALUE operand: the result is the place the reference names, of type `T`, rooted at the call's temporary. That is the read a bound result gets today. A test for each of the four spellings in `tests/impl-ref.test.yo` beside the "(r1)" rows.
