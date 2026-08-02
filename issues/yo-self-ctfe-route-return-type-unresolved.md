# yo-self: CTFE route stamped the raw declared SomeT as the call's return type

Found 2026-08-02 while gating the fn-arm-13 no-match throw (patch C): landing
the throw flipped `tests/comptime.test.yo` GREEN→HOLLOW, and the probe chain
led here. **Fixed same day** (see the CTFE-route block in
`yo-self/evaluator/calls/function.yo`, "TS stamps the CTFE call's return type
from the RESULT VALUE").

## Symptom chain (all measured)

1. `nv :: -(f32(50.75))` — the Call-module expansion correctly selects
   `comptime_neg` (probe: `ncand=2 nsucc=2 nct=1 winner_ct=true`), CTFE folds
   the value (probe at the `::` binding: `val=CONCRETE`) — but the call's
   ExprInfo TYPE stays the raw declared `_Self : (Comptime + ComptimeNegate)`
   (probe: `ty=_Self …`). TS gives `f32`.
2. Every later dispatch on `nv` fails and is swallowed at def time:
   `comptime_assert(nv < f32(0.0))` sees `<unknown: unit>` — inside a test arm
   that PASSES VACUOUSLY (soundness hole: tests/comptime.test.yo arm 0's
   whole negative-number block was asserting nothing).
3. `nv - a` (prefix-op result as infix LHS): receiver dispatch fails on the
   `_Self`-typed receiver, falls into the Call-module pre-pass whose only
   candidates are the 1-arg negs → zero successes → with patch C, an honest
   `No matching call found` (pre-C: silent fall-through).

The known "operator-call result as the RECEIVER loses comptime-ness" defect
(issues/handoff-2026-08-02/05 §4, blocker for fn-arm-12 patch B) is this bug:
the _argument_ position worked because the OTHER operand's concrete type drove
dispatch; the receiver position needed `nv`'s own type.

## Root

`evaluate_function_call`'s CTFE route (function.yo, `out_ct` stamping) used the
callee's DECLARED result type with only receiver-`Self` adoption and
array-length recovery. TS instead sets `returnType = nextReturnValue.type`
(helper.ts:1782) — the CTFE result value's own type, concrete because TS
values carry their type. yo-self values do NOT carry a type
(`value.yo:939` `type_of_eval_value` is lossy), so nothing re-derived the
binding `_Self := f32` on this route (the full call path's Step 9 does, but
the CTFE route bypasses it).

## Fix (landed)

In the CTFE route, when the stamped type still contains SomeTs: substitute the
foralls bound from this call's arguments (`fa_bound_names`/`fa_bound_types`,
filled by `_funcval_bind_foralls`), resolve the remainder from `fresh_env`
(`evaluate_function_return_type_again`), and adopt only a fully-resolved
result (Step-9b acceptance rule). This is the same block the runtime FuncVal
arm (`_evaluate_funcval_runtime_call`) already runs.

## Repros (kept)

- `scratchpad/mine/p2gate/m9.yo` — `nv :: -(f32(50.75))` type probe
- `scratchpad/mine/p2gate/m5.yo` — `comptime_assert(nv < f32(0.0))`
- `scratchpad/mine/p2gate/m2.yo` — the full negative-number block; m1/m4 variants
- corpus test: `tests/codegen-bootstrap/comptime_prefix_op_fold.yo`
