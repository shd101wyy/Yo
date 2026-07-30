# yo-self: call-site where-clause validation (the missing-validation family root)

Status: FIXED (2026-07-30 round). Flipped `tests/inherent_first_resolution.test.yo`
HOLLOW → GREEN with zero regressions (TIER 1 + TIER 2 + 185-file sweep).

## Symptom

yo-self accepted calls whose where-clause constraints a concrete argument type
does not satisfy — every one a `comptime_expect_error` that "saw no error" and
hollowed its file:

```rust
MyTrait :: trait(foo : (fn(self : Self) -> i32));
g :: (fn(generic(T : Type), x : T, where(T <: MyTrait)) -> bool)(true);
r := g(i32(5));                 // TS: "Type i32 does not implement required trait MyTrait."  s1: accepted

s := String.from("hi");
r2 := s.starts_with(i32(5));    // TS: "Type i32 does not implement required trait Pattern."  s1: accepted
```

## Root cause chain (four fixes, one round — each was measured)

1. **`validate_where_constraints_for_call` was gated to MARKER traits only**
   (traits with no function-typed fields). The June narrowing was real: widening
   it naively regresses `check ./std` to 151/153, because the side table stores
   the constraint trait in EVALUATED form — `K <: Eq(K)` is stored as
   `Eq(K‑SomeT)`, which no concrete type can match. **Fix: register the
   where-clause EXPRESSIONS per func_id** (`g_func_where_clause_exprs`,
   types/function.yo — same two-step re-keying as the contracts tables) and
   RE-EVALUATE them in the bound callee env at every call
   (`reapply_where_clause_exprs_for_call`, calls/helper.yo Step 8b + the inline
   FuncVal arm) — the faithful port of TS re-applying
   `functionType.whereClauseExprs` (helper.ts:1515-1530). `Eq(K)` with `K=String`
   then evaluates to `Eq(String)` and the concrete-LHS branch of
   `parse_where_clause_constraints` validates it.

2. **`check` directory sweeps forked the type universe.** `check_single_file`
   REPLACED `g_cached_prelude_env` when the sweep reached `std/prelude.yo` as a
   target file (position 37 of 153): every later file cloned the NEW prelude
   (fresh FuncVal/trait ids) while demand-loaded modules stayed cached from the
   OLD lineage, so `Eq(K)` (new lineage, `yo_id_12931`) minted a trait id no
   OLD-lineage impl ever registered (`__DBG` probes: query `trait_yo_id_16511`
   vs String-84261's registered 4404-era ids). std/assert.yo and
   std/encoding/html_entities.yo failed ORDER-DEPENDENTLY (each passed alone).
   **Fix: populate-once** (`if(g_cached_prelude_env.is_none(), ...)`,
   main.yo) — the documented intent of the cache.

3. **The generic-impl registry was keyed by the per-instantiation trait id.**
   `impl(generic(T), where(T <: Eq(T)), Box(T), Eq(Box(T))(...))` registered
   under `Eq(Box(T))`'s minted id; the query `Box(i32) <: Eq(Box(i32))` carries
   a different minted id → no bucket → "does not implement" (pre-existing —
   baseline s1 rejects the same def-time where clause; only exposed by fix 1;
   regressed hash_map/hash_set/imm_vec GREEN→HOLLOW until fixed). TS keys by
   the trait CONSTRUCTOR's funcId (`getBaseTraitKey`, impl.ts:1042-1050, via
   `returnedType.functionValue` stamped in comptime-fn.ts:266-276). **Fix:**
   `register_trait_ctor_fid`/`lookup_trait_ctor_fid` side table (expr_info.yo,
   stamped in comptime_fn.yo on TraitT returns, first-wins) +
   `get_base_trait_key` (values/impl.yo) used at generic-impl registration,
   `find_matching_generic_impl`, and property_access's trait-witness filter.
   Negative-impl and concrete registries keep `get_trait_key` (TS keeps
   `traitType.id` there).

4. **The specialization cache lived on the per-file `EvalContext`.** TS keeps
   `specializedFunctionCaches` ON the FunctionValue object — process-wide via
   the module cache. Per-ctx storage re-specialized prelude comptime fns per
   checked file. **Fix: module-global `g_specialized_fn_caches`**
   (calls/helper.yo), keyed by func_id; the `EvalContext` field was removed.

### The inline-arm guard

yo-self has a call path TS does not (the inline FuncVal arm in
calls/function.yo). On a spec-cache-hit reuse, the forall params are NOT
re-bound as TypeVals in `fresh_env`, and running the re-application there threw
a spurious `Expected type for left-hand side of where clause constraint, got
variable "U"` (second `zip_with` call — `tests/imm_vec` went hollow, found by
subset-bisect to the arm PAIR 27+28; every arm was clean standalone).
`reapply_where_clause_exprs_for_call` therefore guards: skip when an atom LHS
is bound to a non-type value (adapted from TS's own early-apply guard,
helper.ts:1375-1393). An UNBOUND LHS still re-applies (the parse creates a
fresh SomeT, as TS does).

## Verification

- `tests/inherent_first_resolution.test.yo` HOLLOW → GREEN (markers 1 → 0).
- hash_map / hash_set / imm_vec stay GREEN (each regressed at an intermediate
  state and was root-caused, not narrowed around).
- `check ./std` 153/153, corpus PASS 148 / DIFF 0, stage2 markers = 1
  (the known `unwind()` marker), STRICT_FIXPOINT holds.
- Repro set: wc1 (user trait), wc2 (`P <: Pattern`), ifr (`starts_with(i32)`)
  all REJECTED; boxeq (`Box(i32) <: Eq(Box(i32))`), hm1
  (`HashMap(Box(i32), …)`), two-`zip_with` module repro all ACCEPTED.

## Notes for later rounds

- `evaluator/values/generic_impl_registry.yo` is imported by NOBODY — dead
  legacy duplicate of the registry in values/impl.yo (left untouched).
- The trait-check recursion guard key uses `_trait_type_id(target)`, which is
  `""` for struct targets (TS uses `targetType.id`) — latent collision risk,
  not touched this round.
- TS stamps `functionValue` on enum/union/namespace comptime-fn returns too;
  yo-self stamps structs (pre-existing) and now traits. Enums may need the same
  treatment if an enum-parameterized generic-impl key ever misses.
