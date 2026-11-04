# A structural clone through a pointer dereference copies the record first

**Severity:** S2 — `ArrayList.get_cloned` (and any `(p.add(i)).*.clone()`) over an anonymous record with a move-only field was rejected with E0901 inside std, so a valid program could not read such an element out.

Found by the B8 flip's tree binary (Tier 1, `tests/move_only.test.yo` "B6-b: a structural clone of an anonymous-record element reads it in place"): with `String`/collections as values, `get_cloned`'s `(p.add(index)).*.clone()` over `struct(b : _MoCl, k : i32)` failed with "cannot copy `(p.add)(index).*` … it is the value a pointer or reference points to".

## Root cause

`structural_clone_expansion` (`src/evaluator/utils/closure.yo`) expands `recv.clone()` on an anonymous record into the field-wise literal `_(b : recv.b.clone(), k : recv.k)` when `recv` is a place, and binds a non-place receiver first (`{ __yo_clone_src := recv; __yo_clone_src.clone() }`), which copies it. `_clone_receiver_is_place` knew names, field paths and `Index` element reads, but not a dereference, so `(p.add(index)).*` was bound, and the bind is the copy E0901 rejects.

## Fix

A dereference is a place when its address is a place or pure pointer arithmetic over one (`p.add(i)` with a place `p` and a place or literal offset): re-evaluating such an address per field reads nothing new. `_clone_receiver_is_place` now accepts it (`_clone_address_is_pure`).

## Test

`tests/move_only.test.yo`, "B6-b: a structural clone of an anonymous-record element reads it in place" (the `get_cloned` half): fails before, passes after.
