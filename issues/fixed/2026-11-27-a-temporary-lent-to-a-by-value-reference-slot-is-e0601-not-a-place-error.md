# A temporary lent to a by-value reference slot is E0601, not a place error

**Severity:** S3 — a correct rejection with a misleading message. `slot.replace(&mk())` for `slot : Option(&X)` and
`Option(&X).Some(&mk())` are E0601 "Cannot unify incompatible types: `&X` and `X`" (or "Incompatible types for field
`value`"), which reads as a type mismatch. The real rule is that a by-value reference slot takes a lend of a PLACE
(decision 43 step 3, T9; `r := &mk()` is E0927 for the same reason).

- Filed: 2026-11-27 by the `v81-infer-first` lane (VERDICTS-90 §9 item 4, probes `g2_t9_temp`, `g2b_ctor_temp`).
- Reproduces with the v0.2.80 seed and with a tree binary built from develop at `ba2959c00`.

## Reproducer

```yo
X :: struct(n : i32);
mk :: (fn() -> X)(X(n : i32(1)));
main :: (fn() -> unit)({
  x := X(n : i32(1));
  mut(slot) := Option(&X).Some(&x);
  _o := slot.replace(&mk());
  o := Option(&X).Some(&mk());
  ()
});
export(main);
```

```text
error[E0601]: Cannot unify incompatible types: "&X" and "X"
  --> g2_t9_temp.yo:6:23
  |
6 |   _o := slot.replace(&mk());
  |                       ^^
```

```text
error[E0601]: Incompatible types for field "value":
- Expected: &X
- Given  : X
  --> g2b_ctor_temp.yo:4:25
  |
4 |   o := Option(&X).Some(&mk());
  |                         ^^
```

## Root cause

The T9 lend typing (`t9_lend_ty` in `check_if_function_parameter_matches_argument`, `src/evaluator/calls/helper.yo`,
and the constructor path in `src/evaluator/calls/type.yo`) types a peeled marker as a reference over its place only
when `_lend_place_root_name` finds a place root. A call result has none, so the peeled operand keeps its value type
`X` and meets the slot `&X` as a plain unification failure.

## Expected

VERDICTS-90 R4's text at the lend: "`&mk()` lends a temporary, and parameter `value` would hold that reference by
value: bind the value to a local and lend the local, or pass `mk()` itself".

## Fix (2026-11-28, VERDICTS-90 PR B)

A peeled marker whose operand is no place (`lend_needs_place_error`, `src/evaluator/calls/helper.yo`) is E0914
with R4's text wherever the slot it meets is a by-value reference: the method/helper path
(`check_if_function_parameter_matches_argument`), the inline `FuncVal` arm (`src/evaluator/calls/function.yo`) and
the constructor path (`src/evaluator/calls/type.yo`):

```text
error[E0914]: `&mk()` lends a temporary, and parameter "value" would hold that reference by value: bind the value to a local and lend the local, or pass `mk()` itself.
```

Tests: `tests/borrow-spelling.test.yo` rows `bs_binder_lend_temporary` (`bs_id(&bs_mk())`),
`bs_t9_lend_temporary` (`slot.replace(&bs_mk())`) and `bs_t9_ctor_lend_temporary` (`Option(&BsLent).Some(&bs_mk())`).
