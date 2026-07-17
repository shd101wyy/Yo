# yo-self: `SortedSet(i32).new().is_empty()` call-result type lost → assert specialized with `void flag`

Status: OPEN — 9-line differential isolated 2026-07-17. One of the two
remaining big #69/#70 emission layers (the other: struct-mismatch t42/t49
in arc/hash_map batches).

## Repro (src/tests/fixme.yo shape; TS prints ok, s1 emits 7 clang errors)

```rust
open(import("std/string"));
open(import("std/fmt"));
{ assert } :: import("std/assert");
{ SortedSet } :: import("std/imm/sorted_set");
main :: (fn() -> unit)({
  s := SortedSet(i32).new();
  assert(s.is_empty(), "new set should be empty");
  println(`ok`);
});
export(main);
```

s1's emitted C declares the assert specialization as
`static inline void yo_id_5002_str_id_str_rtparam1_comptime_str_ret_unit(void flag, __yo_str msg);`
— the `flag` param typed VOID and contributing NO signature segment: the
`s.is_empty()` call's RESULT TYPE was missing at the assert call's
specialization time.

## Context

- `SortedSet(T)` methods come from a specific-pattern generic impl WITH a
  where clause: `impl(forall(T), where(T <: (Eq(T), Ord(T), Send)),
SortedSet(T), is_empty : (fn(self : Self) -> bool)(...))`
  (std/imm/sorted_set.yo:28-39). Resolution path:
  `_try_find_receiver_method` → `get_receiver_methods_by_name_from_env` →
  generic-impl fallback → `find_methods_from_generic_impls` →
  `try_match_generic_impl` (base-name prefilter now admits
  `SortedSet(T)` vs `SortedSet(i32)`; where-clauses on specific patterns
  are SKIPPED by design) → candidate method type substituted via
  `substitute(spec_s, ftype)`.
- The class predates this session's resolution fixes (round-1
  async_await already showed void-param leftovers), but files now reach
  it after the earlier layers were fixed.

## Probe result (2026-07-17, [RMETH] in \_try_find_receiver_method)

`is_empty hits=1 is_fn_ty=true has_val=true` printed TWICE (def-trial +
executing) — resolution SUCCEEDS with a function-typed candidate carrying
a value. And the INNER `self._inner.is_empty()` (SortedMap) lookup never
fires — the method-body specialization dies BEFORE reaching it, swallowed
by the def-eval wall; the call expr then has no ExprInfo type → codegen
FTTs the assert flag to void. Next hop: probe the FuncVal-arm call path
(evaluate_function_call → try_to_call_function_with_arguments) for what
throws when calling the SortedSet(i32).is_empty candidate — likely the
`Self`-bound param unification or the impl forall-capture injection
(`_inject_forall_captures`) for the where-clause pattern impl.

## Second probe result ([SNEW] in \_try_find_receiver_method, static branch)

ZERO prints for `new` — `SortedSet(i32).new()` / `SortedMap(T,bool).new()`
do NOT resolve through `_try_find_receiver_method` at all. The static
`Type.new` member resolves in the PROPERTY-ACCESS path
(evaluator/exprs/property_access.yo — the TypeVal-receiver / registry
branches around :213 and :899, or a helper it calls), and the unit-typed
result comes from there. Next hop: probe evaluate_property_access's
TypeVal-receiver branch for member `new` on an instantiated generic
(what info/value it stamps), then compare with TS property-access static
member resolution (src/evaluator/exprs/property-access.ts).

## Sharpened hypothesis (read property_access fallthrough + TTERR chain)

The OUTER `SortedSet(i32).new()` resolves and its body RUNS (the `_inner`
member-mismatch TTERR is thrown from inside it at exec time). The INNER
`SortedMap(T, bool).new()` evaluates to unit WITHOUT reaching
`_try_find_receiver_method` (no [SNEW] print even for a hits=0 miss) and
without the property-access static branch stamping anything (its
fallthrough returns unstamped). Prime suspect: **stale def-time trial
ExprInfo** — yo-self keys ExprInfo by ast_expr_id (TS uses per-object
`expr.$`), so if the impl-method BODY is trial-evaluated at def time
WITHOUT `clone_expr_fresh_ids` and the trial stamps the inner call node
with a unit/failed info, the EXEC-phase specialization (if it reuses the
same node ids) reads the stale unit info from the table and never
re-dispatches. Check: does the specialization path that evaluates
SortedSet's impl `new` body clone with fresh ids
(create_specialized_function_inline / \_trial_eval_fn_body callers)? Then
probe expr_info_table_get on the inner call node id at exec time.

