# A `&mut` payload bound through a shared scrutinee is writable

**Severity:** S1. A `match` over a `&E` (a `&T` parameter, `self : &Self`, a `&` local borrow) binds a `&mut`
reference payload as a `&mut`. The arm can then write through it, and it can store it in another value's `&mut`
slot. Either way the `&` borrow of the scrutinee hands out an exclusive loan. The derived `Clone` of an enum with a
`&mut` payload stores it, so the clone and the original are two `&mut` of one place. Pre-existing: v0.2.76 and
develop `ece5e5cfd` accept both programs below.

Found 2026-11-13 by lane c8e while fixing A26
(`issues/fixed/2026-11-11-a-mut-reference-field-read-by-value-is-copied-so-two-holders-share-one-exclusive-borrow.md`).
That fix covers the struct forms. This is its enum row, "`derive(Clone)` on an enum with a `&mut` payload; `Option(M)`'s
clone", which stays open here.

## Reproducers

`issues/repros/2026-11-13-a-mut-payload-bound-through-a-shared-scrutinee-is-writable.yo` (negative, expects E0908):

```yo
{ println } :: import("std/fmt");
X :: struct(n : i32);
E :: enum(V(r : &mut X), Z);
poke :: (fn(e : &E) -> unit)(
  match(
    e,
    .V(r) => {
      r.n = i32(5);
    },
    .Z => ()
  )
);
main :: (fn() -> unit)({
  mut(x) := X(n : i32(1));
  e := E.V(r : &mut x);
  poke(&e);
  println(`OUT: ${match(e, .V(r) => r.n, .Z => i32(0)).to_string()}`);
});
export(main);
```

```text
$ yo check repro.yo        # v0.2.76, develop ece5e5cfd, and with the A26 fix: accepted
$ yo compile repro.yo -o t && ./t
OUT: 5
```

`…-derive.yo` (negative, E0908) is `derive(E, Clone)` over `V(r : &mut Box(X))`. A write through the clone's payload
is seen through the original, `OUT: 1`: two holders write one exclusive loan.

The same write through a STRUCT's `&mut` field reached through `&` is E0908 already: `m.r.n = …` with `m : &M`.
With the A26 fix, the struct's field stored in a `&mut` slot is E0908 too.

## Root cause (hypothesis, not traced)

A pattern binding of a borrowed scrutinee reads a reference payload as the reference itself (R1, "R-READ of a
reference payload binding"). Its type is the payload's, `&mut X`, whatever mode the scrutinee was borrowed in. The
struct path finds the `&T` root because `shared_borrow_param_root_of_place` walks `m.r` back to `m`. A pattern binding
is its own variable, so the walk stops at it. Neither the write check (`evaluate_assignment` → E0908) nor the A26
constructor check (`src/evaluator/calls/type.yo`) sees the `&` scrutinee behind it.

## Expected

Through a shared scrutinee a `&mut` payload binds as a `&` reborrow, as a `&mut` field read through a `&` path does
(`REFERENCES_AND_ORIGINS.md` O3, "Reborrows"). A write through it, or a store of it into a `&mut` slot, is E0908.
`derive(Clone)` over such an enum then fails at the derive, as the struct derive does.

## Test

With the fix, both programs move to `tests/origins/unsound/` as G-B rows (E0908), and
`tests/origin_holder_derive.test.yo` gains the enum `derive(Clone)` rejection beside the struct one.
