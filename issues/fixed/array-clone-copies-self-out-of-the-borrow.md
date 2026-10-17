# `Array(T, N).clone` is E0901 for a `Clone`-but-not-`Copy` element

**Severity:** S2: a valid program is rejected. `Array(Q, 2).clone()` fails although `Array(T, N) <: Clone` holds under `where(T <: Clone)`.

**Status: FIXED** 2026-10-16 (`fix/collection-clone-through-borrow`). Found 2026-10-14 by the v0.2.62 batch review. **Measured on:** develop a89b8356c (the v0.2.62 candidate) and v0.2.61; both fail the same way.

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

## Fix

The `Array(T, U)` `Clone` impl no longer copies the receiver. It takes the
storage from `MaybeUninit(Self)`, the idiom `Array.fill` already uses for "an
array to write into before any `T` exists", and moves each element's clone,
read in place through the `&T` projection `self(i)`, into its uninitialized
slot with `__yo_ptr_write`, which drops nothing:

```yo ignore
mu := MaybeUninit(Self).new();
raw := mu.as_ptr();
p := (*T)(raw);
(i : usize) = usize(0);
while(i < U, i = (i + usize(1)), {
  __yo_ptr_write(p.add(i), self(i).clone());
});
mu.assume_init(raw)
```

The old `out(i) = self(i).clone()` over a copied `out` also dropped the copied
element in each slot before overwriting it; for a `Copy` element that drop is
nothing, and for any other element the copy never compiled, so no program
observed it.

**Test:** `tests/collection_clone_through_borrow.test.yo`: a `derive(Q, Clone)`
element, a move-only `Box(String)` element, a `Drop` element (one `clone` per
slot, one drop per owner) and a `Copy` element. Those four tests alone, run
by develop ed733408c's compiler with its std, fail to compile with this doc's
E0901 (`cannot copy self, whose type Array(_CbQ, 2) is copied only
explicitly`); with the fix all four pass. The
same PR fixes the `ArrayList.clone` sibling
(`issues/fixed/arraylist-clone-copies-elements-out-through-get.md`) and the
`Path.clone` instance of its shape.
