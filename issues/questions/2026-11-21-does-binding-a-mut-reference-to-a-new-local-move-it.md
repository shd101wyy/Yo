# Does `a := m` move a `&mut` reference binding into `a`, or is it rejected?

**Kind:** design question

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
