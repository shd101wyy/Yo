# A statement after an always-exiting statement in a loop body leaves the function untranspiled

**Severity:** S2 — a loop body that has a statement after one that always
exits (`cond(k => break, true => break); i = (i + 1);`, or
`cond(true => break); …`) makes the enclosing function's body untranspilable:
the C build fails, or, depending on how the body is reached, the program
builds and aborts with `yo: FATAL: reached yo_id_…, whose body failed to
transpile` when the function is called. The workaround is to delete the dead
statements. The same dead statement in an `io.async` body fails the C build,
and a borrowed-element `for(&mut xs, x => { …; return(v); })` aborts even with
the `return` last (both below).

**Found:** 2026-10-23, in the adversarial review of
`issues/fixed/2026-10-22-a-cond-with-a-compile-time-condition-returns-a-borrowed-handle-without-a-dup.md`.
The v0.2.68 seed and develop `265faa941` both have it. `yo check` reports
nothing.

## Reproducer

`issues/repros/2026-10-23-a-statement-after-an-always-exiting-statement-in-a-loop-body-leaves-the-function-untranspiled.yo`:

```yo
{ println } :: import("std/fmt");
v1 :: (fn(k : bool) -> i32)({
  mut(i) := i32(0);
  while(i < i32(3), {
    cond(
      k => break,
      true => break
    );
    i = (i + i32(1));
  });
  i
});
main :: (fn() -> unit)({
  println(v1(true));
});
export(main);
```

```text
error: call to 'yo_id_…' declared with 'error' attribute: yo: the body of yo_id_… failed to transpile — its definition-time evaluation failed and was swallowed (run yo check with YO_DEBUG_SWALLOW=1); this call would abort at runtime
```

With `cond(true => break)` in place of the runtime `cond`, the same program
builds and aborts at the call. With the always-exiting statement LAST in a
`while` body, both spellings are correct.

### A `for(&mut xs, …)` body fails with the exiting statement last

`issues/repros/2026-10-23-a-statement-after-an-always-exiting-statement-in-a-loop-body-leaves-the-function-untranspiled-for-body.yo`
(found in the second review round): `for(&mut xs, x => { v := x; return(v); })`
builds and aborts with `yo: FATAL: reached yo_id_…, whose body failed to
transpile` (rc 134), although the `return` is the body's last statement. The
collapsed `cond(true => return(v))` and the same loop over an `ArrayList(i32)`
fail the same way; a runtime `cond(k => return(v), true => ())` and an index
loop `for(xs.indices(), i => { return(xs(i)); })` are correct. The
borrowed-element `for` is a macro whose expansion most likely places its
cursor advance AFTER the user's body, so the user's last statement is not the
expanded body's last: the same dead statement after an exit.

### The `io.async` body twin

`issues/repros/2026-10-23-a-statement-after-an-always-exiting-statement-in-a-loop-body-leaves-the-function-untranspiled-async-tail.yo`:
an `io.async` body with a statement after a `cond` whose arms all return
(`cond(k => return(q), true => return(q)); R(n : i32(0))`, after an await)
fails at C compile time, with no loop involved:

```text
error: expected expression
```

after `sm->result = // Failed to transpile R(n : i32(0));`. A collapsed
`cond(true => return(x)); R(n : i32(0))` after an await fails the same way
(`assigning to … from incompatible type 'void'`). The state-machine tail
emitter generates the unevaluated dead tail as the body's result.

## Analysis

The evaluator's `begin` loop (`src/evaluator/exprs/begin.yo`, "If this
expression carries control flow, it becomes the last expression") stops at a
statement that always exits and leaves the statements after it unevaluated.
The codegen `begin` emitter (`src/codegen/exprs/begin.yo`) mirrors that stop
only in its EXPRESSION form (a block with a result temp). The STATEMENT form
emits every statement. If the loop body takes that form (not yet confirmed),
it generates the unevaluated `i = (i + 1)`, which has no `ExprInfo`, and the
function gets the untranspiled-body stub. The likely fix is to give the statement form the same
stop (at a statement with no `ExprInfo` or one whose `control_flow` is set);
it needs the dup/drop emit-diff gate because every statement-form block goes
through that loop. The stop must also cover a macro-expanded `for(&mut …)`
body (the statements the expansion adds after the user's body) and the async
state-machine tail emitter (`src/codegen/async/`), which must stop at an
always-exiting statement the same way. The fix's tests cover all three
repros.
