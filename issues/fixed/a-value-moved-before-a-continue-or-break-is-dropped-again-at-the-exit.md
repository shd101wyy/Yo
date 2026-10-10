# A value moved before a `continue` or `break` is dropped again at the exit

**Severity:** S1 — a double drop: a move-only value moved inside an `if` arm that then `continue`s (or `break`s) is disposed a second time at the loop exit, after its new owner took it.

## Symptom

Found while testing decision 26's consuming `match` (2026-10-10), and
reproduced on plain locals with the V3b stack seed (v0.2.56 + the stack):

```rust
{ ArrayList } :: import("std/collections/array_list");
(g_d : i32) = i32(0);
Fd :: struct(n : i32);
impl(Fd, Dispose(dispose : (fn(imm(self) : Self) -> unit)({ g_d = (g_d + i32(1)); })));
loop_it :: (fn(mut(keep) : ArrayList(Fd)) -> i32)({
  (i : i32) = i32(0);
  (total : i32) = i32(0);
  while(i < i32(5), {
    f := Fd(n : i);
    if(f.n == i32(1), { keep.push(f); i = (i + i32(1)); continue; });
    if(f.n == i32(3), { break; });
    total = (total + f.n);
    i = (i + i32(1));
  });
  total
});
```

`loop_it` disposes four `Fd`s instead of three (0 and 2 at the iteration's
end, 3 at the `break`), although the keeper still holds the one with `n == 1`:
the emitted C pushes `f` into the list and then runs `f`'s drop before
`continue`.

## Root cause

`f` is moved inside an `if` arm that leaves the loop body (`continue`), so
the move does not reach the join: after the `if`, `f` is live again and its
scope-end drop stays on the loop body's pending list. The flow log keeps the
arm's move as an `UndoneMove` up to the arm's last token, and every return
point consults it (`_variable_moved_before_cleanup_point`, `codegen/exprs/return.yo`),
but the loop-exit emitter (`_emit_loop_body_drops_before_exit`,
`codegen/exprs/atom.yo`) emitted each pending drop without asking whether its
value was moved on the path to the exit.

## Fix

`_emit_loop_body_drops_before_exit` skips a pending drop whose target was
moved before the exit: its `consumed_at_token` is at or before the exit, or
`variable_moved_at_cleanup_point` finds an undone move whose arm contains the
exit — the check the return points already make.

## Verification

`tests/move_only.test.yo`, "move-only: a value moved before a `continue` is
not dropped again at the exit" (4 disposes before the fix, 3 after), and the
consuming-`match` twin "consuming match: in a loop, `continue` after a move
and `break` while owning drop each value once".
