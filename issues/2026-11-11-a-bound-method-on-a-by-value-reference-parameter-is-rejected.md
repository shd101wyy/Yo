# A bound's method on a by-value `v : T` at `T := &Bag` is rejected, and `g(...).*` on a by-value reference result is an internal error

**Severity:** S2: valid programs are rejected (compile-time only; nothing miscompiles).

Found 2026-11-11 by the VERDICTS-54 probes (`fable/probe-54/q2.yo`). Present on develop `13aa6abe0` with the same two diagnostics, so R3 (narrowed) does not change it; it is the same class R3 opens (a by-value slot that is a reference VALUE), one step further.

## Reproducer

Program: `issues/repros/2026-11-11-a-bound-method-on-a-by-value-reference-parameter-is-rejected.yo`.

```yo ignore
Named :: trait(nl : (fn(self : Self) -> usize));
impl(&Bag, Named(nl : (fn(self : Self) -> usize)(self.n)));
use_it :: (fn(generic(T : Type), v : T, where(T <: Named)) -> usize)(v.nl());   // E0601 "Bag" and "&Bag"
use_q  :: (fn(generic(T : Type), v : T, where(T <: Named)) -> usize)(T.nl(v));  // E0914: lend `v` with `&v`
// r : &Bag;  use_it(r)  /  use_q(r)
```

Also found with R3: `g(...).*` where `g`'s declared result is a binder `T` at `T := &i32` (`_sm_pick(rx, ry, true).*`) stops with the internal error `check_if_function_parameter_matches_argument: arg has no ExprInfo`; binding the result first (`p := _sm_pick(rx, ry, true); p.*`) works.

## Root cause (not yet traced)

`v` is a by-value binding whose value is a reference. The receiver and the argument position of a bound method are judged as for a place of the referent (`Bag`) or as a bare by-value read where a `&Self` slot wants the reference (the read rule by type, VERDICTS-45, is not applied to a by-value reference binding).

## Fix

Treat a by-value binding of reference type as a reference binding for receiver dispatch and the read rule (value type the referent, the slot by value). Test: the reproducer runs both forms.
