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

## Test

The fix adds the reproducer's in-place read as a test case and moves this doc to
`issues/fixed/`.
