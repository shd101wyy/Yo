# A generic negative `Sized` or `Escapable` impl is accepted

**Severity:** S3 — `impl(generic(T : Type), Holder(T), !(Sized()))` checks clean, while the concrete `impl(H, !(Sized()))` is rejected because `Sized` is derived from a type's structure.

Filed 2026-11-26 by the `bound-s1` lane during the marker-trait audit for
`issues/fixed/2026-11-25-a-generic-or-aliased-send-impl-skips-the-allow-unsafe-gate.md`.
Reproduced with a stage 1 of `fix/bound-forms-and-send-gate`.

## Reproducer

```yo
Holder :: (fn(comptime(T) : Type) -> comptime(Type))(struct(v : T));
impl(generic(T : Type), Holder(T), !Sized());
main :: (fn() -> unit)({
  ()
});
export(main);
```

`yo check` exits 0. The same with `!(Escapable())`.

## Root cause

`evaluate_module_value` (`src/evaluator/values/impl.yo`) rejects `!(Sized())` and `!(Escapable())` only in Case 3 (a concrete
receiver), and there by the written name (`ast_expr_text(&neg_head).* == "Sized"`). Case 2's negative branch looks the trait up
and registers the negative generic impl with no such check, so an alias slips through the concrete path too.

## Fix

Check the resolved negated trait in both cases, the way `_throw_if_unimplementable_marker_impl` checks a positive one.
