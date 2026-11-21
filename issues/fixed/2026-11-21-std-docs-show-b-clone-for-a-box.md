# std's `Box` documentation shows `b.clone()`, which is E0616

**Severity:** S3 — documentation: the `Box` doc example and two doc comments spelled a box clone in a form the compiler rejects (E0616), and wrote through an immutable binding (E0917).

## Symptom

`std/prelude.yo`'s `Box` doc comment said "`b.clone()` is a deep copy", and its ```` ```yo ```` example
wrote `b := a.clone();` for `a : Box(i32)`. A method call on a `Box` whose payload has a member of the
same name is ambiguous, E0616 (`E_AMBIGUOUS_METHOD`, decision 32): `i32` has `clone` too. The example
also wrote `b.* = i32(42)` through a binding declared without `mut` (E0917). The `as_ref` doc comment
wrote `Box.clone(h)` for an owned `h`; the checker accepts it today, but the call-site marker for a
`self : &Self` argument is `&h` (decision 33), so the comment now writes `Box.clone(&h)`. (`b.clone()` on a
`Box(Dyn(T, Clone))`, as `docs/en-US/DYN_DESIGN.md` writes it, is accepted: a `Dyn` payload's members
are not reached by auto-dereference, so there is no ambiguity there.)

## Fix

The doc comments and the example (`mut(b) := Box.clone(&a);`) spell the clone `Box.clone(&b)`, as
`docs/en-US/DESIGN.md` already does. `CloneInto`'s comment names it the same way. No ```` ```yo ```` block
under `docs/` spells a sized `Box`'s clone as a method call.

## Test

The corrected example was checked with the tree compiler as a standalone program; the doc example
itself is not compiled by any suite (std doc examples are not run).
