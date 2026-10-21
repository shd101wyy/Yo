# `return` of an array with refcounted elements emits invalid C

**Severity:** S2 — a function returning `Array(T, N)` with a refcounted `T` (`String`, a `Box`, a `dyn`) by `return(w.a)` from a borrowed struct fails at the C compiler, so the obvious accessor cannot be written.

**Status:** fixed (2026-10-21, `feat/macro-b3-collection-constructors`).
Pre-existing: the v0.2.67 seed fails the same way. Found by the adversarial
review of macro plan B3 as the sibling of
`issues/fixed/2026-10-20-ptr-write-of-an-rc-element-array-emits-invalid-c.md`
(same mechanism, different adoption site).

## Reproducer

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");
W :: struct(a : Array(String, 2));
getr :: (fn(w : &W) -> Array(String, 2))({
  return(w.a);
});
main :: (fn() -> unit)({
  w := W(a : [`l`, `r`]);
  g := getr(&w);
  println(&g(usize(1)));
});
export(main);
```

```text
error: returning '__yo_t_9952857769383863877' (aka 'struct __yo_t_6644301736545686442_struct *')
from a function with incompatible result type 'Array___yo_t_9952857769383863877_2'
```

## Root cause

The returned field read carries a deferred `___dup`. An ELEMENT-WISE dup of an
`Array(T, N)` lowers to `begin(__yo_dup_array_element(v, 0), …)`: it retains the
elements in place, and the begin block's result temp is the LAST ELEMENT. Three
return paths in `src/codegen/exprs/return.yo` adopted that temp as the
returned value unconditionally, so the function returned a `String` where its
C result type is `Array_String_2`: `generate_return` (an explicit
`return(w.a)`), and the implicit-return helpers `handle_atom_deferred_dup` (a
tail `w.a`) and `handle_func_call_deferred_dup`.

`emit_deferred_dup_or_code` (`src/codegen/exprs/drop_dup.yo`) and, since the
sibling fix, `_generate_inline_call` already require the dup's recorded type
to equal the value's (`type_key`) before adopting its temp. All three return
paths now apply the same test; on a mismatch the source value, whose elements
the in-place dup already retained, is returned (`generate_return` still counts
the dup as handled, so its drop sequence is unchanged).
`handle_func_call_deferred_dup` has no reproducer of its own; it is guarded
for consistency.

Other `Some(dvn)` adoption sites in `src/codegen/` (`and_or.yo`, `cond.yo`,
`dyn.yo`, `recur.yo`, `functions/generation.yo`) were not shown to reach this
shape; none has a reproducer.

## Test

`tests/array.test.yo`, "return of a field array of refcounted elements"
(explicit, early and tail-position returns): fails to compile (the C error
above, three sites) before the fix, passes after.
