# Def-time function-body evaluation — the faithful TS port

## Why this matters

Definition-time body evaluation is the shared prerequisite for **flowability**
(`ref_flowability`, `slice_flowability`, the `ref_*` tests) and **contracts**.
TS evaluates a function body at DEFINITION (`tryToImplementFunctionByFunctionType`,
`function-type.ts:439-513`) in type-check mode (`isExecuting=false`,
`isValidatingFunctionDefinition=true`); that's where the `-> ref(T)` flowability
gate and `wrapFunctionBodyWithContracts` run. yo-self defers body eval to call
time, so those gates have no hook.

## The root divergence (mapped 2026-06) — it is NOT a representation gap

yo-self ALREADY binds comptime type params (`Self`, trait params like `Idx`) as
SomeType-producing values, identical to TS:
- TS `function.ts:561`: `value = isCompileTimeOnly ? createUnknownValue(parameterType, {variableName: label}) : undefined`
- yo-self `function.yo:1167`: `create_unknown_val(final_param_type)` ("Mirrors TS createUnknownValue")

The ONE difference is **where the bound frame lives**:

| | TS | yo-self |
|---|---|---|
| Func type carries the param-bound frame | `FunctionType.parametersFrame: Frame` (`definitions.ts:877`) | **no field** — `Func` is flattened to parallel arrays (`definitions.yo` `Func(forall_labels, param_labels, param_types, …)`) |
| Body-eval env | `pushEnvFrame(env, functionType.parametersFrame)` (`function-type.ts:380`) → `Self`/`Idx` bound | only `caller_env` → `Self`/`Idx` UNBOUND |

So `evaluate_function_parameters`' param-bound `env_mut` is **discarded**;
`try_to_implement_function_by_function_type` receives only `caller_env`. At
body-eval time `Self`/`Idx` are unbound → `Failed to evaluate type expression:
Idx`. They only *look* like atoms because the binding was lost. (Confirmed by the
2026-06 def-eval re-attempt: prelude survives with 6 swallowed `Idx` errors,
real tests regress base 43→fix 5 — all downstream of the missing frame.)

## Why the frame can't live on the `Func` TypeValue

`env.yo` imports `TypeValue` from `definitions.yo` (`env.yo:20`), and
`definitions.yo` imports only std. Putting `Frame` (defined in `env.yo`) on
`Func` would create a `definitions ↔ env` import cycle — which TS doesn't have.
yo-self already solves this exact class with **func-id side-tables**: see
`evaluator/types/function.yo:77` ("yo-self's TypeValue.Func does not carry those
flags, so we side-table the information keyed by func_id") for macro flags, and
the default-args side-table at `function.yo:158`.

## The faithful fix (yo-self adaptation of TS `parametersFrame`)

1. **Side-table** `g_func_parameters_frame : HashMap(String, Frame)` keyed by
   func-type/func-val id (an `evaluator/types/...` registry module, like the
   macro/default side-tables). Mirrors TS `FunctionType.parametersFrame`.
2. **Populate** it in `evaluate_function_parameters` / `evaluate_function_type`:
   after binding all params into `env_mut`, store the resulting top frame under
   the func id. (The params are ALREADY bound with `create_unknown_val` — we
   just need to keep the frame instead of discarding it.)
3. **Consume** it in `try_to_implement_function_by_function_type`: instead of
   `caller_env`, build the body-eval env by pushing the saved parameters frame
   (mirror `function-type.ts:380` `pushEnvFrame(env, functionType.parametersFrame)`),
   then port the body-eval block (TS `function-type.ts:439-513`):
   - `should_defer` = `forall>0 || any param type_contains_some_type ||
     SelfType contains some_type` — works AS TS INTENDS once the frame carries
     SomeTypes (`type_contains_some_type` can detect them). NO should_defer
     invention needed.
   - non-deferred → `evaluate_begin_expression(body, frame_env, body_ctx, …)`
     with `create_function_body_evaluation_context` (already ported,
     `function_type.yo:80`).
4. **Then** wire the gates (separate, downstream): `-> ref(T)` flowability
   (`function-type.ts:524-573`, `is_flowable_expr` already ported in
   `yo-self/types/flowability.yo`) and `wrap_function_body_with_contracts`.

## Validation discipline

Catastrophic-regression history (53→3, and 43→5 in the 2026-06 re-attempt). The
canary is the PRELUDE (single-file check) — must stay clean (0 swallowed errors)
BEFORE any full run. Then per-file diff std/tests/yo-self with 0-regression bar
(the slow ~25-min cycle). Revert on any prelude breakage.

## Reference points
- TS: `function-type.ts:340-513` (param frame push + should_defer + body eval),
  `function.ts:561` (param value = createUnknownValue), `definitions.ts:877`
  (`parametersFrame: Frame`).
- yo-self: `calls/function_type.yo` (try_to_implement + create_function_body_evaluation_context),
  `types/function.yo:1167` (param binding via create_unknown_val), `types/flowability.yo`
  (is_flowable_expr, ported). Side-table precedent: `types/function.yo:77,158`.
