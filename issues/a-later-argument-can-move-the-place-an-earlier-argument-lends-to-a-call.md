# A later argument can move the place an earlier argument lends to a plain call

**Severity:** S1 — the callee reads and writes a place whose value a later
argument already moved out and disposed (a use after `Dispose`).

Found 2026-10-13 while fixing the borrowing-future case
(`issues/fixed/a-later-argument-can-move-the-place-an-earlier-argument-lends-to-the-future.md`).
The bundle fix (`issues/fixed/an-await-bundle-can-overwrite-the-place-its-future-borrows.md`)
noted the same plain-call gap (`firstof(&s, eat(s))`) and left it open.

## Symptom

```yo ignore
(g_disposed : i32) = i32(0);
Res :: struct(n : i32);
impl(Res, Dispose(dispose : (fn(self : &Self) -> unit)({
  g_disposed = (g_disposed + i32(1));
})));
eat :: (fn(b : Res) -> i32)(b.n);
syncf :: (fn(c : &mut Res, k : i32) -> i32)((c.n + k));
main :: (fn() -> unit)({
  a := Res(n : i32(1));
  n := syncf(&mut a, eat(a));   // accepted; `syncf` reads `a` after `eat` disposed it
  println(&n);
});
```

It is accepted and prints `2`: `syncf` reads `a.n` from the moved-out place.
With a payload that owns memory, `eat`'s drop frees what `syncf` then reads.
A bare `syncf2(&mut a, a)` is rejected (`require_ref_own_argument_exclusivity`,
`src/types/flowability.yo`); a move inside a nested call or block is not.

## Root cause

The arguments are evaluated in order, so the borrow `&mut a` is taken before
`eat(a)` runs, and decision 28's argument exclusivity looks only at an
argument that is itself a place aliasing a borrowed one, not at code inside a
later argument that moves, writes or re-lends the place.

## Fix direction

The borrowing-future rule (`_check_future_call_argument_conflicts`,
`src/evaluator/calls/function.yo`) already detects a move, an overwrite and a
`&mut` relend of a lent place in a later argument. Running it for every call
that lends a place, not only one that makes a borrowing future, closes this
case too. An overwrite or a `&mut` relend that finishes before a plain call
runs leaves the place valid (the callee sees the new value), so only the move
is unsound for a plain call; whether to reject the other two there is a
decision 28 question.
