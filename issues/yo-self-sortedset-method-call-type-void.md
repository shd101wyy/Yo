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
