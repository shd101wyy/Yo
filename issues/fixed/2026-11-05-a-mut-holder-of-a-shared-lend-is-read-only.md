# A `mut` holder of a shared lend is read-only (E0908)

**Severity:** S2: a valid program is rejected. A `mut` binding whose value
holds a `&` lend cannot be reassigned, passed `&mut`, or have a field
written: `mut(slot) := Option(&i32).Some(&x); slot = .None` fails with
E0908 "`slot` is a `&` borrow, which is read-only". There is no workaround
short of not holding a reference.

> Reported by the coordinator 2026-11-05 from the N3 future probe
> (`_clear(&mut slot, io)` over `Option(&(i32, x))`). Reproduced on develop
> `ed56f990e` and on the N1e-2b PR2a build; neither N1e-2b PR fixes it.

## Reproducer

```yo
H :: (fn(comptime(p) : Origin) -> comptime(Type))(struct(r : &(i32, p), n : i32));
bump :: (fn(generic(p : Origin), h : &mut H(p)) -> unit)({
  h.n = (h.n + i32(1));
});
main :: (fn() -> unit)({
  x := i32(7);
  mut(slot) := Option(&i32).Some(&x);
  slot = .None;
  mut(h) := H(x)(r : &x, n : i32(0));
  bump(&mut h);
  h.n = i32(5);
});
export(main);
```

```text
error[E0908]: Cannot assign to `slot`: `slot` is a `&` borrow, which is read-only.
error[E0908]: Cannot pass `h` to the `&mut` parameter `h`, which the callee writes: `h` is a `&` borrow, which is read-only.
```

The same programs with `slot` initialized to `.None` are accepted. An
initializer holding no lend registers no freeze.

## Root cause

N2b's binding freeze, `freeze_origin_carrying_binding` in
`src/evaluator/utils.yo`, registers one `LocalBorrowInfo` for each root the
holder's value lends. That record is named after the HOLDER (`slot`, `h`),
and its `is_mut` is the LEND's mode. It is the same record a `y := &x` borrow
binding registers.

`local_borrow_require_writable`, the E0908 check called by
`local_borrow_write_expr` and by assignment, looks up a record by the written
place's root name and rejects the write when `!info.is_mut`. For a borrow
binding `y`, a write rooted at `y` is a write through the borrow, so the
check is right. For a holder, a write rooted at `slot` writes the holder
itself, which the holder's own `mut(...)` already governs. The freeze record
cannot tell the two apart.

## Fix

- Read-only is a property of a REFERENCE binding. A binding is read-only
  exactly when its slot type (`variable_slot_type`) is `Reference(_, imm, _)`.
  `local_borrow_require_writable` now decides from the written root binding's
  slot type (`local_borrow_root_is_shared_reference`), not from the `is_mut`
  of whichever `LocalBorrowInfo` carries the binding's name. A `&mut`
  argument records that verdict where it finds the place
  (`D3PendingInout.lb_read_only`).
- A holder's record stays a FREEZE of the place it lends, and it keeps
  driving E0911 over that place. No record kind or skip flag is needed.
  N2b-r's first version added a `LocalBorrowInfo.is_holder` flag, which this
  fix replaces.

The fix landed with N2b-r, together with O3-3. Alone, it accepted the corpus
row `store-widen-mut-pointee` (`_store(&mut slot, &y)`, which widens an
`Option(&(i32, x))` holder to `y`). Today's E0908 rejected that row for the
wrong reason. With O3-3 in the same change, the row is ORIGIN_MISMATCH
(E0923), its target verdict.

Tests:

- `tests/origins/reference_read_rule.test.yo`, "A mut holder of a shared lend
  is writable": `slot = .None`, a holder passed `&mut`, and `bump(&mut h)`
  plus `h.n = ...` on a `mut` holder of a `&` field. `rr_holder_still_freezes`
  checks that writing `x` while `h` is live stays E0911. VERDICTS-25's cursor
  walk through `self : &mut RrIntCursor(p)` (`rr_next`) runs.
- `tests/borrow_spelling.test.yo`, "a `mut` holder of a `&` reference is lent
  `&mut`".
