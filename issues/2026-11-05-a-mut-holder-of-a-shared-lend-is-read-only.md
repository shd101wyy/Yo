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

## Fix (planned, stacked on N1e-2b PR2a)

- Read-only is a property of a REFERENCE binding. Once PR2a lands, a binding
  is read-only exactly when `variable_slot_type(v)` is `Reference(_, imm, _)`.
  `local_borrow_require_writable` will decide writability from the written
  root binding's own slot type, and will no longer read the `is_mut` of
  whichever `LocalBorrowInfo` carries its name.
- A holder's record is a FREEZE of the place it lends (`x`, in the lend's
  mode). It keeps driving E0911 over that place. If a reader still has to
  tell the two kinds of record apart, the record gets a kind
  (`ReferenceBinding | HolderFreeze`) as its identity, not a skip flag.

Tests go in `tests/origins/`:

- `slot = .None` on an `Option(&i32)` holder is accepted.
- `bump(&mut h)` and `h.n = 5` on a `mut` holder of a `&` field are accepted.
- Writing `x` while `h` is still live remains E0911.
