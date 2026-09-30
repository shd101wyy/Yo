# A begin-block step in a 3-argument `while` reads an undeclared C local (sync code)

**Severity:** S2 — a begin-block step in a 3-argument `while` fails the C compile on a valid program (undeclared-identifier error)

**Status: FIXED (2026-09-29).** Found 2026-09-28 by the async state-machine audit's shape sweep. This one is NOT async: it reproduces in a plain synchronous function. Tree build of develop `af62bdb28`.

## Symptom

`while(c, { t := f(i); i = t; }, body)`: clang reports
`use of undeclared identifier 't'`
(`issues/repros/async-shape-x1-sync-while-step-begin-block-local-c-error.yo`).

## Root cause (to confirm)

`generate_step_expression` (`src/codegen/exprs/while_loop.yo`) appears to
emit the step block's statements without the begin block's scope or
declarations: the binding `t` is declared nowhere the step's use can see.

## Fix direction

Emit a block-valued step through `generate_begin` (a real C block) at the
loop's continue point. Regression: the repro as a language test.

## Fix (2026-09-29)

Confirmed: `generate_step_expression` (`src/codegen/exprs/while_loop.yo`)
rendered a block step as its `=` statements, comma-joined, and silently
dropped everything else, including the `t := ...` declaration. A block step
is now emitted through the begin generator as a real C block at the
continue point (its declarations, statements and scope-end drops), and its
unit value is discarded. The state-machine while emitter uses the same
function. Test: `tests/basic.test.yo` "a 3-argument while with a block step
that declares a local". It fails to compile with the v0.2.45 seed. The shape
corpus case `cases8/m07_step_begin_await` covers the async form.
