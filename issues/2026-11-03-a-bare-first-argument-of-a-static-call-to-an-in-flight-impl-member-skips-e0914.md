# A bare first argument of a static call to an in-flight impl member skips E0914

**Severity:** S3 — a missing diagnostic: decision 33's bare-argument check (E0914) does not fire on one call path, so a program the rule rejects elsewhere is accepted. The call still lends the place; no emitted code is wrong.

**Status:** OPEN (filed 2026-11-03, found while fixing `issues/fixed/2026-11-02-an-impl-method-calling-itself-or-a-sibling-forced-early-rejects-a-borrow-argument.md`).

## Symptom

While an inherent impl member is still being evaluated (it calls itself, or a sibling above it forced it early), a static call `T.m(t, ...)` whose first parameter is `t : &String` accepts a BARE `t`. Decision 33 (`plans/VALUES_BY_DEFAULT.md`) requires `&t`, and the same call made after `m` has finished, which goes through property access, reports E0914.

```yo ignore
W :: impl {
  walk :: (fn(t : &String, d : i32) -> i32)({
    cond(
      (d == i32(0)) => i32(t.len()),
      true => {
        s := String.from("x");
        W.walk(s, (d - i32(1))) // bare `s` to `t : &String`: accepted, E0914 expected
      }
    )
  });
};
```

## Root cause

An in-flight member is registered as a type trait method (`force_in_flight_field`, `src/evaluator/values/impl.yo`), so `W.walk(...)` is resolved by the receiver-method arm of `evaluate_function_call` (`src/evaluator/calls/function.yo`). That arm calls `try_to_call_function_with_arguments` method-form, which treats argument 0 as a receiver; receivers are exempt from `check_call_site_borrow_marker` (`src/evaluator/calls/helper.yo`). Since the 2026-11-02 fix, a static call's argument 0 is PEELED against the method's first parameter (the decision-32 unapplied-constructor path, widened to `method_info.is_static`), but only `apply_call_site_borrow_markers` runs there, not the bare-argument check. The unapplied-constructor form `G.m(x, ...)` has always had the same gap.

## Fix direction

Run `check_call_site_borrow_marker` on argument 0 in that peel block (`uc_inf.bound || method_info.is_static`), against the first parameter's label, type and mode, exactly as the function-form path does for every argument. Expect the change to reject code the tree accepts today: sweep `src/` and `std/` with the tree binary (`yo fix --migrate markers` inserts the markers) before landing. The test is the snippet above in `tests/forward_ref_impl_block.test.yo` expecting E0914, plus the unapplied-constructor spelling.
