# May a later argument overwrite or `&mut`-relend a place an earlier argument lends to a plain call?

**Kind:** design question: an open decision, not a defect. Filed 2026-10-13
by the fix of
`issues/fixed/a-later-argument-can-move-the-place-an-earlier-argument-lends-to-a-call.md`
(decision 28's argument exclusivity, `plans/VALUES_BY_DEFAULT.md`).

## The question

A call's arguments are evaluated in order, so a place lent by an earlier
argument (`&x`, `&mut x`, `&mut x.f`, the receiver of a `&self`/`&mut self`
method) is borrowed while the later arguments run. Three things a later
argument can do to that place:

1. **move** its root binding (`syncf(&mut a, eat(a))`);
2. **overwrite** it (`syncf(&mut a, { a = Res(n : i32(10)); i32(1) })`);
3. **lend it `&mut` again** (`syncf(&mut a, reset(&mut a))`, or call a
   `&mut self` method on it).

Case 1 is now rejected for every call with E0910
(`_check_call_lent_place_moves`, `src/evaluator/calls/function.yo`): the
callee would read and write a moved-out, dropped place. For a call that makes
a borrowing future, all three are rejected (§3.13 A2,
`_check_future_call_argument_conflicts`), because the future holds the borrow
past the call until it is awaited.

For a plain call, cases 2 and 3 are accepted. Should they be?

## Why 2 and 3 are sound for a plain call

The borrow an argument hands a plain call is not used before the call
starts. The overwrite (case 2) drops the old value and stores the new one,
and the relend (case 3) ends when its own call returns; both finish before
the callee runs, so the place is valid and initialized when the callee reads
it, and the callee sees the new value. No storage is read after it was
released. Rust rejects both (two-phase borrows allow only reads of the
place), but that is Rust's static borrow model, not a memory-safety
requirement of Yo's call lowering, which materializes `&x` as the address of
a place that outlives the call.

What they cost is readability: `f(&mut a, { a = ...; k })` reads as if `f`
gets the old `a`.

## Recommendation

Keep cases 2 and 3 accepted for a plain call, and keep rejecting only the
move. The rule then states one hazard (the callee reads a dead value), which
is exactly what the error explains; rejecting a sound program on style
grounds would make decision 28 stricter than its reason. If the maintainer
prefers the Rust-like reading ("an argument's borrow starts when it is
evaluated"), the change is mechanical: run `_find_lent_place_access` (already
written for the future rule) from `_check_call_lent_place_moves`, with the
plain-call message, and add a test that the overwrite and the relend in
`tests/parameter_modes.test.yo` become errors.
