# A `&T` parameter stored through a sibling `&mut` parameter dangles

**Severity:** S1: memory unsafety in an accepted program. A function that stores a
`&T` parameter into a reference-holding `&mut` parameter
(`dst.* = .Some(v)`) stores the address of the callee's by-value copy of the
argument. The copy dies with the call, so the caller's holder points at dead stack.
The checker accepts the program: O3-3 admits the store, and it is the corpus row
`store-same-origin` (ACCEPT).

> Found 2026-11-05 by the N2c design review (VERDICTS-23 §1, R2) on develop
> 68b45b81d (decision 43 step 3).

## Reproducer

```yo
pragma(Pragma.AllowUnsafe);
{ println } :: import("std/fmt");
_store :: (fn(generic(p : Origin), dst : &mut Option(&(i32, p)), v : &(i32, p)) -> unit)({
  dst.* = .Some(v);
});
main :: (fn() -> unit)({
  x := i32(7);
  mut(slot) := Option(&(i32, x)).None;
  _store(&mut slot, &x);
  match(slot, .Some(r) => println(addr_of(r.*) == addr_of(x)), .None => println("none"));
});
export(main);
```

This prints `false`: the held reference is not `x`'s address.

## Root cause

Decision 34's ABI passes a `&T` parameter by value unless it "may outlive the call".
`fn_param_is_ptr_borrow` (src/types/utils.yo) asked that only of the RESULT: a borrow,
or a type carrying an origin (#1771). A sibling parameter whose value type carries an
origin (`&mut Option(&(i32, p))`, `&mut ArrayList(&U)`) can store the reference too.

## Fix

`fn_param_is_ptr_borrow` is also true when any parameter slot's value type (a
reference slot's pointee) carries an origin, the slot's own included. The ABI
readers and the parameter binders all consult this one predicate. Test:
`tests/addr_of.test.yo` ("a &T parameter a sibling may store is the caller's
place").
