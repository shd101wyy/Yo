# Gap-6 attempt #7: ctor-memo reconciliation at signature re-resolution (REVERTED — dyn identity + multi-canonical anomaly)

**Status: REVERTED 2026-07-22** per the gates rule (corpus regressions), but
this attempt got the FLAGSHIP REPRO FULLY GREEN and produced the sharpest
map of the family yet. Read this before attempt #8.

## The flagship repro (KEEP — 12 lines, exercises the whole family)

`/tmp/yo_gap6_list.yo` (recreate: std/imm/list List(i32) new+prepend×3+len+
head+tail+asserts+println, `main :: (fn() -> unit)`, `export(main)`).
TS: `ok 3`. Committed-tree s2: 3 clang errors —
`passing '__yo_t1' to parameter of incompatible type '__yo_t7'` — the
imm\_\*/collections class in miniature.

## Probe-verified mechanism of the split (NEW ground truth)

1. `[CTFE]`/`[CTFERES]` probes in `evaluate_comptime_fn_call`
   (evaluator/calls/comptime_fn.yo): the `should_cache=false` gate (slice 2b:
   any TYPE arg containing SomeTs skips the memo) makes EVERY def-time /
   validation-generation instantiation of `List(T)` / `ListNode(T)` mint a
   FRESH struct id (~15 instances per compile: 4942, 4948, 4953, 4955, 4981,
   4995, …). The CONCRETE calls (`args=int`, sc=true) mint the canonical pair
   `List(i32)=5100` / `ListNode(i32)=5102` — memoized correctly.
2. The IMPL PATTERN instance (`List(T#1972)` = 4953, from the impl's
   def-time eval) LEAKS into user code: main's `xs` C type was 4953 while
   `prepend`'s spec body built values from the concrete 5102 lineage — one
   expression mixing both (the clang error site). The pattern instance
   arrives through impl-candidate `Self` (env-bound to the pattern-era
   instantiation) at spec-signature construction:
   `spec_result := evaluate_function_return_type_again(sp_res_b, callee_env)`
   (helper.yo:1795) returns 4953 with `type_arguments=[T#1972:unres]` — yet
   `[SPECARG]` proved `get_value_of_some_type_from_env(callee_env, T#1972)
= int`. The SomeT lives ONLY in the struct's `type_arguments` metadata,
   which `get_all_some_types` does NOT walk — so no existing resolution path
   ever concretizes it.
3. In TS none of this arises: the CTFE cache lives ON the FunctionValue
   (object identity; TS `shouldCache = isTypeHierarchyType(return)` ONLY —
   no some-containing-arg skip — abstract instantiations are memoized per
   SomeType-id too), and TS "substitution" re-evaluates type EXPRESSIONS
   through that cache, so signature-side and body-side always converge on
   the same type object.

## What was built (all reverted; reproducible from this description)

- `types/substitution.yo`: injected `CtorMemoLookupFn` indirection
  (`set_ctor_memo_lookup` / `ctor_memo_canonical`), wired on first CTFE call
  from comptime_fn.yo (`_ctor_memo_lookup_impl`: bucket by ctor fid, args
  compared via `_ctfe_args_equal` on `TypeVal`-wrapped type args, resolved
  entries only via `_resolved_type_of`).
- `evaluator/types/function.yo`: `_reconcile_resolved_struct_from_env(t, env)`
  — for a ctor-stamped struct, resolve each `type_arguments` SomeT (own cell,
  then env), and when fully concrete swap to `ctor_memo_canonical(...)`.
  Applied at ALL FOUR exits of `_resolve_some_types_deep` (the
  `evaluate_function_{parameter,return}_type_again` engine). NOTE: the
  crucial exit is the `get_all_some_types(ty).len()==0 → return(ty)` one —
  the pattern-era instance has NO walkable SomeTs.

**RESULT: the flagship repro compiled AND ran (`ok 3`, 0 errors).**

## Why it was reverted — two failure modes (both probe-verified)

1. **dyn identity correlation** (corpus `dyn_dispatch_autobox_value`,
   `dyn_error_throw_ioerror`; with the substitute()-arm variant also
   `closure_param_capture`, `dyn_fn_field`, `dyn_fn_same_sig_closures`):
   ONE swap (`[SWAP] cfid=yo_id_2743 (prelude Box) old=2746 new=2942
had_some=false`) breaks the auto-box chain — output `0x00` instead of
   `'Q'` (box data reads zeros). The dyn box/typeid/vtable registrations key
   off a specific instance id; canonicalizing the signature side de-correlates
   them. `had_some=false` (already-concrete instance swapped by pure memo
   preference) is exactly the poisonous case here.
2. **Guarding on had_some breaks the fix**: requiring "at least one tyarg
   was an unresolved SomeT" (attempted twice, incl. the first
   substitution.yo-arm variant) re-broke the repro (t1/t7 back) — the List
   family NEEDS the had_some=false swaps too (concrete-but-noncanonical
   instances flow through signatures).
3. **Multi-canonical anomaly** (the deepest finding): in the repro compile,
   `[SWAP]` showed the SAME old ArrayList instance (`old=struct_yo_id_3049`,
   ctor `yo_id_3044`) swapping to THREE different "canonicals" (3214 ×244,
   3259 ×14, 3761 ×10) — the memo holds multiple entries whose args all
   match 3049's resolved tyargs, and first-match depends on call context.
   Post-hoc id-level canonicalization is therefore not just risky for dyn —
   it is ill-defined: the memo itself contains duplicate-keyed entries
   (likely `_ctfe_args_equal`'s struct-id fast path vs structural fallback
   admitting several u8-arg instantiations).

## Direction for attempt #8 (do NOT re-run #7 with more guards)

Fix the CREATION side, not the consumption side:

- **(a) Impl-candidate `Self` should be the RECEIVER instance** (TS:
  `context.SelfType = dereferencedReceiverType`), not
  substitute(pattern-instance). The receiver at main's call IS canonical
  5100; every spec signature derived from it would be canonical natively.
  The machinery partially exists (`_static_dot_receiver_self_type`,
  ctx.self_type save/set/restore in calls/function.yo ~:1360); the gap is
  that `evaluate_function_return_type_again` resolves `Self` through the
  ENV (pattern-era binding from `_inject_forall_captures`) rather than
  ctx.self_type.
- **(b) De-duplicate the memo**: investigate why `_ctfe_args_equal` admits
  multiple ArrayList(u8)-shaped entries (the ×3-canonical anomaly) — fixing
  THAT may be prerequisite to any memo-based approach and could fix
  cross-module unification failures on its own.
- **(c) The `should_cache=false` gate divergence** (slice 2b vs TS's
  cache-everything): TS memoizes abstract instantiations keyed by SomeType
  id. Porting that faithfully would collapse the ~15 def-time instances to
  ~1 per (ctor × T-instance) and shrink the split surface, but slice 2b
  exists because yo-self's placeholder entries once leaked to codegen —
  re-attempt only with the comparator fixed (b).

Gate battery used here: flagship repro + corpus (`YO_SELF_BIN=... 
scripts/diff-test.sh tests/codegen-bootstrap --parallel 4`, baseline
PASS 139 / DIFF 1) + `check ./std`. The dyn corpus files are the canaries
for any identity-touching change.
