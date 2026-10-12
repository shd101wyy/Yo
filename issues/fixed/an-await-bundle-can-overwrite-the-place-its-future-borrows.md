# `io.await`'s bundle argument can move, overwrite or re-lend the place its future borrows

**Severity:** S1 — the future read a freed `ArrayList` handle through its lent
copy (`-1` where 7 was pushed), or crashed (`rc=139`).

Found by the adversarial review of the §3.13 A2 change, 2026-10-12.

## Symptom

```yo ignore
first :: (fn(items : &ArrayList(i32), io : Io) -> Impl(Future(i32, Io)))(
  io.async({ &items }(io : Io) => {
    io.await(yield(io), io);
    match(items.get(usize(0)), .Some(v) => v, .None => i32(-1))
  })
);
s := ArrayList(i32).new();
s.push(i32(7));
n := io.await(first(&s, io), {
  s = ArrayList(i32).new();   // accepted: overwrites the place the future borrows
  io
});
```

It printed `-1`. Re-lending `&mut s` to a second borrowing future inside the
bundle (`p21_overlap_bundle.yo`) segfaulted, and moving `s` into a `sink`
parameter there (`p09c_bundle_move_asan.yo`) printed `-1` too.

## Root cause

`io.await` evaluates its bundle after its operand, so the bundle runs while
the operand's future already holds its borrow. Nothing froze the borrowed
place for that window. The A2 "As built" note's claim that the future's lent
`&T` copy cannot go stale ("the caller's place stays frozen while the future
lives") relied on a freeze that did not exist. A plain call has the same gap
(`firstof(&s, eat(s))` prints `-1` on v0.2.59), but there the borrow ends
with the call; A2 made it live across a suspension.

## Fix

Re-rooting the future's borrows at the caller's places, which a freeze
needs, is deferred to decision 43. So the conservative rule
(`_check_awaited_future`, `src/evaluator/calls/function.yo`): when the
operand's future borrows, the bundle must be a place that evaluating runs no
code for (a name, or a field chain on one: `io`, `self.io`, `e.io`). Any
other bundle is E0910, naming the fix (compute the bundle before the
statement). Recorded in `plans/VALUES_BY_DEFAULT.md` §3.13 A2's "As built"
note. The plain-call gap is unchanged.

Regression test: `tests/async_await.test.yo`, "a borrowing future's io.await
takes a bundle that is a place".
