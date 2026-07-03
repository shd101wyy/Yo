# yo-self stage-2 fixpoint — error-distribution roadmap

**Goal:** yo-self self-compiles into a _valid_ working compiler (stage-2 C compiles
clean) AND matches TS performance. Perf half already met on `check ./std` (-O2: 10.9s
vs TS 19.9s); the blocker is **stage-2 C validity**.

**UPDATE (commit `4d9b447b0`): 1088 → 885 errors (−203).** Fixed the early-return-cleanup
"drop a not-yet-declared C var" class (user vars: label*sub/value_sub/env/…, 156 sites + temp
escape-drops + cascades). Root: a `x := match(...)`/`cond(...)` binding emits its C declaration
AFTER the RHS switch, so a `throw` inside the RHS precedes x's declaration; TS's return.ts filter
relies on each expr's point-in-time env having `initializedAtToken` unset for the in-flight
binding, but yo-self's recorded env is the END-of-scope env, so its `_keep_pending_drop` used a
SOURCE-ORDER token heuristic that can't see RHS-after-declaration order. Fix: use C-emission
order as ground truth — `declared_c_var_names` is now reset per function + seeded with params in
`generate_function`, grows as each declaration emits, and `_keep_pending_drop` skips a pending
drop whose target C name isn't declared yet (can't double-free/leak: no C value bound). undeclared
612→409, incompat/member unchanged. corpus 97/97 (DIFF 0, SELF-FAIL 0), std 152/152. Remaining 885
distribution: undeclared 409 (266 `g*\*`module globals + 92 local-var stragglers + 39 temps + 15`fn_yo_id` effect handlers), incompat 211, member 95. The two dominant remaining classes — the
266 module globals (module-var port) and 211 incompat — BOTH gate on the type-identity keystone.
Session trajectory: 3643 → 1627 → 1312 → 1189 → 1088 → 885.

**UPDATE (commit `9c9c7d870`): 1189 → 1088 errors (−101).** Landed the temp-drop fix
(READY-TO-EXECUTE DESIGN below, now DONE): `CodeGenContext.declared_c_var_names` records every
declared C variable name at the `get_variable_type_string` choke-point, and
`generate_deferred_drop_expressions` skips a deferred drop whose target is a temp name
(`is_temp_variable_name`) never declared. undeclared 707→612, undeclared-temp 183→85. corpus
97/97, std 152/152; plain corpus binaries terminate with matching TS output. (ASan run deadlocks
against the runtime's custom worker-thread stack — pre-existing, unrelated; safety is by
construction: skipping a drop of a never-emitted C var can't double-free or leak.) Session
trajectory: 3643 → 1627 → 1312 → 1189 → 1088.

**UPDATE (commit `fcb5b667d`): 1312 → 1189 errors (−123).** Fixed the dominant type-identity
root: `compute_compile_time_signature` keyed runtime params by the LOSSY `type_to_string`
(`ArrayList(bool)` and `ArrayList(String)` both → `<struct:struct_yo_id_3849>`), collapsing every
`ArrayList(T).get/set/push` onto ONE specialized func_id → all element types shared one C function
with whichever `T` registered first → "incompatible type". Fix: `_param_type_sig` appends the
struct's `type_arguments` recursively (NOT enum variant_fields — that explodes on the compiler's
recursive enums). incompat 300→206→177 (this commit brought it to 206; a later re-measure shows
177). Residual type-identity: same-base-id generic-ENUM instantiations over different args still
collide (enum recursion omitted to avoid the specialization explosion) — a smaller sub-case.
Session trajectory: 3643 → 1627 → 1312 → 1189. corpus 97/97, check ./std 152/152.

