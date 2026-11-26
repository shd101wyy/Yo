# A struct field or an associated type typed by a bare trait is accepted without a word

**Severity:** S3 — `struct(v : T1)` and `trait(Item : ToString, ...)` check clean, though neither means anything: a field has one type (`Impl(T1)`, `Box(Dyn(T1))`), and an associated type's kind is `Type` with its bound in the trait's `where(Self.Item <: ToString)`. The mistake surfaces later, far from where it was written, or never.

Filed 2026-11-26 by the `v81-v84-pr2` lane from VERDICTS-84 §7 item 3 (probes `f3` and `b6` in `fable/v84-probes/`).
Reproduced with yo 0.2.79 + develop `fc89e3195` (the VERDICTS-84 probe binary).

## Reproducer

```yo
T1 :: trait(get : (fn(self : &Self) -> i32));
S :: struct(v : T1);
Src :: trait(
  Item : Clone,
  next_item : (fn(self : &mut Self) -> Option(Self.Item))
);
main :: (fn() -> unit)({
  ()
});
export(main);
```

`yo check` exits 0 on both definitions (`f3`, `b6`: "rc=0, silent").

## Root cause

A struct field's type is evaluated and stored with no test for a trait that has no receiver (`TraitT` with
`is_concrete == .None`), and `_evaluate_trait_field` (`src/evaluator/types/trait.yo`) records a member whose
type is such a trait as an ordinary member: the associated-type path only fires for a `Type` kind. The only
check for a bare trait in a type slot was the parameter path's "Trait type without receiver type set cannot be
used as function parameter type", so a field, a result and a local each had a different (or no) reading.

## Fix

One rule, two codes (VERDICTS-84 §4): a bare trait never follows an annotation `:`.

- A value's type (a parameter `a : T1` or `a : &T1`, a result `-> T1`, a binding `(x : T1) = v`, a struct field
  `struct(v : T1)`) is E0625, naming `Impl(T1)`, `&Dyn(T1)` and `Box(Dyn(T1))`
  (`trait_as_value_type_error`, `src/evaluator/utils.yo`).
- A binder's kind slot (`generic(T : T1)`, `comptime(T) : T1`, `generic(T : (A, B))`, `generic(T <: T1)`) and an
  associated type's (`trait(Item : Clone, ...)`) is E0624; `yo fix` moves the bound into the `where(...)` in two
  one-edit passes (`throw_bound_in_kind_slot`, `src/evaluator/types/function.yo`).

Tests: `tests/where-clause-fn-inference.test.yo` (the `FormField` and `FormAssocBound` cases),
`tests/cli-cases/fix-moves-a-bound-out-of-a-kind-slot`, `tests/cli-cases/a-trait-as-a-value-type-is-e0625`.
