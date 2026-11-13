# A method call `s.m()` on a `&[T]` receiver does not find an impl on `[T]`

**Severity:** S3 (fixed 2026-11-13): the trait-qualified call `Trait.m(s)` works while no blanket impl of the trait is in scope, and std spells no impl on `[T]` yet (S2 adds them), so nothing in the tree hits it. It blocks the first user-visible `impl([T], Show)`-style API, so S2 must close it.

## Reproducer

```yo ignore
_CoMark :: trait(co : (fn(self : &Self) -> i32));
impl([i32], _CoMark(co : (fn(self : &Self) -> i32)(i32(2))));
main :: (fn() -> unit)({
  a := Array(i32, 2)(1, 2);
  s := unsize(&a);
  _x := s.co();
});
export(main);
```

`yo check` reports `error[E0610]: No method "co" on Slice(i32): the type has no field or method with that name.` Writing `_CoMark.co(s)` checks and runs when no blanket impl exists. With a blanket (`impl(generic(T : Type), T, _CoMark(...))`, or `T : ?Sized`) in scope, `_CoMark.co(s)` fails too: `E0601 Expected "_CoMark" Given "Slice(i32)"` (the blanket matches the reference type `&[i32]` itself as a sized `T`; the `&&T` receiver-slot family, P3b).

## Root cause

`type_id_or_empty` (`src/evaluator/values/type_trait_methods.yo`) had no arm for `SliceT`, so `impl([i32], …)` registered its methods under the empty id, which registers nothing, and the lookup on `Slice(i32)` found nothing. `type_head_name_for_impl_forcing` (`src/evaluator/context.yo`) likewise had no head for a slice, so a pending `impl([T], …)` could not be forced by a miss.

## Fix

Decision 49 S2 (`vbd/d49-s2`, 2026-11-13): a slice is keyed by its element's id (`[<elem id>]`), apart from the element's own impls, and its head name for forcing is `Slice`, the callee an `impl([T], …)` is spelled with. The blanket half of the report (`_CoMark.co(s)` with a blanket in scope matching `&[i32]` as a sized `T`) is the `&&T` receiver family, P3b, and is not changed here.

## Test

`tests/sized.test.yo`, "a method call on a &[T] finds the impl on the slice": `s.co()` on `s := unsize(&a)` answers the slice's own impl beside the sized `Type` blanket, and `s.co_all()` the `?Sized` blanket. The prelude's `[T]` impls (`len`, `contains`, `Eq`, `Hash`, `CloneInto`) are exercised in the same file.
