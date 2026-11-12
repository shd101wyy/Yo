# A tuple of by-value reference parameters emits invalid C

**Severity:** S2 — a program the evaluator accepts fails in the C compiler: `(b, a)` built from by-value `T` parameters specialized at `T := &i32` (R3) takes the parameters' addresses, `const int32_t **` where the tuple's fields are `const int32_t *`.

- Filed: 2026-11-12 (smpick lane, probing the tuple shape of the generic by-value result whose second argument's origin was dropped, `issues/fixed/2026-11-12-a-generic-by-value-result-at-a-reference-type-drops-its-second-arguments-origin.md`).
- New since #1904 (R3): the v0.2.76 seed rejected the program with E0901 (the tuple was a move-only borrow).

## Reproducer

```yo ignore
{ println } :: import("std/fmt");
_sm_swap :: (fn(generic(T : Type), a : T, b : T) -> Tuple(T, T))((b, a));
main :: (fn() -> unit)({
  x := i32(1);
  y := i32(2);
  rx := &x;
  ry := &y;
  p := _sm_swap(rx, ry);
  (v : i32) = p.0.*;
  println(&v);
});
export(main);
```

`yo compile` fails in clang:

```text
error: incompatible pointer types initializing 'const int32_t *' (aka 'const int *') with an expression of type 'const int32_t **' (aka 'const int **'); dereference with * [-Werror,-Wincompatible-pointer-types]
  ... = (__yo_t_...){ ._0 = (&(__yo_v_b)), ._1 = (&(__yo_v_a)) };
```

## Root cause (first read)

The tuple literal's components are recorded as LENDS of the parameters' own storage (their converted runtime type is a
`Reference`, T9), so codegen's `_lend_field_addr` takes `&b`. A by-value reference parameter (`ValueSlot(&U)`, R3) is a
reference VALUE: the component is the pointer itself, as `_generate_runtime_enum_construct` already decides for an enum
payload (`f_is_value_ref`, `src/codegen/exprs/other_fn_call.yo`). The evaluator should not record the lend in the first
place.

## Status

Fixed 2026-11-12 (tuplec lane). The result's origins are right through `generic_result_binder_modes` (the smpick
fix, `issues/fixed/2026-11-12-a-generic-by-value-result-at-a-reference-type-drops-its-second-arguments-origin.md`).

## Fix

The first read above was off: the tuple literal records no lend for a bare element. The anonymous-tuple emitter
(`_build_tuple`, `src/codegen/exprs/tuple_fn.yo`) took the address of EVERY element whose type is a reference,
which is right only for a lend (`&x`, `&r.*`: the place, recorded through `lend_place_reference_type`). A
reference VALUE — a by-value `a : T` at `T := &U` (R3's `ValueSlot`), or a `-> T` call's result there
(`(rr_id(r), i32(3))`, which took `&(call())` of a C rvalue) — is the pointer itself. The predicate the enum
payload emitter already used (#1904) is now one helper, `reference_operand_is_value`
(`src/codegen/exprs/other_fn_call.yo`), shared by `_generate_runtime_enum_construct` and `_build_tuple`. A struct
constructor's reference field was already right (`_lend_field_addr` keys on the recorded lend alone); an
`Array(T, N)(…)` at `T := &U` already compiled. The non-generic `Array(&U, N)(…)` constructor is a separate,
pre-R3 defect: `issues/2026-11-12-an-array-constructor-over-a-reference-element-type-emits-invalid-c.md`.

Test: `tests/origins/reference_read_rule.test.yo`, "a tuple of by-value reference parameters holds the
references" (swap, a reference beside a value, a local tuple of the parameters, a `-> T` call's result as an
element, and the `T := i32` instance beside them). It failed in clang on develop `4f8f975b3` and passes.
