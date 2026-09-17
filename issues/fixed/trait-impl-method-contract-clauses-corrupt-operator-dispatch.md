# An impl method with contract clauses inside a trait entry corrupts operator dispatch (hard "Cannot unify bool and fn" at check)

**Status: OPEN (surfaced by the V6 task-1 trait-variance work, 2026-09-14 —
it blocks the entire feature: the fixture shape cannot be evaluated).**

## Summary

Evaluating an `impl(T, SomeTrait(...))` whose method's fn-type carries
`requires(...)`/`ensures(...)` clauses makes a LATER operator dispatch in
the same evaluation fail with a hard

```
error: Cannot unify incompatible types: "bool" and "fn(self : i32, i : i32) -> i32"
```

anchored at the impl method's clause — even though the failing unify is
happening inside the PRELUDE's operator impls (`(~)`/comparison trials),
whose `self` binding has been cross-contaminated with the impl method's
own type. The failure is MODE-INSENSITIVE at plain-check time (check keeps
the runtime splice; `_is_verify_target` is false), and reproduces on
PRISTINE develop (verified by stashing the working tree) — it is not a
regression from the V6 branch.

## Reproducer (17 lines)

`tmp/lr_trait8.yo`:

```rust
pragma(Pragma.Verify);   // the pragma is NOT required — plain check fails too
{ println } :: import("std/fmt");
T1 :: trait(
  m : (fn(self : Self, i : i32, requires(i >= i32(0)), ensures(result == i)) -> (result : i32))
);
impl(
  i32,
  T1(
    m : (
      fn(self : i32, i : i32, requires(i >= i32(0)), ensures(result == i)) -> (result : i32)
    )(
      i
    )
  )
);
main :: (fn() -> unit)({ println(`x`); });
export(main);
```

`yo check` on this file throws the unify error above, anchored at the
impl's `requires(i >= i32(0))`.

Variants narrowed:

| shape | verdict |
| --- | --- |
| trait field with clauses, NO impl | OK |
| impl method with clauses, NO trait (`impl(i32, m : ...)` inherent) | OK |
| trait (clauses or not) + impl method WITH a clause | **FAILS** |
| impl method with clauses, trait field WITHOUT | **FAILS** |
| trait + impl, NO clauses anywhere | OK |
| ordinary top-level `f :: (fn(i : i32, requires(...)) -> R)(body)` | OK |
| the impl method's `self` param is not required (a no-self trait field fails identically) | — |

So the trigger is exactly: **a clause-carrying fn-type in an impl method
that sits in a trait entry** (the expected-type propagation from the trait
field is involved — the inherent-method shape without a trait passes).

## Diagnosis (gdb, -O0 -g driver build)

Backtrace shape at the throw (`synthesize_types`' unification tail,
`src/evaluator/types/synthesizer.yo:2158`):

```
#0/#1  synthesizer unify (expected=bool, given=fn(self : i32, i : i32) -> i32)
#2     check_if_function_parameter_matches_argument (param_label="self")
#3     try_to_call_function_with_arguments (is_method_call=true)
#4-#8  evaluate-with-given-type → the spliced/wrapped impl-method body's
       begin-block trial (is_evaluating_function_body_begin_block=true)
#9-#10 the deferred-body evaluator called from _evaluate_funcval_runtime_call
       for the `(fn(...) -> R)(i)` application
#11-#21 the impl block's field loop → module begin evaluation
```

