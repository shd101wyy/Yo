# A generic function wrapping its by-value `T := &U` parameter in an `Option(T)` is rejected with E0923

**Severity:** S2: a valid program is rejected.

Found 2026-11-10 while closing R3 (`issues/fixed/2026-11-07-a-generic-function-storing-a-by-value-reference-parameter-emits-invalid-c.md`). Present on the v0.2.76 seed and on develop 367f37489, so it is not R3's regression.

## Reproducer

Program: `issues/repros/2026-11-10-a-generic-function-wrapping-its-by-value-reference-parameter-in-an-option-is-e0923.yo`.

```yo
mk :: (fn(generic(T : Type), v : T) -> Option(T))(.Some(v));
```

called as `mk(ry)` with `ry : &String` reports

```text
error[E0923]: Cannot return a value holding `v`: the result is declared `Option(T)`, whose origin does not name `v`, and a result points only into the places its origin lists (decision 43, plans/backlog/REFERENCES_AND_ORIGINS.md O3).
```

## Root cause (not yet traced)

`return_check` (`src/evaluator/utils.yo`) reads the result's origin from the declared `Option(T)`, which spells none, and roots the returned value at the parameter `v`. A by-value parameter whose type is a reference holds the place its caller lent, not `v`'s own storage: the origin of `v`'s value is the origin of the parameter's TYPE (Q1's by-value elision, VERDICTS-23 R3), which an elided result origin should list.

## Fix

Resolve an elided result origin over the by-value parameters whose types carry an origin, and root the read of a by-value parameter of reference type at that origin, not at the parameter. Test: the reproducer compiles and the result reads the place.
