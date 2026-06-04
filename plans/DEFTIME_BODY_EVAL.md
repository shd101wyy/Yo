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

|                                         | TS                                                                                              | yo-self                                                                                                                      |
| --------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Func type carries the param-bound frame | `FunctionType.parametersFrame: Frame` (`definitions.ts:877`)                                    | **no field** — `Func` is flattened to parallel arrays (`definitions.yo` `Func(forall_labels, param_labels, param_types, …)`) |
| Body-eval env                           | `pushEnvFrame(env, functionType.parametersFrame)` (`function-type.ts:380`) → `Self`/`Idx` bound | only `caller_env` → `Self`/`Idx` UNBOUND                                                                                     |

So `evaluate_function_parameters`' param-bound `env_mut` is **discarded**;
`try_to_implement_function_by_function_type` receives only `caller_env`. At
body-eval time `Self`/`Idx` are unbound → `Failed to evaluate type expression:
Idx`. They only _look_ like atoms because the binding was lost. (Confirmed by the
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

## Progress (2026-06, this session) — staged checklist

**Two prerequisites now LANDED as committed, exported, 0-regression staged
infrastructure (unconsumed until the body-eval wiring):**

- `type_contains_some_type_for_codegen_param` (the deep should_defer predicate) —
  committed `95945b1f` in `evaluator/trait_checking.yo`.
- `parametersFrame` side-table API (`g_func_parameters_frame` +
  `register_func_parameters_frame`/`get_func_parameters_frame`) — committed
  `8d700447` in `function_value.yo` (Frame from env.yo, no cycle).

These are exported but have NO caller yet (⇒ 0 behavior change; build green,
prelude canary + spot-check clean). Landing them de-risks the eventual focused
body-eval push: the storage API + deep predicate are in place and faithful;
what remains is the (regression-prone, multi-layer) WIRING that consumes them.

The params-frame mechanism is IMPLEMENTED and PROVEN, but def-time body eval is
a multi-layer chain; later layers regress and were reverted (baseline kept green
at Tier 1: std 151 / tests 164 / yo-self 227).

- [x] **params-frame side-table — PROVEN.** Capture `env_mut`'s top frame
      IMMEDIATELY after `evaluate_function_parameters` (line ~2995) — NOT later
      (by the `register_func_param_defaults` site the top frame is the MODULE frame
      with 51+ globals, confirmed by probe `frameVars=51`). Key by
      `ast_expr_id(expr)` (the `fn(...)` type-expr id); read in
      `try_to_implement_function_by_function_type` via `ast_expr_id(fn_type_box.*)`;
      `frames.push` it before body eval, `pop_frame` after. Verified: `frameVars=1`,
      `Idx` resolves, prelude `Idx` errors 6→0. `EvalValue` is a value-type (no
      `.clone()`; pass by value). Box `body_expr.clone()` for the FuncVal so def-eval
      reuses the original.
- [x] **`type_contains_some_type_for_codegen_param` — PORTED (proven, reverted).**
      1:1 port of `typeContainsSomeTypeForCodegenParam` (utils.ts:708) added to
      `evaluator/trait_checking.yo` (so it can use `type_implements_fn`/`future`
      without a `types/utils.yo` cycle); recurses Array/Slice/Pointer/Iso/Tuple/
      Struct(excl. Fn-typed fields)/Enum/Union/Module/Func, `TypeAppT`→true; SomeT
      excl. via `type_implements_fn`/`future` (yo-self `SomeT` has no `is_extern`/
      `resolved_concrete_type` → those exclusions are no-ops). Built clean; wired
      into `should_defer`. Reduced prelude swallowed errors 6→4 — but did NOT clear
      the regression.
- [ ] **4TH LAYER (deeper): generic-call unification in type-check mode.** With
      the deep predicate deferring generic fns, def-eval of a CONCRETE fn whose body
      CALLS a generic fn still fails: `str` ctor (prelude.yo:5832
      `Self(bytes : __yo_slice_new(ptr, length))`) → `Type mismatch for "ptr":
Expected *(T) Got *(u8)` — `__yo_slice_new`'s `T` is NOT unified to `u8` in
      def-time type-check mode (`is_executing=false`). So the generic-call
      resolution path isn't robust in def-eval mode. This is NOT a should_defer
      miss — it's the evaluator's call machinery behaving differently under
      type-check mode. bump/closure/comptime_ref/sysinfo all still regress (exit 1).
- [ ] (was) **should_defer needs the DEEP predicate.** yo-self's `type_contains_some_type`
      (types/utils.yo:442) is SHALLOW — only top-level `.SomeT`/`.TypeAppT`. TS uses
      `typeContainsSomeTypeForCodegenParam` (types/utils.ts:708) which recurses
      `Ptr`/`Slice`/`Array`/`Struct`/`Enum`/`Func` (with `Fn`/`Future`/extern SomeT
      exclusions). Without it, generic ptr fns aren't deferred → def-eval runs
      `__yo_ptr_add(self,offset)` with `self:*(T)` → `Type mismatch Expected T Got
*(T)` (bump regressed exit 1). PORT it. Constraints: `type_implements_fn`/
      `type_implements_future` live in `evaluator/trait_checking.yo` (importing into
      `types/utils.yo` cycles — put the predicate in a module that can import them,
      or inline the Fn/Future checks), and yo-self `SomeT` has no `is_extern`/
      `resolved_concrete_type` fields (those TS exclusions become no-ops). A SAFE
      over-deferring stand-in is `get_all_some_types(deep) > 0` (defers more, evals
      fewer bodies — never under-defers), but it is not byte-faithful (over-defers
      `exn:Exception`/`io:Io` fns TS evaluates).
- [ ] **closure.test regressed (exit 1)** under def-eval — another should-defer
      miss (likely cleared by the deep predicate) OR a distinct body-eval side
      effect. 2 swallowed prelude errors also remained (down from 6). Analyze after
      the deep predicate lands.
- [ ] **wire the gates** (downstream): `-> ref(T)` flowability
      (function-type.ts:524-573) + `wrap_function_body_with_contracts`.

## Reference points

- TS: `function-type.ts:340-513` (param frame push + should_defer + body eval),
  `function.ts:561` (param value = createUnknownValue), `definitions.ts:877`
  (`parametersFrame: Frame`).
- yo-self: `calls/function_type.yo` (try_to_implement + create_function_body_evaluation_context),
  `types/function.yo:1167` (param binding via create_unknown_val), `types/flowability.yo`
  (is_flowable_expr, ported). Side-table precedent: `types/function.yo:77,158`.
