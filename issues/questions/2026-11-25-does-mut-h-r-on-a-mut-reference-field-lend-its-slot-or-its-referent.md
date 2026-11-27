# Does `&mut h.r` on a `&mut` reference field lend the field's slot or its referent?

**Kind:** design question, an open decision, not a defect. Filed 2026-11-25 by the VERDICTS-78 Q1 lane.

## The question

VERDICTS-78's rule says "`&mut h.r` lends the slot as a `&mut &(T, p)`", without naming the field's mode. Q1 implements it for a `&` field (`H :: struct(r : &T, …)`): `setp(&mut h.r, &y)` and `p := &mut h.r` lend the slot, and a `&mut T` parameter given `&mut h.r` is E0908 ("lends the reference field itself"). For a `&mut` field (`M :: struct(r : &mut i32, …)`) the old reading is kept: `&mut m.r` reborrows the referent, so `bump(&mut m.r)` with `bump : fn(v : &mut i32)` is accepted, as are `bump(m.r)` (a reborrow of the field's reference) and `bump(&mut m.r.*)`.

```yo ignore
M :: struct(r : &mut i32, n : i32);
bump :: (fn(v : &mut i32) -> unit)({ v.* = (v.* + i32(1)); });
mut(a) := i32(1);
mut(m) := M(r : &mut a, n : i32(0));
bump(&mut m.r);     // accepted today: lends `a`
bump(&mut m.r.*);   // accepted: lends `a`
```

## Options

- **A. Keep the split.** `&mut h.r` lends the slot of a `&` field and the referent of a `&mut` field. No program changes; the rule reads differently by field mode, and a `&mut` field's slot cannot be lent (a `&mut &mut T` setter has no spelling for a field).
- **B. One reading.** `&mut h.r` lends the slot for every reference field, as the verdict's sentence says; the referent is `&mut h.r.*`, the spelling `h.r.* = v` already uses. `bump(&mut m.r)` becomes a type mismatch whose help names `&mut m.r.*`. No `std/` or `src/` struct has a `&mut` reference field today (`grep` over both), so the cost is tests and docs.

## Recommendation

B: it is the verdict's sentence, it makes the place `h.r` mean the field's own storage in every lend (explicit over implicit), and the tree carries no `&mut` reference field to migrate. It lands as a follow-up to Q1 (one condition in `_reference_field_read_place`, `src/evaluator/exprs/property-access.yo`, plus the E0908/E0914 help for a `&mut` field), not inside it, because it rejects programs Q1 keeps accepting.
