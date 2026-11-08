# A shared capture is typed as a `&mut` reference inside the closure body

**Severity:** S2 — a valid program is rejected: a `{ rx : &x }` capture stored into a `&` payload is E0601

Found 2026-11-08 by the advisor's consult on O-3 (VERDICTS-37 §4), on the tree binary at develop `a25a71ee1` and the
v0.2.75 seed.

## Reproducer

```yo
{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  x := i32(1);
  mut(slot) := Option(&i32).None;
  (c : Impl(FnMut() -> unit)) = ({ s : &mut slot, rx : &x }() => {
    s.* = .Some(rx);
  });
  c();
  match(slot, .Some(r) => println(`OUT: ${r.*.to_string()}`), .None => println("none"));
  ()
});
export(main);
```

`yo check` reports E0601 "Incompatible types for field `value`: Expected `&i32`, Given `&mut i32`". Reading the capture
into a `bool` reports E0926 "`rx` is a reference (`&mut i32`)". A write through it, `rx.* = i32(5)`, is still E0902, so
the mistyping was not unsound; passing `rx` to a `&i32` parameter was accepted because the argument path coerces.

## Root cause

A borrow capture binds with `variable_set_is_ref(&cv, true)` (`src/evaluator/values/anonymous_function.yo`). The
flags alone make every `is_ref` binding a `&mut` reference (`_variable_reference_mut` in `src/env.yo`), and nothing
stated the mode the capture was written with.

## Fix

The capture binding states its written mode, `variable_set_reference_mut(&cv, ce.is_mut)`, as a local borrow's binding
site does: `rx : &x` reads as `&i32`, `s : &mut slot` as `&mut`.

## Test that pins it

`tests/closure_capture_list.test.yo`, "a `&` capture reads as a shared reference and stores into a `&` payload".
