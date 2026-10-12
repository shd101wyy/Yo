# An `io.async` body disposes a captured move-only value twice

**Status:** fixed by V3 async A1 (`plans/VALUES_BY_DEFAULT.md` §3.13).

**Severity:** S1: a double dispose (the second runs on a value whose resources
were already released). Any `io.async` body that reads a captured value with a
`Dispose` impl.

> Found 2026-10-09 by the adversarial review of the V3b flip's closure
> changes. Pre-existing: the v0.2.54 seed prints the same counts, for a local,
> a `fn` by-value parameter, a `sink` parameter and a closure parameter alike.

## Reproducer

```yo ignore
{ println } :: import("std/fmt");
{ IoExn, Exception } :: import("std/error");
(counter : i32) = i32(0);
_Res :: struct(n : i32);
impl(_Res, Dispose(dispose : (fn(imm(self) : Self) -> unit)({ counter = (counter + i32(1)); })));
_aw :: (fn(io : Io, e : IoExn) -> i32)({
  q := _Res(n : i32(7));
  (f : Impl(Future(i32, IoExn))) = io.async(e2 => q.n);
  io.await(f, e)
});
main :: (fn(io : Io) -> unit)({
  t_exn := Exception(throw : (err -> { unwind(()); }));
  t_e := IoExn(io : io, exn : t_exn);
  c0 := counter;
  v := _aw(io, t_e);
  println(`v=${v} disposed=${counter - c0} (want 1)`);
});
export(main);
```

Prints `disposed=2`. Without the `io.async` (reading `q.n` directly) it
prints 1.

## Root cause

The `io.async` state machine copies its captures into the state struct, and
the copy is a bitwise copy of a move-only value: the state machine's teardown
drops its copy, and the enclosing function's scope end drops the original.
A by-value capture of a move-only value must MOVE the original into the state
struct (the capture consumes it), or the body must borrow it (`imm`). Decision
37 (plans/VALUES_BY_DEFAULT.md) gives closures that choice; `io.async` bodies
are excluded from the closure capture rules (`is_io_async_sm_closure`), so
they still copy.

## Fix direction

Treat an `io.async` body's implicit capture of an explicit-copy value like a
closure's: a borrow when the future cannot outlive the value (it is awaited in
the same scope, A2's second-class future), otherwise a move. The test is the
reproducer above with a `Dispose` counter, for a local, a by-value parameter
and a closure parameter.

## Fix

`io.async`'s body parameter was `action : &Impl(Fn(e : E) -> T)`: a closure
literal passed to a borrowing `Impl(Fn)` parameter borrows its captures
(decision 22), while the state machine stored them by value. So the frame
owned `q`, the state machine held a bitwise copy, and both disposed it.

A1 makes the slot by value, `action : Impl(FnOnce(e : E) -> T)` (decision 37),
so the closure owns its captures. A move-only local moves into the state
machine and only its teardown disposes it. A `sink` parameter moves the same
way. A borrowed (by-value, pre-V3b) parameter cannot be moved into it, which
is E0901 at the capture instead of a silent double dispose.

Regression: `tests/async_await.test.yo`, "Test an io.async body disposes a
captured move-only value once" (a local, a `sink` parameter, and the E0901 for
a borrowed parameter).
