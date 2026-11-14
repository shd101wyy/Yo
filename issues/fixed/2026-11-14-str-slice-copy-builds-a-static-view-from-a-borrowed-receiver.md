# `str.slice_copy` builds a static view from a borrowed receiver

**Severity:** S2 — `s(a..b)` on a `&str` that does not point at static bytes would return a `str` (a static view)
over those bytes, outliving them; the `static` origin check never sees it because the view is made by
`str.from_raw_parts`.

Found 2026-11-14 by the d49-str lane (VERDICTS-62 decision 2, Fable's probes in `v0273/fable/probe-62/`).

## The defect

`std/prelude.yo` declared the range subscripts of `str` over a borrowed receiver:

```yo ignore
slice_copy : (fn(self : &Self, r : &Range(usize)) -> Self)({
  e := cond((r.end > __yo_str_len(self)) => __yo_str_len(self), true => r.end);
  st := cond((r.start > e) => e, true => r.start);
  __yo_str_from_raw_parts(__yo_str_ptr(self).add(st), e - st)
}),
```

The result `Self` is the static view `str`, but the bytes it covers are the receiver's. The receiver is `&str`. On
v0.2.77 a `&str` points at a `str` value, and safe code has no way to make a `str` value over non-static bytes, so
the hole is not reachable there. Decision 49 S2 makes `str` unsized and `&str` the fat reference: then `&str`
covers any bytes (a `String`'s through `as_str`, a buffer's through `str.from_utf8`). `s(a..b)` on such a
reference would return a view typed `&(str, static)` over heap bytes, which outlives them. The check that a
non-static reference does not flow into a `static` position (P12) does not see it, because `from_raw_parts` is the
unchecked introduction of a static view.

## Fix

`slice_copy` and `slice_copy_inclusive` take `self : Self`, and their bodies read `self.len()`/`self.ptr()`. The
window is static because the receiver is a static view. `s(a..b)`, `s(a..=b)`, `s.slice_copy(&r)` and a field
receiver (`h.name(a..b)`) all keep working: a value `str` receiver is passed by value.

The same PR respells the prelude's three read intrinsics, `__yo_str_len`, `__yo_str_ptr` and `__yo_str_byte`, as
`(s : &str)`, which is their final type. It also re-asserts a static view for the call only at the three copy-in
sites that pass a `&str` receiver to a value-`str` parameter (`ToString(str)`'s `to_string` and `append_to`,
`ToJson(str)`). Each carries a SAFETY comment; S3b-`str` deletes them when the copy-in parameters take `&str`.

## Verification

`tests/str.test.yo`, "slice_copy takes its receiver by value…", binds `str.slice_copy` and
`str.slice_copy_inclusive` to `fn(s : str, r : &Range…(usize)) -> str` values and checks the windows. Before the fix
it is E0601 ("Parameter 1 is `s : str` in the expected type and `self : &str` in the given one"). After the fix it
passes.
