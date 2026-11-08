# Dereferencing a projection call's result in place is an internal error

**Severity:** S2 — a valid program is rejected with an internal error: `first(&q).*` reports `check_if_function_parameter_matches_argument: arg has no ExprInfo` instead of reading the referent.

Found while testing `-> &T` projections for the `OnceCell` borrowing readers, on develop
68b45b81d.

## Symptom

```yo ignore
Pair :: struct(a : i32, b : i32);
first :: (fn(p : &Pair) -> &i32)(&p.a);
main :: (fn() -> unit)({
  q := Pair(a : i32(1), b : i32(2));
  r := first(&q);
  assert(r.* == i32(1), "bound first");           // fine
  assert(first(&q).* == i32(1), "in place");      // internal error
});
```

```
error: check_if_function_parameter_matches_argument: arg has no ExprInfo
  --> …:8:19
```

Reproducer: `issues/repros/2026-11-05-dereferencing-a-projection-call-result-is-an-internal-error.yo`.
Binding the result first (`r := first(&q); r.*`) works.

## Where to look

The `.*` of a call result is rewritten before the comparison operator matches its
arguments, and the rewritten operand carries no `ExprInfo` when the call is a projection
(decision 24's direct-call path, `projection_call_mode_of`). The internal message comes from
`check_if_function_parameter_matches_argument` (`src/evaluator/calls/helper.yo`).

## Fix

**Status:** fixed on `fix/deref-projection-call-result` (2026-11-08).

`f(x).*` on a projection call is the reference's deref: a read of the place the call names, which the bare call already is (decision 24). `evaluate_property_access` now gives the `.*` node the referent's type. It records the node as rewritten to the evaluated call (`note_rewritten_node_as`), so codegen and the place walks read the call, and every record keyed by the call's id stays where it is. Before the fix, `.*` fell through to the referent's own `.*`, and the result reached the comparison operator with no `ExprInfo`.

The `.*` node itself is what the caller keeps, so it reads as a value:

- `n := f(x).*` binds a copy. Codegen skips the projection-call reference binding for a call a written `.*` reads (`ast_call_is_deref_read`).
- `n := f(x)` still binds the reference (N1e).
- A move-only referent cannot be moved out (E0901), exactly as with `r.*`.
- `f(x).* = v` and `f(x).*.m()` act on the place in place.

**Scope:** the rule applies only where both readings agree. When the referent's own `.*` reads through it, `f(x).*` keeps its old meaning, the payload. That covers a `Box`, an `Rc`, an `Arc` and a pointer: `s.boxed().*` with `boxed -> &Box(i32)` is still the `i32`. Programs already depend on that reading, and `yo fix --migrate deref` does not rewrite them.

## Test

`tests/origins/reference_read_rule.test.yo` covers:

- "The deref of a projection call's result reads the place it names": bound, as an operand, through a method projection, the `Box` payload reading, and a bound and a temporary `Drop` holder. A move-only referent is compared, has a method called on it and is cloned out, all in place.
- "... is written in place": a free and a method `&mut` projection written through `.*`.
- `comptime_expect_error` `rr_deref_call_cannot_move`: binding a move-only referent is E0901.

The batch fails to compile on develop `a25a71ee1`.
