# A `&mut`-capturing closure answers `Copy` and `Clone`

**Severity:** S2 — `Type.impls(type_of(t), Copy)` held for a closure with a `&mut` capture, so a `Copy` or `Clone` bound accepted a value whose copy would alias an exclusive borrow

**Found:** 2026-10-14, while fixing `issues/fixed/2026-10-14-a-closure-owning-a-string-copies-implicitly.md`.
**Status:** FIXED 2026-10-14.

## Symptom

```yo
main :: (fn() -> unit)({
  n := i32(0);
  {
    (t : Impl(Fn() -> i32)) = ({ &mut n }() => {
      n = (n + i32(1));
      n
    });
    comptime_assert(!Type.impls(type_of(t), Copy), "mut capture closure is not Copy");
  };
});
export(main);
```

failed the assertion. A copy of `t` was already a move (the closure is
move-only, `type_is_move_only`), but the trait answer disagreed with it, and
decision 36's test list says the structural rule "must not derive `Copy`" for
such a closure (audit #1251 finding 7).

## Cause

The structural rule (`copy_structural_parts`, `type_implements_trait`,
`src/evaluator/trait_checking.yo`) asked only whether every capture field is
`Copy`. A `&mut` capture's field is a pointer, which is.

## Fix

The structural branch answers no, for `Copy` and `Clone`, when the type holds a
`&mut` capture-list borrow (`type_first_mut_borrow`): a copy would alias the
borrow, and a clone could only copy it.

Tests: `tests/copy_trait.test.yo` ("a &mut capture makes a closure neither Copy
nor Clone").
