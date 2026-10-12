# A `Dyn` method's future carries none of its implementation's borrows

**Severity:** S1 — a borrowing future reached through a `Dyn` vtable slot is
treated as first-class: it can be spawned and outlive what it borrows, and
the program reads freed memory.

Found 2026-10-13 while fixing
`issues/fixed/a-call-through-a-function-value-drops-the-borrowing-future-checks.md`
(§3.13 A2, V3 async borrowing futures).

## Symptom

```yo ignore
Bump :: trait(bump : (fn(self : &mut Self, io : Io) -> Impl(Future(i32, Io))));
C :: struct(n : i32);
impl(C, Bump(
  bump : (fn(self : &mut Self, io : Io) -> Impl(Future(i32, Io)))(
    io.async({ &mut self }(io : Io) => {
      io.await(yield(io), io);
      self.n = (self.n + i32(1));
      self.n
    })
  )
));
make :: (fn(io : Io) -> JoinHandle(i32))({
  (d : Dyn(Bump)) = dyn(C(n : i32(41)));
  io.spawn(d.bump(io), io)              // accepted; `C(...).bump(io)` by name is E0909
});
```

With a stack-clobbering call before `h.await(io)`, `--optimize 2` printed
`Some(4667)` where `Some(42)` was right, and `--optimize 0` crashed. `fut :=
d.bump(io)` is accepted too.

## Root cause

The borrows of a borrowing future are registered by the `io.async` in the
implementation's body and reach a call through its result type's resolution,
which only a call that sees the body has. A `Dyn` call goes through the
vtable slot, whose type is the trait's declared `Impl(Future(...))`.

## Why not the function-value rule

A call through a function value is assumed to borrow every place it lends.
For a `Dyn` method that makes every `&self`/`&mut self` receiver a borrow, and
decision 38 D then rejects the common, sound shape of a `Dyn` field of a `ref`
object awaited in place (`e.io.await(self.inner.read(e.io), e)` in
`tests/dyn.test.yo`, `DynSource` in `tests/io/async_traits.test.yo`, and
std's `BufReader(Dyn(Reader))`, whose `self._inner.read(...)` goes through
`self : &Self` of a `ref` struct): the assumed receiver borrow crosses the
`ref` object. None of those implementations returns a borrowing future.

## Fix

Exact at the point the vtable is built. `dyn(v)` resolves the method of `v`
that fills each vtable slot (`_resolve_dyn_trait_values`,
`src/evaluator/values/dyn.yo`); `_reject_dyn_borrowing_future_methods` then
reads each slot's result type and, when it is a future that carries borrows
(`collect_type_borrows`), rejects the `dyn(v)` with E0909, naming the method
and the borrowed place, and pointing at the alternatives: call the method on
the concrete type or through a generic `Impl(Trait)` parameter (both carry
the borrow), or capture by value in the method's `io.async`. Generic-impl
methods and monomorphized `?=` defaults fill the same slots, so they are
checked too, and an `upcast` keeps a vtable a `dyn(v)` already checked. A
`Dyn(Fn(...))` callee is a function value and keeps the assumed-borrow rule.

So every future a `Dyn` method call returns borrows nothing, and
`_callee_is_opaque_function_value` keeps excluding `Dyn` receivers. The
issue's program is rejected at `dyn(C(n : i32(41)))`. Recorded in
`plans/VALUES_BY_DEFAULT.md` §3.13 A2's "As built" note.

Regression test: `tests/async_await.test.yo`, "dyn(v) rejects a v whose
method returns a borrowing future".
