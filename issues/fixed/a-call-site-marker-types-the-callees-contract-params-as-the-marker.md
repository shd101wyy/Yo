# A call-site marker types the callee's contract parameters as the marker

**Severity:** S2 — every contracted callee reached through `&x` / `&mut x` under `pragma(Pragma.Verify)` failed to compile; no miscompile.

**Status:** fixed (PR #1318).

## Symptom

```yo
pragma(Pragma.Verify);
unset_flag :: (fn(b : &bool, requires(!b)) -> i32)(i32(0));
main :: (fn() -> unit)({
  c := false;
  _r := unset_flag(&c);
});
export(main);
```

```
error[E0610]: No matching call found with arguments:
  --> e.yo:2:38
```

The definition alone type-checks, and so does a call that forwards a borrow binding bare. Only a call whose argument carries a call-site marker fails. Before E0914 was always on, the tree passed places bare, so nothing reached it; the marker sweep for #1318 turned two guard-elision fixtures (`tests/spec/fixtures/elision/arraylist_index_{kept,proved}.yo`) red.

## Root cause

`_stash_callsite_contracts` (`src/evaluator/builtins/contracts.yo`) re-evaluates the callee's clauses at each call site with the parameters bound to unknowns of the call site's concrete argument types. `_callsite_arg_type` read that type from the argument node's ExprInfo. For `unset_flag(&c)` the node is the marker `&c`, not the lent place `c`, so `b` was bound at the marker's type and `!b` found no candidate.

## Fix

`_callsite_arg_type` peels a call-site marker (`&x`, `&mut x`) and reads the place's type, as `apply_call_site_borrow_markers` does for every other rule.

Regression: `tests/spec/fixtures/valid/callsite_marker_requires.yo` (both marker forms), plus the two elision fixtures.
