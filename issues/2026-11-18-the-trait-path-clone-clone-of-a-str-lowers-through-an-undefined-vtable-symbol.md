# The trait-path `Clone.clone` of a `str` lowers through an undefined vtable symbol

**Severity:** S2 — a valid program's C references a vtable struct that is never defined, so the link fails
(`undeclared identifier`/undefined symbol); reachable through the direct trait-member spelling, found by
the f1 lane while probing the reachability of `issues/fixed/2026-11-17-str-clone-derefs-its-fat-reference-receiver-and-emits-invalid-c.md`.

## Reproducer

```yo
{ assert } :: import("std/assert");
main :: (fn() -> unit)({
  s := "abc";
  assert((Clone.clone)(s) == "abc", "the trait path");
  ()
});
export(main);
```

The emitted C calls through a dyn vtable constant that is never defined (no `static ... __yo_t_<hash>`
declaration anywhere in the file):

```c
__yo_str temp = (((__yo_str (*)(void*))__yo_t_1637200123826594650.__yo_v_clone)((void*)(__yo_v_s)));
```

The sibling spelling `(str.clone)(s)` — the impl member spelled directly — lowers to a plain call of the
impl's function and is FINE (it is the case the emitter fix above repaired).

## Root cause (first cut)

`(Clone.clone)(...)` resolves the trait member through the dyn-erasure machinery: the call is emitted as a
vtable slot read `__yo_t_<hash>.__yo_v_clone` over a `Dyn(Clone)`-shaped fat pair, but no `Dyn` value was
built and no vtable for `str : Clone` was synthesized or referenced into the file — the receiver `s` (the
`&(str, static)` pair) is cast to `void*` and the undefined constant's slot is called. The dyn vtable
lowering of a fat-reference `Clone` (the #1983/#1970 area — `Deref` projections and the vtable cell work)
does not cover a trait-path call whose Self is the unsized `str`.

## Disposition

v0.2.80, with the dyn vtable work. Not fixed by the emitter fix above (that one only repairs the deref
emission); the reachability fix (#1993) does not route around it either (`(Clone.clone)` is a direct path,
not the `.clone()` method call it intercepts). A fix likely either synthesizes the missing
`Dyn(Clone)`-over-`str` vtable or resolves the trait member to the prelude impl's function statically — a
design call for the vtable lane.