## Route CONFIRMED + first fix attempt failed (2026-07-17)

[PAENT]/[PANEW] probes: property access RUNS on `.new` (20×) but the
assoc-type helper branches never fire — the resolution happens in the
struct-TypeVal branch (property_access.yo:817+): field-label miss →
`find_methods_from_generic_impls(type_val_inner, "new", env)` → exactly-1
candidate → stamps `method_type`/`method_value` and returns. The
candidate's `fn() -> Self` keeps `Self` ABSTRACT (the substitution map
carries only the impl foralls), so the call records unit — the confirmed
root of the whole chain. FIRST FIX ATTEMPT (reverted): appending
`_substitute_self_in_method_ty(substitute(spec_s, ftype), resolved)` in
the candidate construction (helpers moved above MethodCandidate — Yo has
no forward refs). Result: 9-line repro DETERMINISTICALLY still fails (6
clang errors, exit segv 139) — plain substitution of Self with the
recursive concrete receiver is not equivalent to TS's
`reEvaluateFunctionType` (impl.ts:1484 region), which RE-EVALUATES the
method's fn-type expression in an env where Self/foralls are BOUND.
Next attempt should mirror reEvaluateFunctionType properly (evaluate the
stored fn-type expr under a pushed frame binding Self + forall names),
or investigate why the substituted return type still miscompiles (check
what the 6 errors are before designing further).

## TS-shape analysis (impl.ts:91-175 reEvaluateFunctionType)

TS re-evaluates each param/return TYPE EXPRESSION in (fn-type definition
env + substitution frame) with **SelfType passed via CONTEXT** — `Self`
resolves through `context.SelfType`, not through a substitution map.
yo-self's `Func` meta does not retain the type exprs, so a literal mirror
isn't a drop-in; the equivalent lever is `ctx.self_type` AT CALL TIME.
And there's the likely real gap: `create_specialized_function_inline`
sets `ctx.self_type` from the RECEIVER ARGUMENT — `params[0] == "self"`
— which STATIC calls like `.new()` don't have, so the body's `Self(...)`
ctor and the `-> Self` return stay abstract exactly on the static route.
`_static_dot_receiver_self_type` (calls/function.yo) exists for this but
may not run on the property-access-stamped candidate route. NEXT PROBE:
log `ctx.self_type.is_some()` at create_specialized_function_inline entry
for the inner `SortedMap(T,bool).new()` call, and whether
`_static_dot_receiver_self_type` fires for it; if not, thread the
receiver TypeVal's inner type into ctx.self_type for statically-stamped
dot-callees (the TS `context.SelfType = dereferencedReceiverType`
equivalent).

## Implementation plan for the fix (next cycle)

Mirror the CTFE-route Self binding (calls/function.yo:3330-3346 — saves
ctx.self_type, sets it from `_static_dot_receiver_self_type(func_expr,
ctx)`, restores after) on the RUNTIME FuncVal-arm call path: the arm
already computes `recv_type_args` from the same helper (:3006-3016) but
never SETS ctx.self_type, so a static `.new()`'s body/spec evaluation
(create_specialized_function_inline sets self_type only from a `self`
ARGUMENT, which static calls lack) runs with Self abstract. Insertion:
wrap the arm's body-eval/`create_specialized_function_inline` invocation
(after the where-constraint validation at ~:3227) with the same
save/set/restore. Gate on the 9-line SortedSet repro + tk2 + Counter +
corpus + std + fixpoint.

## Second fix attempt failed (static-Self in \_evaluate_funcval_runtime_call)

