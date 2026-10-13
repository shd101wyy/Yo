# `__yo_return_self` dereferences its argument unconditionally, so a primitive `clone` under a `self : &Self` receiver emits `(*value)` and the compiler does not build

**Severity:** S1 — bootstrap breakage: with `Clone.clone` taking
`self : &Self`, the v0.2.59 seed emitted C for the compiler that
dereferenced a `u8`/`usize`, and `yo build` failed in the C compiler.

Found 2026-10-13 while switching `Clone.clone` to `self : &Self`
(`issues/fixed/clone-and-to-string-take-their-receiver-mutably.md`).

## Symptom

`yo build --std-path ./std` with the seed, on a tree whose prelude declared
`clone : (fn(self : &Self) -> Self)` and still wrote the primitive clones as
`clone : (self -> __yo_return_self(self))`:

```text
yo-out/aarch64-apple-darwin/bin/yo.c:130795:131: error: indirection requires pointer operand ('int' invalid)
 130795 |       yo_id_..._u8_rtparam1_u8_ret_unit((&(__yo_v_result)), (*__yo_v_item));
yo-out/aarch64-apple-darwin/bin/yo.c:251400:137: error: indirection requires pointer operand ('size_t' (aka 'unsigned long') invalid)
```

and, in a derived clone over `usize` fields,
`.__yo_v_row = (*__yo_v_self.__yo_v_row)`. Sixteen such errors in all:
`ArrayList(u8).clone`'s `result.push(item.clone())` and every
`derive(Clone)` over a primitive field.

## Root cause

`__yo_return_self : (fn(generic(T : Type), self : &T) -> T)` is an inline
builtin, and its codegen (`src/codegen/exprs/inline_fns.yo`, the
`BF_YO_RETURN_SELF` arm) is `(*arg)`: it assumes the receiver arrives as a
pointer. A `self : &mut Self` receiver did (the inline-call path takes its
address, `_apply_ref_amp` in `src/codegen/exprs/other_fn_call.yo`). A
`self : &Self` receiver of a scalar does not: `fn_abi_param_is_ptr` passes
a small `&T` by value, so the argument is the value itself and `(*value)`
does not compile.

## Fix

The prelude's primitive, `bool`, `str` and raw-pointer `Clone` impls are
now `clone : (self -> self)`: a plain copy out of the borrow, which every
emitter lowers correctly whatever the receiver's ABI. `__yo_return_self`
has no caller left in `std/`, `src/` or `tests/`. The builtin itself still
carries the `(*arg)` lowering; deleting it (the prelude `extern("Yo", ...)`
entry, `BF_YO_RETURN_SELF` in `src/expr.yo`, `src/codegen/constants.yo`,
`src/codegen/exprs/inline_fns.yo` and the builtin list in
`src/evaluator/effects/mutation_summary.yo`) is left for a follow-up.

Regression coverage: the compiler build itself (it failed before the fix),
plus `tests/derive.test.yo`, `tests/derive_clone_complex.test.yo` and
`tests/copy_trait.test.yo`, which clone primitive fields and lists of
primitives, and `tests/parameter_modes.test.yo` "Clone and ToString read a
& borrow".
