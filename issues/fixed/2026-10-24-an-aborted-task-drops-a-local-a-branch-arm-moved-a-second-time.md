# An aborted task drops a local a branch arm moved a second time

**Severity:** S1 — a double free (heap-use-after-free under ASan): a task
local moved in a `cond`/`match` arm is released again when the task is
aborted at a later await.

**Status:** fixed (branch `fix/s1-return-before-break-move`). Found 2026-10-24
while probing that branch's change to the task-slot move check. Present on
develop `7b8b04d86` and `48b8e93a1`.

## Reproducer

```yo
{ println } :: import("std/fmt");
{ String } :: import("std/string");
{ yield } :: import("std/async");
{ sleep } :: import("std/sys/timer");
Fd :: struct(n : i32, s : String);
take :: (fn(sink(f) : Fd) -> i32)(f.n);
run :: (fn(k : i32, io : Io) -> unit)({
  h := io.spawn(
    io.async((io : Io) => {
      f := Fd(n : k, s : String.from("a heap string the abort frees again"));
      io.await(yield(io), io);
      if(k == i32(1), {
        take(f);
      }, {
        take(f);
      });
      io.await(sleep(u64(50)), io);
    }),
    io
  );
  io.await(yield(io), io);
  io.await(yield(io), io);
  io.await(yield(io), io);
  h.abort();
  _r := h.await(io);
});
main :: (fn(io : Io) -> unit)({
  run(i32(1), io);
  println("done");
});
export(main);
```

`yo compile repro.yo --optimize 2 --sanitize address --allocator system`
reports `heap-use-after-free` in the task's dispose. One arm moving and the
other keeping the value (`{ take(f); }, { (); }`) fails the same way on the
moving path. A straight-line move, and a move on a loop's `break` path, were
correct.

The emit-diff of the fix shows where it reached: `tests/async_await.test.yo`'s
`if(flag, io.await(f1), …)` shapes, where an await in an arm moves the future
into the await slot, and `std/http/wire.yo`'s message read task, which now
flags eleven arm moves of `result` (into `_release_message`,
`_split_into_carry` and `String.from_bytes`). The `wire.yo` change is
hardening, not a fixed double free: every one of those moves sits in the
`_framed_out := cond(...)` after the task's last await (the read loop), and
none of the callees takes an effect handler, so neither an abort nor an
effect escape reaches the task's dispose after them.

## Root cause

An aborted task drops the values its slots still own. A read that moves a
slot local out sets the slot's move flag (`_sm_consuming_read`,
`src/codegen/exprs/atom.yo`), and the read counted as a move only when it was
the variable's `consumed_at_token`. A branch join marks a value the arms move
at the branch's END token (`arm_move_end`), so no read in an arm matched: the
flag was never set, and the abort released the value the callee had already
freed.

## Fix

`_sm_consuming_read` also treats a read as a move when the flow log kept a
move made there for one path (`_is_kept_move_site`: an `UndoneMove` that is
neither an arm's own drop nor a nested branch's end). The same change keeps a
loop's `break`-path move flagged now that the loop join marks it at the loop's
end
(`issues/fixed/2026-10-24-a-return-before-a-loops-break-move-skips-the-drop-of-the-local-the-break-path-moves.md`).

## Test

`tests/move_only.test.yo`: "an aborted task does not drop a local a `break`
path or a branch arm moved again" (both arms moving, one arm moving, the
keeping arm, and the `break` path). It fails on develop `48b8e93a1` and passes
with the fix.
