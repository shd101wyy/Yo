# Does `a := m` move a `&mut` reference binding into `a`, or is it rejected?

**Kind:** design question (resolved)

**Verdict:** ADOPTED (VERDICTS-76, 2026-11-22) — `a := m` with `m : &mut T` is a MOVE
(Rust's bare-`let` rule): the loan transfers to `a` until `a`'s last use, a later use of
`m` is E0901, and a reborrow stays spelled `a := &mut m.*`. Confidence 0.85. The
implementation is a separate fix PR: today's tree has contradictory arms — a false E0911
path at `src/evaluator/exprs/initialization-assignment.yo:983-999` and the E0901
"lend it on with `&mut`" arm at `src/evaluator/utils.yo:1512`.

Found while writing `docs/en-US/OWNERSHIP_AND_BORROWING.md` (2026-11-21).

```yo ignore
main :: (fn() -> unit)({
  mut(x) := i32(1);
  m := &mut x;
  a := m; // error[E0911]: Cannot borrow with `&mut` `x` here: `m` borrows `x` with `&mut` and is still live
  a.* = i32(2);
});
export(main);
```

## What the tree does today

- `a := m` is E0911. The binding registers `a` as a new `&mut` loan over `x` and finds `m` live, because
  `m`'s last use is this very statement ("its last use is in the same statement as the access").
- `(a : &mut i32) = m` is E0901 with a different reason: "cannot copy `m`, whose type `&mut i32` is
  move-only, and it cannot be moved either: it is a `&mut` borrow, which names storage the caller owns.
  Lend it on with `&mut`, or move the caller's value." (`transfer_explicit_copy_value`,
  `src/evaluator/utils.yo`, the `v.is_ref()` arm.)
- `a := &mut m.*` (an explicit reborrow) is accepted, and `m` is usable again after `a`'s last use.
- A struct that HOLDS a `&mut` moves whole: `m2 := m` with `m : M` and `M :: struct(r : &mut Box(X), …)`
  is accepted (`tests/origins/unsound/mut-field-holder-moved-whole-pos.yo`).
- The capture-list check says the opposite of the E0901 text: "A `&mut T` moves at its last use
  (decision 35); this closure cannot take it" (`src/evaluator/values/anonymous-function.yo`).

## What the documents say

- `plans/backlog/REFERENCES_AND_ORIGINS.md` §5 route 3: "a `&mut`-holding value is move-only, so a copy never
  duplicates an exclusive loan". Move-only implies it can be moved.
- `plans/VALUES_BY_DEFAULT.md` decision 42 lists "reborrow versus move of a `&mut T`" among the tests,
  so both were meant to exist.
- `docs/en-US/OWNERSHIP_AND_BORROWING.md`: "`&mut T` is not `Copy`, so there is never more than one
  usable `&mut` to a place." It does not say whether a `&mut` binding can be moved.
- Rust accepts `let a = m;` (a move: `m` is unusable afterwards, `a` inherits the loan) and reborrows
  implicitly when `a`'s type is annotated.

Two rules disagree in the tree: a bare `&mut` binding cannot be moved, but a struct holding one can.

## Options

1. **Accept the move (Rust's rule).** `a := m` consumes `m` (a later use is E0901) and `a` inherits
   `m`'s loan over `x`: `x` stays frozen until `a`'s last use. The E0901 arm for a `&mut` local
   borrow then applies only to a `&mut` PARAMETER, whose storage the caller owns, and only when the
   parameter is moved where the move can outlive the call. A local borrow is a value of this frame.
2. **Keep the rejection, fix the diagnostic.** `a := m` reports what `(a : &mut i32) = m` reports
   (E0901, "lend it on with `&mut`": write `a := &mut m.*`) instead of an E0911 whose loan is the
   binding's own source. The guide then says a `&mut` binding is never moved, only reborrowed.

## Recommendation

Option 1. Moving a value is the default for every other move-only value in Yo, including a struct
that holds the same `&mut`, so the rejection is an exception with no reason the user can see. The
loan-transfer machinery exists (a holder moved whole keeps its origins). Tests to add with the fix:
a G-B negative in `tests/origins/unsound/` that writes `x` while `a` lives (E0911), its positive
twin (this program), and a use of `m` after `a := m` (E0901).

## Resolution (2026-11-22, VERDICTS-76 Q1 as amended by its Fable review)

A bare `&mut T` reference read by value MOVES; the reborrow is spelled `&mut m.*`.

- `a := m` (and a `begin`/`cond`/`match` initializer whose leaves are such references): the R-TAIL
  chain binding (`_bind_projection_result`, `src/evaluator/exprs/initialization-assignment.yo`)
  marks a moved leaf's places as HELD — the destination takes over the places the reference holds,
  with no fresh `&mut` loan and no access check against `m`'s own loan (the false E0911) — and
  consumes the leaf through `set_expr_as_consumed`, so a later use, a move inside a loop and a move on
  one branch are the ordinary E0901. A moved reference with no local places (a parameter's) binds
  with none.
- `(a : &mut T) = m`, a tuple element, a generic `T` slot: `transfer_explicit_copy_value` and
  `check_dyn_copy` (`src/evaluator/utils.yo`) split the `is_ref` arm by what moves
  (`moves_reference_itself`): the reference read as itself is consumed, while the referent (`m.*`)
  keeps its E0901. The holder's `bind` already registers the moved reference's origin.
- The E0901 for a moved reference names the reborrow (`_mut_reference_move_help`), not the generic
  move-only help.
- A `&mut` parameter moves the same way: `a := m; …; m.* = v` in a body was an accepted silent reborrow
  before and is now E0901 (the breaking half; std/tests swept to `&mut m.*`).

Tests: `tests/origins/unsound/v76-mut-ref-*.yo` (G-B rows 1–9, 11, 15, 17, 18, 21–23 of the review's
table). Rows not in this change, filed: row 10
(`issues/2026-11-22-assigning-a-mut-reference-to-a-mut-reference-binding-is-e0926-not-a-re-point-by-move.md`),
row 12's reborrow spelling (`issues/2026-11-22-a-mut-reference-field-has-no-reborrow-spelling-into-a-local.md`),
row 14 (`issues/2026-11-22-a-shared-reference-field-read-bare-is-e0926-instead-of-a-copy.md`), row 20
(`issues/2026-11-22-a-capture-list-entry-cannot-move-a-mut-reference-into-the-closure.md`).
