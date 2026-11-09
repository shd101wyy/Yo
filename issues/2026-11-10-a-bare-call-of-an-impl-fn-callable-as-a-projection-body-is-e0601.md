# A bare call of an `Impl(Fn(...) -> &T)` callable as a projection body is E0601, not the decision-24 text

**Severity:** S3. A malformed program (a `-> &T` body that forwards a call without the `&` that lends it) is
rejected with the internal result form, `Cannot unify incompatible types: "i32" and "*(i32)"`, instead of the
decision-24 message the same mistake gets elsewhere.

Found 2026-11-10 by the bugs2 lane while triaging
`issues/fixed/2026-11-08-a-projection-yielding-a-reference-returning-callables-call-is-rejected.md`.

## Reproducer

`issues/repros/2026-11-10-a-bare-call-of-an-impl-fn-callable-as-a-projection-body-is-e0601.yo`:

```text
error[E0601]: Cannot unify incompatible types: "i32" and "*(i32)"
  --> t.yo:1:67
  |
1 | apply_v :: (fn(f : Impl(Fn(x : &i32) -> &i32), v : &i32) -> &i32)(f(v));
```

The same body with `f : (fn(x : &i32) -> &i32)` (an `fn`-typed parameter), or forwarding a named projection
`g(v)`, reports "This function returns `&i32`, a projection (decision 24) ... The body forwards another
projection ... write `&f(v)`". With `&f(v)` the `Impl(Fn)` form is accepted.

## Where to look

The error is raised while the generic function's body is trial-evaluated at definition (`YO_DEBUG_SWALLOW=1`:
`[trial]` then `[swallow] error[E0601]`, kept because the diagnostic is marked generic-independent), before the
specialization check (`calls/helper.yo`, `projection_body_mismatch_message`) that would give the decision-24 text.
Only a callee typed by an `Impl`/`Dyn` Fn trait is affected.

## Expected

The decision-24 message naming `&f(v)`. Not fixed in the lane that found it (the unification site was not
located in the time available); no failing test yet beyond the reproducer.
