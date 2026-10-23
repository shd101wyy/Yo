# An exit inside an unmoved async local's own initializer drops its zeroed slot

**Severity:** S2 — the user's `Drop` runs on a phantom all-zero value: a drop
counter is off, and a file-descriptor wrapper would `close(0)`. No memory
error (a zero `String` drops as a no-op).

**Status:** open. Found 2026-10-23 by the adversarial review of branch
`fix/derive-early-return-drop`. Present on a develop-built binary
(`6dee22187`) and on the branch alike. The moved-local variant (the slot still
holds the previous iteration's moved-out value, a double free) is fixed:
`issues/fixed/2026-10-23-an-exit-inside-a-bindings-own-initializer-drops-a-stale-task-slot.md`.

## Reproducer

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");
{ yield } :: import("std/async");
{ RefCell } :: import("std/sync/refcell");
(mut(g_d) : i32) = i32(0);
Fd :: struct(n : i32, s : String);
impl(
  Fd,
  Drop(
    drop : (fn(self : &mut Self) -> unit)({
      g_d = (g_d + i32(1));
    })
  )
);
main :: (fn(io : Io) -> unit)({
  result := rc(RefCell(i32).new(0));
  task := io.async((io : Io) => {
    (mut(total) : i32) = i32(0);
    (mut(i) : i32) = i32(0);
    while(i < i32(4), {
      i = (i + i32(1));
      x := cond(
        (i == i32(3)) => {
          break;
        },
        true => Fd(n : i, s : String.from("a heap string"))
      );
      io.await(yield(io), io);
      total = (total + x.n);
    });
    result.with_mut(cur => {
      cur = total;
    });
  });
  io.await(task, io);
  t := result.with(cur => cur);
  d := g_d;
  println(`total=${t} drops=${d} (want drops=2)`);
});
export(main);
```

Expected two drops (`x` of iterations 1 and 2, at the scope end); the
program reports three. The reviewer's two-loop version
(`tmp/review-code/p13.yo` in that branch's review) prints
`= 83 drops=7 sum=83` where 5 drops are expected.

## Root cause

`x` is not moved, so it rides the loop body's pending scope-end drops.
At the `break`, `_emit_loop_body_drops_before_exit`
(`src/codegen/exprs/atom.yo`) emits every pending loop-body drop that is
live at the exit. A task-slot local bypasses the C-scope-stack gate ("the
slot always exists and is zero while it owns nothing"), and the env-liveness
test reads the end-of-scope env, where `x` is initialized. The `break` sits
inside `x`'s own initializer, before the binding stores anything, so the drop
runs on the zeroed slot.

## Fix direction

Skip a pending drop whose target's binding statement contains the exit (the
exit lies inside the target's initializer). Codegen can track the binding
statements it is emitting (a stack of their variables) and consult it here
and in `generate_early_return_only_deferred_drop_expressions`.
