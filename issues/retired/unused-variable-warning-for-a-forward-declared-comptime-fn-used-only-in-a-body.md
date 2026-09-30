# A forward-declared comptime fn used only inside another fn's body is warned "unused"

**Severity:** S3 — a false unused-variable warning for a forward-declared comptime fn used only from another function's body

**Status:** RETIRED 2026-09-29 — does not reproduce. The reproducer below, run exactly as
written, prints no warning on the 0.2.44 release (`yo version install 0.2.44`, its bundled
std), on 0.2.41, 0.2.42, 0.2.45, or develop `c52ce152c`. A control that adds a third comptime fn
nobody calls warns `unused variable \`never_used\`` on every one of them, so the channel is
live. The warning was most likely observed on an intermediate state of the repro being written
at the time (one whose body failed). The guard is now
`tests/cli-cases/check-no-unused-warning-for-a-forward-declared-comptime-fn`, whose keep-match
keeps the variable NAME: it fails if `is_even`/`is_odd` ever warn or `never_used` stops.
**Found:** 2026-09-27, writing the repro for
`issues/fixed/a-forward-comptime-fn-body-error-is-dropped-by-the-pending-rerun.md`.
**Measured:** yo 0.2.44 seed.

## Symptom

```rust
{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  comptime(is_even) : (fn(n : i32) -> bool);
  comptime(is_odd) : (fn(n : i32) -> bool);
  is_even = _(cond((n == 0) => true, true => is_odd(n - 1)));
  is_odd = _(cond((n == 0) => false, true => is_even(n - 1)));
  println(`${is_even(10)}`);
});
export(main);
```

```
warning: unused variable `is_odd`
  --> tmp/fwd.yo:4:12
```

`is_odd` is called from `is_even`'s body (and assigned). The unused-variable pass
(`src/evaluator/exprs/begin.yo`, the `emit_warning` "unused variable" site) apparently does not
count a use recorded inside a function body that was evaluated while the variable was still
valueless (the pending re-run path), or counts the assignment `is_odd = ...` as a write only.

## Next step

Trace which usage channel the unused-variable check reads (`track_variable_usage`) and whether
the def-time trial of `is_even` — which runs under a swallowing handler and is re-run later —
records its use of `is_odd` there.
