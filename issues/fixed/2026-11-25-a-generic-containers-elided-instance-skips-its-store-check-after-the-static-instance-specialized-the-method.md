# A generic container's elided-origin instance skips its store check after the static instance specialized the method

**Severity:** S1 (safe code compiles to a use-after-free: ASan reports stack-use-after-scope).

**Status:** FIXED (branch `fix/p12-t6-static-store`, 2026-11-25). Found 2026-11-25 by the p12-t6 lane on develop
`1175c046c`, while it fixed the static store hole
(`issues/fixed/2026-11-24-a-generic-containers-method-stores-a-local-reference-into-a-static-instantiated-receiver.md`).
P12 (#2082) split `Box2(&X)` and `Box2(&(X, static))` into two instances; before it they were one, and the shared
slot below was the same type.

## The repro

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");
X :: struct(s : String);
Box2 :: (fn(comptime(T) : Type) -> comptime(Type))(
  struct(v : Option(T))
);
impl(
  generic(T : Type),
  Box2(T),
  put : (fn(self : &mut Self, v : T) -> unit)({
    self.v = .Some(v);
  })
);
G := X(s : String.from("g"));
main :: (fn() -> unit)({
  mut(a) := Box2(&(X, static))(v : .None);
  a.put(&G);
  mut(b) := Box2(&X)(v : .None);
  {
    x := X(s : String.from("0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz"));
    b.put(&x);
  };
  match(b.v, .Some(r) => println(`OUT: ${r.*.s.len().to_string()}`), .None => println("none"));
  _ := a;
});
export(main);
```

`yo check` accepts it, and the ASan build reports:

```text
==682681==ERROR: AddressSanitizer: stack-use-after-scope on address 0x7bffb37ff060 at pc 0x5555556ccc69 bp 0x7bfff3ffeaf0 sp 0x7bfff3ffeae8
```

Without the two lines over `a`, the same program is E0911 ("Cannot store a reference to `x` in `b` here").

## Root cause

A generic impl's specialized method is shared by the instances whose `type_key` agrees, and the static bit is not in
`type_key`. `a.put(&G)` specializes `put` first, so the `self` slot that `b.put(&x)` reads (`_method_slots`) is
`&mut Box2(&(X, static))`. `lend_through` step 3 decides its by-type-argument solve on that slot's pointee:
`type_carries_origin(Box2(&(X, static)))` is false (a static reference borrows nothing), so `by_type_argument` stays
false, nothing is solved, and `b`'s flow set never gains `x`. `YO_DEBUG_N2B` shows the step entered
(`lend-through &mut arg b`) with no `lend-through solve` line after it.

## The fix

`_lent_argument_pointee` (`src/evaluator/calls/function.yo`) reads the lent argument's own type, as step 1 does, and
step 3 decides `by_type_argument` on it; step 1c (the static store check) reads the pointee the same way. The origin
names and type variables step 3 matches stay the slot's, since a specialized slot spells none and a generic one is
the definition's.

## The test

`tests/origins/unsound/generic-method-shared-slot-elided-store.yo` (the repro, `// expect: E0911`), and a
`comptime_expect_error` row in `tests/unsized-places.test.yo` that stores into `_UpBox1(&_UpX)` after the file's static
rows have specialized `put` for `_UpBox1(&(_UpX, static))`.
