# A call through a `Box(Dyn(Fn(...) -> &T))` loses its reference result

**Severity:** S2 (a valid program is rejected with a misleading E0914; found on the flip branch before it merged)

## What happened

On the decision 49 S2 flip branch, a `Box(Dyn(Fn(...)))` is the prelude's real `Box`. Its call is
dispatched through the payload (`extract_fn_trait_from_type` sees through the box), but
`closure_fn_trait_of`, which `projection_call_mode_of` reads through `fn_trait_call_func_type`, stopped at
the box. A call through `f : Box(Dyn(Fn(t : &T) -> &i32))` was then no projection. Its result bound by
`r := f(&t.*)` was no reference binding, and passing `r` on to a `&i32` parameter was E0914
(`tests/borrow_spelling.test.yo`):

```text
error[E0914]: Parameter "x" is a `&` borrow (`x : &T`): lend `r` with `&r`. ...
```

## Fix

`closure_fn_trait_of` (`src/types/utils.yo`) follows a `Box` whose payload is a `Dyn` to that `Dyn`'s
`Fn` trait, as `extract_fn_trait_from_type` does. Its other readers (the `FnMut` call rule, O7's
signature check, codegen's projection mode) now treat a `Box(Dyn(Fn))` callee as a `Dyn(Fn)` one, which
is what the pre-flip alias did.

## Tests

`tests/dyn.test.yo`, "a call through a Box(Dyn(Fn(...) -> &T)) yields a reference";
`tests/borrow_spelling.test.yo`'s `bs_via_dyn` rows.
