# A later argument can move the place an earlier argument lends to the call's borrowing future

**Severity:** S1 — the future wrote through a place whose value had already
been moved out and disposed, so it used a dead value after its `Dispose` ran.

Found 2026-10-13 while closing the §3.13 A2 review (V3 async, borrowing
futures).

## Symptom

```yo ignore
(g_disposed : i32) = i32(0);
Res :: struct(n : i32);
impl(Res, Dispose(dispose : (fn(self : &Self) -> unit)({
  g_disposed = (g_disposed + i32(1));
})));
eat :: (fn(b : Res) -> i32)(b.n);
two :: (fn(c : &mut Res, k : i32, io : Io) -> Impl(Future(i32, Io)))(
  io.async({ &mut c, k }(io : Io) => {
    io.await(yield(io), io);
    println(&g_disposed);       // prints 1: `a` was disposed already
    c.n = (c.n + k);            // writes into the moved-out `a`
    c.n
  })
);
main :: (fn(io : Io) -> unit)({
  a := Res(n : i32(1));
  n := io.await(two(&mut a, eat(a), io), io);   // accepted
  println(&n);
});
```

It printed `1` and then `2`: the future ran after `eat` had taken `a` and
disposed it, and it wrote into the moved-out place. Overwriting the place in
a later argument (`two(&mut a, { a = Res(n : i32(0)); i32(1) }, io)`) and
lending it `&mut` again (`two(&mut a, touch(&mut a), io)`, or a `&mut self`
method call `a.touch()`) were accepted too.

## Root cause

The arguments are evaluated in order, so the future's borrow of `a` starts
when `&mut a` is evaluated, and the later arguments run while that borrow is
held. Decision 28's argument exclusivity covers a bare by-value argument that
aliases a borrowed one (`two(&mut a, a, io)` is rejected by
`require_ref_own_argument_exclusivity`), not code inside a later argument
that moves, writes or re-lends the place. For a plain call the borrow ends
with the call; a borrowing future holds it until the `io.await` completes.

## Fix

`_check_future_call_argument_conflicts` (`src/evaluator/calls/function.yo`)
runs at the call that makes a borrowing future, after the decision 38 D check.
For each place the future borrows (the receiver, then each argument lent with
`&`/`&mut` to a parameter the future captures), it rejects, with E0910
(`E_BORROW_CONFLICT`):

- a move of the place's root binding by a later argument (the binding is
  consumed once the arguments are evaluated; a move before the lend would
  already be E0901 at `&x`);
- an assignment to an overlapping place in a later argument;
- a `&mut` of an overlapping place in a later argument, written out or as the
  receiver of a `&mut self` method.

A read or a `&` borrow of the place in a later argument is not this rule's
concern: a later argument that is itself a place overlapping one lent `&mut`
(`f(&mut p, p.m, io)`) is decision 28's argument exclusivity, as for any call.
The help names the fix: compute the argument before the statement. Recorded in
`plans/VALUES_BY_DEFAULT.md` §3.13 A2's "As built" note. The plain-call case
(the borrow ends with the call) is
`issues/fixed/a-later-argument-can-move-the-place-an-earlier-argument-lends-to-a-call.md`.

Regression test: `tests/async_await.test.yo`, "a later argument cannot move,
overwrite or lend &mut what an earlier one lends to the call's future".
