# yo-self: return-temp `void*` for an unresolved-SomeT return expression

_2026-07-20. Diagnosis + one landed codegen fix (`generate_return`), plus the
remaining multi-error breakdown of `comptime.test.yo`._

## Symptom (the void\*-return-temp class)

A specialized function whose PROTOTYPE renders a concrete C return type emits a
body return TEMP typed `void*`:

```c
static inline float yo_id_124_f32_id_f32_rtparam0_f32_ret_216(float self) {
  void* _file____User_temp_4698 = (-(self));   // temp is void*, fn returns float
  return _file____User_temp_4698;              // → "returning void* from float"
}
```

TS emits the temp as `float` (same prototype). Minimal repro:
`negate :: (fn(x : f32) -> f32)(-(x));` (a runtime `-(f32)`).

## Root

`-(x)` dispatches to the generic operator `neg` (prelude.yo:585,
`fn(forall(_Self), self : _Self) where(_Self <: Negate)` → body
`return(self.neg())`, inlined to `(-(self))`). Its DECLARED return type is the
forall `_Self` (a SomeT, id 216: `_Self : (Negate)`). Specialization for f32:

- the specialized FUNCTION TYPE's `result` is concretized to f32 (used by the
  prototype → `float`), BUT
- the body's RETURN-EXPR node keeps the abstract `_Self` (216). `get_type_string(_Self)`
  finds no resolution (216's cell empty; the id-keyed global is unset, and
  setting it would cross-poison every other `Negate` impl that shares 216) → `void*`.

Probed facts (2026-07-20, s1dbg):

- `[REBIND] fn=yo_id_124 p=self cur_some=false cur=f32 concrete=f32` — `self` is
  ALREADY f32 in the specialized body env (a param-rebind is NOT the fix; a
  guarded SomeT→concrete param rebind was implemented, proved a no-op here, and
  reverted).
- `[VOIDFB] sid=216 name=_Self ty=_Self : (Negate) fn=yo_id_124_f32_...` — the
  body return-expr type is the shared operator forall `_Self`, disconnected from
  the specialized concrete return.

So the disconnect is: return-EXPR type (abstract `_Self`) ≠ specialized function
return type (concrete f32). TS keeps them equal because its body eval types
`self.neg()` naturally as f32; yo-self coerces the return expr to the declared
`_Self` and the specialization concretizes only the function type, not the node.

## Fix landed — `generate_return` resolves the temp through the FN return type

`yo-self/codegen/exprs/return.yo` (`generate_return`): the return statement
yields the FUNCTION's value, so the return temp's C type IS the function's
(specialized) return type. When the return expr's own type lowers to `void*`
but the function's return type is concrete, use the function's return type.
Mirrors the deferred-dup / scope-ret tail paths (generation.yo:196,265) which
already type the tail temp from `function_type.Func.result`. Guarded to the
`void*`→concrete transition so ordinary returns are untouched.

Verified: the f32-neg temp flips `void* → float` (s1r2 emit).

## `comptime.test.yo` is MULTI-error — this fix alone does NOT flip it

After the fix, `comptime` still fails on a SECOND, independent root:

```c
static inline double yo_id_124_comptime_float_id_comptime_float_rtparam0_comptime_float_ret_216(double self) {
  void* _file____User_temp_6726 = fn_yo_id_199(self);   // fn_yo_id_199 UNDECLARED
  return _file____User_temp_6726;
}
```

`fn_yo_id_199` = the `ComptimeNegate` impl's `neg` body `__yo_comptime_float_neg`
(prelude.yo:930) — a COMPTIME-only builtin with no runtime C definition. yo-self
SPECIALIZES + COLLECTS the operator `neg` for `comptime_float` (a compile-time
type) as a RUNTIME function, whose body calls the comptime builtin → undeclared.
All the `neg` uses in comptime.test.yo are `::` (comptime) bindings that should
FOLD; TS does not emit a runtime `comptime_float` neg.

**The comptime-leak is a separate Gap** (a comptime call registering a runtime
specialization for codegen). `should_skip_function_codegen`
(codegen/functions/declarations.yo:462) skips `_func_result_is_comptime_only`,
but this specialization's declared result is the SomeT `_Self`, not a
comptime-marked type, so it is not skipped.

**Attempted + REVERTED (2026-07-20): a `should_skip` param-comptime check.**
Added `_func_has_comptime_only_param` (skip if any param is
`.ComptimeInt/.ComptimeFloat/.ComptimeString`). It did NOT fire — a `[SKIPCP]`
probe in `should_skip` showed the DESYNC:

