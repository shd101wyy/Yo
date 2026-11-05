# A type parameter is not inferred through an origin-parameterized composite (E0613)

**Severity:** S2: a valid program is rejected. A generic function whose `T` is
reachable only through a parameter of type `C(T, p)` cannot be called when
`C` is a type constructor that takes an `Origin`. This holds whether the
parameter is passed by value, as `&`, or as `&mut`. The call fails with E0613
as soon as `T` appears in the result. VERDICTS-25's cursor
(`next :: (fn(generic(T : Type, p : Origin), self : &mut Cursor(T, p)) -> Option(&(T, p)))`)
type-checks but cannot be called.

> Found 2026-11-05 while writing N1e-2b PR 2b's acceptance test (decision 43
> step 2). Reproduced on develop `f531eabec`, so N1e-2b did not cause it.

## Reproducer

```yo
{ ArrayList } :: import("std/collections/array_list");
Cursor :: (fn(comptime(T) : Type, comptime(p) : Origin) -> comptime(Type))(struct(xs : &(ArrayList(T), p), i : usize));
first :: (fn(generic(T : Type, p : Origin), self : &mut Cursor(T, p)) -> Option(T))(.None);
main :: (fn() -> unit)({
  mut(xs) := ArrayList(i32).new();
  mut(c) := Cursor(i32, xs)(xs : &xs, i : usize(0));
  o := first(&mut c);
  ()
});
export(main);
```

```text
error[E0613]: Cannot infer the type parameter "T" of this call: it appears in the result type Option(T), and neither an argument nor the expected type determines it.
```

An annotation on the result's binding does not help either
(`(o : Option(&(i32, xs))) = next(&mut c)` is still E0613). A function whose result does not mention `T`
(`len :: (fn(generic(T : Type, p : Origin), self : &mut Cursor(T, p)) -> usize)`)
is accepted, which shows that the argument check never binds `T` from
`Cursor(i32, xs)`. The same shape with a concrete element type,
`IntCursor(p)`, works.

## Root cause

Not yet investigated. The unification of the parameter's instantiated type
`Cursor(T, p)` against the argument's `Cursor(i32, xs)` does not bind `T`. The
suspect is the constructor-instance match, which does not see through an
instance whose arguments include an origin.

## Test

When this is fixed, `tests/origins/reference_read_rule.test.yo` should call
the generic `rr_next_at` on a `RrCursor(i32, xs)` instead of the `i32`
cursor `rr_int_at`.
