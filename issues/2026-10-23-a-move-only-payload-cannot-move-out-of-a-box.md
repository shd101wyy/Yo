# A move-only payload cannot move out of a `Box`, so `RefCell(T).into_inner()` rejects a move-only `T`

**Severity:** S3 — a valid program is rejected inside std (E0901 with a note into `std/sync/refcell.yo`); the payload can still be taken out with `take()` or `replace(v)`, which move it bitwise.

**Status:** OPEN — found 2026-10-23 while adding `RefCell.into_inner`
(step 0 of `issues/questions/2026-10-23-should-yo-add-a-flagless-cell.md`).
Not fixed there: the fix needs a compiler builtin, and that change is std-only.

## Reproducer

`issues/repros/2026-10-23-a-move-only-payload-cannot-move-out-of-a-box.yo`
(seed v0.2.68 and a develop 4b96ec5e9 tree binary, `--std-path ./std`):

```
error[E0901]: use of moved value: cannot copy `value`, whose type `Tok` is move-only, and it cannot be moved either: it is borrowed (a `&T` parameter or a `match`/`for` binding), and a borrow cannot give the value away.
note: raised here, inside the standard library
 --> std/sync/refcell.yo
  |     match(self, { _slot : { _borrow : _, _value : value } } => value)
```

Expected: `got 1`, then `drop 1` once.

## Cause

`RefCell(T)` keeps its mark and value in a `Box(_RefCellSlot(T))`.
`into_inner(self : Self)` owns the box, but no operation moves a payload out of a
`Box` and frees the cell without dropping that payload, which is Rust's `*b`
move or `Box::into_inner`:

- A pattern through the box (`{ _slot : { _value : v } }`, or `Box(v)`)
  binds a borrow, so the binding copies. That is fine for a `Copy` or
  explicit-copy payload, whose copy the box's drop then releases. A move-only
  payload cannot be copied, hence E0901.
- `__yo_ptr_read` moves the payload out bitwise, but the box's `Drop` still
  runs `drop_in_place` on the dead slot, which would drop the value twice.
- `Rc` and `Arc` solve the same problem for `try_unwrap` with the builtin
  `__yo_rc_forget_payload`. `Box` has no counterpart, and std has no
  `forget`: `MaybeUninit` drops its payload
  (`issues/2026-10-23-an-unwritten-maybeuninit-drops-its-payload.md`).

## Fix directions

1. Add `Box.into_inner(b) -> T` to the prelude, on a builtin that frees a box
   cell without dropping its payload (`__yo_box_forget_payload`, mirroring the
   `Rc` one). `RefCell.into_inner` then moves the slot out through it. This
   is a Generation A builtin: std can use it only once `SEED_VERSION` carries it.
2. Or wait for decision 49 step 2 (the question above): `RefCell` moves inline
   onto the interior primitive, and `into_inner` becomes a plain field move.

A fix adds a `RefCell(Tok).into_inner()` case with a counted `Drop` to
`tests/sync/refcell.test.yo`.
