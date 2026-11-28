# A lend passed to a method's by-value binder parameter is reported as E0910, not E0914

**Severity:** S2 — a valid program is rejected: `slot.replace(&x2)` (`Option(&X).replace(self : &mut Self, value : T)` at `T := &X`) with a move-only `X` fails with E0910 "This argument moves `x2`, which an earlier argument of the same call lends", although nothing moves `x2`. The same call over a `Copy` payload (`Option(&i32)`) is accepted.

- Filed: 2026-11-20 by the v0.2.80 s1-origins lane, while writing the positive twins for `issues/fixed/2026-11-19-an-fnmut-closure-stores-its-per-call-reference-parameter-through-a-method-of-a-mut-capture.md`.
- Reproduces on the rename tree `df9927b92`, on `v0280/clusters` `33c855dfa`, with the v0.2.79 seed, and with a tree binary built from develop `4cdc10d31`.
- Status: FIXED by the `fix/a-lend-to-a-by-value-binder-parameter-is-e0914` PR. The program is now ACCEPTED, not E0914 (see "Correction").

## Reproducer

```yo
X :: struct(n : i32);
main :: (fn() -> unit)({
  x := X(n : i32(1));
  x2 := X(n : i32(2));
  mut(slot) := Option(&X).Some(&x);
  _o := slot.replace(&x2);
  ()
});
export(main);
```

```text
error[E0910]: This argument moves `x2`, which an earlier argument of the same call lends to it (`&(x2)`): the arguments are evaluated in order, so the callee would read and write a place whose value was already moved out and dropped (decision 28's argument exclusivity, plans/VALUES_BY_DEFAULT.md).
```

A user generic container's method (`impl(generic(T : Type), H(T), put : (fn(self : &mut Self, v : T) -> unit)(…))`, `h.put(&x2)` on `H(&X)`) failed the same way.

## Correction

The first version of this document expected E0914, by analogy with a free generic function
`keep(generic(T : Type), dst : &mut Option(T), v : T)`, where `keep(&mut slot, &x2)` is E0914. The two are not the
same position:

- In `keep`, the marker is peeled (`apply_call_site_borrow_markers`, `src/evaluator/calls/helper.yo`) before `T` is
  inferred, so the slot is a by-value slot of an unbound binder, and decision 33's mismatch rule reports E0914.
- In `slot.replace(&x2)`, `T` is already bound by the receiver's type `Option(&X)`, so the parameter's type is the
  reference `&X`. Decision 43 step 3's T9 (N2b) makes a by-value parameter whose type is a reference take a LEND:
  the marker is peeled and the argument's type is that reference over the place, as for a constructor's reference
  field (`Option(&X).Some(&x)` on the line above, accepted). The `Copy` twin (`islot.replace(&y)` on an
  `Option(&i32)`) was already accepted, and so is `r := &x2; slot.replace(r)`.

So the right outcome is acceptance, with `x2` lent (frozen while `slot` holds it), not moved.

## Root cause

`check_if_function_parameter_matches_argument` (`src/evaluator/calls/helper.yo`) recognised the T9 lend and typed the
argument `&X`, but then ran the shared ownership rule `consume_argument_for_parameter` on the evaluated argument, which
is the PLACE `x2`, as for any by-value parameter. Its step 4b transfers a non-`Copy` value into the parameter:
`set_expr_as_needs_to_call_dup` → `transfer_explicit_copy_value` marks the owning local `x2` consumed. Decision 28's
argument-exclusivity check (`_check_call_lent_place`, `src/evaluator/calls/function.yo`) then saw a place the call
lends (`&x2`) whose root was moved by an argument of the same call, and raised E0910. For a `Copy` payload step 4b is
skipped (`type_is_bitwise_copy`), which is why `Option(&i32)` passed. The constructor path
(`src/evaluator/calls/type.yo`) already skips the transfer for a T9 field
(`issues/fixed/2026-11-03-a-place-lent-into-a-reference-field-is-never-dropped.md`).

## Fix

`consume_argument_for_parameter` takes `param_takes_lend`; a T9 lend skips step 4b (nothing of the place's value
moves or is shared; the callee receives its address). Step 4a (the place must not be already moved) and decision 38
A's second-class check still run. After the fix the lend is a real loan: moving `x2` while `slot` is live is E0911
("Cannot move `x2` here: `slot` borrows `x2`"), writing it is E0911, and storing a lend of a block-local place into an
outer `slot` is E0911.

Tests: `tests/borrow-spelling.test.yo`, "a lend to a method's by-value reference parameter keeps a move-only place"
(the reproducer, a user generic method, and a `&mut` lend through `Option(&mut X).replace`), with the negatives
`bs_method_lend_freezes_move` and `bs_method_lend_outlives_place`.

## Related

- The static (UFCS) form `Option(&i32).replace(&mut islot, &y)` is still rejected with E0601 ("Expected `&i32`,
  given `i32`"): the Yo-callee (`FuncVal`) arm of `evaluate_function_call` peels the marker but has no T9 typing.
  Filed as `issues/fixed/2026-11-23-a-lend-to-a-by-value-reference-parameter-in-a-static-method-call-is-e0601.md`.
