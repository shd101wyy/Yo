# A safe-mode `unwrap` inside an `io.async` body passes `yo check` and fails `compile` with E0905

**Severity:** S3 — the real diagnostic (E0611) is swallowed: `check` is green, and `compile` reports only the generic "body was never fully evaluated" E0905

**Status: FIXED (2026-09-29).** Found 2026-09-29 writing async state-machine probes (`plans/ASYNC_STATE_MACHINE_GENERATION.md` phase 5). Reproduces with the v0.2.45 seed and a tree build.

## Symptom

`issues/repros/safe-mode-unwrap-in-an-io-async-body-is-swallowed.yo` (also the CLI case fixture):

```rust
_run :: (fn(o : Option(i32), io : Io) -> Impl(Future(i32, Io)))(io.async((e : Io) => {
  v := o.unwrap();
  v
}));
```

- `yo check` passes (`evaluator OK`).
- `yo compile` fails with E0905 at the `io.async` closure and never names the `unwrap`.
- In a plain function the same line is E0611 (`unwrap` on an Option/Result discards the failure case).

## Root cause

The D7 ban (`src/evaluator/exprs/property_access.yo`, `src/evaluator/calls/function.yo`) is a plain `exn.throw`. The `io.async` body is evaluated in a definition-time trial, which swallows the throw, and nothing re-raises it: the body is left unevaluated, which codegen then reports as E0905. #994 fixed the same class for flow violations: `raise_flow_violation` flags the rejection so the trial's caller re-raises it (`reraise_flow_violation`).

## Fix direction (as filed)

Raise the D7 rejection through the flow-violation flag, so the trial's caller re-raises it at the `unwrap`. Test: a CLI case where `check` reports E0611 inside an `io.async` body.

## Fix (2026-09-29)

The four D7 sites (`calls/function.yo`, and three in
`exprs/property_access.yo`) raise the rejection with `raise_flow_violation`
instead of a plain throw. The trial still swallows it, but the flag it sets is
what the trial's caller re-raises (`reraise_flow_violation`, the #994
mechanism), so `yo check` now reports E0611 at the `unwrap` and exits 1.
Regression test: CLI case `check-unwrap-in-async-body` (a GOLDEN-DIFF on the
v0.2.45 seed, which prints `bad.yo — evaluator OK`).
