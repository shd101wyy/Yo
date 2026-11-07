# Should an elided result origin prefer the receiver's?

**Kind:** design question — an open decision, not a defect.

**Status:** OPEN — filed 2026-11-07 by the G1 lane (`vbd/g1-fnmut-slots`)
while rebasing VERDICTS-28 Q1 onto #1804.

## The collision

VERDICTS-28 Q1 makes every non-escaping callback slot in std
`f : &mut Impl(FnMut(...))`, call-once included, `OnceCell.get_or_init` by
name. #1804 made `get_or_init` return `&T` into the cell (Rust's
`OnceLock::get_or_init`), and in the same change took `f` **by value**
(`f : Impl(Fn() -> T)`), not by reference. That was deliberate: an elided
result origin is the union of every reference parameter's origin
(`plans/backlog/REFERENCES_AND_ORIGINS.md` O2), so with `f` a reference
parameter the result also borrows the closure, and

```yo
{ OnceCell } :: import("std/sync/once");
main :: (fn() -> unit)({
  cell := OnceCell(i32).new();
  got := cell.get_or_init(() => i32(42)); // borrows the temporary closure
});
export(main);
```

is rejected at the binding: "the projection's result is a place inside
`() => i32(42)`, which is a temporary that ends with this statement". All 19
tests of `tests/sync/once.test.yo` and the `once-reentrant-call-panics`
cli-case fixture bind the result this way.

The G1 branch keeps both decisions by spelling `get_or_init`'s slot
`sink(f) : Impl(FnMut() -> T)`: Q1's `FnMut` trait, #1804's by-value
parameter, so the receiver stays the only origin. It is the one non-escaping
callback slot in std that is not `&mut Impl(FnMut(...))`.

## The question

Rust resolves the same signature without a by-value slot. Its third elision
rule: when one input is `&self` or `&mut self`, the elided output lifetime is
the receiver's, whatever other reference parameters exist. Yo's O2 takes the
union instead (the conservative R3-era default), which is exact for free
functions (`longest(a, b)`) but over-approximates every method whose other
reference parameters are inputs only — a callback, a key, a probe.

Two ways to go:

1. Keep the union and keep the by-value carve-out wherever a method returns
   a reference and takes a callback (today only `get_or_init`).
2. Adopt Rust's receiver rule for methods: a `self : &Self` / `&mut Self`
   receiver's origin is the elided result origin; the union stays for free
   functions. A method that does return a borrow of another parameter then
   spells its origin (O2's "the load-bearing ones spell"), which today has
   no surface syntax.

## Recommendation

Option 2, when the origin surface syntax lands (the checker rejects a body
whose result does not come from the receiver, so the default stays checked,
never trusted). It is Rust's rule, it removes the only exception to Q1's
uniform slot, and it narrows exactly the over-approximation that made #1804
move `f` by value. Until then option 1 holds: `get_or_init` keeps
`sink(f) : Impl(FnMut() -> T)` and lends `&mut` to its
`&mut Impl(FnMut)` `_init`, and a new reference-returning method that takes
a callback takes it the same way.
