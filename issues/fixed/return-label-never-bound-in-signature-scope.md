# The return label was never bound in the signature's evaluation scope (`ensures(<label> ...)` worked only by name collision)

Status: FIXED (with the V3 wiring, `feat/fv3-straight-line-vc` — PR #497; the
soft-fallback + the verifier's registration env).

## Symptom

Any labeled return other than an accidentally-shadowed name made
`ensures(<label> ...)` fail evaluation with a hard E0401 — but only in
some contexts:

```rust
// E0401 "Variable \"r\" not found." (batch compile: hard, surfaces)
f :: (fn(x : i32, ensures(r >= i32(0))) -> (r : i32))(x);
// PASSES — because "result" collides with an unrelated binding:
g :: (fn(x : i32, ensures(result == (x / y))) -> (result : i32))(x / y);
```

`yo check` on a module swallowed the error (def-time trial swallow), so
the Phase-0/V1 test set — which used exactly the spelling `result` —
never noticed. The batch-compile path (`yo test` on a file whose import
closure does not include the evaluator) surfaced the throw.

## Root cause

Two gaps composed:

1. **No binding.** Nothing ever bound the return label in the env where
   the contract markers' predicates were raw-evaluated. The wrapper's
   SPLICE does bind it (`<label> := body`), but only at body-evaluation
   time; the signature-time diagnostic evaluation (and the generic
   pre-evaluation of the fn-type's args) ran with just the outer scope.
   `result` survived by colliding with an unrelated prelude/global
   binding — pure accident.

2. **No dedicated predicate context.** The predicates reference the
   signature's parameters and the return label by design; evaluating
   them in an env without those names made "not found" the ordinary
   outcome, not an error condition.

## Fix (PR #497)

- `EvalContext.is_evaluating_contract_predicate` (set by
  `_evaluate_contract_marker` around each raw predicate evaluation,
  carried through both ctx copy sites): the identifier resolver
  soft-falls-back to an unknown value instead of throwing inside
  predicates. Type errors still surface; the V1 label-the-return hint
  for unlabeled ensures still applies on the swallow path.
- The V3 task registration (`function_type.yo`) diagnostic-evaluates
  each predicate in a shared-frames env that binds the parameters and
  the return label as unknown values — the context the plan's "one
  diagnostic evaluation pass" always intended, and where the verifier's
  ExprInfo-keyed walk gets typed nodes.

## Reproducer (pre-fix, with a v0.2.28 seed)

```bash
printf 'f :: (fn(x : i32, ensures(r >= i32(0))) -> (r : i32))(x);' > tmp/fixme.yo
yo check ./tmp/fixme.yo   # error[E0401]: Variable "r" not found.
```
