# A boxed or lent `FnOnce`/`FnMut` closure erases into a `Dyn(Fn(...))`, and a second call frees its captures twice

**Severity:** S1: a safe program passes `yo check` and frees memory twice at run time. An `FnOnce` closure written
`dyn(Box.new(f))` into a `Box(Dyn(Fn() -> T))`, or `dyn(&f)` into a `&Dyn(Fn() -> T)`, is accepted, and every call
through the `Dyn` moves the captures out again: `free(): double free detected in tcache 2`. An `FnMut` closure in a
`Dyn(Fn(...))` slot is accepted the same way.

**Status:** FIXED 2026-11-16 (`vbd/s3b-dyn`, decision 49 S3b). Found by the S3b-`Dyn` lane: the deletion of the
plain `dyn(f)` alias moved `tests/fn_mut.test.yo`'s and `tests/fn_once.test.yo`'s E0913 rows to `dyn(Box.new(f))`,
and they stopped raising. It reproduces on develop `223b188f4` (v0.2.78 content).

## Reproducer

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  s := String.from("moved-once");
  (f : Impl(FnOnce() -> String)) = ({ s }() => s);
  (d : Box(Dyn(Fn() -> String))) = dyn(Box.new(f));
  a := d();
  b := d();
  println(&a);
  println(&b);
});
export(main);
```

`yo check` is clean; the binary aborts with a double free. The lent form,
`run(dyn(&f))` twice with `run :: (fn(d : &Dyn(Fn() -> String)) -> String)(d())`, aborts the same way.

## Root cause

`_reject_weaker_closure_into_dyn` (`src/evaluator/values/dyn.yo`) read the closure trait off the value `dyn` was
given. For the plain alias `dyn(f)` that value was the closure, so the check fired. For `dyn(Box.new(f))` it is the
`Box` handle, whose type names no closure trait, so the check saw nothing. `dyn(&f)` (`_evaluate_dyn_over_lend`) never
called it. The alias was the only checked spelling, and decision 49 S3b deletes it.

## Fix

The check reads the handle's payload (`unique_box_payload_type`, `cell_handle_view`), so `dyn(Box.new(f))` and
`dyn(Rc.new(f))` are checked as the alias was. The lend path calls it with the `Dyn` its position expects. Both give
E0913 ("Cannot box an `FnOnce(...)` closure as a `Dyn(Fn(...))`"), as for an implicit `FnMut`.

Tests: `tests/fn_once.test.yo` (`_dyn_fn_rejects_fnonce`, boxed; `_lent_fn_rejects_fnonce`, lent, new) and
`tests/fn_mut.test.yo` (`_fm_dyn_fn_rejects_fnmut`, `_fm_dyn_fnmut_rejects_fnonce`, `_fm_fnmut_literal_dyn_fn`).
They are spelled `dyn(Box.new(f))`/`dyn(&f)`. Each fails on develop (the expression raises nothing) and passes with
the fix.
