# A nested `io.async` that implicitly captures an enclosing capture moves it, and the enclosing dispose drops it again

**Severity:** S1: memory unsafety in generated code. A heap-use-after-free:
the inner future owns the value, and the enclosing state machine's dispose
frees it under the inner one.

> Found 2026-10-28 by the V2c tests sweep (`tests/async/sm_ownership.test.yo`,
> "a capture list and a nested implicit capture of the same name compile"):
> under decision 17 the nested future's implicit capture of an `Rc` moves it.
> Pre-existing: develop `c847d0b76` (and `a56c3a4f5`) shows the same
> use-after-free with a move-only `Box`.

## Reproducer

```yo
{ assert } :: import("std/assert");
{ println } :: import("std/fmt");
{ sleep } :: import("std/sys/timer");
main :: (fn(io : Io) -> unit)({
  b := box(u64(5));
  outer := io.async({ b }(io : Io) => {
    inner := io.async((io : Io) => {
      io.await(sleep(u64(1)), io);
      b.* + u64(1)
    });
    io.await(inner, io) + u64(1)
  });
  assert(io.await(outer, io) == u64(7), "both state machines ran");
  println("ok");
});
export(main);
```

`yo compile repro.yo --sanitize address --allocator system`: the run reports
`heap-use-after-free` when the inner future reads `b`. With an explicit capture
list on the inner future (`io.async({ b }(io : Io) => …)`) it prints `ok`.

## Root cause

The inner future's capture literal is built by
`_build_async_capture_struct_literal` (`src/codegen/exprs/async.yo`). An
implicit capture that is not implicitly copyable was moved by the evaluator
(`generate_captured_variable_dup_expressions`: no dup, the variable is
consumed), so the literal reads the enclosing machine's slot
(`.b = sm->__capture.b`) and takes no retain. But nothing told the enclosing
machine that its slot was moved out: its `__yo_mv___capture_b` flag stayed 0,
and its dispose dropped `sm->__capture.b` while the inner future still held it.
A capture-list entry does not have the problem, because its initializer is an
atom, and the atom emitter's `_sm_consuming_read` sets the flag.

## Fix

The implicit fallback now marks the move as `_sm_consuming_read` does
(`_sm_capture_moved_out`). After the line that holds the literal, it sets the
slot's move flag or, when the slot has no flag, empties the slot.

Test: `tests/async/sm_ownership.test.yo`, "a nested implicit capture moving
an enclosing capture is dropped once" (a `Box`, so it fails on develop without
decision 17).
