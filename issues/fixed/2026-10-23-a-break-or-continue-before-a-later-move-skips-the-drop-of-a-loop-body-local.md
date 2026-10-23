# A break or continue before a later move skips the drop of a loop-body local

**Severity:** S1 — a silently skipped destructor and a leak on every
iteration that takes the path: a `break` or `continue` that leaves a block
before the block moves one of its owned locals never drops that local.

**Status:** fixed 2026-10-23 (branch `fix/derive-early-return-drop`; see
[Fix](#fix)). **Found:** 2026-10-23 by the adversarial review of
`issues/fixed/2026-10-23-an-early-return-in-a-derive-generated-body-skips-the-drop-of-a-value-local.md`,
which asked whether the other early exits behave. Reproduced with the v0.2.68
seed and a develop-built binary (`56dd8253f`). Hand-written and
derive-generated code fail alike.

## Reproducer

```yo
{ println } :: import("std/fmt");
{ String } :: import("std/string");
(mut(g_drops) : i32) = i32(0);
B :: struct(n : i32);
impl(
  B,
  Drop(
    drop : (fn(self : &mut Self) -> unit)({
      g_drops = (g_drops + i32(1));
    })
  )
);
sink :: (fn(b : B) -> i32)(b.n);
brk :: (fn(k : i32) -> i32)({
  (mut(i) : i32) = i32(0);
  (mut(acc) : i32) = i32(0);
  while(i < i32(3), {
    b := B(n : i);
    i = (i + i32(1));
    if(i == k, {
      break;
    });
    acc = (acc + sink(b));
  });
  acc
});
strbrk :: (fn(k : i32) -> usize)({
  (mut(i) : i32) = i32(0);
  (mut(acc) : usize) = usize(0);
  while(i < i32(3), {
    s := String.from("hello world, a heap string");
    i = (i + i32(1));
    if(i == k, {
      break;
    });
    acc = (acc + s.into_bytes().len());
  });
  acc
});
main :: (fn() -> unit)({
  r := brk(i32(2));
  d := g_drops;
  println(`break r=${r} drops=${d}`);
  println(strbrk(i32(2)));
});
export(main);
```

```text
break r=0 drops=1
26
```

Expected `drops=2`: `B(n : 0)` is dropped by `sink`, and `B(n : 1)` must be
dropped at the `break`. Under `--sanitize address --allocator system` the
`String` loop leaks 58 bytes (the `String` and its buffer). The same holds
for `continue`, for a local of a block nested in the loop body, for a
consuming `match` arm's binding, for a `for` body, and for a `break` in a
`cond` arm.

## Root cause

A local that the block moves on some path (`consumed_at_token` set) is left
out of the block's scope-end drop list, so the drop on an exit BEFORE that
move has to come from somewhere else. For `return` and `unwind` the M3 driver
in `_evaluate_begin_expression_impl` (`src/evaluator/exprs/begin.yo`)
attaches an early-exit-only `___drop` to each such exit
(`_attach_early_return_only_drop_to_returns`), and codegen emits it there
(`generate_early_return_only_deferred_drop_expressions`). Nothing did the
same for `break` and `continue`: their codegen
(`_emit_loop_body_drops_before_exit`, `src/codegen/exprs/atom.yo`) emits only
the loop body's pending scope-end drops, which never list a consumed local.

## Fix

- `_attach_consumed_drop_to_loop_exits` (`src/evaluator/exprs/begin.yo`)
  attaches the same `___drop` to every `break`/`continue` that leaves the
  block before the move. It does not enter a nested `while` (a `break`
  there exits only the inner loop), stops at function boundaries, and walks
  a macro call through its expansion only (a `for` body lives in the
  expansion's `while`). Like the `return` walker, it skips an exit where the
  flow log shows the value already moved (`sink(b); break;`). The block's M3
  driver and `attach_consumed_binding_exit_drops` (a consuming match arm's
  binding) both call it.
- `generate_early_return_only_deferred_drop_expressions` moved from
  `src/codegen/exprs/return.yo` to `src/codegen/exprs/drop_dup.yo`, so that
  `atom.yo` can call it without an import cycle. The `break` and `continue`
  emitters call it after the loop-body drops.

**Regression tests:** `tests/move_only.test.yo`, "move-only: a `break` or
`continue` before a later move drops the local once" (fails under the v0.2.68
seed) and the over-drop canaries "move-only: an inner loop's exit and a move
before a `break` drop nothing twice" (an inner loop's `break`, a move on the
breaking arm, a `break` before a move an arm's `continue` undoes), and "…
in an io.async loop, a `break` or `continue` before a later move drops the
slot local once" (the local lives in a task slot across an await; fails under
a develop-built binary). `tests/derive.test.yo` covers a `break` in a
derive-generated body.
