# A temporary built in a three-argument `while` step is dropped outside its C scope

**Severity:** S2 — a valid program fails at the C compiler (`use of undeclared identifier`) when the
step of `while(cond, step, body)` builds a temporary object; a step that replaces an owned value
(`s = mk(n).s`) compiles but leaks the replaced values, one per iteration but the last.

**Status:** fixed 2026-10-25 on `fix/cond-scrutinee-temps`. Found the same day by the triage of
the `while`-condition leak
(`issues/fixed/2026-10-24-a-temporary-object-built-in-a-while-condition-leaks-once-per-iteration.md`).
The develop binary (b97be9b48) and the v0.2.70 seed behave the same.

## Reproducer

```yo
{ println } :: import("std/fmt");
RI :: ref(struct(v : i32));
main :: (fn() -> unit)({
  mut(j) := i32(0);
  while(j < i32(3), j = (j + RI(v : i32(1)).v), {
    println(`${j}`);
  });
});
export(main);
```

```
error: use of undeclared identifier '_file____home_temp_128445872030975532321'
```

The emitted C declares the step's temporary inside the loop and releases it once after the
loop label, where it is out of scope:

```c
  continue_main_r2c2_n1:;
__yo_t_…* _file____home_temp_128445872030975532321 = __yo_new___yo_t_…(1);
    __yo_v_j = … _file____home_temp_128445872030975532321->__yo_v_v …;
  }
  loop_main_r2c2_n0:;
  __yo_decr_rc((void*)(_file____home_temp_128445872030975532321));
```

With `continue` in the body the same error appears. In an `io.async` body the temporary has a
state-machine slot, so the C compiles and the step leaks every value but the last.
`while(n < i32(3), s = String.from("abc"), …)` leaks the replaced strings the same way:
103 bytes in 6 allocations under LeakSanitizer.

## Root cause

The evaluator evaluated the step with `evaluate_expression_raw`
(`src/evaluator/exprs/while.yo`, the straight path and the `continue` path). That gives the step
no frame of its own, so its temporaries joined the enclosing block, whose scope-end drops run once,
after the loop. The condition and the body each get their own frame (`evaluate_begin_expression`).

## Fix

The step is evaluated as a one-expression block (`evaluate_begin_expression`) on both runtime
paths, so its temporaries' drops ride the step node. `generate_while_loop`
(`src/codegen/exprs/while_loop.yo`) flushes them right after the step statement, inside the loop
block. They are pending while the step renders, so an early exit inside the step releases what is
live. A block step (`{ … }`) keeps its own begin generator's drops. The comptime-unrolled path
emits no step and is unchanged.

Giving the step its own frame exposed a second bug in the step emitter itself:
`generate_step_expression` hand-built an assignment step as
`lhs_code = rhs_code`, a bitwise C copy. That never dup'ed an RC right side
(`s = String.from("abc")` moved the fresh string, and the frame's new drop then
released it under its new owner — a use-after-free), and never released the
replaced value (the pre-existing leak above). An assignment step now goes
through the real assignment generator, like a statement: it dups an RC right
side into its place, saves and releases the replaced value, and materializes a
place that runs a call once.

The adversarial review found a third shape in the same emitter: routing an
assignment step through the generator also passed its RETURN value — the
old-value save's NAME (`generate_assignment`'s last line) — back to the loop,
which emitted it as a statement. In sync code `<save>;` was dead but legal
(the save is a C local); inside a state machine the save lives in an
`sm->var_<name>_<id>` slot, so the bare name was an undeclared identifier
(S2: an RC-place or move-only-place assignment step of a three-argument
`while` inside `io.async` failed at the C compiler). An assignment step now
discards the return: statement position emits the statement, not its value.

## Test

`tests/continue_rc_cleanup.test.yo`, "a temporary in a three-argument while step is released once
per iteration": a step that builds a `Drop`-counted value, with `continue` and `break` in the body
(four releases for four steps), and a step that replaces a `String`. Before the fix the file fails
at the C compiler. The review shapes are pinned by "an RC-place assignment step inside io.async
compiles and releases per iteration" and "a move-only-place assignment step inside io.async does
the same" in the same file: an `io.async` three-argument `while` whose step replaces a `ref`
handle / a `Drop` value struct, with the body suspending between iterations — both failed at the
C compiler before the third fix and now show three replaced values plus the final one released.
