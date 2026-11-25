# A generic container's method stores a local reference into a receiver instantiated over `static`

**Severity:** S2 (an invalid program is accepted: a local's reference enters a holder typed over the empty origin `static`, which a later read treats as a static value; the program fails later in C codegen today, see below).

**Status:** OPEN. Found 2026-11-24 by the P12 lane (VERDICTS-74) on `v0280/p12-static-origin` at `c33686cd6`. Probe t6 of VERDICTS-74 stopped at a bogus E0910 until #2053 removed it, so the flow behind it was never reached before.

## The repro

```yo
X :: struct(n : i32);
Box1 :: (fn(comptime(T) : Type) -> comptime(Type))(
  struct(v : Option(T))
);
impl(
  generic(T : Type),
  Box1(T),
  put : (fn(self : &mut Self, v : T) -> unit)({
    self.v = .Some(v);
  })
);
main :: (fn() -> unit)({
  x := X(n : i32(1));
  mut(b) := Box1(&(X, static))(v : .None);
  b.put(&x);
});
export(main);
```

`yo check` accepts it. So do `r := &x; b.put(r);` and the `ArrayList` form (probe t6):

```yo
{ ArrayList } :: import("std/collections/array-list");
X :: struct(n : i32);
main :: (fn() -> unit)({
  x := X(n : i32(1));
  mut(xs) := ArrayList(&(X, static)).new();
  xs.push(&x);
});
export(main);
```

The same value is rejected at every other site that names the type: `Box1(&(X, static))(v : .Some(&x))`
(constructor), `b.v = .Some(&x)` (field write), and a non-generic method `put(self : &mut Self, v : &(X, static))`
all give E0923.

## Root cause

A specialized method of a generic container types `v : T` from the ARGUMENT, not from the receiver's
instance (the comment above `w_holder_is_param` in `lend_through`, `src/evaluator/calls/function.yo`). So the
slot `_method_slots` returns for `b.put(&x)` is `&X`, and the static arm (step 1b, `type_spells_checked_static`
over the slot) never sees `static`. Step 3 then joins the stored value into the receiver `b`
(`flow_write_back_through` → `store_through_mut_join` → `place_write_join`), and `place_write_join` checks only
the NAMED origins the root holder's type spells: it has no static arm, and it cannot have a whole-holder one,
since a holder may spell `static` in one part and a named origin in another.

## Where the fix belongs

Either the method slot is read through the receiver's instance (the type argument the receiver's type binds
`T` to, which spells `static`), or step 3's by-type-argument solve judges a stored value against the type
argument it occurs in: an argument whose type occurs among the receiver pointee's type arguments only at
positions that spell `static` must be static. The second stays inside `lend_through` and needs no change to
how methods specialize.

## The test

A `tests/origins/unsound/static-generic-method-store.yo` row (the first repro with `x` dropped while `b`
is live and `b.v` read after, `// expect: E0923`) and its `-pos` control (`b.put(&G)` for an immutable
module-level `G`).