**PIVOTAL NEGATIVE RESULT (6th+7th approaches): the specialization cache is a RED HERRING for
incompat — distinguishing MORE makes it WORSE.** The spec cache compares compile-time TypeVal args
via `eval_value_eq` → lenient `are_types_compatible` (empty-name fast path). I changed that
comparison to (6) `are_types_compatible_exact` → incompat 206→**215**; and (7) `type_key` equality
→ incompat 206→**217** (and s-2 C ballooned 40MB→53MB: type_key is STATEFUL — mutates/reads
g_struct_cfid_keys order-dependently — so calling it per cache-comparison in the evaluator phase
thrashes → over-specialization). BOTH corpus 97/97 + std 152/152, both reverted. The lesson: the
lenient baseline (206) is OPTIMAL among cache-comparison choices; making the evaluator distinguish
generic instantiations MORE just mints more specialized functions, each of which re-exposes the
CODEGEN type-identity inconsistency → net MORE incompat. So the `with_capacity` collapse was
MASKING codegen bugs (fewer specializations = fewer inconsistency sites), not causing the incompat.
DEFINITIVE REDIRECT: the ~206 incompat are NOT fixable from the evaluator (specialization / cache /
spec-sig — 7 approaches now exhausted). The fix is in CODEGEN `type_key`'s handling of
generic-instantiation structs whose `constructor_func_id` is empty and whose `id` churns across
instantiations — it falls back to the raw churning `id` (index.yo `.Struct` arm, the
`(sid.len() > 0) => g_struct_cfid_keys.get(sid) or sid` branch), emitting DIFFERENT C names for the
same logical type. Make that fallback key by structural content (fields + cfid) so same-logical-type
instantiations share ONE C name. That single codegen fix should cut the 206 incompat AND unblock the
266 module-globals (same root). This is the true, precisely-located blocker.

