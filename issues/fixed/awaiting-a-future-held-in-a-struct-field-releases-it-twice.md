# Awaiting a future held in a struct field releases it twice

**Status:** FIXED 2026-09-11 — `src/codegen/async/state_code_gen.yo`
(`emit_await_future_store`).
**Found by:** develop's full battery, run 34557965609 — `test (ubuntu-latest)`,
`test (ubuntu-24.04-arm)` and `test (macos-latest)` all report it in
`tests/async/waker.test.yo`, "Test a wake before the park suspends is not lost".

## Symptom

```
==3965==ERROR: AddressSanitizer: heap-use-after-free on address 0x507000003824
READ of size 1 at 0x507000003824 thread T1
    #0 __yo_decr_rc
    #1 yo_id_17469                 <- Park's dispose, dropping self._future
    #2 __yo_decr_rc_tracked
    #3 __yo_decr_rc
    #4 __yo_user_main

freed by thread T1 here:
    #1 __yo_decr_rc
    #2 __yo_waker_release           <- the Waker's dispose
    ...
    #6 __yo_user_main

previously allocated by thread T1 here:
    #2 __yo_async_park_start
```

Every ASan-armed CI leg reports it — the two Linux ones and macOS (there as
exit code 6, an abort out of ASan). It does NOT reproduce by running the
program on this development machine: the object is freed one drop early and the
read that follows lands on memory the allocator has not reused, and the local
box's `--sanitize address` build does not instrument (the long-standing local
ASan defect). The emitted C is the oracle here, not a local run.

## Reproducer

```rust
{ Park } :: import("std/async/waker");

main :: (fn(io : Io) -> unit)({
  p := Park.new();
  w := p.waker();
  w.wake();
  io.await(p.wait(io), io);
  ()
});
export(main);
```

`Park.wait` is the whole reproducer:

```rust
wait : (fn(self : Self, io : Io) -> Impl(Future(unit, Io)))(
  io.async((io : Io) => {
    _r := io.await(self._future, io);
    ()
  })
)
```

## Root cause

`sm->await_future_N` **owns** its reference. The emitted state machine
`__yo_decr_rc`s that slot in three places — when the await's result is
extracted, when the awaited future aborts, and in the state machine's dispose
function — and every other way a future reaches the slot pays for that:

- a future the awaited expression **produces** (an `io.async(…)` block, a
  `__yo_async_*_start()` extern, a call returning `Impl(Future)`) hands over the
  reference it just created, and the temp's own deferred drop is aliased onto
  the slot rather than emitted twice (`state_machine.yo`, Phase 1b);
- a **named** future is never stored in the slot at all — the await reads the
  variable's own field, and the comment at the dispatch-mode branch in
  `state_code_gen.yo` says why: "storing it into the slot would hand the slot an
  unowned reference (the extraction decref would over-release it)".

A future read out of a **field** was the case nobody had covered. The store was

```c
sm->await_future_0 = (void*)(sm->__capture.self->_future);
```

with no `__yo_incr_rc`, while `Park`'s own dispose still drops `_future`. Two
releases, one reference. In the failing test the `Waker` holds the second
reference, so the ordering is: `p` allocates the future (rc 1), `p.waker()`
takes one (rc 2), the await releases one it never took (rc 1), dropping `w`
releases the last one and **frees** it, and `p`'s scope-end drop then reads the
freed header.

## Fix

Every one of the seven await-future store sites now goes through
`emit_await_future_store`, which takes a reference when the awaited expression
is a borrowed place — a field, or a chain of them, rooted at an atom. That
predicate (`_await_future_expr_is_borrowed_place`) is shaped after
`arg_is_rc_projection_place` in `src/evaluator/utils.yo`, which asks the same
borrow question about an ordinary call argument; the codegen form is purely
syntactic because there is no environment to resolve the root binding in.

Emitted C after the fix:

```c
sm->await_future_0 = (void*)(sm->__capture.self->_future);
// Borrowed future (read out of a field): the slot releases what it
// holds, so it needs a reference of its own — otherwise this await
// frees the field's future out from under its owner.
if (sm->await_future_0 != NULL) { __yo_incr_rc((void*)sm->await_future_0); }
```

## Regression test

`tests/async/waker.test.yo` — "Test awaiting the same park twice does not
release its future twice". The first await alone is already the bug; awaiting
twice drives the count to zero **while the park and its waker are still live**,
so the release is unambiguous rather than a one-off imbalance at scope end.
The ASan-armed CI legs are what turn it red.
