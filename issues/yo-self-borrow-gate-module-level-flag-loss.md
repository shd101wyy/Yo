# yo-self: borrow gates never fired for module-level roots + closure args (ref_field_borrow)

**Status: FIXED** (this commit). Flips `tests/ref_field_borrow.test.yo` (rc=1 → 11/11).

## Symptoms (three stacked, each masked the next — `check` stops at the first

failed `comptime_expect_error`)

1. `bump(g_holder.n)` (inout borrow of a MODULE-LEVEL object's field) was
   accepted — `require_valid_ref_argument_places`' module-root arm never
   fired.
2. `run(xs(usize(0)), () => { xs.push(...) })` (closure capturing the
   container alongside an index-place ref arg) was accepted — the
   element-only reachability loop never flagged the closure.
3. With 1+2 fixed, the file exposed a codegen hole: a module-level TUPLE with
   an RC element (`g_rc_tuple := (ArrayList(i32).new(), i32(42))`) emitted
   `._0 = /* skip generating value */` — invalid C.

## Roots

1. **`is_module_level` lost in the def-time body-eval env flatten.** Probes
   showed the `:=` binding stores `is_ml=true`, but the flowability lookup
   inside the fn body sees `is_ml=false`. `evaluator/calls/function_type.yo`
   builds the def-time body env by FLATTENING every caller variable into a
   fresh single-frame env via `add_variable_to_env(...)` — a signature that
   cannot carry `is_module_level`, so the copy defaulted to false. TS reuses
   the definition env's Variable OBJECTS (function-type.ts:499) so every flag
   survives. FIX: patch `copied_var.is_module_level = cv.is_module_level`
   after the add. LANDMINE: this flatten drops EVERY Variable field
   `add_variable_to_env` can't take (doc_comment, parameter_alias, …) — if a
   future gate reads one of those through a def-time env, patch it here too.

2. **`closure_function_value` is never set by anonymous-fn eval** (documented
   Phase-3 convention in `anonymous_function.yo`: "downstream code falls back
   to reading info.value"). The flowability reachability loop checked ONLY
   `oi.closure_function_value` — TS checks `otherExpr.$?.closureFunctionValue`,
   which TS stamps under the SAME `isCreatingClosure` gate as `captureType`.
   FIX (`types/flowability.yo`): fall back to
   `is_anonymous_function_definition && capture_type.is_some()`.

3. **Tuple value with runtime elements carried holes.** yo-self runtime
   results are `Some(UnknownVal)` where TS uses `undefined`; the tuple
   evaluator's `all_known` check (`evaluator/values/tuple.yo`) read
   `Some(UnknownVal)` as known → `TupleVal` with an UnknownVal hole →
   codegen's comptime short-cut emitted `/* skip generating value */` into a
   compound literal. TS: `tupleValues.some((v) => !v)` → value undefined →
   falls through to the runtime tuple emitter. FIX: treat UnknownVal elements
   as not-known (third site needing the UnknownVal-convention guard).

## Verification

- ref_field_borrow.test.yo 11/11, ref_return_ban.test.yo 2/2.
- codegen-bootstrap, check ./std 153/153, prior-green spot set (incl.
  flowability_comprehensive, for_macro_borrow, index 48/48), STRICT_FIXPOINT
  — see commit.
