# A closure that owns a `String` copies implicitly

**Severity:** S2 — `d := c; e := c` on a closure that captures a `String` by value compiled and ran, sharing one buffer between copies, where Rust (and decision 36) move it

**Found:** 2026-10-14, reviewing v0.2.62 (`~/Workspace/Yo-wt/review-v0262/fnprobe/g.yo`).
**Status:** FIXED 2026-10-14.

## Symptom

```yo
{ println } :: import("std/fmt");
{ String } :: import("std/string");
main :: (fn() -> unit)({
  s := String.from("hi");
  (c : Impl(Fn() -> usize)) = ({ s }() => s.len());
  d := c;
  e := c;
  println(d() + e());
});
export(main);
```

compiled and printed `4`. The type answer was already right —
`Type.impls(type_of(c), Copy)` is false, since its capture `s` is a
`String` — but the copy rule never asked it. The maintainer's ruling
(2026-10-14): "the closure behavior should match rust. If it captures String
then it shouldn't auto derive Copy."

## Cause

`type_requires_explicit_copy` (`src/types/utils.yo`) is
`type_is_move_only(ty) || _plain_data_lacks_copy(ty)`, and
`_plain_data_lacks_copy` returns `false` for any type that reaches a counted
cell or an owned buffer (`type_contains_rc_cell_or_move_only`). That carve-out
is V2b's (`String`, the collections) and V2c's (`Rc`, `Arc`) own migration, and
a closure's capture record holding a `String` hit it: the closure was judged by
the `String` inside it, which still copies implicitly, not by its own `Copy`
answer. A closure holding a plain struct without `Copy` was implicitly
copyable too, because the flip's question (`type_lacks_copy_for_flip`,
`src/evaluator/trait_checking.yo`) returned `false` for every type mentioning a
SomeT, and a closure's type is an `Impl(Fn(...))` SomeT.

## Fix

A closure is judged by its capture record, as Rust judges it:
`_plain_data_lacks_copy` asks the flip's `Copy` question of a closure identity
(or its capture struct) before the owned-buffer carve-out, and
`type_lacks_copy_for_flip` reads a capture record whose SomeTs are all bound
closure identities as concrete. So:

- a by-value capture (listed `{ s }`, or implicit: a bound closure owns what it
  captures, decision 22) that is not `Copy` makes the closure explicit-copy:
  `d := c` moves `c`, and a later use is E0901 whose note names `c.clone()`;
- `&` captures (pointers) keep a closure `Copy`;
- a `&mut` capture keeps it move-only
  (`issues/fixed/2026-10-14-a-mut-capturing-closure-answers-copy-and-clone.md`).

Until V2b, `t := s` on the `String` itself still shares; the closure is the
stricter of the two by design.

Tests: `tests/copy_trait.test.yo` ("a closure that owns a String moves at
d := c, as Rust's does", "an implicit capture of a String is by value, so that
closure moves too").
