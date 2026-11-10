# A method call `s.m()` on a `&[T]` receiver does not find an impl on `[T]`

**Severity:** S3: the trait-qualified call `Trait.m(s)` works, and std spells no impl on `[T]` yet (S2 adds them), so nothing in the tree hits it. It blocks the first user-visible `impl([T], Show)`-style API, so S2 must close it.

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

`yo check` reports `error[E0610]: No method "co" on Slice(i32): the type has no field or method with that name.` Writing `_CoMark.co(s)` checks and runs.

## Root cause

Not investigated: method-name resolution on a receiver whose type is `&Slice(T)` (the unsized pointee behind a reference) does not consult the impl table the way it does for a sized pointee. Seen on the S1e branch (`vbd/d49-s1-errors`), also on S1c.

## Test

`tests/sized.test.yo`, "a blanket over a Type binder covers the sized types only", calls through the trait-qualified form; a `s.co()` row belongs with the fix (S2).
