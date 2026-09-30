# An auto-boxed `dyn` value builds its `box(...)` call with node id 0

**Severity:** S2 — synthesized AST nodes share id 0, so the id-keyed ExprInfo table can answer one with another's entry

**Status:** FIXED 2026-09-29 (branch `tss/impl-self-operator`, the Phase 6 §3.3 census).
**Found:** the `yo check --test-bodies` census over `tests/**/*.test.yo`
(`plans/TYPE_SYSTEM_SOUNDNESS_HANDOVER.md` §3.3, site #8): `tests/closure.test.yo` failed
strict with a location of `1:1`, on develop `c52ce152c` and on the Phase 3 step 7 branch.

## Symptom (measured)

```rust
{ assert } :: import("std/assert");
test("an auto-boxed closure in a test body", {
  x := 1;
  (closure : Dyn(Fn(y : i32) -> i32)) = dyn(y => {
    x = (x + y);
    return(x);
  });
  assert(closure(1) == 2, "called");
});
```

```
$ yo check main.test.yo --test-bodies
error[E0606]: box is not callable: it has type unit.
  --> main.test.yo:1:1
```

The same body with an explicit `box(...)` passes, and so does the same code in a function body.
The two failing tests in `tests/closure.test.yo` are exactly the two that rely on auto-boxing
("… captures Rc object with auto boxing", "a closure captured by a Dyn closure field releases
its captures").

## Root cause

`evaluate_dyn_value`'s executing path (`src/evaluator/values/dyn.yo`) wraps a non-object value
in a synthesized `box(value)` (or `arc(value)`) call and evaluates it. It built both nodes with
`usize(0)` as their id:

```rust
box_atom := AstExpr.Atom(usize(0), box_tok);
box_call := AstExpr.FnCall(usize(0), box_atom, box_args, false, expr_tok);
```

The ExprInfo side table is keyed by node id, and id 0 is shared by every other node built that
way, so the callee atom's evaluation could read an entry some other id-0 node left behind — in
the test-body trial, a `unit`-typed one. The non-executing path a few lines above already mints
fresh ids (`alloc_global_expr_id()`); the executing path did not.

`evaluate_type_join_fields` (`src/evaluator/builtins/type_fns.yo`) had the same shape: the
combined `Expr` it returns (spliced into derive bodies and evaluated) was built from id-0 nodes.

## Fix

Both sites mint fresh ids with `alloc_global_expr_id()`. The remaining `AstExpr.Atom(usize(0),
…)` in `evaluator/types/function.yo` is an unreachable placeholder that is never evaluated.

## Test

`tests/cli-cases/check-test-bodies-auto-boxed-dyn`: `check --test-bodies` on the body above
exits 0. It fails before the fix with the E0606 above.
