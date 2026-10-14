# A trait method named `drop` is left out of every Dyn vtable, so a call through Dyn is invalid C

**Severity:** S2 — a valid program that calls a user trait's `drop` (or `dispose`) method through `Dyn` fails in the C compiler; renaming the method works around it.

**Status:** Fixed (v0.2.63). Found by the v0.2.62 adversarial review; a regression from v0.2.61 for the name `drop` (decision 45 Generation A, #1343), and the same defect for `dispose`, which predates it.

## Symptom

```yo
Stack :: trait(drop : (fn(self : &mut Self, n : i32) -> i32));
S :: struct(top : i32);
impl(S, Stack(drop : (fn(self : &mut Self, n : i32) -> i32)({ self.top = (self.top - n); self.top })));
main :: (fn() -> unit)({
  (d : Dyn(Stack)) = dyn(S(top : i32(10)));
  r := d.drop(i32(3));
});
export(main);
```

The evaluator accepts it; clang then fails:

```
d1.c: error: no member named '__yo_v_drop' in 'struct __yo_t_..._vtable_s'
yo: error: compile: C compiler failed
```

v0.2.61 compiled it and printed `r=7`. The same program with the method named
`dispose` failed on v0.2.61 too.

## Root cause

#1343 added `|| (label == "drop")` to the two name-only filters that keep the
destructor out of a Dyn vtable: `_is_reserved_dyn_method`
(`src/codegen/types/generation.yo`, the vtable struct) and
`_is_reserved_dyn_label` (`src/codegen/functions/dyn.yo`, the wrappers and the
static vtable). They test the label alone, so every trait's method called
`drop` (and, since before #1343, `dispose`) lost its slot, while the call site
still emits `vtable->__yo_v_drop`. `_destructor_method_name`
(`src/codegen/functions/collection.yo`) already told the destructor from a
same-named method by its trait.

## Fix

`is_destructor_trait_member(trait_ty, label)` (`src/types/utils.yo`) is true
only for `drop`/`dispose` of the prelude `Drop`/`Dispose` trait (recognized by
the trait's name; codegen has no environment). The vtable struct, the
wrapper pass and the static vtable now leave out a member only when it is the
destructor trait's own; the name filters keep just `___dup`/`___drop`/
`___dispose`.

## Test

`tests/move_only.test.yo`, "Drop: a trait method named drop or dispose keeps
its Dyn vtable slot": a user trait with methods `drop(n)` and `dispose()`,
both called through `Dyn`. Before the fix the batch fails in clang (`no member
named '__yo_v_drop'` and `'__yo_v_dispose'`).
