# An unsized projection call's place lent to a reference parameter spills an undeclared temporary

**Severity:** S2 — a valid program fails to compile in C: `f(&b.view().*)` and `b.view().*.len()` with `view : fn(self : &Self) -> &[T]` emit `&(__yo_ref_spill_N)` for a temporary whose declaration is commented out.

**Status:** fixed by the argument hunk of the `str` flip (#1980), which `vbd/d49-deref-owner` (VERDICTS-63
Generation A) carried until #1980 merged; the regression row is in `tests/deref_owner.test.yo`.

Found 2026-11-16 by the deref-owner lane: probe p3e of VERDICTS-63, which passed on the 2026-11-15 develop build
`yo-dt6`, fails on develop `223b188f4`. Every owner's `.*` is such a place (`&b.*` lowers to `b.deref()`), so
Generation A could not run without the fix.

## Reproducer

```yo
pragma(Pragma.AllowUnsafe);
{ assert } :: import("std/assert");
Buf :: struct(items : Array(i32, 4), n : usize);
impl(
  Buf,
  view : (fn(self : &Self) -> &[i32])({
    p := unsafe(__yo_slice_ptr(unsize(&self.items)));
    part := unsafe(__yo_slice_from_raw_parts(p, self.n));
    &part.*
  })
);
count :: (fn(xs : &[i32]) -> usize)(xs.len());
main :: (fn() -> unit)({
  b := Buf(items : Array(i32, 4)(1, 2, 3, 4), n : usize(2));
  assert(count(&b.view().*) == usize(2), "as an argument");
  assert(b.view().*.len() == usize(2), "as a receiver");
});
export(main);
```

```text
// Unknown type: Slice(i32) __yo_ref_spill_0 = yo_id_…((&(__yo_v_b)));
int32_t … = yo_id_…((__yo_slice_t)((&(__yo_ref_spill_0))));
error: use of undeclared identifier '__yo_ref_spill_0'
```

## Root cause

#1970 (decision 49 flip A) made an unsized projection call's code the fat pair itself instead of `(*call)`. A `&[T]`
parameter keeps the pointer ABI, so `_apply_ref_amp` (`src/codegen/exprs/other_fn_call.yo`) addresses the argument:
the pair is not an addressable C expression, so it is spilled into a temporary typed by the place type `Slice(i32)`,
which `get_type_string` cannot spell, and the declaration is emitted as a comment.

## Fix

`_apply_ref_amp` passes an argument whose place type is unsized, or whose type is a reference to an unsized pointee,
as the fat pair (`unsized_place_fat_code`): a `(*fat)` place folds to `fat`, and anything else is the pair already.
The hunk landed with the `str` flip (#1980), whose string-literal arm also folds a `"lit"` argument to a `&str` slot.

## Verification

`tests/deref_owner.test.yo` ("&b.* lends the view: …"): `_sum(&RawBuf.deref(&b).*)` and
`RawBuf.deref(&b).*.len()`, plus every `&b.*` argument and view-method receiver of the file.
