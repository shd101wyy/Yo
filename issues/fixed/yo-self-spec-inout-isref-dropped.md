# yo-self: `inout` param `is_ref` dropped at call-time binding → `p.x` on a pointer

**Status:** FIXED — `yo-self/evaluator/calls/function.yo:3239`. Gate GREEN under -O2:
STRICT_FIXPOINT=HOLDS, corpus 135/2/0 (baseline), std 153/153, ref_return_ban 2/2,
prior flips (str, duration, lexer, parser) preserved, no regressions (the other
rc=1 files — impl, sync/mutex, ref_field_borrow, ref_closure_capture — are all in
the round-19 red baseline, red for their own roots, not is_ref).
**Flips:** `tests/ref_return_ban.test.yo` (0/2 → 2/2)
**Class:** faithful-port divergence (NOT Gap-6 type-identity).

## Symptom

`s2 test tests/ref_return_ban.test.yo` failed to C-compile:

```
tests/.yo_selftest_batch_1.bin.c:5052:38: error: member reference type
'__yo_t22 *' (aka 'struct __yo_t22_struct *') is a pointer; did you mean to use '->'?
 5052 |   int32_t _file____User_temp_6484 = p.x;
```

The failing `p.x` is in the positive test `with_x :: (fn(inout(p) : Point, body : Impl(Fn(...))) -> i32)(body(p.x))`.
`with_x` has a closure param, so it is **specialized** per call.

## Root cause — differential

The emitted C contained **two** copies of the function:

```c
// ORIGINAL (def-time body eval) — CORRECT
static inline int32_t yo_id_6016(__yo_t22* p, __yo_t29 body) {
  int32_t _t = (*p).x;   // deref: is_ref honored
  ...
}
// SPECIALIZED (call-time) — WRONG
static inline int32_t yo_id_6016_rtparam0_..._capture_...(__yo_t22* p, __yo_t29 body) {
  int32_t _t = p.x;      // no deref: is_ref LOST
  ...
}
```

A codegen probe in `_var_read_code` (atom.yo) confirmed: codegen reads `p` with
`is_ref=false, nvars=1` in the specialized function, `is_ref=true` in the original.

The specialized body's params are bound by the **call-time runtime param binding**
at `function.yo:3239`, which used `add_variable_to_env(...)`:

```rust
p_is_ref := match(fv_param_is_ref.get(pi), .Some(b) => b, .None => false);
var_opt := add_variable_to_env(
  fresh_env, pname, bind_ty, bind_val,
  is_ct,
  p_is_ref,   // <- passed as is_reassignable (position 6)
  false, false,
  synthetic_token(pname, env.module_path)
);
```

`add_variable_to_env` (env.yo:836) **hardcodes `is_ref: false`** — it has no `is_ref`
parameter. So `p_is_ref` set only `is_reassignable`; `is_ref` was silently dropped.
`_var_read_code` (atom.yo:118) reads `v.is_ref` to decide the `(*name)` deref, saw
`false`, and emitted the bare `p` → `p.x` on a pointer.

Why the ORIGINAL was correct: the **def-time** body eval binds params via
`add_parameter_to_env` (function_type.yo:362), which DOES take/set `is_ref`. The
anonymous-function path (anonymous_function.yo:645) also stamps `is_ref` after
binding, with a comment noting "add_variable_to_env can't set is_ref". Only the
call-time runtime-call path had the unpatched gap.

TS keeps both flags at binding (helper.ts:584-585:
`isRef: parameter.isRef, isReassignable: parameter.isRef, isParameter: true`).

## Fix

`function.yo:3239` — bind via `add_parameter_to_env` (mirrors function_type.yo:362),
setting `is_ref = p_is_ref` and `is_parameter = true`:

```rust
var_opt := add_parameter_to_env(
  fresh_env, pname, bind_ty, bind_val,
  is_ct,
  p_is_ref,   // is_reassignable
  false, false,
  p_is_ref,   // is_ref   <- now carried
  true,       // is_parameter
  synthetic_token(pname, env.module_path)
);
```

Requires adding `add_parameter_to_env` to function.yo's `../../env.yo` import.

## Scope / non-scope

- All method/index-trait/other calls route through
  `try_to_call_function_with_arguments` → this same runtime-call binding, so the
  single site covers the whole call-time path (no sibling fix needed in
  index_trait.yo — it only READS param_is_ref for routing, not a separate bind).
- This is is_ref (codegen deref), NOT the Gap-6 per-call `SomeType` identity
  problem — most of the remaining spec-family red files are still Gap-6.

## Regression surface

Hot path (every runtime call binds params here). Change is uniform + deterministic
(adds is_ref/is_parameter only for `inout` params; non-inout params get
`is_ref=false` as before). Gate: corpus (135/2/0 = baseline), std (153/153),
fixpoint, ref_return_ban flip, prior flips + inout spots (sync/mutex,
ref_field_borrow, ref_closure_capture).
