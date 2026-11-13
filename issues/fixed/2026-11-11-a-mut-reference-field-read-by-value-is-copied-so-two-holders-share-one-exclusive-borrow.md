# A `&mut` reference field read by value is copied, so two holders share one exclusive borrow

**Severity:** S1. Reading a `&mut` reference field by value into another holder's `&mut` slot copies the pointer:
`M(r : m.r, …)` leaves `m` usable, `dup(m : &M) -> M` builds `M(r : m.r, …)` through a `&` path, and
`derive(M, Clone)` generates exactly that body. Both holders then write and read one place: a write through the copy
frees a Box that a reference taken through the original still reads (ASan: heap-use-after-free; the
`&mut Option(Rc(X))` variant SEGVs). Pre-existing: v0.2.76 accepts all three forms.

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 A26). Confirmed on develop `64f33c710`. The derive form
contradicts `issues/fixed/2026-11-05-derive-clone-over-a-reference-field-clones-the-referent.md`; see Root cause.

## Reproducers

`tests/origins/unsound/mut-field-copied-by-derive-clone.yo` (was `issues/repros/2026-11-11-…`)
(negative, expects a rejection at the derive, E0908):

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");
X :: struct(s : String);
M :: struct(r : &mut Box(X), n : i32);
H :: struct(p : &X);
big :: (fn() -> Box(X))(Box.new(X(s : String.from("0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz"))));
derive(M, Clone);
main :: (fn() -> unit)({
  mut(x) := big();
  m := M(r : &mut x, n : i32(0));
  m2 := m.clone();
  h := H(p : &m.r.*.*);
  m2.r.* = Box.new(X(s : String.from("b")));
  println(`OUT: ${h.p.*.s.len().to_string()}`);
});
export(main);
```

```text
$ yo check repro.yo        # develop 64f33c710: accepted.  v0.2.76: accepted
$ yo compile repro.yo --optimize 1 --sanitize address --allocator system -o t && ./t
==…==ERROR: AddressSanitizer: heap-use-after-free
```

- `mut-field-copied-through-shared-param.yo` (negative, E0908): no derive, `dup :: (fn(m : &M) -> M)(M(r : m.r, n : m.n));`.
- `mut-field-reborrowed-from-owned.yo` (negative, E0911): `m2 := M(r : m.r, n : i32(1));` straight out of the local `m`, which stays usable.
- `mut-field-holder-moved-whole-pos.yo` (positive control): `m2 := m;` moves the holder whole; only `m2` is used afterwards.

## The family (develop `64f33c710`)

| Shape | Verdict | Correct |
| --- | --- | --- |
| `derive(M, Clone)`, `m.clone()` (`r : &mut Box(X)`) | accepted, heap-use-after-free | rejected at the derive (E0908) |
| the same with `m : &mut Option(Rc(X))`, the clone reads while the original writes `.None` | accepted, SEGV | E0908 |
| a hand-written `Clone` building `M(r : self.r, …)` from `self : &Self` | accepted, heap-use-after-free | E0908 |
| `dup(m : &M) -> M` = `M(r : m.r, …)`; through a local `mm := &m` | accepted, heap-use-after-free | E0908 |
| `M(r : m.r, …)` out of the owned local `m` | accepted, heap-use-after-free | E0911: a reborrow freezes `m` while `m2` lives |
| `derive(Clone)` on an enum with a `&mut` payload; `Option(M)`'s clone (ledger) | accepted | E0908 |
| a spelled holder `M(p)` with a `&mut (T, p)` field, derived (ledger) | accepted, heap-use-after-free | E0908 |
| `M(r : &mut m.r.*, …)`, the reborrow spelled | accepted, runs clean | accept |
| `derive(M, Copy, Clone)` | rejected at the derive: "`&mut Option(String)` is a `&mut` reference … move-only" | same |
| the same reads of a `Box(X)` field (`B(b : m.b, …)`, owned or through `&B`) | E0901 "it is a field of another value … (Yo has no partial moves)" | same |

## Root cause

What the fixed issue fixed: the prelude's `__derive_clone` wrote `self.f.clone()` for every field, which on a `&`
field cloned the referent (E0601 for a holder over `&i32`). It now passes a reference field bare,
`Self(self.r, …)`, which is Rust's `Clone` for `&T`. Its sentence "A `&mut` field makes the holder move-only, so its
lend is rejected there" (repeated in the comment over `__derive_field_is_reference`'s use in `std/prelude.yo`) was
never tested: the bare `self.r` of a `&mut` field is accepted, and that is this defect.

Partly verified in the source, the rest is hypothesis. The read rule for a reference field
(`_reference_field_read_type`, `src/evaluator/exprs/property_access.yo`, N1e-2) reads `m.r` at a position that
expects a reference (`reference_read_wanted`: the constructor's `&mut Box(X)` slot) as the reference itself, a
value whose origin is the field's. Nothing then treats that value as a reborrow of `m.r.*` or as a use of a
move-only value: `place_root_binding` (`src/evaluator/utils.yo`) returns `.None` for a reference field read ("the
place it refers to, which the binding only points to"), so no loan of `m` is registered and the no-partial-move
E0901 that a `Box` field gets never sees the read, although `type_is_move_only` (`src/types/utils.yo`) does call a
`&mut` reference move-only (route 3; that is what rejects `derive(Copy)`).
`reject_write_through_shared_reference_field` checks only a `&` FIELD written through; a `&mut` field reached
through a `&` path (`self : &Self`, `m : &M`) is not checked when it is copied out.

## Expected

`REFERENCES_AND_ORIGINS.md` O3, "Reborrows": "a `&mut` passed to a `&mut` slot is reborrowed (`&mut r.*`); read
through a `&` path a `&mut` component yields a `&` reborrow", and §5 route 3: "a `&mut`-holding value is
move-only, so a copy never duplicates an exclusive loan". So:

- out of an owned holder, `M(r : m.r, …)` is the reborrow `&mut m.r.*`: `m` is frozen while `m2` lives, and the
  lend `&m.r.*.*` is E0911 (the program is then the explicitly spelled reborrow, which is accepted today);
- through a `&` path (`self : &Self`, `m : &M`, `mm := &m`) the field reads as a `&` reborrow, which cannot fill a
  `&mut` slot: a rejection at `m.r` (E0908, as a write through a `&` path is), so `derive(M, Clone)` over a holder
  with a `&mut` field fails at the derive, as `derive(M, Copy, Clone)` does today.

## Test

With the fix: the three negative programs and the positive control move to `tests/origins/unsound/`;
`tests/origin_holder_derive.test.yo` gains `derive(M, Clone)` over a `&mut` field (rejected) beside the `&` field
case the fixed issue added; corpus rows `clone-mut-holder` (E0908), `mut-field-copied-through-shared` (E0908) and `mut-field-reborrowed-from-owned` (E0911).

## Fix

The two rules the Expected section states (lane c8e, VERDICTS-58 #18). A `&mut` reference field read bare into a
`&mut` slot is the reborrow `&mut m.r.*`.

- **Through a `&` path: E0908.** A struct or enum-variant constructor's `&mut` field
  (`src/evaluator/calls/type.yo`, after `note_mut_lend_value`) now runs the write-through-borrow checks a field write
  runs, whenever the value it is given is a `&mut` (the lend `&mut p`, or a `&mut` reference value: a reference field
  read, a reference binding):
  - `shared_borrow_param_root_of_place` reports a `&T` parameter root (`m : &M`, `self : &Self`). The error is "Cannot
    store `m.r` in the `&mut` field `r`: `m` is a `&T` parameter, a read-only borrow of the caller's value."
  - `local_borrow_require_writable` reports a `&` local borrow root (`mm := &m`).

  `derive(M, Clone)` over a `&mut` field therefore fails at the derive: "derive on "M" failed: Cannot store
  `self.r` …". A call argument (`f(m.r)` with `x : &mut X`) was E0908 already, through
  `require_no_inout_write_through_borrow`. A lend of a place inside a `&T` parameter into a `&mut` field
  (`M2(p : &mut m.n)`) goes through the same check.
- **Out of an owned holder: the reborrow's freeze.** `origin_of`'s R-FIELD (`src/evaluator/utils.yo`) gives a `&mut`
  reference field read that a slot took as a `&mut` value (`is_mut_lend_value`) the spelled lend's origin,
  `_origin_push_lend`: the place `m.r`, mode `&mut`. The field type's origin it gave before was `x`, which the holder
  already freezes. The new holder therefore freezes `m` while it lives, and `h := H(p : &m.r.*.*)` before its last
  use is E0911, exactly as `M(r : &mut m.r.*, …)` is. A lend that only crosses the field (`&m.r.*.*`) still reads the
  field type's origin.

Not fixed here: the enum row. A `&mut` payload bound by a `match` over a `&E` is still a writable `&mut`, so
`derive(Clone)` over such an enum is still accepted. It is
`issues/2026-11-13-a-mut-payload-bound-through-a-shared-scrutinee-is-writable.md` (S1, open). The cause is the
pattern binding, which is its own variable with no path back to the `&` root.

Tests:

- `tests/origins/unsound/` (G-B): `mut-field-copied-by-derive-clone` and `mut-field-copied-through-shared-param`
  (E0908), `mut-field-reborrowed-from-owned` (E0911), and the controls `mut-field-holder-moved-whole-pos` and
  `mut-field-reborrowed-from-owned-pos` (the reborrow used and dropped before `m` is read again), clean under ASan.
- `tests/origin_holder_derive.test.yo`, "origin holder derive: a `&mut` field read into a `&mut` field reborrows it":
  the write through the reborrow reaches `x`, and the `&M` copy is E0908.

The corpus rows the Test section names are not added: each needs its encoding in the model's toy language
(`tests/origins/model_corpus.test.yo`), and the G-B rows above gate the same three shapes.