```
[SKIPCP] cname=yo_id_124_comptime_float_id_comptime_float_rtparam0_comptime_float_ret_216
         fid=<same> params=f64 | has_cp=false skip1=false
```

`get_func_type(fid)` returns param **`f64`** (renders `double self`), but the
c_name AND the body are `comptime_float` (`self.neg()` dispatched to
`ComptimeNegate.neg` = `__yo_comptime_float_neg` = the undeclared `fn_yo_id_199`).
So the function is a HYBRID: an **f64 ABI** with a **comptime_float body/c_name**.
The param-comptime signal can't catch it (param is f64); a c_name string-match
would catch it but is an unfaithful band-aid with fixpoint risk.

### DEFINITIVE ROOT (2026-07-20, traced to the exact unported feature)

The body's `self.neg()` dispatched to the COMPTIME `ComptimeNegate` impl
(`__yo_comptime_float_neg`) because the arg stayed typed `comptime_float` into
the specialized body eval. TS AVOIDS this at `helper.ts:508-524`: when a param
is NOT comptime-only (`!parameter.isCompileTimeOnly`) and the arg is a
comptime-only type, it calls `convertComptimeTypeToRuntimeType` (comptime_float
→ f64) BEFORE synthesis + body eval — so `self` binds f64 and `neg` dispatches
to the runtime `Negate` impl (`__yo_op_neg`, which inlines to `-(self)` and
compiles, cf. the f32 case above).

yo-self's port of that conversion is `helper.yo:531`, but its guard is
`(!is_some_type(resolved_pt)) && (!pt_is_comptime)` — it uses `!is_some_type` as
a PROXY for TS's `!parameter.isCompileTimeOnly`, and that proxy WRONGLY skips the
conversion for a **runtime param typed as a SomeT** — exactly the operator
`neg`'s `self : _Self`. So the comptime_float arg is never lowered to f64.

Why the proxy: **yo-self does not track the per-param comptime modifier.**
`is_ct_only` is hardcoded `false` at the call site (helper.yo:3029, "Phase 3
treats all regular params as runtime"), and `FuncMeta`
(types/definitions.yo:33) has `param_labels` / `param_is_ref` /
`param_is_owning` but **NO `param_is_comptime`**. The `!is_some_type` guard was
added as a workaround (protects comptime-generic SomeT params like a
`comptime(x) : T` from over-conversion — and the sibling `!pt_is_comptime`
protects the `fn(comptime_int,comptime_int)` overload for `3 > 4`), but it also
catches runtime-generic SomeT params it shouldn't.

**Faithful fix (a dedicated port, NOT a tail change):** track the per-param
comptime modifier and thread it to `is_ct_only`, then change the `helper.yo:531`
guard to TS's shape (`!is_ct_only && is_comptime_only_type(arg)`). To avoid the
`_patch_self_shell` exponential-walk hazard of adding a field to the hot
`FuncMeta`, store it in a func-id-keyed side-table (the established pattern —
cf. the default-args side-table). Populate it during function-type evaluation
(where the `comptime(x)` param modifier is parsed) and read it at helper.yo:3029.
Full battery + STRICT_FIXPOINT mandatory (this is the arg-binding hot path for
every generic call). Do NOT remove `!is_some_type` alone — that over-converts
comptime-generic SomeT params (breaks `comptime(x) : T` and, without the
`param_is_comptime` distinction, cannot tell them apart from `neg`'s `self`).

## Landscape note (why 0 files flip from the void\* work)

The remaining #69 red files are ALL deep multi-error Gap-6. The void\* SomeT
fallback appears in several DIFFERENT shapes — none share one fix:

- concrete FN return + abstract return-expr → void\* temp (THIS fix; comptime f32 neg).
- `void*` FN RETURN TYPE (unresolved) + concrete body (`ref_closure_capture`:
  "returning \_\_yo_t30 from void\*") — the function type itself is unresolved.
- `void*` TARGET ← concrete struct (`impl_fn_field_rejection`: "initializing
  void* with \_\_yo_t33") — a field/param typed void*.
- `__yo_io_future_t*` future fallback (async cluster) — see
  `yo-self-async-emission-cluster.md`.
  Plus the `__yo_tX vs __yo_tY` per-call-identity cluster (arc, linked*list,
  imm*_, thread, worker, cli) and the `undeclared yo_id_N` collection cluster
  (sync/_, imm_map/set, ordered_map). Each is its own Gap-6 manifestation.
