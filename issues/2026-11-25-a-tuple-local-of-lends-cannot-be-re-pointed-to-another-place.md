# A tuple local of lends cannot be re-pointed to another place: `t.0 = &y` and `t = (&y, t.1)` are E0923

**Severity:** S3: a sound program is rejected with a correct-looking but over-strict E0923; the workaround is a struct holder (`H(r : &z, n : …)`, whose reference field's origin is elided and flow-inferred), which re-points freely.

Found 2026-11-25 by the VERDICTS-78 Q1 lane: the verdict's positive row `mut(t) := (&z, i32(0)); t.0 = &y; use(t.0);` (edge 9, "tuples follow the same rule") is E0923 once the field store is admitted, and so is the whole-tuple store it is checked as, `t = (&y, t.1)`, which is not new: the v0.2.80 E0926 help (#2059) suggested that spelling without running it.

## Reproducer

```yo
{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  z := i32(1);
  y := i32(2);
  mut(t) := (&z, i32(0));
  t = (&y, t.1);
  println(t.0.*);
});
export(main);
```

```text
error[E0923]: Cannot assign a value holding origin `y` to `t`: its type is declared over `Tuple(0 : &i32, 1 : i32)`, whose origin does not name `y`, and a holder points only into the places its origin lists (decision 43, plans/backlog/REFERENCES_AND_ORIGINS.md O3).
```

`t.0 = &y` gives the same error. Rust accepts both (`let mut t = (&z, 0); t.0 = &y;`).

## Root cause

A tuple literal's lend element is typed with its place named as the origin (`lend_place_reference_type`, `src/evaluator/utils.yo`: `&(i32, z)`), and a `:=` binding takes the literal's type, so `t : Tuple(&(i32, z), i32)`. `bind_join` and `place_write_join` read the origins a holder's type names (`origin_param_names_of`) as declared and check the stored value's roots against them (`_bind_join_subset_check`). A struct constructor's instance type has no such name (its reference field's origin is elided, so the holder's set is flow-inferred), which is why `h.r = &y` and `h = H(r : &y, n : h.n)` are accepted for a struct holder.

## Recommendation

An origin that only a lend's place produced (no annotation, no origin parameter) is inferred, not declared: type a tuple literal's lend element with an elided origin and let the binding's flow set carry the place, as a struct constructor's field does. That is a change to how tuple literals of lends are typed, beyond VERDICTS-78 Q1's field store, which is checked as the whole-holder store and so agrees with it today.

## Test

`tests/borrow-spelling.test.yo` pins the E0923 for `t.0 = &y` and the accepted same-origin store; `tests/origins/unsound/v78-tuple-store-outside-origin.yo` (E0923) and its `-pos` twin. The fix flips the first to a positive.
