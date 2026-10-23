# An exit inside a binding's own initializer drops a stale task slot

**Severity:** S1 — a double free: in an io.async loop, a `break`, `continue`
or `return` inside the right side of a loop-body binding that is moved later
drops the binding's task slot, which still holds the previous iteration's
moved-out value.

**Status:** fixed 2026-10-23 (branch `fix/derive-early-return-drop`; see
[Fix](#fix)). **Found:** 2026-10-23 by the adversarial review of that branch.
The `return` form double-freed on develop already (`6dee22187`); the branch's
new `break`/`continue` exit drops added the other two. The unmoved variant (a
phantom drop of a zeroed slot) is still open:
`issues/2026-10-23-an-exit-inside-an-unmoved-async-locals-own-initializer-drops-its-zeroed-slot.md`.

## Reproducer

```yo
{ println } :: import("std/fmt");
{ String } :: import("std/string");
{ yield } :: import("std/async");
{ RefCell } :: import("std/sync/refcell");
(mut(g_drops) : i32) = i32(0);
Fd :: struct(n : i32, s : String);
impl(
  Fd,
  Drop(
    drop : (fn(self : &mut Self) -> unit)({
      g_drops = (g_drops + i32(1));
    })
  )
);
take :: (fn(f : Fd) -> i32)(f.n);
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
      total = (total + take(x));
    });
    result.with_mut(cur => {
      cur = total;
    });
  });
  io.await(task, io);
  t := result.with(cur => cur);
  d := g_drops;
  println(`total=${t} drops=${d} (want total=3 drops=2)`);
});
export(main);
```

`yo compile repro.yo --optimize 2 --sanitize address --allocator system`:

```text
develop (6dee22187):            total=3 drops=2 (want total=3 drops=2)
branch before the review fix:   SUMMARY: AddressSanitizer: heap-use-after-free
fixed:                          total=3 drops=2 (want total=3 drops=2)
```

With `return(())` in place of `break` develop also reports
heap-use-after-free.

## Root cause

The M3 driver (`_evaluate_begin_expression_impl`,
`src/evaluator/exprs/begin.yo`) attached the consumed local's exit drop to
every exit with `init <= exit < move`. `x`'s init token is the binding's own
left side, so an exit inside its right side qualified, though it runs before
`x` holds anything. In synchronous code codegen skips that drop (`x`'s C
declaration is not emitted yet), but a task-slot local bypasses that gate on
the premise that the slot is zero while it owns nothing. A moved-out slot is
not zeroed (the move only sets its moved flag), so the drop released the
previous iteration's value a second time.

## Fix

The M3 driver skips the statement that binds the variable
(`_m3_is_binding_statement_at`): no exit inside a binding's own initializer
gets that variable's exit drop.

**Regression test:** `tests/move_only.test.yo`, "move-only: in an io.async
loop, an exit inside a binding's own initializer drops nothing" (`break`,
`continue` and `return` inside the right side).
