# A type error in a comptime fn that captures a forward declaration is dropped

**Status:** FIXED 2026-09-27 (branch `tss/p6-generic-reraise`, Phase 6 step 2, census site #4).
**Found:** 2026-09-27, Phase 6 census of the swallow sites.
**Measured:** yo 0.2.44 seed: `yo check` rc=0.
**Repro:** `issues/repros/a-forward-comptime-fn-body-error-is-dropped-by-the-pending-rerun.yo`

## Symptom

```rust
main :: (fn() -> unit)({
  comptime(is_even) : (fn(n : i32) -> bool);
  comptime(is_odd) : (fn(n : i32) -> bool);
  is_even = _({
    (z : bool) = i32(3);
    cond((n == 0) => true, true => is_odd(n - 1))
  });
  is_odd = _(cond((n == 0) => false, true => is_even(n - 1)));
  println(`${is_even(10)}`);
});
```

`yo check` passes: `(z : bool) = i32(3)` is never reported.

## Mechanism (READ)

`is_even`'s definition-time trial runs while `is_odd` is still valueless, so
`try_to_implement_function_by_function_type` (`calls/function_type.yo`) does not re-raise the
trial's error (`has_fwd_comptime_fn_cap`: the failure might be the forward reference) and
registers a `PendingDefEval` instead. When `is_odd` is filled, assignment.yo calls
`_rerun_pending_def_evals`, which re-ran the body under a swallowing handler and then only
counted down `attempts`: success and failure were treated alike, and a failure was never
reported. The hook had no `exn` to report through.

## Fix

The pending entry records the forward declarations it saw (`fwd_vars`). After a re-run: a body
that typed with all of them filled is done; a body that still fails with all of them filled has
its own error, which the hook now returns (`RerunPendingDefEvalsFn -> Option(YoError)`) and
assignment.yo raises at the filling assignment; anything else keeps waiting. Test:
`tests/cli-cases/check-forward-comptime-fn-body-error-is-reported`.
