# A reference field cannot be re-pointed in place: `h.r = &y` and `&mut h.r` are rejected

**Severity:** S3: a missing spelling with a workaround. Storing a reference into a field of reference type (`h.r = &y`, `t.0 = &y`) is E0926 and lending the field itself (`&mut h.r`, `setp(&mut h.r, &y)`) is E0908; writing the whole holder, `h = H(r : &y, n : h.n)`, is accepted and checked on every route. Rust accepts both spellings.

Status: FIXED in v0.2.81 (VERDICTS-78 Q1, branch `wip/v0281-v78-q1`). It was open by design for v0.2.80, which only reworded the two diagnostics (#2059).

## Reproducer

```yo ignore
{ String } :: import("std/string");
X :: struct(s : String);
mk :: (fn() -> Rc(X))(Rc.new(X(s : String.from("abc"))));
H :: struct(r : &Rc(X), n : i32);
setp :: (fn(generic(p : Origin), slot : &mut &(Rc(X), p), v : &(Rc(X), p)) -> unit)({ slot.* = v; });

main :: (fn() -> unit)({
  z := mk();
  y := mk();
  mut(h) := H(r : &z, n : i32(0));
  h.r = &y;               // E0926
  p := &mut h.r;          // E0908
  setp(&mut h.r, &y);     // E0908
  h = H(r : &y, n : h.n); // accepted: the spelling today
});
export(main);
```

(`ignore`: the reproducer is rejected by design.)

## The diagnostics (v0.2.80)

`h.r = &y` (also `t.0 = &y`, `h.r = &mut b` on a `&mut` field, and `h.r = y` with `y` a reference binding):

```text
error[E0926]: `h.r = &y` stores a reference into the field `r` (`&Rc(X)`): a reference field is set by writing the whole holder
help: write the whole holder: `h = H(r : &y, n : h.n)`
```

Through a holder that is itself a reference (`w := &mut h; w.r = &y`, or a `h : &mut H` parameter) the help writes `w.* = H(r : &y, n : w.n)`; on a tuple, `t = (&y, t.1)`.

`p := &mut h.r` (also `setp(&mut h.r, &y)`, `match(&mut h.r, …)`, `&mut t.0`):

```text
error[E0908]: `&mut h.r` lends the reference field itself (`&Rc(X)`), not the place it refers to, and a reference field is not re-pointed in place.
help: to re-point `h.r`, write the whole holder with the new reference in that field; to write the place it refers to, declare the field `&mut` and lend `&mut h.r.*`
```

Unchanged: `h.r = v` with `v` a value (not a reference) stays E0926 "`h.r` is a reference (`&Rc(X)`): reading the value it refers to is spelled `h.r.*`", and `h.r.* = v` through a `&` field stays E0908 "Cannot write through `h.r`".

The reworded E0926 is chosen where the right side is spelled as a reference: a borrow `&x` / `&mut x` or a reference binding (a `&T` parameter, a local borrow). A right side whose type is a reference but which is neither (`h.r = g.r`, a call returning `&T`) is checked before the right side is evaluated and keeps the read wording.

## Root cause

After VERDICTS-75 §8 a place of type `&T` takes a `&T`, but a reference-typed field on the left of `=` is still read as its referent (N1e-2's field read, `src/evaluator/exprs/property-access.yo` `_reference_field_read_place`), so the target `h.r` is E0926 before the store is considered; and `&mut h.r` is judged as a write through the field (`reject_write_through_shared_reference_field`, `src/evaluator/utils.yo`). The whole-holder store already runs every check the field store needs: the holder's writability, no live borrow of `h` or through `h.r` (E0911), the field's declared origin (E0923), and the scope of what `e` points into (E0911), each charged to the root holder (direct, through a local `&mut`, a `&mut` match binding, a `&mut` parameter, a generic slot).

## Fix (v0.2.81, VERDICTS-78 Q1)

The rule text, edge cases, test rows and the "must not" list are in VERDICTS-78 §Q1. In short: `h.r = e` with `e` a reference of the field's type is the store `h = H(r : e, …the other fields of h)` and is checked as that store is, through the same path (no second checker); `&mut h.r` lends the slot as a `&mut &(T, p)` with `p` invariant; `h.r = v` with `v : T` stays E0926 with a help naming both spellings. The document moves to `issues/fixed/` with that PR.

## Test

`tests/borrow-spelling.test.yo` pins the v0.2.80 wording (the reworded E0926 on a struct field, a tuple element and through a `&mut` holder; the reworded E0908 at `&mut v.at`; the unchanged value-store E0926 and `v.at.* = …` E0908). In v0.2.81 the store rows flip to positives (the respell manifest's rows for this issue too).

## Fixed (v0.2.81)

- **The target.** The left side `h.r` of a store is the field itself: `reference_field_store_mark` (`src/evaluator/utils.yo`) records its label, and `_reference_field_read_place` (`src/evaluator/exprs/property-access.yo`) types it as the field's reference type and marks it a reference self place, whose C is the field's own storage (`generate_field_access`, `src/codegen/exprs/property-access.yo`). No E0926 at the target.
- **The right side.** `&place` / `&mut place` is a reference value `&(T, place)` whose marker stays in the tree (`_evaluate_reference_field_store_lend`, `src/evaluator/exprs/assignment.yo`); a `&mut` lend needs a writable place and is an exclusive access. A reference binding is read as the reference. A value (`h.r = v`) is E0926 "stores a value into the reference field", whose help names `h.r.* = v` and `h.r = &place`.
- **The checks.** The store then runs the field write's own checks, the ones `h.o = .Some(&y)` already ran: `mut(h)` (E0917), a write through a `&H` parameter (E0908), no live borrow of `h`, of `h.r` or of a place reached through it (E0911), and the place-write join that charges the stored origin to the root holder, through a local `&mut` borrow or a `&mut` parameter included, checking a declared origin (E0923) and the lent place's scope (E0911). It is a union: the old target stays held.
- **`&mut h.r`** on a `&` field, at a call argument and in `p := &mut h.r`, lends the field itself as a `&mut &(T, p)`; `lend_through` fixes `p` exactly (invariance), and its write-back now reaches a field place's root holder (`issues/fixed/2026-11-25-a-mut-lend-of-a-holders-field-does-not-write-back-what-the-callee-stores.md`, the same gap for every field). `p.* = &y` through such a `p` (or any `&mut &T`) stores the lend; the store through the reference GENs into the target holder, never treated as a re-point of `p`. A `&mut` field's `&mut h.r` still lends the place it refers to (`issues/questions/2026-11-25-does-mut-h-r-on-a-mut-reference-field-lend-its-slot-or-its-referent.md`).
- **Tuples** follow the rule, so `t.0 = &y` is E0923 where the whole-tuple store `t = (&y, t.1)` is: a tuple local of lends names its places in its type (`issues/2026-11-25-a-tuple-local-of-lends-cannot-be-re-pointed-to-another-place.md`, S3, open).
- **The cursor in a field** (the verdict's edge 7) is E0911: `c.cur = &mut n.next` through the arm binding of `match(&mut c.cur.*, …)` is a write of the place the binding borrows (`issues/2026-11-25-a-cursor-held-in-a-reference-field-cannot-be-re-pointed-through-its-match-binding.md`, S3, open; `tests/origins/unsound/v78-field-cursor-walk.yo`).

Tests: `tests/borrow-spelling.test.yo` (the positives, run, and the E0926/E0917/E0908 rows) and the G-B rows `tests/origins/unsound/v78-*.yo` with their `-pos` twins under ASan.