The decisive detail: at frame #2 the ARGUMENT is an ATOM whose TOKEN is at
**std/prelude.yo:582:4** — the prelude `(~)` impl's `bit_not` `self`
parameter — and its evaluated TYPE is the impl method's registered
Self-substituted fn type. I.e. the prelude operator impl's def-time trial
(`self.(~)()` inside `bit_not`) is re-run during the impl-method
evaluation and reads a `self` binding that has been cross-contaminated
with the trait-impl method's own type; the subsequent where-clause
synthesis then resolves `_Self` to a stale `bool` (from the clause
predicate's comparison) and the final unify throws.

This is the **def-time body env sharing** defect class documented in
`plans/backlog/FUNCVAL_ENV_SHARING.md`: def-time body envs COPY what TS
SHARES, and the trait-entry path (expected-type propagation + the splice's
trial frames) aliases frames the prelude's operator-impl FuncVals hold.
An inherent (non-trait) impl method with the same clauses does not trip
it — the expected-type propagation from `_trait_field_type_by_label` is
what routes the evaluation through the shared-frame path.

## Why it matters

`plans/backlog/FORMAL_VERIFICATION.md` V6 task 1 (trait-contract
variance) needs exactly this shape — contracted trait methods with
contracted impl methods — and the phase's claim that "signature
extraction already parses trait-field contracts (Phase 0)" holds only for
the TRAIT side in isolation; the impl side has never been exercised (no
test in the corpus combines impl + clauses; `contracts_phase0.test.yo`
deliberately avoided the trait machinery). The feature is implemented on
`feat/fv6-trait-variance` and blocked end-to-end solely by this defect.

## Suggested attack

Follow the FUNCVAL_ENV_SHARING levers for the trait-entry expected-type
path: the impl method's def-time trial (and the contract splice's
pred-env pass) must not mutate frames the prelude's generic operator
FuncVals alias. A first probe: compare the env frame IDENTITY
(`env.frames` array identity) seen by the prelude `(~)` impl's trial
before/after evaluating a trait-entry impl method with clauses — the
frame the corrupted `self` is read from is the frame to stop sharing.

## Update 2026-09-14 — confirming evidence from the V6 task 1 work

Task 1 landed with the two-step spelling (named fn carrying the clauses,
referenced from the impl entry), which evaluates clean — the defect is
routed around, not fixed, and this issue stays OPEN.

Two new data points for whoever fixes it:

1. **The trigger is clauses visible in the fn-type side tables during
   trait-entry evaluation, not the clause ASTs sitting in the impl's
   fn-type syntax.** The first inheritance draft planted the TRAIT's
   clauses under the impl fn-TYPE EXPRESSION id before the application
   evaluated (hoping the re-key would carry them to the FuncVal). The
   impl's fn-type itself was CLAUSE-LESS — and the corruption fired
   identically (`Cannot unify incompatible types: "bool" and "fn(...)"`
   anchored at the TRAIT's clause). The fn-type evaluation / splice
   re-reads `get_func_requires_exprs(<fn-type-expr-id>)` and evaluates
   whatever it finds there inside the trait-entry expected-type path.
   Anything that writes those tables before a trait-entry application
   re-triggers this.
2. **A bare module-level call statement is evaluator-only** (codegen
   collects only `:=` / `(x : T) =` / `x =` inits as module-level
   initializers, `anonymous_module.yo`'s collection loop) — a hook
   installed by a bare call works under `yo check` and is silently
   DROPPED from compiled binaries. The `_name := (fn() -> bool)({...})();`
   runtime-binding shape (the `_trait_checking_init` precedent) is the
   form that survives both.

## Fixed 2026-09-17 (rides PR #753's branch)

Root cause found by instrumented driver (YO_DEBUG_PARAMCHECK probes at the
param check's Step 6 and at try_to_call_function_with_arguments' Step 10,
plus a per-site expected-setter tag): the trait entry evaluates each impl
method's value WITH the trait field's (Self-substituted) fn type on
`ctx.expected_type` (values/impl.yo). That expected copied into the def-time
body trial's context (create_function_body_evaluation_context), and the
SPLICED BODY's runtime contract guard — the `i >= i32(0)` inside
`requires(...)` lowered to `cond(begin(runtime(pred)) ...)` — dispatched the
operator through try_to_call's Step 10, which unifies the call's return
against the expected: `bool` vs the fn type → the hard throw. The backtrace
frames named the prelude impl trials because the guard's operator dispatch
enters the prelude's operator impls — their frames were innocent; the
EXPECTED was the leak.

Fix (src/evaluator/calls/helper.yo, try_to_call Step 10): skip the
return-vs-expected synthesis when the expected is a fn type the call does
not itself return — a fn-type expectation belongs to fn-expression
positions and can never be satisfied by an ordinary inner call. Clearing the
expected at the trial sites was tried first and REVERTED: bodies legitimately
infer from the ambient expected (prelude trait-default `.None` shorthands
broke — the trial must keep it).

Regression test: `tests/internal/verifier_trait_variance.test.yo` "the
INLINE clause spelling loads and proves" + fixture
`tests/spec/fixtures/valid/trait_impl_clauses.yo` — 4/4 green locally (the
fixture's own variance task now PROVES: `impl-variance@…:m=ok`).
