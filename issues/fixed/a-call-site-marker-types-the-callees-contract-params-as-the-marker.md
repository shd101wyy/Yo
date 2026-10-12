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

The definition alone type-checks, and so does a call that forwards a borrow binding bare. Only a call whose argument carries a call-site marker fails. The verifier had the same blind spot: `safe_div(i32(7), &x)` made `caller_ok` in `tests/spec/fixtures/valid/refine_nonzero.yo` a `subset-error [untyped expression]` instead of `ok`. Before E0914 was always on, the tree passed places bare, so nothing reached it; the marker sweep for #1318 turned two guard-elision fixtures (`tests/spec/fixtures/elision/arraylist_index_{kept,proved}.yo`) red.

## Root cause

`_stash_callsite_contracts` (`src/evaluator/builtins/contracts.yo`) re-evaluates the callee's clauses at each call site with the parameters bound to unknowns of the call site's concrete argument types. `_callsite_arg_type` read that type from the argument node's ExprInfo. For `unset_flag(&c)` the node is the marker `&c`, not the lent place `c`, so `b` was bound at the marker's type and `!b` found no candidate.

The verifier's `_expr_term` (`src/verifier/vc.yo`) met the same marker node as an argument. The evaluator peels a call-site marker before typing the call, so the node carries no ExprInfo, and the walk rejected it as an untyped expression.

## Fix

`_callsite_arg_type` peels a call-site marker (`&x`, `&mut x`) and reads the place's type, as `apply_call_site_borrow_markers` does for every other rule. `_expr_term` maps an UNTYPED marker node to the lent place's term; a typed `&x` (a local borrow binding's initializer) is untouched.

Regression: `tests/spec/fixtures/valid/callsite_marker_requires.yo` (both marker forms), `tests/spec/fixtures/valid/refine_nonzero.yo` (the verifier half), and the two elision fixtures.
