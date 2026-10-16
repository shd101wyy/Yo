# An unapplied-constructor call rejects its receiver's borrow marker

**Severity:** S3 — `Rc.make_mut(&mut h)`, Rust's spelling, is rejected with a message that says `&mut h` is not a call argument, although it is one; `Rc(T).make_mut(&mut h)` with the type arguments written compiles.

**Found:** 2026-10-16, by decision 46 Generation A (`feat/vbd-d46-gena`), writing the `Rc.make_mut` tests.

## Reproducer

develop at 3151f8e96 (any method with a `self : &mut Self` receiver, called through an unapplied constructor, decision 32):

```yo
{ println } :: import("std/fmt");
Pair :: struct(a : i32, b : i32);
impl(Pair, Clone(clone : (fn(self : &Self) -> Self)(Pair(a : self.a, b : self.b))));
main :: (fn() -> unit)({
  h := rc(Pair(a : i32(1), b : i32(2)));
  Rc.make_mut(&mut h).a = i32(10);
  println(`${h.a.to_string()}`);
});
export(main);
```

```text
error: `&mut x` lends a place to a `&mut T` parameter: it is written as a call argument, a `match` scrutinee or a local borrow (`y := &mut x`), and is not an expression of its own. Pass the place itself, or take a raw pointer with `addr_of(x)`.
6 |   Rc.make_mut(&mut h).a = i32(10);
```

## Root cause

`G.m(x, ...)` through an unapplied constructor resolves `G` from `x`'s type and then calls `m` in method form (`try_to_call_function_with_arguments(..., is_method_call = true, ...)`), so `apply_call_site_borrow_markers` treats position 0 as a method-form receiver (`xs.m()`), which it never peels. In this call form the receiver is written as an argument, so its marker is a call-site marker: left unpeeled, it reached the evaluator as an expression and hit the "not an expression of its own" error.

## Fix

`src/evaluator/calls/function.yo`, the unapplied-constructor arm of the method dispatch: the receiver argument is run through `apply_call_site_borrow_markers` against the method's `self` parameter (with `first_is_receiver = false`) before the method-form call, so `&mut h` is checked against `self : &mut Self` and peeled, and a wrong marker gets the usual E0914 message. `_infer_unapplied_ctor_receiver` reads the place under the marker to infer `G`'s arguments.

## Verification

`tests/rc.test.yo` ("Rc.make_mut on the only handle writes the payload in place", "Rc.make_mut on a shared handle clones the payload first") and `tests/arc.test.yo` ("Arc.make_mut clones a shared payload and writes a unique one in place") call `Rc.make_mut(&mut h)` / `Arc.make_mut(&mut b)`; their batches failed to compile with the error above before the fix.
