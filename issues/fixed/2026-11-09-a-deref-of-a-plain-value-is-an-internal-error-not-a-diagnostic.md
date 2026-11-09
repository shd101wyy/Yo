# `.*` on a plain non-reference value (`x.*` with `x : i32`) is an internal error, not a diagnostic

**Severity:** S3. A malformed program (a dereference of a value that is not a
reference, pointer or `Deref` type) is reported as an evaluator internal error
with no hint, or as "Failed to evaluate, got (z.(*))".

Found 2026-11-09 by the bugs lane while triaging
`issues/2026-11-08-a-projection-call-as-a-blocks-tail-binds-without-exprinfo.md`:
its reproducer binds `z := { ...; first(&x) }`, which binds the VALUE (an
`i32` copy), and then reads `z.*`.

## Reproducer

```yo ignore
{ assert } :: import("std/assert");
main :: (fn() -> unit)({
  x := i32(1);
  assert(x.* == i32(1), "m");
});
export(main);
```

```text
error: check_if_function_parameter_matches_argument: arg has no ExprInfo
  --> t.yo:4:11
```

and `q := x.*;` reports `error: Failed to evaluate, got (x.(*))`.

## Cause

`evaluate_property_access` (`evaluator/exprs/property_access.yo`) handles `.*`
on a reference binding (E0xxx deref-of-borrow) and falls through for any other
object to the field lookup ("Not a pointer, fall through"); for a scalar type
nothing is found and the node is left without an `ExprInfo`.

## Expected

A diagnostic at the `.*` naming the operand's type: `x` is `i32`, a value, and
`.*` applies to references, raw pointers and `Deref` types. Not fixed in this
lane: it needs a decision on where the check lives (a type with a `Deref` impl,
a raw pointer, an `*` field and the CTFE reference parameters all share the
fall-through), so it is filed with its reproducer and no test yet.

## Fixed

Adopted verdict: `VERDICTS-41` Q1 (second half), new code E0621
`E_DEREF_OF_VALUE` (Rust's E0614, a type error: E0620 is reserved for a plain
`dyn(v)`, and E0920's number is spent).

**Root cause.** The `.*` ladder in `evaluate_property_access` consumes every
legal `.*` (a reference binding, a CTFE reference parameter, a projection
call, a reference-typed place, the E0920 branch) and then fell through to the
field lookup, which for a plain value finds no member and leaves the node
without an `ExprInfo`.

**Fix.** The last arm of the ladder, guarded by `_is_written_star`, throws
E0621 when the operand's type is not dereferenceable (`_type_is_dereferenceable`:
a reference, a raw pointer or a handle `.*` reads through, a `Deref` type, a
type declaring a field `*`). A type value, a module and a type still holding
open type variables are exempt. `yo explain E0621` (en and zh-CN) and the
`explain-list` golden carry the entry.

**Test.** `tests/origins/reference_read_rule.test.yo`: `x.*` on an `i32`
(operand and bound), on a struct, on a non-atom expression, and the positive
twins (reference binding, `Box`, `Rc`, raw pointer);
`tests/internal/diagnostics_registry_examples` checks the registry example.
