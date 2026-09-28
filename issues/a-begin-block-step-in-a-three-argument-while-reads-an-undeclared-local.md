# A begin-block step in a 3-argument `while` reads an undeclared C local (sync code)

**Status: OPEN.** Found 2026-09-28 by the async state-machine audit's shape sweep. This one is NOT async: it reproduces in a plain synchronous function. Tree build of develop `af62bdb28`.

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
