# A generic container's method stores a local reference into a receiver instantiated over `static`

**Severity:** S1 (safe code compiles to a use-after-free: a local's reference enters a holder typed over the empty origin `static`, and the holder outlives the local; raised from S2 on 2026-11-25, see "Severity" below).

**Status:** FIXED (branch `fix/p12-t6-static-store`, 2026-11-25). Found 2026-11-24 by the P12 lane (VERDICTS-74) on `v0280/p12-static-origin` at `c33686cd6`. Probe t6 of VERDICTS-74 stopped at a bogus E0910 until #2053 removed it, so the flow behind it was never reached before. P12 (#2082) made `static` spellable in every safe file, which opened it to safe code.

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

## Severity

Every accepted variant except the `ArrayList` one compiles and reaches undefined behaviour under AddressSanitizer
(develop `1175c046c`, `--sanitize address --allocator system`):

| Variant | ASan |
| --- | --- |
| `b.put(&x)` in `make() -> Box1(&(X, static))`, `b` returned and `b.v` read by the caller | stack-use-after-return |
| `r := &x; b.put(r)`, returned the same way | stack-use-after-return |
| `b.put(&x)` in an inner block, `b.v` read after the block | stack-use-after-scope |
| a struct holder `H(inner : Box1(&(X, static)))`, `h.inner.put(&x)`, `h` returned | stack-use-after-return |
| `ArrayList(&(X, static))`, `xs.push(&x)` | accepted; the C compile fails (the sibling `_Alignof` S2, fixed alongside) |

So the issue is S1, and with the `_Alignof` fix the `ArrayList` form would have reached the same use-after-free.

## Root cause

A specialized method of a generic container types `v : T` from the ARGUMENT, not from the receiver's
instance (the comment above `w_holder_is_param` in `lend_through`, `src/evaluator/calls/function.yo`). So the
slot `_method_slots` returns for `b.put(&x)` is `&X`, and the static arm (step 1b, `type_spells_checked_static`
over the slot) never sees `static`. Step 3 never runs either: its gate asks `type_carries_origin` of the `&mut`
pointee, and `Box1(&(X, static))` carries none (a static reference borrows nothing), so the by-type-argument solve
that would have related `v` to the receiver's type argument is skipped (`YO_DEBUG_N2B` prints no `lend-through`
line for the call; the same program over `Box1(&X)` prints the solve and rejects with E0911). And had it run,
`place_write_join` checks only the NAMED origins the root holder's type spells: it has no static arm, and it cannot
have a whole-holder one, since a holder may spell `static` in one part and a named origin in another.

## Where the fix belongs

Either the method slot is read through the receiver's instance (the type argument the receiver's type binds
`T` to, which spells `static`), or step 3's by-type-argument solve judges a stored value against the type
argument it occurs in: an argument whose type occurs among the receiver pointee's type arguments only at
positions that spell `static` must be static. The second stays inside `lend_through` and needs no change to
how methods specialize.

## The fix

The second option (the coordinator's choice): `lend_through` step 1c (`_static_type_argument_stores`,
`src/evaluator/calls/function.yo`). For each `&mut` argument (top-level, or nested in a by-value parameter as step
3 reads it) whose pointee spells `static` at a checked position, every other argument whose slot type occupies a
position among the pointee's type arguments that spells `static` (`_type_occurs_at_static_position`, the walk of
`_type_occurs_in_type_arguments` with positions compared origin-free) is judged by `_static_value_offense`, and a
value that holds a place is E0923 through `_static_origin_reject`, naming the receiver. When the argument's type
also occupies a non-static position, which one the callee writes is not known at the call, and the static one
decides (VERDICTS-74 rule 4: a site that cannot tell rejects). Method specialization is unchanged.

## The test

`tests/origins/unsound/static-generic-method-store.yo` (the inner-block repro with `b.v` read after,
`// expect: E0923`) and its `-pos` control (`b.put(&G)` for an immutable module-level `G`); in
`tests/unsized-places.test.yo`, the five variants above as `comptime_expect_error` rows, a positive
(`Box1(&(X, static)).put(&G)`, `ArrayList(&(X, static)).push(&G)` twice) and a non-static control
(`Box1(&X).put(&x)` still accepted).
