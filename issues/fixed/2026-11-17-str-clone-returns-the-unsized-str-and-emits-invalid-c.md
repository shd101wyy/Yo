# `s.clone()` on a `&str` returns the unsized `str` and emits invalid C after the `str` flip

**Severity:** S2 — `s.clone()` on a string view either failed to compile in C (`return (*__yo_v_self);` over a
`__yo_str`) or, bound to a local, was rejected with E0619. `tests/copy_trait.test.yo` failed to compile on develop
`916b279c1` and `b2155b8bf`.

**Status:** FIXED on `fix/develop-v0279-reds`.

## Reproducer

```yo
{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  s := "abc";
  t := s.clone();
  println(&t);
  u := (s.clone() == "abc");
  println(&u);
});
export(main);
```

`t := s.clone()` was E0619 (`str` is not `Sized`: the local `t` needs a size). Without the binding, the
comparison type-checked and the C did not compile:

```text
error: indirection requires pointer operand ('__yo_str' invalid)
  return (*__yo_v_self);
```

## Root cause

After #1980 `str` is unsized and `&str` is the fat reference. The prelude still carries
`impl(str, Clone(clone : (self -> self.*)))` and `impl(str, Copy())` from when `str` was the sized view. Their target
is now the unsized `str`, so `clone(self : &str) -> str` returns an unsized value by value. The receiver lookup on a
`&str` derefs to `str` and finds that impl. The body `self.*` is a read of an unsized place through a borrow, which
`_var_read_code` emits as `(*self)` (the convention #1980 added), and `self` is the fat pair by value in C.

Rust has no such impl: `str` is not `Clone`, and `s.clone()` on `s : &str` is `<&str as Clone>::clone`, which returns
the `&str`. A shared reference is already `Copy` and `Clone` structurally in `type_implements_trait` (decision 43).

The impls cannot simply be deleted: the v0.2.78 seed builds the compiler against `./std`, its `str` is still sized, and
without `impl(str, Copy())` it rejects `std/encoding/utf8.yo` (E0901, measured). S3b-`str` (v0.2.80) deletes them with
the alias.

## Fix

`src/evaluator/calls/function.yo`: a `clone()` whose receiver is a `str` view (a `&str`, or the unsized `str` a `&str`
binding reads as in receiver position, `_is_str_view_receiver_type`) clones structurally before the receiver lookup
(`_structural_clone_precedes_lookup`). The call expands to its receiver, typed as the binding's own `&str` slot, so the
prelude impl is never reached. `impl(str, Clone)` and `impl(str, Copy())` are deleted by S3b-`str`, on a seed that has
the flip.

## Verification

The reproducer prints `abc` and `true`. `tests/copy_trait.test.yo` (the row "a str view clones as itself") failed to
compile before the fix and passes after.
