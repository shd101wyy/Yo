# A statement-level (fire-and-forget) `io.spawn(...)` leaks the whole state machine

**Status: OPEN.** Found 2026-09-28 by the async state-machine audit (`plans/backlog/ASYNC_STATE_MACHINE_GENERATION.md`). Reproduces on the v0.2.45 seed and on a tree build of develop `af62bdb28`.

## Symptom

`issues/repros/statement-level-io-spawn-leaks-the-state-machine.yo`: 2000
unbound `io.spawn(job(i, io), io);` statements.

```
LEAK Direct 304000 B x 2000 : __yo_rc_alloc <- __yo_new_<job> <- yo_id_… <- __yo_user_main
```

The task's own `Thing` locals are disposed; the 152 B state machine is not.
Bound handles (`h := io.spawn(…)`) and handles pushed into a list are
fine.

## Root cause

`_generate_io_spawn` (`src/codegen/exprs/generation.yo`) takes the
"JoinHandle owns a reference" `__yo_incr_rc` whenever the spawn expression
has a `variable_name`. The comment there assumes an unbound spawn has none.
The evaluator now gives every spawn a temp `variable_name`, so the
reference is taken for a handle that is discarded and never dropped.

## Fix direction

Decide ownership from whether the handle value is USED (bound, passed,
returned), not from `variable_name`. Better still, emit the handle's drop
for a discarded statement value, the same as any other discarded RC
temporary. Regression test: the repro's dispose count, plus an LSan-clean
run.
