# yo-self stage-2 fixpoint — error-distribution roadmap

**BREAKTHROUGH (struct type_arguments in exact compat): 533 → 399 errors (−134; commit `9e4077300`).**
The generic-method "specialization collapse" (thought deep/regression-prone) had a CLEAN root fix.
Concrete: `Iter(usize).next()` reused `Iter(String)`'s specialization (only String's `.next` was
emitted; its Option(String) return assigned to an Option(usize) var → incompatible). ROOT:
`are_types_compatible_exact` (the spec-cache runtime-param comparison) never compared struct
`type_arguments`. yo-self struct `id`s churn across instantiations, so `Iter(usize)`/`Iter(String)`
share a base id AND their `field_types` are the generic placeholder (`SomeT(T)` in both) — so BOTH the
`(aid==eid)` shortcut and the structural field comparison matched. The ONLY distinguisher is the
concrete `type_arguments` ([usize] vs [String]), which the exact `.Struct` arm ignored. FIX
(compatibility.yo): before the id/field checks in the exact struct path, return false when both structs
carry non-empty `type_arguments` of equal length and some arg is exact-incompatible (recur, require_exact);
same-args falls through unchanged (non-generic/identical untouched). **incompat 170→46.** Validated
corpus 97/97 (DIFF 0), std 152/152. LESSON: the prior "distinguishing more regresses" results were about
the WRONG distinguisher (are_types_compatible_exact wholesale, type_key, base-id) — the RIGHT one
(concrete type_arguments) is sound and clean. METHOD: traced via emitted C — both `gs_15687_usize` and
`gs_15687_struct_4014` structs exist (distinct), `.iter()` returns usize correctly, but only String's
`.next` specialization was emitted → the cache equated the two receivers → type_arguments were the gap.
Session trajectory: 3643 → … → 882 → 741 → 580 → 533 → 399 (−483 this session, ~55%).

**WHY self_type-in-sig FAILS + why impl-forall is the ROBUST fix (decisive, this session).** The emitted specialized func's params come from `func_type` (`ft_pt`, helper.yo:1197), NOT `runtime_param_tys` — so runtime*param_tys feeds only the sig + cache key. The self_type append regressed (+2634 "too few args") because `ctx.self_type` is CONTEXT-DEPENDENT: set on the static-dot call path but not at definition-time body eval, so the SIG (hence func_id `${base}*${sig}`) DIVERGES between call site and definition → the call references a func_id the definition never emitted (or a differently-specialized one). Therefore the distinguisher MUST be a STABLE property of the method type, consistent at def+call = the impl block's forall params. Robust fix = add impl `K,V`to the method's`forall_labels`/`forall_types`at registration, kept UNRESOLVED (do NOT substitute them out via spec_s — the`\_inject_forall_captures` captures bind them at the call; compute_compile_time_signature:703 forall loop then reads concrete K,V from callee_env). Delicate: the substitute-vs-keep-forall interplay in find_methods_from_generic_impls needs care (K,V stay forall labels, other impl subst applied to fields). Multi-iteration; dedicated session.

