# A lend to a by-value reference parameter in a static method call is E0601

**Severity:** S2 — a valid program is rejected: `Option(&i32).replace(&mut islot, &y)` fails with E0601 "Expected `&i32`, given `i32`", while the method form `islot.replace(&y)` and the constructor `Option(&i32).Some(&y)` are accepted.

- Filed: 2026-11-23 by the v0.2.80 `fix-slot-replace` lane, beside
  `issues/fixed/2026-11-20-a-lend-passed-to-a-methods-by-value-binder-parameter-is-reported-as-e0910-not-e0914.md`.
- Reproduces with the v0.2.79 seed and with a tree binary built from develop `e1ece945d` plus that fix.

## Reproducer

```yo
main :: (fn() -> unit)({
  mut(s) := Option(i32).Some(i32(1));
  _o := Option(i32).replace(&mut s, i32(2));
  y := i32(3);
  mut(islot) := Option(&i32).None;
  _p := Option(&i32).replace(&mut islot, &y);
  ()
});
export(main);
```

```text
error[E0601]: Cannot unify incompatible types:
Expected: "&i32"
Given: "i32"
  --> u1.yo:6:43
  |
6 |   _p := Option(&i32).replace(&mut islot, &y);
  |                                           ^
```

Line 3 (a static call over a non-reference `T`) is accepted; only the reference slot fails.

## Root cause (as far as traced)

`replace`'s `value : T` at `T := &i32` is a by-value parameter whose type is a reference, which takes a LEND
(decision 43 step 3, T9). The static call goes through the Yo-callee (`FuncVal`) arm of `evaluate_function_call`
(`src/evaluator/calls/function.yo`), which peels the `&y` marker (`apply_call_site_borrow_markers`, the T9 arm of
`src/evaluator/calls/helper.yo` accepts the lend) but, unlike `check_if_function_parameter_matches_argument` in
`helper.yo` (the method form's route) and the constructor path in `src/evaluator/calls/type.yo`, never types the
peeled place as the parameter's reference over it (`t9_lend_ty`). The place `y : i32` then meets the slot `&i32`.

## Expected

Accepted, `y` lent to the call (frozen while `islot` holds it), as for `islot.replace(&y)`.

## Fix (2026-11-27, VERDICTS-90 PR A)

A lend is judged at the slot the call solved before its arguments, not at the declared slot (VERDICTS-90 R3). The
T9 typing moved out of `check_if_function_parameter_matches_argument` into one helper, `t9_lend_type`, which the
inline `FuncVal` arm now calls too: the peeled place's argument type is the slot's reference over it, and the arm
passes `param_takes_lend` to `consume_argument_for_parameter`, so a move-only place is lent, not moved. The peel
(`apply_call_site_borrow_markers`) no longer rejects a lend at a by-value slot typed by a bare binder: it records the
marker, and `judge_lend_at_solved_slot` decides once the slot is known, so `id(generic(&X), &x)` and
`(q : &X) = id(&x)` lend `x` as well. Tests: `tests/borrow-spelling.test.yo`, "a lend at a slot the call solved to a
reference lends the place" and the `bs_solved_*` rows.