**FOURTH incompat approach RULED OUT (reverted): `ctx.self_type` cache key.** Same machinery as
the third (new `SpecializedFunctionCache.spec_self_key` field + find/store threading + func_id
suffix) but keyed by `ctx.self_type` (which function.yo:1097 sets to the concrete static-dot
receiver BEFORE `create_specialized_function_inline`), gated on `type_contains_some_type(result)`.
Built 71s, corpus 97/97, std 152/152 — but incompat 206→206 AGAIN, total 880, IDENTICAL to the
third attempt. That identical result is the tell: the shared gate `type_contains_some_type(result)`
is almost certainly FALSE for `with_capacity`-style functions at that point (so neither approach
ever engaged — `Self`/the impl-return type isn't a `SomeT` variant there), OR `ctx.self_type` is
not the concrete receiver on `with_capacity`'s actual dispatch path. FIVE approaches now ruled out
(hand-mirror ×2 over-distinguish; shared-type_key isolates type_key as irrelevant; return-type &
self_type cache keys both no-op/un-engaged). CONCLUSION HARDENED: localized spec-cache-key tweaks
do NOT reach this — the fix must be at the METHOD-DISPATCH level, threading the impl/type-path type
args (K,V) as actual forall/compile-time args into the call's `arg_values.forall_args` so they land
in `compile_time_arg_values` (already a cache key) naturally. Next session: instrument the
`with_capacity` dispatch (function.yo method-call path) to see where K/V are known and why they
aren't passed as forall args; that is the true root, in the arg-binding of method resolution.

**THIRD incompat approach RULED OUT (reverted): resolved-return-type cache key.** Added
`SpecializedFunctionCache.resolved_return_type` + keyed the spec cache AND the specialized
func_id by `evaluate_function_return_type_again(result, callee_env, ctx)` (gated on
`type_contains_some_type` for perf; find+store threaded identically so no re-spec loop; built in
72s, corpus 97/97, std 152, check ./std 31s @ -O0). Result: incompat 206→206 (UNCHANGED), total
882→880. ROOT of the no-op: at the cache-lookup point `callee_env` does NOT yet have the concrete
element type `V` bound — that binding happens DURING specialization, AFTER the lookup — so the
"resolved" return type is still generic/`Self`, identical across the collapsing cases. DEFINITIVE
CONCLUSION (3 approaches ruled out: hand-mirror ×2 over-distinguished; return-type-cache no-op):
the 206 incompat REQUIRE the faithful fix — thread the impl-level/`Self` type params as
COMPILE-TIME (forall) args at method-call specialization, so they land in BOTH `callee_env` and
`compile_time_arg_values` (which the cache already keys on) BEFORE the lookup. That is a deep
change in the method-dispatch → specialization arg-binding path (how a method resolved on
`HashMap(K,V)` passes K/V as comptime args to the method's specialization). See memory
yo-self-parametric-trait-impl-self-subst / "impl-level forall not bound in FN-REG-BODY".

**PRECISE ROOT CAUSE of the ~206 incompat (traced @ 882, corrects the "codegen-side" label
below).** The incompat is NOT codegen type_key and NOT the runtime-param spec-sig. It is that
`compute_compile_time_signature` OMITS the `Self` / impl-level element type for generic METHODS.
Concrete case: `yo_id_13320` is a `with_capacity(n : usize) -> Self`-style method (returns
`enum_13319< gs_13298<String, V>, … >`). Its specialization signature is just `rtparam0_usize`
(the ONLY runtime param is the `usize` capacity; its forall segment is EMPTY because the element
type `V` is an impl-level/Self type param, NOT in this function's `func_type.meta.forall_labels`).
So `with_capacity` for `V=DynImplEntry` (struct_298507), `V=CapturedVariable` (struct_224375),
`V=ArrayStructInfo` (298505), `V=CodegenExternFnEntry` (298498)… ALL collapse onto ONE emitted
function `yo_id_13320_rtparam0_usize` whose return type is baked to whichever `V` registered first
(224375) → assigning its result to a `V=DynImplEntry` slot = "incompatible type". This is why the
shared-type_key change barely moved incompat (the runtime-param segment is `usize` for all — type_key
doesn't enter it). FIX DIRECTION (deep, evaluator-side, RISKY — validate hard): the sig must
capture the Self / impl-level type args. Either (a) propagate the impl block's forall params into
each method's `func_type.meta.forall_labels` at method registration (so the existing forall loop in
compute_compile_time_signature picks them up — see memory yo-self-parametric-trait-impl-self-subst /
"impl-level forall not bound in FN-REG-BODY"), or (b) thread the resolved `Self` type into
compute_compile_time_signature and append `type_key(self_type)` to the sig. History: this is the
same `with_capacity Bucket(K,V)` lever as the (completed) task #28; the method-sig omission is the
residual. Both hand-mirror attempts and the shared-type_key extraction were necessary to RULE OUT
type_key and localize it here.

**UPDATE (commit `1f23934c3`): 885 → 882 errors (−3); type_key SHARED (spec-sig red herring ruled out).** Extracted the
type*key cluster into shared `types/type_key.yo` (verbatim; codegen re-exports it, no import
cycle — types/ is below both layers, and Yo re-exports imported names fine) and replaced the
evaluator's `_param_type_sig` hand-mirror with a direct `type_key(ptype)` call. corpus 97/97
(DIFF 0), std 152/152. CRITICAL FINDING: using codegen's ACTUAL type_key moved incompat only
211→206 — so the ~206 incompatible-type errors are NOT caused by the specialization signature
(that hypothesis is now DISPROVEN; the spec-sig aligns perfectly with codegen and it barely
matters). The 206 are CODEGEN-SIDE type_key inconsistency: type_key's recursive expansion emits
DIFFERENT C type names for two instantiations that should share one C type (raw errors show
`...gs_yo_id_A_struct_yo_id_B` vs a sibling with different inner ids — a type's declaration
C-name diverging from its use-site C-name). This is the SAME generic-instantiation identity
family as the module-var-port cascade (266 g*\* globals) — see memories struct-identity cache
collision / comptime-fn cache / phase3-hashmap-new-blocker. NEXT: fix type_key (now in ONE shared
place) so same-logical-type generic instantiations with differing inner eval-ids collapse to one
key — that single fix should cut BOTH the 206 incompat AND unblock the 266-global module-var port.
Session trajectory: 3643 → 1627 → 1312 → 1189 → 1088 → 885 → 882.

RESIDUAL type-identity (211 incompat @ 885) — TWO hand-mirror attempts now REVERTED, both made
incompat WORSE (over-distinguish):
(1) type_intern_key sig (injective): 1189→1185 total but incompat 177→203.
(2) `_param_type_sig` enum branch mirroring type_key's structural sig (variant names +
discriminants + visited-guarded field recursion): built fine (72s, NO explosion — the
visited guard works), corpus 97/97 + std 152, but incompat 211→258, total 885→937. ROOT of
the drift: `ref(enum(...))` types (TypeValue/AstExpr) — codegen type_key keys them by ID
(index.yo:863 `if(e_is_ref, key, {structural})`) and also applies `resolve_enum_shell` +
the `g_enum_sig_keys` dedup; a partial mirror lacks all three → different merging than
codegen → extra mismatching func_ids.
LESSON (now empirically confirmed twice): a partial hand-mirror of type_key DRIFTS and
over-distinguishes. The ONLY reliable alignment is to make the spec-sig use codegen's ACTUAL
`type_key`. Direct import is blocked: type_key is NOT exported, and helper.yo↔codegen would
cycle (`codegen/functions/collection.yo` already imports `create_specialized_function_inline`
from helper.yo). SO the path is option (a): EXTRACT the type_key cluster into a new shared
low-level module `yo-self/types/type_key.yo` (types/ is below both layers → no cycle). Cluster
to move (all currently in codegen/utils/index.yo): `type_key`, `_type_key_at`, `_tk_seen`,
`_lookup_or_register_enum_sig`, `can_optimize_as_nullable_pointer`, globals `g_tk_visited` /
`g_struct_cfid_keys` / `g_enum_sig_keys`. Deps it needs: `resolve_enum_shell`/`resolve_struct_shell`
(already in types/creators.yo) + `type_to_string` (types/string.yo). Then codegen/utils/index.yo
imports type_key from the new module (re-export for its existing users), and helper.yo's
`_param_type_sig` becomes `type_key(ty)`. CAUTION: verify `can_optimize_as_nullable_pointer`'s
own deps don't pull codegen; and the stateful globals will now be populated during the EVALUATOR
phase (specialization) before codegen — benign IF runtime param types are concrete at spec time
(they should be) and both phases compute from the same type values (first-registration-wins stays
consistent). Validate: corpus 97 + std 152 + re-measure incompat (expect a LARGE drop, this is
the keystone that also unblocks the 266 module-globals port).

RESIDUAL type-identity (177 incompat) — direction (this session eliminated one option): routing
the sig through `type_intern_key` (types/intern.yo — injective, recursion-safe) was tried: it
COMPLETES (peak ~7GB, no explosion) but incompat got WORSE (177→203, total only 1189→1185). It
OVER-distinguishes — being injective, it separates types that CODEGEN's `type_key` treats as the
SAME C type, minting extra func_ids that then mismatch. The sig must align with codegen's OWN
`type_key` (so two params of the same emitted C type share a func_id), not the interning key.
type_key lives in codegen (evaluator→codegen import risk); options: (a) move type_key's core to a
shared low-level module importable by both, or (b) extend the current struct-args `_param_type_sig`
to also append generic-ENUM `variant_fields` BUT with type_key's exact visited-guard discipline
(id-only on the recursion path) so it matches codegen without the explosion. Keep the committed
struct-args version (1189) meanwhile.

**UPDATE (commit `4950719fb`): 1627 → 1312 errors (−315).** Fixed the "Failed to transpile"
cascade root: `find_function_calls_in_expr` now falls back to the durable macro-expansion
table (like codegen), so method-callees inside match-arm-`if` macro expansions get collected.
This collapsed the syntax/brace cascades (implicit-int 172→47, K&R 74→20, extraneous-brace
out of top-10). Remaining dominant class is now type-identity (undeclared 707 + incompat 257

- member-ref 95 + passing 43). See issues/fixed/yo-self-failed-transpile-if-in-match-arm.md.

**Verified 1312 distribution + accurate next targets:**

- **undeclared 707** — UNCHANGED by the fix (the −315 was ALL syntax/brace cascade collapse).
  Breakdown: **183 `_file____User_temp` never-materialized-temp drops** (single RC-drop root,
  `drop_dup.yo` — biggest single cluster; RC-correctness-sensitive, validate with ASan).
  READY-TO-EXECUTE DESIGN (worked out this session): (1) add `declared_c_var_names : HashSet(String)`
  to `CodeGenContext` (struct in utils/index.yo + its constructor in codegen_c.yo); (2) in
  `get_variable_type_string` (the CENTRAL choke-point — all 23 declaration-emission sites route
  through it) record `sanitize_for_c_identifier(var_name, false)`; (3) in
  `generate_deferred_drop_expressions` (drop_dup.yo:542) skip a drop whose target (via
  `get_deferred_drop_target_atom_name` → resolved to its C name) is a temp NOT in
  `declared_c_var_names`. SAFETY: skipping a drop for a NEVER-DECLARED C variable CANNOT
  double-free (no such C variable exists) and cannot leak more than the current non-compiling
  state (the variable never held a value in C — its value was inlined+dropped at the real site).
  So the only correctness question is exact name-matching (raw token value from
  get_deferred_drop_target_atom_name vs the codegen name recorded at declaration — verify they
  align, else convert via get_variable_name_for_codegen with the atom's env). Validate: corpus 97
  - std 152 + an ASan run on a representative corpus binary + re-measure (expect ~−150+).
    Temps are globally-unique so no per-function reset of the set is needed. ~60
    `g_*` module globals (module-var port, gated on type-identity), **15 `fn_yo_id` = uncollected
    `.throw` EFFECT-HANDLER closures** in `Exception(throw : (err)->{..})` struct literals
    (verified: all are `(__yo_struct_yo_id_5803){ .throw = fn_yo_id_N }` — the propagate-mode
    exn handlers pervasive in the evaluator). NOT a collection-walker gap: `find_function_calls_in_expr`
    (collection.yo:447) only walks `effect_analysis.handler_value`'s BODY, not registering the
    handler — and TS (collection.ts:293) does EXACTLY the same (faithful). The divergence is the
    effect-handler CODEGEN MODEL: yo-self emits the handler as a struct-field function POINTER
    (`.throw = fn_id`) needing a standalone C definition, so it must be collected+emitted;
    TS lowers `Exception(throw:..)` handlers differently (not a raw fn-pointer needing collection
    here). This is Phase-5 effect-handler codegen, not a quick collection fix.), rest scattered.
    REPRO NOTE: the temp-drop bug does NOT reproduce with minimal concrete-type code — verified
    a faithful transcription of the source construct (`validate_concrete_type_constraints`,
    function.yo:1448: a `while` with a match-early-return then `if(ast_expr_is_fn_call_of(arg,"!",
Some(usize(1))), ..)`) compiles clean. It only manifests in the SPECIALIZED-GENERIC
    instantiation (real AstExpr/enum types), e.g. emitted fn `yo_id_247313` where `drop(temp_144445)`
    is emitted inside an `if` body but `temp_144445` is never declared (declaration elided while
    its deferred-drop survived). NEXT: instrument the real self-compile — log in
    `drop_dup.yo generate_deferred_drop_expressions` when a drop target name was never emitted as
    a C decl (track declared names), and in the RC-emission layer where that drop was scheduled —
    rather than chase a minimal repro.
- **type-identity class ~395** (incompat 257 + member-ref 95 + passing 43) — now the dominant
  CLASS; generic-instantiation cfid consistency (index.yo:755/781), deep + previously-reverted.
  Sub-analysis: 115 incompat assign into `enum_<id>_struct_<id>` (enum-over-struct) — the enum
  structural-sig embeds the payload struct's key, so the ENUM divergence is DOWNSTREAM of the
  struct key inconsistency. **HYPOTHESIS ELIMINATED (this session):** a structural-sig bridge in
  `type_key` (register `s_<name>_<typeargs> → gs_key` in the cfid-full path, look it up in the
  cfid-empty fallback) does NOT fix it — built + corpus 97 + std 152, but stage-2 went 1312→1314
  (incompat +22: it even MERGED some distinct structs). So the two divergent C names do NOT share
  `name`+`type_args` — the divergence is deeper (different type*args, or via the enum-sig path, or
  a struct with empty name). NEXT: instrument `type_key` to dump BOTH C names + the full TypeValue
  (name/id/cfid/type_args/fields) for one concrete incompat pair (e.g. bl-emit.c:23353
  `enum_5152_bool` vs `enum_17883*...`) to see EXACTLY what differs, before attempting a fix.

  **REFINED ROOT (this session, from the C at cs-emit.c:23353):** it is NOT two dedup-able
  instantiations of the same type — it is a **generic-specialization SUBSTITUTION bug**. The C
  is `__yo_enum_yo_id_5152_bool t = yo_id_3872(trait_negated, j)` where `trait_negated :
ArrayList(bool)` and `yo_id_3872` is `ArrayList.get` SPECIALIZED for it. The call site
  correctly expects `Option(bool)` (enum*5152) but the specialized `get` RETURNS
  `Option(enum_17868)` — i.e. the element type `T` was NOT substituted to `bool` in the
  specialized function's return type (`enum_17868` is an unsubstituted `T`/SomeType-derived
  enum). So the fix is in generic specialization / monomorphization (substitute type args into
  the SPECIALIZED return type), NOT in `type_key` dedup — which is why the sig bridge failed.
  This is the create_specialized / substitute() return-type path (related to task #22, #30).
  EXACT LOCUS: `create_specialized_function_inline` (helper.yo:1140) computes
  `spec_ret_ty := evaluate_function_return_type_again(<generic result type>, callee_env, ctx)`.
  For the failing case it yields `Option(enum_17868)` not `Option(bool)` → so `callee_env` binds
  the type param to the wrong type (an unsubstituted/mis-inferred `T`) in this (likely nested)
  specialization context. NEXT: instrument `create_specialized_function_inline` to log func_id +
  the generic result type + `spec_ret_ty` + the callee_env type-param bindings for the
  ArrayList.get specialization, to see why `T` resolves to `enum_17868` rather than `bool`.
  Deep specialization type-inference; validate any fix with corpus 97 + std 152 + re-measure.
  INSTRUMENTATION RESULT (this session): a guarded log at helper.yo:1140 for specializations
  whose `type_to_string(spec_ret_ty)` contains "Option" fired ZERO times over a full self-compile.
  So EITHER `evaluate_function_return_type_again` at 1140 is NOT the path that produces
  ArrayList.get's return type (it may come from a cached specialization / a different call path /
  the funcId side-table `get_func_type`), OR `type_to_string` does not spell generic enums as
  "Option" (likely the raw `enum(None,Some(..))`/id form). NEXT: first add an UNCONDITIONAL
  counter/log at 1140 to confirm the path is hit at all, and log `type_to_string` of a known
  Option value to learn its spelling; then widen the search to where codegen reads the specialized
  return type for a call (get_func_type(specialized_func_id) → its Func result), which is what the
  emitted C prototype's return type actually comes from.
  UPDATE 2 (this session): confirmed helper.yo:1140 IS the path — an unconditional log fired
  550 times for `yo_id_3872` (ArrayList.get) specializations. But `type_to_string` is LOSSY: it
  renders every specialized return type as bare `<enum:enum_yo_id_3869>` (the base `Option` id, no
  type arg), so it cannot reveal whether the element arg is `bool` or wrong. NEXT (correct tool):
  log `type_key(spec_ret_ty)` (shows the full parameterized `enum_3869*<argkey>`form) OR dump the
 `.EnumT type_arguments`directly, for the`struct_yo_id_3849`(trait_negated's ArrayList)
  specialization specifically — then trace how`callee_env`/`evaluate_function_return_type_again`
  binds the element type. Use type_key, NOT type_to_string.

- **Residual 56 "Failed to transpile"** — NOT the macro-fallback family (that is fully fixed;
  plain while-condition/if-begin method calls compile clean now — verified). They cluster in an
  **async/effect function body** (a link/compile command builder that `io.await(cmd.status(io))`)
  whose whole body is un-annotated — the Phase-5 async codegen subsystem, deferred.
- residual syntax (implicit-int 47, K&R 20, expected-\* ~45) — remaining cascade tails.

Recommended next: the **183 temp-drop single root** (`drop_dup.yo`, ASan-validate) OR the
**type-identity class** (biggest, deep). Both are focused standalone tasks.

**Prior baseline (`b3d499966`):** self-compile runs exit 0 and emits
`/tmp/bl-emit.c` (682K-ish lines), which clang reported **1627 errors** (`-ferror-limit=0`;
the default cap of 20 is misleading). This is a **multi-root, multi-session** effort —
no single fix reaches 0. Below is the root-cause-classified distribution to execute
against, most-leverage first.

Reproduce the measurement:

```
YO_MAIN_STACK_MB=2048 <binary> compile yo-self/main.yo --emit-c --skip-c-compiler -o /tmp/bl-emit
clang -std=c11 -fno-strict-aliasing -fwrapv -w -O0 -ferror-limit=0 /tmp/bl-emit.c -o /tmp/bl-bin
grep -o 'error: [a-z].*' clang.txt | sed -E "s/'[^']*'/'X'/g" | sort | uniq -c | sort -rn
```

## Error categories (baseline 1627)

| count | category                                      | root class                                     |
| ----: | --------------------------------------------- | ---------------------------------------------- |
|   729 | use of undeclared identifier                  | **mixed — see breakdown**                      |
|   256 | initializing with incompatible type           | **generic-instantiation type-identity** (deep) |
|   172 | type specifier missing (implicit int)         | decl emitted without return/var type           |
|    95 | member reference base is not struct/union     | type-identity / wrong C type on a var          |
|    74 | K&R param list (no types)                     | malformed fn-ptr/param emission                |
|    43 | passing incompatible type to parameter        | type-identity                                  |
|    41 | expected identifier                           | syntax cascade                                 |
|    37 | expected expression                           | syntax cascade                                 |
|    37 | expected 'X'                                  | syntax cascade                                 |
|    32 | initializer element not compile-time constant | file-scope init of non-const                   |
|    14 | unknown type name                             | uncollected type                               |
|    11 | extraneous closing brace                      | brace-imbalance cascade root                   |

### The 729 "undeclared identifier" breakdown (by name cluster)

- **176 `_file____User_temp_N` inside `__yo_decr_rc(...)`** — **SINGLE ROOT**: deferred
  drops emitted for temps codegen NEVER materialized (declaration elided, e.g. the value
  was inlined, but the RC-drop was still scheduled). Concentrated in specialized-generic
  fns (`yo_id_246160`, `yo_id_12319`, `yo_id_247313`, ...). RC-correctness-sensitive:
  wrongly skipping a drop risks the P0 double-free/leak family — needs careful validation,
  not a blind filter. Fix site: `codegen/exprs/drop_dup.yo:542 generate_deferred_drop_expressions`
  - `return.yo _keep_pending_drop` (the HEAD commit's `_variable_initialized_after_cleanup_point`
    handles drops for locals declared AFTER the drop; this is the NEVER-declared sibling case).
- **~60 `g_*` module globals** (`g_comptime_fn_caches` 13, `g_cached_prelude_env` 12,
  `g_send_derivation_in_progress`, `g_impl_registry_keys`, `g_traverse_visit_expr`,
  `g_tk_visited`, `g_struct_cfid_keys`, `g_macro_quoted_param_indices`, `g_loading_keys`, …)
  — **FIXED by the module-var port** (`issues/module-level-var-port.patch`), but that port
  is itself gated on the type-identity issue (see below); apply after it lands.
- **~15 `fn_yo_id_N`** — functions called but never collected/emitted.
- **remainder** — scattered locals (`env`, `lhs_info`, `expr`, `evaluated`, `ty`, `t`,
  `value_sub`, `label_sub`, `new_pending`, …); likely block-scope / early-elision cases.

## KEY REFRAME: 1627 errors ≈ 4 root CLASSES (not 1627 independent bugs)

Cascade analysis (this session) shows most errors are downstream of a few roots:

- **Brace-imbalance class (~350 errors from ~11 roots).** The 11 "extraneous closing
  brace" errors are match/switch emitters producing an EXTRA `}` that closes the enclosing
  C function early. Everything after then parses at file scope → the 172 "implicit-int"
  (a function _call_ like `yo_id_20848(env);` read as a K&R decl), the 74 "K&R param list",
  and much of the "expected identifier/expression/'X'" (~115) are ALL cascades from these
  ~11 sites. Example root (bl-emit.c:55505): a `switch` over an enum tag closes, then an
  extra `}` appears before an `else {}` whose `if` brace was miscounted — a nested
  match-in-if / match-arm brace-accounting bug in the match/cond emitter. **Highest-leverage
  tractable target: pure codegen emission, no RC/type-identity sensitivity.** Fix the
  emitter brace accounting; ~350 errors should collapse.
- **Type-identity class (~256 + 95 member-ref + 43 passing ≈ 394).** Generic-instantiation
  key inconsistency (details below).
- **Temp-drop class (176).** Deferred drops for never-materialized temps (details below).
- **Uncollected-functions/globals (~75).** ~60 fixed by the module-var port; ~15 `fn_yo_id`.

So the effective work is ~4 focused investigations, and the brace class (~350, safest) is
the recommended FIRST fix — it needs no type-identity or RC reasoning.

## Priority order

-1. **"Failed to transpile" markers (66) — THE cascade root, DO FIRST, has a MINIMAL REPRO.**
`generate_func_call` emits a `// Failed to transpile <expr>` COMMENT when a FnCall has no
ExprInfo (generation.yo:405). That comment eats the rest of the C line — parens AND braces —
so it is UPSTREAM of the brace-imbalance (#0), implicit-int, K&R-param, and expected-\*
syntax cascades. Fixing the 66 markers likely collapses ~350-500 errors together.
**Minimal TS-divergent reproducer** (`issues/yo-self-failed-transpile-if-in-match-arm.md`):
a method call inside an `if` that is a match-arm body — `match(o,.Some(cv)=>if(cv.len()>0,..),.None=>..)`
— loses ExprInfo on `cv.len()`. `if` is a macro; its expansion is cloned-fresh + evaluated at
`evaluator/calls/function.yo:3000` (works at top level), but the match-arm path gives codegen a
`cv.len()` whose id ≠ the eval-set id. Fix in the match evaluator's variant-arm body eval
(`evaluator/exprs/match.yo`) so the arm-body macro expansion's child ExprInfo matches codegen's
ids. Fast loop: `<bin> compile x.yo --emit-c --skip-c-compiler` + grep `Failed to transpile`.
The 66 also include method calls in `while(...)` conditions — same family, re-scan after.

0. **Brace-imbalance in match/switch emission (~350 errors, ~11 roots) — largely DOWNSTREAM of -1.** Safest
   (pure emission, no RC/type-identity). Roots at bl-emit.c:55505/55546/60853/103512/110431/
   110813/125872/158456/182714/188670. Each is a match/switch (often nested match-in-if or a
   match arm) emitting an unbalanced `}`. Reproduce by extracting the offending yo-self source
   construct into a standalone `.yo`, compile with `./yo-cli compile` to see the C, count braces.
   Fix the emitter (`codegen/exprs/match.yo` / `cond.yo`) brace accounting. Validate corpus 97.
1. **Generic-instantiation type-identity consistency** (unlocks 256 incompat + 95 member-ref
   - 43 passing + the module-var port's ~60 globals). Localized in `codegen/utils/index.yo`:
     generic structs key as `gs_<constructor_func_id>_<typeargs>` (line ~755) only when cfid
     is populated (stamped at `evaluator/calls/comptime_fn.yo:872`), else fall back to an
     unstable bare `sid` (line ~781). Same logical `Option<value-struct>` reaches `type_key`
     with cfid at one site, empty at another → two C names. **CAUTION:** this code path was
     profiled at O(n²)/hours and carefully optimized; a prior evaluator-side cfid-population
     attempt was reverted (memory `yo-self-phase3-generic-impl-funcid`). First diagnostic:
     disambiguate _different-sids_ (needs a structural-sig bridge, perf-careful) vs _ordering_
     (needs pre-registration, cheap). See `issues/module-level-var-port.md`.
2. **Never-materialized-temp drops** (176). Single root, RC-sensitive; validate with corpus
   97 + std 152 AND an ASan/leak check, since it touches drop correctness.
3. **implicit-int (172)** — find the decl-emission path dropping a return/var type.
4. **Syntax cascades (~130: expected-identifier/expression/'X' + extraneous-brace)** — likely
   a few malformed emissions; fix the brace-imbalance roots first (cascades collapse).

## Validation gates (every fix)

- corpus: `YO_SELF_BIN=<bin> bash scripts/diff-test.sh tests/codegen-bootstrap` → 97/97
- `<bin> check ./std` → 152, `check ./tests`, `check ./yo-self`
- re-measure the clang error count on the regenerated stage-2 C
- for RC-touching fixes: also `--sanitize address` a representative binary
