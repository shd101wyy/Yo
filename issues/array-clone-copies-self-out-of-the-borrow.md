# `Array(T, N).clone` is E0901 for a `Clone`-but-not-`Copy` element

**Severity:** S2: a valid program is rejected. `Array(Q, 2).clone()` fails although `Array(T, N) <: Clone` holds under `where(T <: Clone)`.

**Status: OPEN.** Found 2026-10-14 by the v0.2.62 batch review. **Measured on:** develop a89b8356c (the v0.2.62 candidate) and v0.2.61; both fail the same way.

## Symptom

```yo
Q :: struct(r : usize, b : bool);
derive(Q, Clone);
main :: (fn() -> unit)({
  qs := Array(Q, 2)(Q(r : usize(1), b : true), Q(r : usize(2), b : false));
  qs2 := qs.clone();
});
export(main);
```

`error[E0901]: use of moved value: cannot copy self, whose type Array(Q, 2) is copied only explicitly (.clone()) ... it is borrowed`. The error is reported at `std/prelude.yo` (`out := self;` in the `Array` `Clone` impl).

## Cause

The `impl(generic(T, U), where(T <: Clone), Array(T, U), Clone(...))` body copies the whole array out of the `&Self` receiver (`out := self`) and then overwrites each slot. Under decision 36, implicitly copying a non-`Copy` value out of a borrow is E0901. The body therefore compiles only for an element type that happens to copy implicitly.

## Fix direction

Build the result element by element from `self(i).clone()`, with no whole-value copy of the receiver. Add a test with a plain `derive(Q, Clone)` struct element and a move-only `Clone` element.
