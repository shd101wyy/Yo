# Evaluator deadline error can be swallowed by trial-eval handlers and masked by a later error

**Status: FIXED 2026-08-24 (branch s1-prelude-traits).** Found by PR #240's
tier-1 gates: the `compile-timeout` CLI case went vacuous (`stdout_keep_match
matched nothing`) on the S1 prelude branch. Verified: with the latch, the
case passes again on that prelude shape (PASS 1, no vacuous match).

## Symptom

On branch `s1-prelude-traits`, `yo compile main.yo --compile-timeout-ms 1`
still fails (rc=1) but never prints the canonical diagnostic

```
Yo compilation exceeded the configured time limit (possible evaluator hang). See issues/fixed/test-runner-no-compile-timeout.md.
```

Instead it emits a misleading cascade beginning with:

```
check: error in: Error: derive: derive rule must return(comptime(Expr)); got Comptime
  std/prelude.yo:6748:16: derive(Pragma, Eq(Pragma));
check: error in: Error: Variable "Pragma" not found.   (std/fmt/to_string.yo)
...
```

The `tests/cli-cases/compile-timeout` case pins THE failure via
`stdout_keep_match=exceeded the configured time limit`, so the harness
correctly failed it as vacuous (NO-GOLDEN).

## Root cause

`_check_evaluator_deadline` (`src/evaluator/exprs/_expr.yo`) throws through
the exception effect once `(counter & 16383) == 0` and the deadline has
passed. But the evaluator contains many DELIBERATE swallowing handlers —
`Exception(throw : ((_e) -> { ...; unwind(...) }))` — used for trial
evaluation: receiver probing (`_try_eval_receiver_node`), Call-overload
trials (`_trial_eval_fn_body` idiom), def-time trial runs. If the deadline
throw lands inside one of those, it is eaten like any trial failure, and
the NEXT deadline check is another 16384 dispatches away. The intervening
code then completes with a half-evaluated value and reports ITS OWN error:
here, `derive`'s rule-call returned a truncated `Comptime` value, so
`derive` threw "derive rule must return(comptime(Expr)); got Comptime" —
masking the timeout entirely.

Whether the trip lands inside a swallow is an accident of dispatch-count
alignment: the S1 prelude additions (Default/From/Into/Ord.cmp) moved the
16384-dispatch boundary into `derive(Pragma, Eq(Pragma))`'s rule-call
trial window. On `develop` the same command happens to trip in a
propagating context and prints the canonical line — the bug was latent.

## Fix

Latch the trip (`_g_eval_deadline_tripped`) and make
`_check_evaluator_deadline` throw on EVERY dispatch once tripped (the
latch test is one boolean read; the monotonic clock is still only read on
counter boundaries). A swallow can still eat one throw, but the very next
`evaluate_expression` dispatch in the enclosing (propagating) context
rethrows, so no downstream code can run long enough to manufacture a
masking error. `set_evaluator_deadline` resets the latch.

Regression coverage: `tests/cli-cases/compile-timeout` itself — it now
asserts the named diagnostic on a prelude shape that previously masked it.
