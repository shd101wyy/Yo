# A state machine returning a borrowed capture hands out the capture's only reference

**Severity:** S1 — an `io.async` body that awaits and then returns a value it captured implicitly (a `String`, a `ref` struct) gave the awaiter a value the future's dispose freed: a use after free, with no diagnostic

**Status:** FIXED 2026-10-12 (feat/vbd-v3-genb). Present in the released v0.2.59 seed.

## Symptom

Found while testing `std/async`'s `join_all` over tasks that return a
captured `String` (`slow(ms, v : String, io)` whose body sleeps, then returns
`v`). It is independent of `JoinHandle`: a plain `io.await` shows it.

```yo
slow :: (fn(ms : u64, v : String, io : Io) -> Impl(Future(String, Io)))(
  io.async((io : Io) => {
    io.await(sleep(ms), io);
    v
  })
);
main :: (fn(io : Io) -> unit)({
  f := io.async((io : Io) => {
    out := ArrayList(String).new();
    (i : i32) = i32(0);
    while(i < i32(3), {
      out.push(io.await(slow(u64(1), `b`, io), io));
      i = (i + i32(1));
    });
    out
  });
  x := io.await(f, io);
});
export(main);
```

crashed in about half the runs with `pointer being freed was not allocated`
(macOS libmalloc), with v0.2.59, the A2 stand-in and the tree compiler alike.
With a `Dispose` counter the early free is deterministic: the value is
disposed while the awaiter still holds it.

## Cause

The state-machine lowering (`src/codegen/async/state_machine.yo`) emits the
body's tail as `sm->result = <code>;` straight from `_call_generate_expr`, so
the tail's deferred dups were never emitted. A borrowed tail (here the
implicit capture `v`, which the future's dispose still drops) carries one, and
a sync body's begin epilogue applies it. In the state machine the result and
the capture were one reference: `sm->result = sm->__capture.__yo_v_v;`. Since
§3.13 A1 the awaiter moves the result out and marks the future `-3`, and the
dispose then drops the capture, freeing the value the awaiter holds. (Before
A1 the awaiter dup'd the result, and the dispose dropped the capture AND the
result, which freed it the same way.)

## Fix

The tail goes through `arm_value_with_dups` (`src/codegen/exprs/drop_dup.yo`),
as a match arm's value does: its deferred dups are emitted and the result
takes the dup'd value.

Regression test: `tests/async/sm_ownership.test.yo`, "a state machine
returning an implicit capture retains it for the result" (a `Dispose` counter
that fails before the fix, and the `String` loop).
