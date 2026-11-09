# A function-value call reads a borrow slot over a reference as a by-value reference

**Severity:** S2 — valid programs are rejected: a function value or generic callee whose parameter is `& &T` (or `&A`
with `A` bound to a reference) rejects every argument, so std's `map`/`filter`/`fold`/`find` over an iterator whose
`Item` is a reference cannot be called

Found 2026-11-08 while landing P3 (`&&T`, `plans/backlog/BORROW_CHECKER_COMPLETENESS.md` §7) with its required
`&&T` adapter-closure test. Not reachable on develop before P3: the parameter wall rejected `& &T`, and an adapter over
a reference `Item` failed earlier (E0920 at `v.*.*`).

## Reproducer

```yo
_g :: (fn(v : & &i32) -> i32)(v.*.*);
apply :: (fn(item : &i32, f : (fn(item : & &i32) -> i32)) -> i32)({
  rr := &item;
  f(rr)
});
main :: (fn() -> unit)({
  x := i32(4);
  _n := apply(&x, _g);
  ()
});
export(main);
```

```
error[E0601]: Cannot unify incompatible types: "i32" and "&i32"
  --> tmp/fixme.yo:4:5
  |
4 |   f(rr)
  |     ^^
```

`f(&r)` on a local `r : &i32` and std's `(self._f)(&item)` inside `IterMap.next` report the same error. A call of the
NAMED function (`_g(&item)`) was accepted, because a non-generic named callee's arguments are checked elsewhere.

## Root cause

`check_if_function_parameter_matches_argument` (the argument check for generic callees and function values) receives a
borrow slot's POINTEE as its parameter type: for `v : & &i32` that is `&i32`. Two of its rules read a reference-typed
parameter type as "this slot takes a reference value", which was true only while a borrow slot's pointee could never be a
reference:

- the expected type it installs for the argument's evaluation is `&i32`, so the read rule (`reference_read_wanted`,
  decision 43 step 2 N1e-2b) read a reference binding `rr` as the reference VALUE `&&i32` instead of the place `&i32`;
- the T9 lend (a by-value `&T` parameter takes a lend of the place) wrapped `&r`'s self place (`&i32`) into `&&i32`.

Either way the argument was one reference deeper than the slot's pointee.

## Fix

A borrow slot whose pointee is a reference (`slot_of_reference`: the parameter is not by value and its resolved type is
a reference) takes a PLACE of that reference type. The check installs no expected type for it, and skips the T9 lend. The
forced self lend at such a slot (`&r` lends `r` itself in every tree) reads the same predicate.

## Test that pins it

`tests/ref_of_ref.test.yo`: "a function value with a & &i32 parameter takes &r and a &&i32", and "an adapter closure
over a reference Item takes a &&T".
