# An exit between a move and a reassignment drops the moved value

**Severity:** S1 — a double free: an early `return`, `break`, `continue`,
`unwind` or effect escape that sits between a move of a `mut` local and its
reassignment releases the value the move already gave away
(heap-use-after-free under ASan, glibc heap corruption without it).

**Status:** fixed 2026-10-23 (branch `fix/derive-early-return-drop`; see
[Fix](#fix)). **Found:** 2026-10-23 by the adversarial review of that branch.
The `return`, `unwind` and effect-escape paths double-freed on develop
already (`6dee22187`); the branch's new `break`/`continue` exit drops and its
derive-body change (`issues/fixed/2026-10-23-an-early-return-in-a-derive-generated-body-skips-the-drop-of-a-value-local.md`)
carried the same fault to loop exits and to every `derive_rule` body.

## Reproducer

```yo
{ println } :: import("std/fmt");
{ String } :: import("std/string");
(mut(g_drops) : i32) = i32(0);
B :: struct(s : String);
impl(
  B,
  Drop(
    drop : (fn(self : &mut Self) -> unit)({
      g_drops = (g_drops + i32(1));
    })
  )
);
sink :: (fn(b : B) -> usize)(b.s.len());
brk :: (fn(k : i32) -> usize)({
  (mut(i) : i32) = i32(0);
  (mut(acc) : usize) = usize(0);
  while(i < i32(3), {
    i = (i + i32(1));
    (mut(b) : B) = B(s : String.from("first"));
    acc = (acc + sink(b));
    if(i == k, {
      break;
    });
    b = B(s : String.from("second"));
    acc = (acc + sink(b));
  });
  acc
});
ret :: (fn(k : i32) -> usize)({
  (mut(b) : B) = B(s : String.from("first"));
  acc := sink(b);
  if(k == i32(1), {
    return(acc);
  });
  b = B(s : String.from("second"));
  acc + sink(b)
});
main :: (fn() -> unit)({
  r := brk(i32(2));
  d := g_drops;
  println(`break acc=${r} drops=${d} (want acc=16 drops=3)`);
  g_drops = i32(0);
  r2 := ret(i32(1));
  d2 := g_drops;
  println(`return acc=${r2} drops=${d2} (want acc=5 drops=1)`);
});
export(main);
```

`yo compile repro.yo --optimize 2 --sanitize address --allocator system`:

```text
develop (6dee22187):            SUMMARY: AddressSanitizer: heap-use-after-free   (the `return` path)
branch before the review fix:   SUMMARY: AddressSanitizer: heap-use-after-free   (the `break` path too)
fixed:                          break acc=16 drops=3 (want acc=16 drops=3)
                                return acc=5 drops=1 (want acc=5 drops=1)
```

The review's probes showed the same for `continue`, a `for` body, an
io.async loop whose local lives in a task slot, an effect `unwind` raised
between the move and the store, and a `derive_rule` body that returns between
them.

## Root cause

The exit-drop deciders order the exit against the variable's
`initialized_at_token` (its FIRST initialization) and `consumed_at_token` (its
LAST move). A store into a moved variable resets `consumed_at_token`
(`src/evaluator/exprs/assignment.yo`), and the next move sets it again, so
nothing remembered that the variable owned nothing between the first move and
the store. An exit there satisfied `init <= exit < last move` and got the
drop: the M3 attach (`_attach_if_cleanup_needs_drop`,
`src/evaluator/exprs/begin.yo`) for `return`/`unwind`/`break`/`continue`, and
codegen's escape-drop gate (`generate_consumed_var_drops_for_escape`) for an
effect escape.

## Fix

A store into a variable whose `consumed_at_token` is set records the window
from that move to the end of the store as an `UndoneMove`
(`src/evaluator/exprs/assignment.yo`). `variable_moved_at_cleanup_point`
(`src/env.yo`), which every cleanup decider already asks (the evaluator's
exit-drop walks, codegen's pending drops, its escape drops and its loop-exit
drops), then reports the value as moved at an exit inside the window.
`variable_has_undone_move` keeps a loop body evaluated twice from recording
the window twice.

**Regression tests:** `tests/move_only.test.yo`, "move-only: an exit between a
move and a reassignment drops nothing" (`break` in a `while`, `continue` in a
`for`, `return`, an effect `unwind`; fails on develop) and "… in an io.async
loop, an exit between a move and a reassignment drops nothing" (passes on
develop, failed on the branch before this fix). `tests/derive.test.yo`, "a
derive-generated body: an exit between a move and a reassignment drops
nothing; …".