**ENUM-INCOMPAT 44 — DECISIVELY CONFIRMED: `with_capacity`/`new` impl-forall-not-in-sig.**
The failing call (stage2.c) is `yo_id_13320_rtparam0_usize((size_t)(new_capacity))` = `HashMap.with_capacity(n : usize) -> Self`. Its sig is ONLY `rtparam0_usize` (the capacity) — the receiver `HashMap<K,V>` is NOT a runtime param and `K,V` are impl-level, so different instantiations collapse onto ONE specialized func whose `Self` return is baked to the first → `Option(HashMap(usize,_))` vs `Option(HashMap(String,_))` mismatch. CONSTRAINT (why it's hard): `runtime_param_tys` (helper.yo) drives BOTH the sig AND the emitted C parameter list — adding `self_type` there (tried) added a C param → "too few arguments" ×2600 regression. So the fix must put the impl `K,V` into the sig + cache key WITHOUT touching runtime params. Mapped 3-part fix (all needed together): (1) add impl forall names to the method's `func_type.meta.forall_labels` + `forall_types` at registration (find_methods_from_generic_impls / \_inject_forall_captures already binds K,V as captures → the sig's forall loop at compute_compile_time_signature:703 looks them up in callee_env); (2) ensure create_specialized binds these extra forall labels from the env (no explicit forall_args) without arity error; (3) eval_value_eq TypeVal → are_types_compatible_exact (else the cache's compile_time_arg comparison stays lenient). Deep multi-site; validate + revert-on-regress; do NOT add self_type to runtime_param_tys.

**ENUM-INCOMPAT 44 — negative results (this session, all reverted): NOT a comparison-layer or sig-append fix.**
Confirmed the residual incompat (Option(HashMap(usize,_)) vs Option(HashMap(String,_)), etc.) is the
STATIC/return-type-only specialization collapse: the instantiation type args come from the receiver/
expected type, NOT from a runtime argument, so `compute_compile_time_signature` (which keys runtime
params by concrete `ae.arg_type`, helper.yo:1117) can't capture them. Tried & reverted: (1) remove the
struct `(aid==eid)` exact shortcut — no-op (field_types generic SomeT, not the shortcut). (2) remove the
EnumT `(aid==eid)` shortcut — no-op +2 (enum variant_fields generic SomeT). (3) eval_value_eq TypeVal →
are_types_compatible_exact — no-op +1 (not the compile_time_arg path). (4) append `ctx.self_type` (generic
instantiation) to `runtime_param_tys` in create_specialized — **REGRESSED 399→3033** ("too few arguments
to function call" ×2600: over-specialization broke call-site arity, the documented self_type-approach
failure). REMAINING viable fix = the DEEP one: propagate impl-block forall params into each method's
`func_type.meta.forall_labels` at registration so the existing forall loop in
compute_compile_time_signature captures the impl-level type args (memory yo-self-parametric-trait-impl-self-subst).
Multi-site evaluator change; the type_arguments exact-compat fix (above) is the prerequisite that makes it sound.

Distribution @ 399: **member-ref 104** (async-fn void\* returns — now the biggest; SM struct registered
under io.async-block SomeT id not fn-return SomeT id, see below), incompat 46 (was 170; residual
generic/type-identity), implicit-int 45 + expected-expression 28 + non-const-initializer 21 + K&R-param
19 + expected-identifier 17 (~130 SYNTAX CASCADES from malformed functions — should largely clear once
member-ref/incompat roots are fixed), undeclared 44 (block-RHS-elided locals + effect-handler fn ptrs).
Next high-value: member-ref 104 (async SM-struct SomeT-id registration).

**UPDATE (static-method callee fallback fix): 580 → 533 errors (−47; commit `b51624a81`).**
Traced the dominant incompat cluster to ground truth: the evaluator resolves `Environment.new`
CORRECTLY (instrumented: recv=Environment sid=struct_20794 fid0=yo_id_20814), but CODEGEN's concrete
method-call registry FALLBACK (other_fn_call.yo:941) computed the receiver type id from `dm_runtime[0]`
— the first RUNTIME arg. For a STATIC call `Type.method(args)` the evaluator prepends NO receiver, so
dm_runtime[0] is the first ARGUMENT (`module_path : String`), giving String's id → the fallback
resolved `String.new` (0-arg → struct_4014) instead of `Environment.new` → "incompatible type" at ~39
sites. Fix: compute `tid` from the DOT-RECEIVER (`dmethod_args[0]`) — its ExprInfo value is a `TypeVal`
for a static call (use inner type), the receiver instance for an instance call (use its type); old
dm_runtime[0] path kept as the no-ExprInfo fallback. incompat 210→170; `yo_id_4077(module_path)` now 0.
Validated corpus 97/97 (DIFF 0), std 152/152. Session trajectory: 3643 → … → 882 → 741 → 580 → 533.
METHOD: property_access NEWDBG instrumentation proved eval was correct → localized to codegen fallback
receiver-type source (the earlier "record callee in side-table" no-op was because this path reads the
registry fallback, not g_method_callee_values).

**INCOMPAT 170 — DEEPEST ROOT TRACED: generic-instantiation struct ids don't encode type args.**
Concrete case (stage2.c:33372): `seg_iter` is `gs_yo_id_15687<usize>` (iterator over usize), so
`seg_iter.next()` should return `Option(usize)` (enum*3936_usize). But codegen emits
`yo_id_15707_rtparam0_gs_yo_id_15687_struct_yo_id_4014` — `.next()` specialized for
`gs_15687<**String**>` → returns `Option(String)` (enum_5051_struct_4014) → incompatible. WHY: the
method-callee side-table MISSES for this call (the FuncVal-callee eval branch at function.yo:3217
records nothing, and recording `specialized_function_value` there was a NO-OP because it's None —
the concrete per-instantiation specialization isn't captured), so codegen falls to the registry
fallback (other_fn_call.yo:970) `get_type_trait_methods_by_name(type_id_or_empty(gs_15687<usize>),
"next")`. But `type_id_or_empty` for a Struct returns its `id` (type_trait_methods.yo:58), and
`gs_15687<usize>` and `gs_15687<String>` share the SAME generic base struct `id` (the id does NOT
encode type args) → the registry can't distinguish them → returns the FIRST-registered `.next`
(String's). ROOT = generic-instantiation type identity: a generic struct's `id` (and thus its
method-registry key) omits the type arguments, so all instantiations collide. This is THE deep
type-identity class (memories struct-identity-cache-collision / phase3-hashmap-new-blocker); the
codegen `type_key` DOES encode args (gs*<cfid>\_<argkeys>) but the EVALUATOR's `type_id_or_empty` /
method-registry key does not. Fix options (all deep, regression-prone — prior spec-sig/id approaches
regressed): (a) make generic instantiations carry distinct ids encoding args, keyed consistently at
impl-method registration AND call-site lookup; (b) capture the concrete per-instantiation
specialization into g_method_callee_values at the FuncVal-callee eval branch so codegen never uses
the ambiguous registry fallback. Validate + revert-on-regress; this is the ~9-approaches class.

**MEMBER-REF 104 — fn-return registration attempt (NO-OP, reverted).** Added `context.base.register_type(type_key(fn_return), fn_return, "${sm_struct}*")` at both async-block registration sites (generate_async_block ~1463 + preregister ~1901), guarded to a Future-returning `current_function_type`. Result: 399 UNCHANGED, member-ref still 104. So either (a) `current_function_type` isn't the async fn at these codegen sites, or (b) `type_key(fn-return SomeT registered here)` != `type_key(await's future_type at the caller)` — the two SomeTs differ enough that their type_keys don't match. NEXT: instrument to compare the two type_keys (register-site fn-return vs caller await future_type); the real fix likely needs the CALLER's await to resolve via the callee func_id → SM-struct (a func_id→sm_struct registry) rather than type_key matching. Additive/low-risk but ineffective as-is.

**MEMBER-REF 104 — ROOT REFINED (SM struct EXISTS; registered under wrong SomeT id).** The async
function (e.g. `yo_id_7197(path, io) -> void*`) DOES create its state-machine struct in its body
(`io_async_block_yo_id_397717_sync_fut_t*`, memset + `state`/`__yo_resume_fn`), returned as `void*`.
The sync-await (`void* __sync_future = <call>; __sync_future->state`) fails because
`future_type_name = get_type_string(future_type)` → `void*`: get_type_string's SomeT arm
(utils/index.yo:775) does `lookup_some_resolved_concrete(sid)`, but the SM struct is registered (async
codegen ~2064) under the io.async BLOCK's future SomeT id — INTERNAL to the callee — while the
CALLER's await looks up the FUNCTION-RETURN SomeT id (a different SomeT). Mismatch → void\*. FIX
(Phase-5, deep): register the SM struct ALSO under the async function's return-type SomeT id (needs
that id at block-codegen time), OR resolve the function-return SomeT to the block's future type. A
generic header-cast at the await site is UNSAFE: `state`/`__yo_resume_fn` sit AFTER the per-block
`__capture` field, so their offsets vary between SM structs. validate + revert-on-regress.

Distribution @ 533: **incompat 170** — now dominated by GENERIC-METHOD specialization collapse (a
DIFFERENT, deeper mechanism than the static-method fix above): e.g. `yo_id_15707_rtparam0_gs_...`
specialized fns whose baked return type mismatches the call-site LHS (`enum_3936_usize` etc.) — one
specialized func serving multiple instantiations, return baked to whichever registered first. Plus
member-ref 104 (async-fn void\* returns), undeclared 48, implicit-int 45, expected-expression 28,
non-const-initializer 21. Next: the generic-method specialization return-type collapse (deep).

**INCOMPAT 210 — TRUE ROOT (property-access resolution) + no-op fix attempt (reverted).**
Confirmed the mis-resolution is UPSTREAM in property-access, not codegen callee lookup or call-eval
recording. `Environment.new` IS correctly emitted (`yo_id_20814(module_path)->struct_20794*`), but the
callee VALUE for the ~39 `Environment.new(module_path)` calls is ALREADY `String.new` before codegen —
property_access.yo (`is_struct_type` static branch, ~771) searches Environment's struct `field_labels`
for `new`, finds the label, but yo-self's TypeValue carries NO field VALUES (types/values are split; the
inherent `new` FuncVal lives in the paired StructVal, not the Struct TypeValue). One candidate fall-back is
`get_type_trait_methods_by_name(type_id_or_empty(Environment), "new")` (~872). ATTEMPTED (reverted,
NO-OP): recording `call_result_rt.specialized_function_value` / `callee_value` in
`g_method_callee_values` at the FuncVal-callee branch (function.yo:3230) so codegen uses it — 580
UNCHANGED. This result is AMBIGUOUS: either (a) `callee_value` is ALREADY String.new at that branch
(evaluator mis-resolves there), or (b) codegen does NOT read the side-table for these calls (they
don't match other_fn_call.yo's `method_atom_ok && !recv_is_dyn` method-dispatch branch — likely
handled as a plain call reading the callee differently). IMPORTANT CONTRA-EVIDENCE: the evaluator
resolves `Environment.new` CORRECTLY during `check ./std` / corpus (both pass), so the mis-resolution
is specific to the stage-2 codegen path, NOT a universal evaluator bug. NEXT (needs instrumentation,
multi-cycle): log at function.yo:3217 what `callee_value`'s func_id is for an `Environment.new` call
(distinguishes a vs b), then fix the identified site. Inherent `ref(struct)` methods
(`Environment :: ref(struct(new : fn...))`, env.yo:355) are registered ONLY via impl.yo's
register_type_trait_method — verify whether the struct-def path registers them at all. Deep;
validate + revert-on-regress.

**INCOMPAT 210 — GROUND TRUTH CONFIRMED (fresh 580 emit): `yo_id_4077` IS `String.new()`.**
Read the definition body: `static inline struct_4014 yo_id_4077()` returns a `struct_4014` built from an
`ArrayList(u8)`-backed enum — i.e. `String.new()` (0-arg, empty String; struct_4014 = String). So the
~40 `yo_id_4077(caller_env->module_path)` call sites (each `Environment.new(module_path)`, helper.yo:2066)
MIS-EMIT String.new's C name: the evaluator's STATIC-method dispatch for `Environment.new` on the
`ref(struct)` Environment type resolves to `String.new` instead of Environment's own inherent `new`
(env.yo:355, `new : fn(module_path : String) -> Self`). Path: function.yo:229-237 — is_static→
`get_type_trait_methods_by_name_from_env(env, "new", inner_ty=Environment)`. The registry
(`get_type_trait_methods_by_name`, type_trait_methods.yo:180) is id-keyed via `type_id_or_empty`
(Struct→id) with NO cross-type fallback, so this returns String.new only if (i) inner_ty resolves to
String not Environment, or (ii) Environment's inherent `new` registered under a Struct id that differs
from the call-site lookup id (ref-struct id churn). NEXT: instrument the env-variant lookup for
`.new` on Environment to see the receiver Struct id at registration vs lookup. Deep, hot-path,
regression-prone — validate + revert-on-regress.

**INCOMPAT 210 ROOT REFINED (concrete trace): method-call callee MIS-RESOLUTION, not base-id churn.**
The dominant `yo_id_4077` cluster: `yo_id_4077` is _defined_ 0-arg → `struct_4014` (the module*path/String
type — i.e. it is `String.new()`), yet \_called* as `yo_id_4077(caller_env->module_path)` at ~40 sites.
That call is `Environment.new(module_path)` (helper.yo:2066) — a 1-arg method → Environment (struct_20794).
So codegen resolved `Environment.new`'s callee to the WRONG `.new` (String's 0-arg one). Both are `.new`
methods; picking the correct one needs stable receiver-TYPE identity at the call's method-dispatch /
`g_method_callee_values` resolution. So incompat 210 = method-dispatch callee resolution coupled to
type-identity — NOT base func_id churn (below), NOT the codegen type_key (TKCHURN=0), NOT the spec-sig.
Next attempt should instrument `g_method_callee_values` / the method-dispatch path for `.new`-family calls
to see why the receiver type resolves to String instead of Environment. Deep; validate + revert-on-regress.

**NEGATIVE RESULT (base-func-id memoization — reverted): does NOT fix incompat 210.**
Tried memoizing the base `fn_val_id` (function*type.yo:482, `try_to_implement_function_by_function_type`)
by the definition expr's AST id (a `g_fn_expr_func_ids : HashMap(ExprId, String)` side-table), on the
hypothesis that re-evaluating the same `fn(...)` across passes mints fresh ids so a call site and the
definition disagree (the `yo_id_4077`: one 0-arg definition vs ~40 arg-bearing call sites). Result: 580
→ **587 (+7 WORSE)**, incompat UNCHANGED at 210. So the collision is NOT base-id churn — it arises in
SPECIALIZATION (`create_specialized_function_inline`) or method-callee resolution
(`g_method_callee_values`), consistent with the ~9 prior exhausted approaches. NOTE: TS also uses
`fn*${randomId()}` per-eval (function-type.ts:414) — TS's stability comes from evaluating each fn once,
not from a stable id scheme. Reverted; baseline 580. Do not retry base-id memoization.

**UPDATE (loop-exit drop gate): 741 → 580 errors (−161; commit `47237f3cb`).**
`_emit_loop_body_drops_before_exit` (atom.yo — the `continue`/`break` drop path) filtered
drops by ENV-liveness (SOURCE order), not C-emission order. An `x := match(...)`/`cond(...)`
binding emits its C declaration AFTER the RHS switch, so a `continue`/`break` inside the RHS
precedes the declaration → the emitted `__yo_decr_rc((void*)(gt))` referenced an undeclared local
(`gt`/`et`/`res`/…). Fix: gate the drop by `context.base.declared_c_var_names` (the same
C-emission-order ground truth the committed `_keep_pending_drop`/return.yo early-return fix uses).
Safe by construction (no C value bound → skipping its drop can't double-free/leak); targeted to
the loop-exit path ONLY, so it does NOT touch the synth-function drop path that regressed a prior
blanket attempt. **undeclared 210→49.** Validated corpus 97/97 (DIFF 0 — double-free oracle),
std 152/152. Session trajectory: 3643 → … → 882 → 741 → 580.

Distribution @ 580: **incompat 210** (type-identity — deep, ~9 approaches exhausted; +35 vs
pre-module-var from newly-reachable init code), **member-ref 104** (async-fn future SM-struct never
registered under its return type → void* → `->state`; root located, Phase-5 feature), **undeclared
49** (now scattered: effect-handler `fn*yo_id\*\*`pointers + a few block-RHS-elided locals`env`/`t`/
`expr` [[yo-codegen-block-rhs-drops-statements]] + temps — no single dominant cluster), implicit-int
45 + expected-expression 28 + non-const-initializer 21 (cascade artifacts from malformed functions
downstream of the incompat/type-identity breakage). Next high-value: incompat 210 (type-identity)
or member-ref 104 (async future type registration) — both deep.

**UPDATE (module-level-variable emission PORTED): 882 → 741 errors (−141).** Ported the
deferred module-level mutable-variable subsystem (TS `emitModuleLevelVariableDeclarations` +
`moduleLevelInitExprs` collection + `collectTypesFromExpr` on init exprs). yo-self codegen
emitted **0** `static ... // module-level mutable variable` declarations (TS emits 105) — every
`g_*` module global (`g_evaluate_expression`, `g_method_callee_values`, …) was USED (assigned/
read) but never DECLARED → the dominant "use of undeclared identifier" class. Fix, faithful to
src/: (1) evaluator `evaluate_anonymous_module_begin_exprs` (anonymous*module.yo) collects `x :=
v` (atom LHS, no comptime value) and `(x : T) = v` (a `:` binding LHS) init exprs into a durable
`g_module_level_init_exprs` side-table in expr_info.yo — the idiomatic eval→codegen bridge (same
pattern as g_macro_expansions; the EvalValue enum can't carry TS's `moduleValue.moduleLevelInitExprs`
field). KEY: the `=` case must key off the LHS \_shape* (`:` binding), NOT `variable.isModuleLevel`
— that flag is false for IMPORTED modules (their body evaluates inside a loader function frame),
which is why an earlier is_module_level-gated attempt collected only the 8 `:=` globals; (2) codegen
`emit_module_level_variable_declarations` (generation.yo) emits file-scope `static <type> <cname>;`
per var, deduped by resolved C name; (3) `generate_main_wrapper` emits a `__yo_main_module_init()`
helper initializing each (emitted DIRECTLY to the emitter, header-first, so an RC-returning
initializer's aux temps land INSIDE the fn body — a detached string orphans them at file scope →
"initializer element is not a compile-time constant"; deferred-drops reset so the value MOVES into
the global), called first on the worker thread / from main on the direct path; (4) types/collection.yo
`collect_required_types` walks the init exprs so their instantiation types (e.g. HashMap(K,V)) are
registered. yo-self now emits 100/105 module vars (5 edge shapes remain). VALIDATED: corpus 97/97
(DIFF 0), std 152/152, minimal repro compiles+runs. Distribution 741: undeclared 210 (was 409),
incompat 210 (was 175 — newly-reachable init code exposed more), member-ref 104, implicit-int 45,
expected-expression 28, non-const-initializer 21. Session trajectory: 3643 → … → 882 → 741.

**RETRACTED (this session): the "faithful funcId encoding" experiment.** Encoding impl-block forall
substitutions into the specialized method funcId (mirroring TS impl.ts:1550 `_specialized_K_..._V_...`)
DOES engage (with_capacity per-V now distinct) but regressed 882→971 + ballooned C to 475MB — it
distinguishes MORE specializations, exposing more references to the (then-)undeclared module globals

- a structural cascade. Reverted. The module-var emission above is the correct prerequisite; the
  funcId change may be revisitable ON TOP of it (unvalidated).

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

**CORRECTION (instrumented, TKCHURN=0): the `type_key` def↔use "keystone" UNIFICATION BELOW IS
DISPROVEN.** I instrumented `type_key`'s cfid-empty→raw-id fallback (`.Struct` branch b) to eprintln
any generic instantiation (type*args present) that falls to its raw churning id — the supposed
def↔use leak. Full stage-2 emit: **TKCHURN total = 0.** So NO generic-instantiation struct ever
churns through the cfid-empty path — `type_key` keys generic structs CONSISTENTLY (they carry cfid
→ the `gs*<cfid>\_<args>`branch, or the recorded cfid-key). This is why ALL the codegen`type_key`experiments (shared extraction, both additive side-tables) couldn't move incompat and the field one
regressed: they targeted a NON-problem. The incompat's real root is the EVALUATOR's`with_capacity`
specialization collapse (one specialized func serving multiple element types, its return baked to
whichever V registered first) — a genuinely different mechanism. The 7 evaluator cache/sig approaches
made it WORSE because distinguishing specializations exposed OTHER downstream issues, not because
type_key was wrong. NET: the incompat is evaluator-side spec identity, type_key is NOT the fix; the
"567-error unification" was an incorrect inference and is retracted. (member-ref 95 is still the
separate async future-type-resolution gap; module-globals 266 still gate on generic-instantiation
identity but via the EVALUATOR spec path, not type_key.) STALE (retracted) unification follows:

**UNIFICATION (this session): 567 of 882 errors share ONE keystone — codegen `type_key`
def↔use consistency.** Traced member-ref 95 deeper: async.yo:1461-1463 ALREADY registers the
future's SM struct under `type_key(future_type)` (c_name `${struct_name}*`) for io.async BLOCKS,
and get_type_string's SomeT arm looks it up via `get_type_c_name(type_key(t))`. The member-ref
failures are futures coming from async FUNCTIONS (e.g. `yo_id_6900`): the function's `Impl(Future)`
RETURN type has a DIFFERENT `type_key` than the block's registered future type → lookup misses →
`void*` → `->state`/`->__yo_resume_fn` on void\* = the 95 errors. That is the SAME `type_key`
inconsistency (a type registered under one key, used under another) as the incompat class and the
module-var-port cascade. So **incompat 206 + member-ref 95 + module-globals 266 = 567 errors all
reduce to ONE keystone: make `type_key` produce the SAME key for a type at its
registration/definition site and at every use site** (generic-instantiation structs with churning
ids / empty cfid; future types flowing async-block→fn-return→await). Fix locus: codegen `type_key`
(now shared in types/type_key.yo) — the `.Struct` cfid-empty→raw-id fallback + stable future-type
keying. The remaining ~315 (undeclared stragglers, effect-handler fn-pointers, scattered) are
separate/smaller. This keystone is the single highest-value target and the true floor of the
fixpoint.

**KEYSTONE FIX ATTEMPTED + REVERTED (8th type-identity approach): additive structural-sig side-table.**
Added `g_struct_struct_keys` mapping `<name>|<argkeys>` → the stamped `gs_` key, recorded in the
cfid-present branch and consulted FIRST in the cfid-empty fallback (so an unstamped copy recovers
its stamped sibling's exact key; the `gs_` branch OUTPUT unchanged — minimal surface). Built 72s,
corpus 97/97, std 152/152, but stage-2 884 (+2 WORSE: incompat 207, undeclared 412). So the additive
side-table does NOT fix the def↔use mismatch — the failing cfid-empty structs evidently have EMPTY
names (so `<name>|<argkeys>` never matches the stamped sibling) OR the id-churn/inconsistency is
beyond the cfid-empty fallback (e.g. the argkeys themselves differ, or futures use a separate
mechanism). CONFIRMED EMPIRICALLY: the keystone needs the harder full rewrite (cfid-independent
structural keying for BOTH branches, keyed on FIELD structure not name — since names are empty) or
upstream always-stamp-cfid; the minimal additive form is insufficient. Reverted; baseline 882.
FIELD-STRUCTURAL REFINEMENT — IMPLEMENTED + VALIDATED, ALSO REGRESSED (9th approach). Built the
field-structural side-table (`<name>|<fieldsig>`, fieldsig = labels + recursive field-type keys,
computed under the g*tk_visited guard for both the gs* record and cfid-empty lookup): corpus 97/97,
std 152/152, PERF FINE (std check 31s = baseline, so the hot-path field recursion did NOT regress
perf), but stage-2 885 (+3: incompat 208, undeclared 412). So BOTH additive side-table variants
regress (name +2, field +3) via OVER-MERGE — a structural signature collides distinct types
(same name+fields, or empty-name+same-fields) and hands an unstamped copy the WRONG sibling's key.
The additive-side-table approach is now DEFINITIVELY DEAD (2 validated implementations). The
def↔use mismatch is NOT recoverable by mapping a structural sig back to a stamped key — the fix
must be the FULL cfid-independent rewrite (replace the `gs_` cfid scheme itself, not augment it) or
upstream always-stamp-cfid, both dedicated deep work. Original (stale) analysis below:
FIELD-STRUCTURAL REFINEMENT — ANALYZED, NOT SAFE AS A SIDE-TABLE: to make cfid-empty copies recover
the stamped key via a FIELD signature (labels + recursive field-type keys, since names are empty),
the signature must be RECORDED in the common cfid-present `gs_` branch — i.e. field recursion added
to the HOTTEST type_key path, which risks regressing the PERFORMANCE half of the goal (currently
met; type_key runs constantly during codegen). Plus over-merge risk for same-C-layout distinct
types. So a hot-path side-table is disqualified. The viable designs are: (1) CACHE the fieldsig
per struct id (compute once), then key by it in both branches; (2) make cfid ALWAYS stamped upstream
(evaluator) so branch (b) never fires — the root, but the churn source that has resisted fixes; or
(3) key generic instantiations by (base-struct-id + argkeys) if a STABLE base-struct id independent
of instantiation churn exists. All are dedicated-session work with perf + regression validation.

**KEYSTONE FIX DESIGN CONSTRAINT (critical — determined this session by reading type_key.yo:102-134).**
The `.Struct` arm has TWO generic-instantiation branches: (a) cfid non-empty + type*args →
`gs*<cfid>_<argkeys>`; (b) cfid EMPTY → `g_struct_cfid_keys.get(sid)`or raw`sid`. The def↔use
inconsistency is that ONE logical type reaches (a) at some sites (cfid stamped) and (b) at others
(unstamped copy, churning id) → two different keys. Making ONLY branch (b) structural does NOT fix
it: (b)'s structural key (`gsx_<fields>_<args>`) would differ from (a)'s cfid key (`gs_<cfid>_<args>`)
→ still two keys for one type. THE FIX MUST BE CFID-INDEPENDENT FOR BOTH BRANCHES — key every
generic-instantiation struct purely structurally (field labels + recursive field-type keys +
type_args, under the existing g_tk_visited cycle guard), so cfid-present and cfid-empty instances
agree. This is a MAJOR, delicate rewrite of type_key's core struct keying (the cfid-based `gs_`
scheme was itself added to fix earlier same-fielded-instantiation collisions — see commits
"struct-identity cache collision" / "Codegen layer-2 stable type identity"), so it needs a
dedicated session + full corpus/std/stage-2 validation, not an end-of-session edit. Alternative
(upstream, evaluator-side): ensure cfid is ALWAYS stamped on generic-instantiation structs so
branch (b) never fires — but that's the same churn source that has resisted fixes all along.

**COMPLETE 882-error-space MAP (all 4 classes root-caused; all deep/multi-front):**

- **incompat 206** — codegen type-identity; NOT evaluator-fixable (7 approaches exhausted, below).
  Fix = codegen `type_key` cfid-empty generic-instantiation struct fallback + coupled evaluator
  distinguish, in that order.
- **member-ref 95** — ALL are `base type 'void'`: the SYNCHRONOUS-AWAIT codegen
  (await.yo:413-414) emits `${future_type_name} __sync_future = ...; ...->state`, but
  `future_type_name = get_type_string(future_type)` resolves to `void*` because the async fn
  (e.g. `yo_id_6900`) returns `void*` instead of its concrete Future state-machine struct — the
  Phase-5 async SM-struct-TYPE-resolution gap. `->state`/`->__yo_resume_fn` on `void*` = the 95
  errors. Independent of type-identity. ROOT LOCATED (this session): `get_type_string`'s SomeT arm
  (index.yo:775-790) tries `lookup_some_resolved_concrete(sid)` then `get_type_c_name(type_key(t))`
  → both MISS → void\*. WHY they miss: the only `register_some_resolved_concrete` in async codegen
  (async.yo:2064) registers the io.async block's OUTPUT type, NOT the future's SM struct; and async
  FUNCTIONS (vs io.async blocks — which do get `io_async_block_..._sync_fut_t` structs) never
  register an SM struct under their future return type at all. NO clean local cast (the generic
  `__yo_future_generic_t` uses field `resume_fn`, but the emitted code + concrete SM structs use
  `__yo_resume_fn` — different names). FIX = register each async function's SM struct in
  `context.types` under `type_key(future_return_type)` (and/or `register_some_resolved_concrete`
  under the future SomeT id) during the async pre-pass, so get_type_string resolves it. Substantial
  Phase-5 feature (async-fn SM-struct emission + type registration), not localized.
- **undeclared 409** = 266 `g_*` module-globals (module-var port, gated on type-identity) + 92
  local + 39 temp stragglers (scope-end/synthesized-fn drop path, see
  [[yo-self-stage2-drop-emission-order]] ABANDONED extension) + 15 `fn_yo_id` effect-handler
  fn-pointers (Phase-5 effect-handler codegen). rest scattered.
  Every remaining class is a deep codegen change (type-identity, Phase-5 async, Phase-5 effects) or
  gated on type-identity — none is a localized fix. Session brought 3643→882 (−307 this continuation:
  temp-drop −101, early-return-drop −203, shared-type_key −3).

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

---

## Session 2026-07-03 — decisive root decomposition (baseline held at 399)

**Baseline re-measured clean: 399 clang errors, stage-2 C = 497 MB. TS emits the
SAME source (`yo-self/main.yo`) as 51.7 MB → yo-self over-emits ~10×.** The 10×
is NOT function count (stage2 has 3738 fn bodies vs TS 6522 — FEWER) — it is
per-identifier blowup: single C type-identifier lines reach **224 KB**.

### Root A — `type_key` structural blowup (the 10× size; ~5 direct errors + all bloat)

`codegen/utils/index.yo:get_type_string` emits the full structural `type_key`
as the C type name. TS instead uses `context.types[type.id].cName` — a SHORT,
stable name keyed by a NUMERIC type id (getTypeString, utils/index.ts:521).
yo-self's `TypeValue` has no numeric id, so `type_key` (types/type_key.yo)
recursively expands the whole nested type; its `g_tk_visited` set only cuts
NAMED-type cycles and does NOT cut recursion THROUGH `Struct` wrappers → the
compiler's own recursive enums (`TypeValue`/`AstExpr`) expand to 224 KB names.
Fix = intern types to short ids (structural key → counter → `yo_t<N>`), the
faithful mirror of TS's `id → cName`. LARGE (touches every `get_type_string`
call site + all C type names → high corpus/std regression risk). Bounding/
truncating names instead is UNSAFE (distinct types would collide).

### Root B — async future lowered to `void*` (108 `'void'` errors + most of the 265 cascades)

Await emits `void* __sync_future_N = ...; __sync_future_N->state;` — `void*`
has no members → "member reference base type 'void'" + "assigning from
incompatible type 'void'". `await.yo:378` DOES call
`get_type_string(future_type)`, but `future_type` is a `SomeT` whose
`get_type_string` arm (utils/index.yo, `.SomeT`) misses BOTH
`lookup_some_resolved_concrete(sid)` and `get_type_c_name(type_key(t))` →
`void*` fallback. The async pre-pass registers the SM/sync-fut struct under
`type_key(block.future_type)` (`async.yo:1463`), and `type_key(SomeT)` = the
SomeT's **id string** (type_key.yo:232). So registration and await only match
if the future SomeT's **id is preserved** from async-fn-return synthesis to the
await site — it is NOT (fresh `random_id`, same SomeT-identity class as the
generic-impl funcId blocker `yo-self-phase3-generic-impl-funcid`). This is why
the prior "register under fn-return SomeT" attempt was a NO-OP: the id itself
diverges. Fix requires preserving/threading the future SomeT identity (deep),
OR resolving the future SomeT → concrete registered struct at await via the
`FutureTraitT` (localized but unproven; risk another no-op).

### Root C — generic static-method funcId collision (this session, FALSIFIED as the fix)

Static methods on generic types (`HashMap._alloc_with_capacity`, `.new`,
`.with_capacity`) resolve via the FLAT trait-method registry
(`env.yo:get_type_trait_methods_by_name_from_env` → keyed by
`type_id_or_empty` which DROPS type_arguments), returning a SHARED base
func_id. TS instead attaches per-concrete-type methods (distinct funcId
encoding `Self`, impl.ts:1551) to the concrete type's `.trait`.

- **Attempt 1** (impl.yo `_inject_forall_captures`: bake concrete impl-forall
  bindings into the method func*id, gated all-concrete): built clean, corpus
  path OK, **but stage-2 stayed EXACTLY 399** — the suffix reached find_methods-
  resolved methods (13263/13298 got `\_usize_gs*...`) but NOT the static registry
path (`with_capacity` 13320 stayed bare). Neutral. Reverted.
- **Attempt 2** (env.yo `_specialize_method_ids_for_concrete_receiver`: rewrite
  registry-resolved static-method func_ids by the receiver's concrete
  type_arguments, gated all-concrete, fresh MethodEntry copies): **REGRESSED
  399 → 589** (C shrank 497 MB → 48 MB ≈ TS size, but +190 errors — 265
  "expected expression" from malformed bodies). Reverted. Lesson: distinct
  func_ids WITHOUT re-resolving the concrete return type just multiply
  mismatches; `with_capacity` already returns a concrete enum (NOT collapsed),
  so Root C was never the void-collapse source — Root B is.

**Conclusion:** all three roots are deep type-identity / interning ports, each a
dedicated-session change; two localized attempts this session were falsified and
reverted. Baseline preserved at 399 / clean tree. Highest-leverage next target =
Root B (108 + cascades) via future-SomeT-identity preservation, then Root A
(interning) for size+perf.

### Session 2026-07-03 (cont.) — LANDED: C-type-name interning (Root A) + Root B mechanism pinned

**COMMITTED `d632fc845` — stage-2 C 497 MB → 57.5 MB (8.6×, ≈ TS 51.7 MB), errors unchanged 399, corpus 97/97 / std 152/152 (zero regression).** collection.yo:180 built the emitted C type name as `__yo_<full type_key>`; for recursive `TypeValue`/`AstExpr` that reached 200 KB+ per identifier. Added `_intern_type_c_name` (collection.yo): a global `HashMap<type_key,__yo_t<N>>` — pure content-addressed rename (registry still keyed by full type_key; enum tags/variant names derive from the registered c_name so they shrink too). The giant names were NOT causing clang errors (clang tolerates long identifiers), but this serves the performance half (C size ≈ TS) and makes stage-2 clang ~8× faster to iterate. NOTE: `type_key` still BUILDS the 200 KB strings internally (intern map key) — a further bottom-up-interning-inside-type_key change would also speed up yo-self's own emit; deferred.

**Root B mechanism PINNED (now readable in the 57 MB C).** An async fn (e.g. `yo_id_7197`) BODY creates + returns the concrete `io_async_block_<id>_sync_fut_t*` (struct EXISTS + is registered under `type_key(block.future_type)`), but the fn's DECLARED return type is `void*` because `get_type_string(fn_return_type)` misses: the fn-return future `SomeT` id ≠ the inner io.async block's future `SomeT` id (both implement Future, different random_ids). Caller does `void* __sync_future = yo_id_7197(...); __sync_future->state;` → "member reference base type void". This is exactly why the prior "register SM struct under fn-return SomeT" was a NO-OP — the two SomeT ids diverge, so registering under one doesn't help the other. FIX DIRECTION (next focused session): at async-fn SIGNATURE generation, resolve a future-`SomeT` return type to the fn body's io.async block struct name (link via the existing `_set_async_sm_struct_name` expr→struct side-table), rather than trying to reconcile the two SomeT ids. Fast iteration loop now available (57 MB clang).

### Session 2026-07-03 (cont. 2) — LANDED: async-fn Future return override (Root B), 399→304

**COMMITTED `9cbf4f245` — stage-2 clang errors 399 → 304 (−95), void-class 108 → 13, corpus 97/97 / std 152/152 (zero regression).** Root B fixed: async fns returning `Impl(Future(T))` were declared `void*` → callers' `io.await` did `void*->state`. yo-self had ported `find_returned_async_block` + the `override_return_type` plumbing but NEVER wired the computation (declarations.yo explicitly deferred the Future branch as "Phase 5"). Faithful port of TS declarations.ts:505-519 / generation.ts:1206: `_async_override_return_type` (declarations.yo) resolves the returned io.async block's SM struct (`<struct>*`), applied to BOTH the prototype (generate_function_declaration) and the definition + `return`-statement casts (generate_function → context.override_return_type_str). KEY EXTRA STEP that closed the caller side: also `register_type(type_key(ret), ret, <struct>*)` so a CALLER's `get_type_string(call_result)` resolves to the concrete struct — the fn-return and call-result SomeTs SHARE a type_key (this is why the earlier "register under fn-return SomeT" note read as a no-op: it was never tried together with wiring the override + it needed the type_key registration, not the async-block-side registration).

**Remaining 304 decomposition:** 46 undeclared-ident + 46 incompatible-init + 45 implicit-int + 28 expected-expr + 21 non-const-init + 19 K&R-param + 17 expected-id + 9 member-ref + ... Two clusters:

1. **~56 `// Failed to transpile` + `// Error:` emitted comments** replacing code (→ implicit-int / expected-expr / K&R cascades). Dominant sub-root: control-flow nodes (`if`×13, `while`×8, `cond`×3, `usize(n)`×4, `match`) whose **ExprInfo is MISSING** (generation.yo:408) inside effect/async-transformed function bodies — the Phase-5 transform produces nodes without ExprInfo. Plus specific gaps: `JoinHandle.await return type must be Option(T)` (×5), effect-throw `dyn(...)` transpile, `(() < ())` empty-operand comparisons.
2. **~59 incompatible-init + undeclared** = the generic-instantiation type-identity roots (still open; `gs_<cfid>` vs bare sid).

Session net: stage-2 **882 → 304 (−578)** across the broader effort; C size **497 MB → 57 MB**. Both halves advanced (perf: C ≈ TS; self-compile: −578). Self-compile still non-zero.

### Session 2026-07-03 (cont. 3) — remaining-304 UNIFYING root: def-time body-eval halts mid-function

Investigated all 304 clusters + a minimal repro. KEY finding: the two biggest clusters share ONE root.

- **`// Failed to transpile if/while/cond`** (missing ExprInfo, generation.yo:408) AND **`use of undeclared identifier fn_yo_id_*`** (unemitted effect handlers) both come from **def-time body evaluation HALTING partway** in complex functions (e.g. the CLI `compile` handler `yo_id_398441`): nodes BEFORE the halt get ExprInfo + emit fine; the halt point + everything AFTER lose ExprInfo → control-flow emits `Failed to transpile`, and effect-record constructions after the halt never run `collect_effect_record_members` (collection.yo:418) so their `.throw = fn_yo_id_N` handlers are never collected/emitted → undeclared. This unifies ~100+ of the 304 (Failed-to-transpile ~56 + undeclared-handler ~45 + implicit-int/K&R/expected-expr/expected-id cascades).
- The halt = an eval throw swallowed by the def-time trial-eval wrapper (which wraps the WHOLE body, so a mid-body throw stops the tail). yo-self's evaluator throws where TS succeeds.
- **Minimal repro of the exact halt construct** (`cond((s=="") && flag => ..., ...)` + statements after, self-hosted binary emit-c) did NOT reproduce — `after-cond` present, 0 Failed-to-transpile. So the halt is CONTEXT-SPECIFIC (the throwing construct depends on the function's specific types/methods — e.g. `Command.arg` resolution, effect `exn`/`io` params), not the control-flow shape. Pinning it needs evaluator instrumentation on the specific halting functions (find the swallowed throw).
- Other residual clusters: enum/newtype C-name identity collision (`__yo_t3` = both `enum_yo_id_4021` AND a String-newtype typedef — needs `type_arguments` on EnumT, 62 fragile positional destructures); JoinHandle.await result-type is an unresolved SomeT not Option(T) (await.yo:612 bail — evaluator gap).

All deep/context-specific; no safe narrow fix found. Baseline held at 304 (committed 9cbf4f245), corpus 97/97, std 152/152.

### Session 2026-07-03 (cont. 4) — DOMINANT root NARROWED to a precise reproducible bug: `String == <str literal>` at def-time

Instrumented the def-time trial-eval swallow (`_trial_eval_fn_body`, function_type.yo:217) to print swallowed errors — only **7 throws total** for the whole main.yo compile; the dominant is **4× `Cannot unify incompatible types: "String" and "str"`** (+ a cascading `Expected bool type for "and" argument`). This is THE halt that de-populates ExprInfo (see cont.3) — it fires in the CLI compile handler's clang-flag `cond` (`main.yo:1126`: `(optimize == "") && release`), stops body eval, and cascades to ~100 errors (Failed-to-transpile + undeclared handlers).

**Minimal repro (src/tests/fixme.yo)**: a fn `(optimize: String, release: bool)` with `cond(((optimize == "") && release) => ..., ...)` — REPRODUCES (`[TTERR] Cannot unify "String" and "str"`, `after-cond` present but the cond emits `Failed to transpile`). Backtick ` ` ``(String) does NOT reproduce; the double-quote`""`(a`str`/comptime_str literal) is required — the bug is `String == str`.

**Diagnosis (OPSEL instrumentation of the operator path, function.yo:1286+)**: overload selection is CORRECT — for `recv=String` there are 2 `==` candidates (`cand[0] self:String other:String` = Eq(String); `cand[1] self:String other:str` = Eq(str)), and it correctly picks `chosen=1` (Eq(str), the str overload). **Yet the subsequent `try_to_call_function_with_arguments(first_m.value, first_m.ty, ...)` STILL throws** `Cannot unify String and str` at **synthesizer.yo:1848** (tag-mismatch fallback: expected `String` Struct-tag vs given `str` Str-tag). The Eq(str) `==` BODY (std/string/string.yo:1462) is clean (self.\_bytes / other.len()/ptr()). So the mismatch is in the CALL's arg/self synthesis, NOT selection or body — most likely the parametric-trait `Self` substitution (`impl(String, Eq(str))` — the FuncVal VALUE's `self:Self` binding Self→str instead of String at call time; cf. `[[yo-self-parametric-trait-impl-self-subst]]`), or the `!=` default `not(Self.(==)(lhs,rhs))` typing rhs as Self.

**NEXT (focused, high-leverage — unlocks ~100 of 304):** instrument `try_to_call_function_with_arguments` (helper.yo) for the `==`/String case to find which arg↔param unification hits synthesizer.yo:1848 with (String, str); the fix is to ensure the selected Eq(str) method's `self` binds to String (receiver) and `other` accepts comptime_str→str at the def-time call. Repro is instant (src/tests/fixme.yo + `<bin> compile --emit-c`; grep `Failed to transpile`). Baseline held at 304 (all instrumentation reverted; corpus 97/97, std 152/152).

### Session 2026-07-03 (cont. 5) — String==/!=str root pinned to the EXACT synthesize call

Instrumented the arg-synthesis (`check_if_function_parameter_matches_argument`, helper.yo:573) — the failing synthesize is **`param="String" arg="str" label="other"`** → `synthesize_types(String, str)` → tag-mismatch throw (synthesizer.yo:1848). The infix `==` overload selection is CONFIRMED CORRECT (OPSEL: 2 candidates `other:String`/`other:str`, picks `other:str`). So the throw is NOT the infix `==`; the `label="other"` (a `==`/`!=` METHOD param, not the `!=` default's `lhs`/`rhs`) points to **`Eq(String).==` (other:String) being invoked with a `str` arg** — i.e. the **`!=` default `not(Self.(==)(lhs, rhs))`**: its internal `Self.(==)(lhs, rhs)` call (a `String.(==)` method dispatch, NOT the infix path, so it bypasses the operator-selection at function.yo:1292) resolves `==` to the `Eq(String)` overload and passes the `str` rhs → throws.

**EXACT FIX (focused, unlocks ~100 of 304):** make the internal `Self.(==)(lhs, rhs)` dispatch (and any multi-overload `==`/`!=` METHOD call, not just the infix operator) select the overload whose param matches the arg type — i.e. route it through the same `_select_matching_overload` logic the infix path uses, OR coerce the `str` rhs against the chosen `Eq(str)` overload. Repro: src/tests/fixme.yo (`String == "<str literal>"` in a cond). Instant test: `<bin> compile src/tests/fixme.yo --emit-c` → grep `Failed to transpile` / stderr `Cannot unify "String" and "str"`. Baseline held at 304 (instrumentation reverted; corpus 97/97, std 152/152).

### Session 2026-07-03 (cont. 6) — String==str fix LANDED (correct, stage-2-neutral); unifying-root theory CORRECTED

**COMMITTED `2db874987`** — property_access defers multi-overload `Type.method` resolution to the call-site `_select_matching_overload` (mirrors the infix path). Fixes the real `String ==/!= str` bug (the `Eq` `!=` default's internal `Self.(==)(lhs, str_rhs)` no longer picks `Eq(String)` and throws). Validated corpus 97/97, std 152/152. **Stage-2 NEUTRAL at 304** (the 4 String/str throws were swallowed; removing them changed no emitted C).

**CORRECTED understanding (earlier cont.3 theory was WRONG):** the ~56 `Failed to transpile` / missing-ExprInfo cascade is NOT caused (solely) by the def-time throws. Proof: with the String==str throw fixed, the repro's `cond` STILL emits `Failed to transpile` with NO throw. The 7 swallowed def-time throws (4 String/str now fixed; remaining: `Incompatible types`, `Frame level N has different number of values`, `Expected bool type for "and" argument`) are SEPARATE from whatever leaves the cond without ExprInfo. So the cond halt is driven by MULTIPLE independent def-time throws AND/OR a distinct missing-ExprInfo mechanism (node-id/clone mismatch, or runtime-return fn body only partially evaluated — early statements got ExprInfo, the cond did not).

**NEXT:** re-capture the remaining def-time throws WITH the String==str fix in place (re-instrument `_trial_eval_fn_body` swallow, function_type.yo:217, rebuild, grep `[TTERR]`), fix each remaining gap (`Frame level` = cross-arm binding count; `Expected bool for "and"` = `&&` operand typing; `Incompatible types`), and separately investigate why the cond node lacks ExprInfo even absent a throw. Repro: src/tests/fixme.yo. Baseline: 304 (all wins committed; corpus 97/97, std 152/152).

---

## Session 2026-07-04 (Fable) — 304 → 171 via three landed root fixes

**Method that cracked it:** tag ALL 8 evaluator swallow sites (`-> unwind(())`) with unique
eprintln markers → only 3 def-time throws remained in the whole main.yo compile → bisect each
with single-construct repro files against the debug binary (no rebuild per probe).

1. **`dd7b0a78b` trait `?=`-default fill at impls** (impl.yo; TS trait-type.ts:418-489 mirror):
   defaults were registered in the trait-defaults side-table but NEVER filled into impls —
   `impl(String, Eq(str)((==):...))` had no str-rhs `(!=)`; `optimize != ""` picked
   `Eq(String).(!=)` and threw String-vs-str at def-time = the DOMINANT Failed-to-transpile
   root (FTT 56→23; if×13→0). Same commit: type-DECL emission dedup by C name
   (types/generation.yo) — two type_keys → one c_name double-emitted "redefinition of
   enumerator" ×33. Errors 304→360 (holes unmasked)→322.
2. **`57932bdbd` concrete-vs-SomeT compat rule + primitive registry ids** (−151, −47%):
   compatibility.yo ports TS compatibility.ts:800-828 (unconstrained SomeT accepts any
   concrete non-exact; constrained SomeT checks implements via new
   `set_compat_type_implements_trait_fn` hook); trait_checking.yo `_type_id_for_trait_check`
   → `type_id_or_empty` (primitives returned "" → registry lookup skipped →
   `bool <: LogicalNot` false → prelude `(!)` module rejected bool operands inside `&&`).
   322→**171**; implicit-int 45→5; K&R cascades gone.

**Remaining 171:** 59 incompat-init = the `with_capacity`/`new` Self-collapse (ONE shared
FuncVal per struct-internal static method of a generic type ctor — `enum_yo_id_13319`
emitted as t122/t575/t792..t800 with different HashMap payloads; producer/consumer pick
different instantiations). Fix IN FLIGHT (helper.yo): include `ctx.self_type` in the
specialization CACHE KEY (compile*time_args, a TypeVal — compile-time only, no C arity
change, unlike the regressed runtime_param_tys attempt) + a `\_self*<type_key>`SIG segment,
GATED on the func type mentioning a`Self` SomeT. ~12 FTT sites left (3rd throw =
"Frame level 3" await.yo:125 arm-merge; statx cond; evaluator while; argv index-call).

### Session 2026-07-04 cont. — 171 → 132 via two more landed fixes; remaining-132 map

3. **`865551e29` specialization keyed on (resolved) return type** (−26): with_capacity
   Self-collapse CLOSED — call sites pass the PER-INSTANTIATION struct-field func_type
   (concrete return), so keying the cache (extra COMPILE-TIME TypeVal — no C arity change)
   - a `_ret_<type_key>` sig segment splits the collapsed family (47 bare
     yo_id_13320 callers → 0). Two negative gates first (self_type-named-SomeT;
     SomeT-only-return): both neutral — the colliders have CONCRETE declared returns.
4. **`a70f2ad51` `_is_bare_literal` leading-digit requirement** (−13): identifiers of
   digits+[fFlLuU] (`l1`, `f2`) were classified as numeric literals → ref-args wrapped in
   compound literals `(&((String){l1}))` → newtype-over-enum initialized `.tag` with a
   String (the 13× `__yo_t3_tag ← __yo_t2` cluster).

**Remaining 132:** 24 expected-expression (dominant sub-root: statx/fs `io.await`-in-closure
result emits empty operands `(() < ())` — async family ~12); 22+7 undeclared (mixed user
vars + 4 unemitted effect handlers `fn_yo_id_*`); 29 incompat-init (enum-identity churn
`enum_yo_id_13319` t122/t575/... + misc); 10 call-to-undeclared `fn_yo_id_2230`/`fn_yo_id_5802`
(callers reference the UNSPECIALIZED trait-default/dyn method func_id — the operator call
must specialize at eval; an infix-operator-callee collection branch in
functions/collection.yo was tried and NEUTRAL — callers need the SPECIALIZED id, not
registration of the generic one; reverted); 9 member-ref; 10 returning-incompat; misc tail.

### Session 2026-07-04 cont.2 — 132 → 131; next root pinned

7th fix `d1ac8407c`: `_is_dot_access` accepts `<recv>.io.await/state/spawn` (effect-bundle IO
field) — TS's `ioBuiltin` marker is semantic; the bare-atom-`io` syntactic check missed
`e.io.await(...)`. Validated corpus/std; net −1 (unmasking).

**Next root (statx closure, ~12 empty-operand errors):** `closure_yo_id_7340`
(std/fs/metadata.yo) STILL emits no await — the `result := e.io.await(statx(...), e.io)`
STATEMENT is dropped entirely: the EVALUATOR never stamps ExprInfo for the await call in
this closure (the FuncVal-callee arm at function.yo:3288 only fires when `e.io.await`
resolves to a FuncVal; `e` is the effect-record param — resolution bails earlier, and the
init-assignment emitter silently drops a statement whose RHS lacks ExprInfo — the OPEN
"Block-RHS drops statements" behavior). Debug next by instrumenting the eval of `e.io`
property access inside that closure's def-time eval. Remaining 131: this async/effect tail
(~40), unspecialized operator-method callees fn_yo_id_2230/5802 (10), unemitted effect
handlers (4), enum-identity long tail (max 2/pair), misc.

### Session 2026-07-04 cont.3 — statx/async family investigation state

- `e.io.await(...)` in the io.async closure (std/fs/metadata.yo `_stat_path`) still emits
  nothing after the `_is_dot_access` fix: the failure is NOT a def-time throw (TT-DEF shows
  only "Frame level 3" remaining) — the closure body evaluates WITHOUT stamping ExprInfo for
  the await statement (silent structural gap), and the init-assignment emitter silently drops
  an info-less statement. The io.async block is then classified NO-await (sync-future path)
  and the closure's return type degrades to bool (`sm->result` type mismatch errors).
- There is NO eval-side special-case for io.await — bare `io.await(...)` works as an ordinary
  field-method call on the `Io`-typed param. `e.io.await(...)` differs only in the receiver
  being a FIELD ACCESS on the (unknown-valued) effect-record param — suspect: property access
  `.io` on an unknown-value struct yields no usable receiver info, so the `.await` call
  resolution silently bails.
- Standalone repro is blocked on harness shape: TS rejects bare `(e) =>` without the
  Future(..., IoExn) expected type flowing from a fn-return position; effectful awaits need
  the handler context (std-internal pattern; NO corpus/test coverage — which is why this gap
  survived). NEXT: instrument `evaluate_property_access` for field access on unknown-value
  struct receivers + the method-dispatch entry for `.await`, compile main.yo with the debug
  binary, grep the metadata closure. Then fix eval to stamp the await ExprInfo (TS does —
  its `ioBuiltin` marker rides on the FIELD TYPE, receiver value not needed).

Baseline: 131 (7 fixes committed this session; corpus 97/97, std 152/152 at every step).

### Session 2026-07-04 cont.4 — async family: probe results (INVALID earlier zeros; real data now)

**TOOLING LESSON (important):** three probe cycles produced FALSE zero-hit conclusions because a
leftover probe captured `arg` in a `->` Exception handler (illegal — capture-free), which made
`function.yo` FAIL TO IMPORT; the grep-filtered build output hid the failure, and the stale
`/tmp/yo-self-dbg` binary kept "working". ALWAYS verify a probe string exists in the emitted
`.c` before trusting a zero-hit run (`grep -c PROBE /tmp/<bin>.c`).

**Valid probe data (verified binary):** every `io.await` call in the compile evaluates exactly
ONCE and stamps ExprInfo (`[EVALAWAIT] ... pred=true` ×71; `[INITAWAIT] ... info=true` ×52,
including std/fs/metadata.yo:112 and all file.yo awaits). The eval side is FINE. The await
STATEMENT vanishes at CODEGEN: `generate_await` never runs for it (no AWAITSM hits, no error
comments) — the codegen init-assignment (codegen/exprs/init_assignment.yo:182-187) silently
returns "" via one of TWO skip branches: `_last_is_compile_time_only` or `_last_is_module_level`
on the LHS var (`result`), read from `lhs_ei.env`'s LAST binding. Eval-side determination says
result should be neither (force_compile_time_bindings=false in the closure-body ctx;
is_module_level=false because is_evaluating_function_body_or_async_block is Some) — so the
codegen reads a DIFFERENT/stale binding for `result` from the lhs ExprInfo env snapshot.
**NEXT (one build):** instrument both skip returns in codegen init_assignment to print
(fn, var, which-skip) — that pins the wrong-binding source; then fix the binding/env snapshot.
