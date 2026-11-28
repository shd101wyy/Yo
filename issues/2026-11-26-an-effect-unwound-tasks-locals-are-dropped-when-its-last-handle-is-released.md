# An effect-unwound task's locals are dropped when its last handle is released

**Severity:** S2 — when an effect handler `unwind`s out of a task, the task's locals are not dropped at the unwind: a local's `Drop` runs only when the task's last handle is released, and a `_Scoped` combinator operand the task holds (a `select` or `timeout` it was running) keeps running until then, on every backend.

**Not fixed:** retired with the mechanism at E-5 of [`plans/backlog/ERRORS_AS_VALUES.md`](../plans/backlog/ERRORS_AS_VALUES.md) (VERDICTS-96 §5). The bug is documented only: `ctl` and `unwind` are deleted, and this doc moves to `issues/retired/` with E-5. AFA-3 carries no unwind into embedded frames, so K-8 of the archived `plans/archive/CAPABILITIES_AND_HANDLERS.md` is not built.

- Filed: 2026-11-26 (lane abort-walk; the case VERDICTS-83 §7 left out of the abort walk, `issues/fixed/2026-11-25-an-aborted-tasks-locals-are-dropped-when-its-last-handle-is-released.md`).
- Status: open.

## Reproducer

Safe code. The task holds a `Drop` local across an await, then throws; the handler the spawner installed `unwind`s, so the task ends Aborted (`-2`).

```yo
{ println } :: import("std/fmt");
{ Error, Exception, IoExn } :: import("std/error");
{ ToString } :: import("std/fmt");
{ String } :: import("std/string");
{ yield } :: import("std/async");

Loud :: struct(id : i32);
impl(
  Loud,
  Drop(
    drop : (fn(self : &mut Self) -> unit)({
      println(`  drop Loud ${self.id}`);
    })
  )
);
Oops :: struct(n : i32);
impl(
  Oops,
  ToString(
    to_string : (fn(self : &Self) -> String)({
      return(String.from("oops"));
    })
  )
);
impl(Oops, Error());
derive(Oops, Clone);

_task :: (fn(io : Io) -> Impl(Future(i32, IoExn)))(
  io.async(e => {
    l := Loud(id : i32(1));
    e.io.await(yield(e.io), e.io);
    e.exn.throw(dyn(Box.new(Oops(n : i32(1)))));
    l.id
  })
);

main :: (fn(io : Io) -> unit)({
  h := io.spawn(_task(io), IoExn(io : io, exn : Exception(throw : (err -> unwind(())))));
  io.await(yield(io), io);
  io.await(yield(io), io);
  println(`task unwound: ${h.is_finished()}; two loop turns later, handle still held`);
  r := h.await(io);
  println("after the join consumed the handle");
});
export(main);
```

On `wip/v0281-abort-walk` `a2b469e02` (the abort walk in place), io_uring and epoll alike:

```text
task unwound: true; two loop turns later, handle still held
  drop Loud 1
after the join consumed the handle
```

Expected: `drop Loud 1` before `task unwound: true`, as an abort now does.

## Root cause

An unwind that escapes a task is emitted by `emit_async_future_escape` (`src/codegen/exprs/async-completion.yo`): it sets the state to `-2`, registers the abort, wakes the waiters and drops the task's own reference. It does not drop the task's live locals; `<block>_state_dispose` drops them (`__yo_sm_drop_locals`) when the last reference goes, as it did for every abort before the abort walk. The walk (`__yo_sm_abort_walk`, runtime-core.yo) is emitted only in the abort hook and the aborted-entry guard, which know the block's `<id>_state_dispose_locals` and `<id>_resume`. `emit_async_future_escape` is called from three sites and is not given those names, so the fix needs that plumbing: walk the frame before the wake, and when a drop lingers, leave the task `-4` with its gate (its slot is empty, since the task is running), so the gate's resume finishes the walk, wakes the waiters and releases the task through the aborted-entry guard. VERDICTS-83 §7 judged it not an S1 (a running task has no operation in flight in its slot) and left it out of the first PR.
