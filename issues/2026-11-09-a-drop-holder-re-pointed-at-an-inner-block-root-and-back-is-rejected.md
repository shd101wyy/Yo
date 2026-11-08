# A `Drop` holder re-pointed at an inner-block root and re-pointed back before the block ends is rejected

**Severity:** S3: a valid program is rejected with E0911. That is S2 by the scale; it is triaged S3 because nothing in `src/`, `std/` or `tests/` reaches the shape (a flow-inferred holder with a user `Drop`, stored an inner-block root and overwritten in that same block).

- Filed: 2026-11-09 (O-5 lane), from O-4's (#1839) Deferred list.
- Reproduced on develop `ee24d9058` (this lane's tree binary carrying O-4).

## Reproducer

Program: `issues/repros/2026-11-09-a-drop-holder-re-pointed-at-an-inner-block-root-and-back-is-rejected.yo`.

```text
error[E0911]: Cannot store a reference to `y` in `g` here: `y`'s scope ends with its block, while `g` is live to its drop at the end of its own block (its type reaches a `Drop` that may read what it holds), so the reference would outlive the storage it points into …
  --> …:18:9
   |
18 |     g = G(&i32)(t : &y);
```

Expected: accepted. The program prints `2`, then `G dropped: 1` when `g` drops at the end of `main`. The value holding `&y` is dropped by the reassignment `g = G(&i32)(t : &x)`, while `y` is still alive. At the scope end `g` holds only `&x`. Rust's NLL accepts the equivalent (`let mut g = G(&x); { let y = 2; g = G(&y); g = G(&x); }`).

## Root cause

O-4 makes a holder whose type reaches a user `Drop` live to its scope-end drop: `local_borrow_range_of(…, to_scope_end)` in `src/evaluator/utils.yo`. The `=` join (`bind_join_roots_for`) then registers every joined root over that whole range. It also runs §7's scope check ("the root's scope ends before the holder's range does") at the store itself. Two pieces of information are missing:

- the join does not know that a later whole-holder assignment in the root's block kills the entry: the KILL of the next `=` is applied when it is evaluated, after the check has already fired;
- the drop that the reassignment performs reads the old value while its roots are still alive.

## Fix direction

At the store, compute the holder's live range per entry: the entry ends at the next whole-holder assignment that every path from the store reaches within the root's block, or at the scope end. The scope check and the same-block declaration-order check use that end. This is §7's flow join with kill precision, the same machinery P1 (re-point widening) needs.

## Test that pins it

The reproducer, moved under `tests/origins/` as a positive control (`// expect: accept` in `tests/origins/unsound/`, so it also runs clean under ASan) when the fix lands.