Adding Self-substitution (via \_static_dot_receiver_self_type) to the
runtime-return path's resolved_ret did NOT change the repro (2 FTTs
persist) — so the failing call does NOT flow through
`_evaluate_funcval_runtime_call` at all. Combined with the `_inner`
member-mismatch TTERR firing from BODY evaluation (the runtime path never
executes bodies), the call must route through a body-evaluating path:
either the CTFE gate (`is_type_hierarchy_type(ret)` — no — or
`callee_result_is_comptime`), or a def-time body validation
(check_deferred_generic_return_type / the def-eval trial of the
specialized candidate). NEXT PROBE (route census): print a marker in (a)
\_evaluate_funcval_runtime_call entry, (b) the CTFE-route entry, (c) the
FuncVal-arm inline body eval, (d) check_deferred_generic_return_type —
each gated on the callee being a dot-call whose member is `new` — run the
9-line repro, read which routes fire and in what order. Reverted;
attempts so far each disprove one route.

## Route census results + the REAL question (2026-07-17 late)

- [ROUTE]: all 12 `.new` dot-calls take `_evaluate_funcval_runtime_call`.
- ret_somes=[] and static_recv=true — the declared return has NO SomeTs.
- [STAMP]: the property-access candidate's Func result is NOT unit and
  IS a function type — i.e., THE TYPE FLOW IS HEALTHY at both phases.
- Yet codegen emits FTT because `get_expr_info(call node)` is `.None`
  (codegen/exprs/generation.yo:407-414) — the runtime path DID stamp
  `expr` (function.yo `out_rt` → expr_info_table_set on the call node).

So the remaining question is an ExprInfo TABLE-IDENTITY mismatch: the
node ids codegen walks (from main's registered FuncVal body) differ from
the ids the successful evaluation stamped — a def-time-trial vs exec-eval
vs registration cloning mismatch (yo-self's id-keyed table vs TS's
per-object expr.$ again). NEXT PROBE: at the codegen FTT site, print the
missing node's ast_expr_id; at the runtime-call stamp site, print
ast_expr_id(expr) for `.new` calls; compare. Then find which copy of
main's body got registered vs evaluated (evaluate module-level fn
binding → FuncVal body field vs the def-time trial clone vs the exec
walk).

## FINAL LOCALIZATION (2026-07-17, id probes)

12 [STAMPID] prints, ZERO [FTTID] at the missing-info site — the info IS
stamped; the FTT comes from generation.yo's SECOND site (:591):
`generate_other_function_call(...)` returned `.None` for the call. This
is the KNOWN Gap-6 remainder, called out verbatim in
`_evaluate_funcval_runtime_call`'s specialization block comment
("Method-chain generics ... still hit the upstream soft-fallback-to-unit
inside create_specialized — that's the deeper Gap-6 evaluator work"):
the codegen-time monomorphization of the generic-impl method
(`create_specialized_function_inline` on SortedSet(T).new with T=i32)
soft-fails while evaluating the specialized BODY — the def-time
`Type mismatch for type member "_inner": Got unit` TTERR is THAT body
eval failing on the nested `SortedMap(T, bool).new()` (static call,
no `self` arg → `spec_self_set` stays false → Self/nested resolution
degrades). SCOPE: this is the deep Gap-6 specialization work — a
dedicated session on create_specialized_function_inline's static-method
self/forall threading and its nested-call recursion, not a spot fix.
All shallower routes (resolution, candidate typing, runtime-path return
resolution, ExprInfo identity) are now PROBED HEALTHY and eliminated.

## Hunt plan

Probe `find_methods_from_generic_impls`' candidate for `is_empty` on
`SortedSet(i32)` (the [FMGI]/[TMGI] pattern from the session — NEVER
inside `->` handlers): print the substituted `method_type`. Expected
`fn(self : SortedSet(i32)) -> bool`; suspicion: the substitution leaves
`Self`/return unresolved (bool is fine — more likely `self`'s type or the
whole Func meta), or the CALL path discards the candidate's type and
re-derives from a FuncVal that carries none (`FuncVal values carry no
type` — the known reconstruction gap), leaving the call expr's ExprInfo
type unit. Then compare with TS `findMethodsFromGenericImpls`'
`shouldCreateSpecializedValue` / type-only-specialization flow
(impl.ts:1337-1392) for where the type is preserved.
