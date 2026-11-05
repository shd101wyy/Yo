# A `mut` binding holding a `&` reference is reported as a read-only `&` borrow when lent `&mut`

**Severity:** S2: a valid program is rejected. A `mut` local whose value carries an
origin (`mut(slot) := Option(&(i32, x)).Some(&x)`) cannot be lent to a `&mut`
parameter: E0908 says `slot` "is a `&` borrow, which is read-only" and points at its
declaration as `slot := &...`, which it is not. The corpus row
`store-widen-mut-pointee` stopped at this error instead of reaching its O3-3 rule.

> Found 2026-11-05 while gating the N2b residue rows on develop 74b5bbcc8
> (decision 43 step 3).

## Reproducer

```yo
_store :: (fn(generic(T : Type, r : Origin), dst : &mut Option(&(T, r)), v : &(T, r)) -> unit)({
  dst.* = .Some(v);
});
main :: (fn() -> unit)({
  x := i32(1);
  mut(slot) := Option(&(i32, x)).Some(&x);
  _store(&mut slot, &x);
  ()
});
export(main);
```

```text
error[E0908]: Cannot pass `slot` to the `&mut` parameter `dst`, which the callee writes: `slot` is a `&` borrow, which is read-only.
note: `slot` is declared `slot := &...` here:
```

## Root cause

N2b's binding freeze (`freeze_origin_carrying_binding`, src/evaluator/utils.yo)
registers the places a holder's origins name as local-borrow entries under the
HOLDER's name, so the E0911 machinery freezes them while the holder lives. A `&`
root's entry is not `is_mut`. `local_borrow_require_writable` reads any entry named
after the written place's root as "that root is a `&` borrow", so a write of the
holder itself was a write through a read-only borrow.

## Fix

`LocalBorrowInfo` gains `is_holder`, set on the entries the binding freeze
registers. The holder holds references and is not one, so
`local_borrow_require_writable` skips it. Writing the holder is checked as any
binding write: its own mutability, and the freeze of what it points into. Test:
`tests/borrow_spelling.test.yo` ("a `mut` holder of a `&` reference is lent
`&mut`").
