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

## Fix

`_check_call_lent_place_moves` (`src/evaluator/calls/function.yo`) runs at
every call, in user code and in std, after the borrowing-future checks
(`_note_future_producing_call`), so a call that makes a borrowing future
still reports the stricter §3.13 A2 conflict first. It finds each place the
call lends:

- an argument written `&x`/`&mut x`, a field path included (`&mut a.f`),
  whatever the callee (a function by name, a method, a closure or another
  function value);
- the receiver of a method whose `self` is a borrow (`self : &Self` or
  `self : &mut Self`) when the receiver is a name or a field chain on one
  (`a.peek(eat(a))`); a by-value `self` moves the receiver itself, so a later
  use of it is already E0901.

If the place's root binding was consumed once the arguments are evaluated, a
later argument moved it (a move before the lend is E0901 at `&x`, and Yo has
no partial moves, so moving `a` while `&mut a.f` is lent is a move of the
lent place too). That is E0910 (`E_BORROW_CONFLICT`, "Call arguments are
exclusive", whose registry text now names this case), pointing at the move:
"This argument moves `a`, which an earlier argument of the same call lends to
it (`&mut a`) ...", with the help "move a copy instead (`a.clone()`), or split
the call so the move comes after it". The move check is shared with the
future rule (`_lent_place_moved_at`).

An overwrite or a `&mut` relend of the lent place in a later argument stays
accepted for a plain call: it finishes before the call runs and the callee
sees the new value. Whether to reject it anyway is the decision 28 question
`issues/questions/a-later-argument-overwriting-a-place-lent-to-a-plain-call.md`.

Documented in `docs/{en-US,zh-CN}/FLOWABILITY.md` ("One call-site rule"),
`docs/{en-US,zh-CN}/ASYNC_AWAIT.md`, decision 28's "As built" note in
`plans/VALUES_BY_DEFAULT.md` and `.github/instructions/yo-syntax.instructions.md`.

Regression test: `tests/parameter_modes.test.yo`, "a later argument cannot
move the place an earlier argument lends to the call" (a nested-call move, a
move two calls deep, a block move, a field-path lend `&mut p.f` with a later
move of `p`, a borrowed receiver, a closure callee; and, accepted, an
overwrite, a `&mut` relend and a move of another binding).
