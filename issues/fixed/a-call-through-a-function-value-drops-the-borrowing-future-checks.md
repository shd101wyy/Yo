# A call through a function value drops every borrowing-future check

**Severity:** S1 — a future spawned through a function value read and wrote a
dead stack frame (`7000001` where 42 was right), and an `Rc` lend lost
another task's update.

Found by the adversarial review of the §3.13 A2 change, 2026-10-12 (the
review's finding is the `Rc` case; the wider defect and the generic-closure
shape were found while fixing it).

## Symptom

```yo ignore
add_later :: (fn(c : &mut Inner, io : Io) -> Impl(Future(unit, Io)))(
  io.async({ &mut c }(io : Io) => { io.await(yield(io), io); c.v = (c.v + i32(1)); })
);
make :: (fn(io : Io) -> JoinHandle(unit))({
  x := Inner(v : i32(41));
  fp := add_later;
  io.spawn(fp(&mut x, io), io)          // accepted; `add_later(&mut x, io)` is E0909
});
```

`fp := add_later; fut := fp(&mut x, io);` passed `check` (the direct form is
"would hold a borrowing future"), and `io.await(fp(&r.*.items, io), io)`
passed although `r` is an `Rc`. A generic `Impl(Fn(k : &mut C, io : Io) ->
Impl(Future(unit, Io)))` parameter behaved the same: `io.spawn(f(&mut c, io),
io)` on a local `c` crashed with `rc=138`.

## Root cause

A call by name carries its callee body's borrows on its result: the body's
future type is the result's resolution, and `collect_type_borrows` follows it
to the borrows `io.async` registered. A call through a function value has
only the function type's declared `Impl(Future(...))`, with no resolution, so
its future carried no borrows and every A2 rule (no binding, no spawn,
decision 38 D) saw a first-class future.

## Fix

The function value's body is not visible at the call, so the rule is the
conservative one: a call through a function value whose result is a future
is assumed to borrow every place it lends with `&`/`&mut`.
`_note_future_producing_call` (`src/evaluator/calls/function.yo`) registers
those assumed borrows under a fresh wrapper id that resolves to the call's
own type (codegen lowers it as before), and the future is then second-class
like a direct call's. A callee that is a function by name, a method resolved
to its definition, or an extern is exact and unaffected. A `Dyn` method call
is excluded; it was closed later at the `dyn(v)` site
(`issues/fixed/a-dyn-method-future-carries-no-borrows.md`).
Recorded in `plans/VALUES_BY_DEFAULT.md` §3.13 A2's "As built" note.

Regression test: `tests/async_await.test.yo`, "a future made through a
function value is assumed to borrow what the call lends".
