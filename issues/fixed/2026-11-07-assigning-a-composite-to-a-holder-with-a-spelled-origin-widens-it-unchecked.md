# Assigning a composite to a holder with a spelled origin widens it unchecked

**Severity:** S1 — use-after-free in safe code: a holder declared over `x` is assigned a composite holding `&y`, and `y` dies while the holder is read

Found 2026-11-07 while verifying O-1's `=` join (`plans/backlog/BORROW_CHECKER_COMPLETENESS.md` §3, §8).

## Reproducer

Program: `issues/repros/2026-11-07-assigning-a-composite-to-a-holder-with-a-spelled-origin-widens-it-unchecked.yo`.

`mut(s) := Option(&(Rc(X), x)).None;` then, inside a block, `s = .Some(&y);` with `y` a block local; `s` is read after the block. `yo check` accepts it (develop `f89a24b0d`); compiled with `--sanitize address --allocator system` and run, ASan reports `heap-use-after-free`.

## Root cause

A whole-holder assignment whose value is not a bare lend registered nothing: the re-point machinery (decision 25) handles `s = &y`, and the binding paths handle `:=`, but `s = .Some(&y)` neither checked the value's origin against the holder's spelled one (O3's place writes) nor grew the holder's flow set, so `y`'s scope end saw no live loan.

## Fix

Fixed by O-1: `bind_join` (`src/evaluator/utils.yo`), wired into `evaluate_assignment`'s whole-variable write, is the `=` join. The value's origin (`origin_of`) joins the holder's loan set, and a holder whose type spells its origin checks the subset first: a root the spelled origin does not name is E0923 at the assignment.

## Test that pins it

`tests/origins/unsound/spelled-holder-assign-widen.yo` (G-B: rejected with E0923; its positive twin `spelled-holder-assign-widen-pos.yo` compiles and runs clean under ASan).
