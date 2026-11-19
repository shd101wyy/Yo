# A call returning `&[T]` or `&str` whose call may unwind spills into an undeclared temp

**Severity:** S2 — a valid program does not compile: reading the result of a call that returns `&[T]` or `&str`
(`view(&r).len()`, `v := view(&r)`) where the call may unwind, which includes every `test` body, emits C that
references an undeclared `__yo_ref_spill_N`.

**Status:** FIXED on `v0279/sized-assoc` (the `?Sized` associated-type lane, which found it while pinning a generic
`-> &T.Target` projection at `T.Target = [i32]`).

Seed `yo` 0.2.78 and develop `d8f0d89fa` both fail.

## Reproducer

`issues/repros/2026-11-19-an-unsized-projection-call-that-may-unwind-spills-into-an-undeclared-temp.yo`:

```yo
{ assert } :: import("std/assert");
Row :: struct(a : Array(i32, 3));
view :: (fn(x : &Row) -> &[i32])(&x.a.*);
main :: (fn() -> unit)({
  r := Row(a : Array(i32, 3)(i32(1), i32(2), i32(3)));
  assert(view(&r).len() == usize(3), "three");
});
export(main);
```

```text
/tmp/sized_rp.c:2318:115: error: use of undeclared identifier '__yo_ref_spill_0'
```

The emitted declaration is a comment:

```text
// Unknown type: Slice(i32) __yo_ref_spill_0 = yo_id_…((__yo_t_…*)((&(__yo_v_r))));
```

## Root cause

A projection call (decision 24) that may unwind is emitted as a statement first, for its unwind check, and its
result is held in a `__yo_ref_spill_N` temp. For an unsized pointee (decision 49) the result is the fat pair, and the
three sites in `src/codegen/exprs/other_fn_call.yo` (a method dispatch, a direct call, a call through a function
value) typed that temp with `get_type_string` of the call's result type. For the direct and function-value calls that
type is the POINTEE (`fn_result_pointee`), and `get_type_string` of `[T]` or `str` is no C type ("Unknown type"), so the
declaration became a comment. A `Dyn` pointee hid the bug: its type string is already the fat struct.

## Fix

`_projection_result_unsized_c_type` types the temp as a pointer to the pointee (`pointer_c_type_string`:
`__yo_slice_t`, `__yo_str`, a `Dyn`'s fat struct), taking either the reference or its pointee. All three sites use it.

## Verification

`tests/unsized_places.test.yo` ("an unsized projection call result is read where the call may unwind": a free
`&[i32]` and `&str` projection, read in place and bound, and a generic `?Sized` projection at `T = [i32]`) failed to
compile on develop and passes with the fix; `tests/sized.test.yo` reads a generic `-> &T.Target` projection the same
way.
