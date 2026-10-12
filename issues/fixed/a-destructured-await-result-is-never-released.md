# A destructured await result is never released

**Severity:** S2 — `(a, b) := io.await(f, io)` inside an `io.async` body leaked the result's heap components (every `race`/`any` call awaited from a task leaked its handle list and the tasks in it); no crash, no diagnostic

**Status:** FIXED 2026-10-13 (feat/vbd-v3-async-lowering-fixes; found on feat/vbd-v3-genb). Present in the released v0.2.59 seed.

## Symptom

Found with `leaks --atExit` while checking `std/async`'s `race_first`, whose
body is `(w, hs) := io.await(race(handles, io), io)`. Independent of
`JoinHandle`:

```yo
{ ArrayList } :: import("std/collections/array_list");
{ yield } :: import("std/async");
mk :: (fn(io : Io) -> Impl(Future(Tuple(usize, ArrayList(i32)), Io)))(
  io.async((io : Io) => {
    io.await(yield(io), io);
    l := ArrayList(i32).new();
    l.push(i32(1));
    (usize(1), l)
  })
);
main :: (fn(io : Io) -> unit)({
  f := io.async((io : Io) => {
    (w, l) := io.await(mk(io), io);
    w
  });
  _x := io.await(f, io);
});
export(main);
```

leaks the list (2 objects, 80 bytes) with v0.2.59 and the tree compiler
alike. `t := io.await(mk(io), io); (w, l) := t;` does not leak, and neither
does the destructure at `main`'s level (outside a state machine).

## Cause

A destructure reads the fields of its right-hand side and leaves the value
to the right-hand side's temp, whose scope-end drop releases it
(`_emit_destructurings`, `src/codegen/exprs/init_assignment.yo`).
In a state machine that temp has a task slot, and the drop reads the slot:
`__yo_decr_rc(sm->var_<temp>._1)`. The inline await
(`emit_inline_await`, `src/codegen/async/state_machine.yo`) wrote the result
to a C local (`__yo_await_value0`) or a result field and returned that, so
the slot the drop reads stayed zeroed and the value was never released. The
join-handle await already had this rule ("a result temp with a task slot is
dropped through the slot, so the owned result goes there too",
`generate_join_handle_await`); the `io.await` lowering, fused or not, did not.

## Fix

`_store_await_result_into_temp_slot` stores the result in the await's temp
slot, when it has one, on both the fused and the ordinary path. A consumer
that takes the value over (`t := io.await(…)`) gives the temp no slot, so
nothing changes for it.

Regression test: `tests/async/sm_ownership.test.yo`, "a destructured await
result is released" (a fused and a non-fused callee, with a `Dispose`
counter).
