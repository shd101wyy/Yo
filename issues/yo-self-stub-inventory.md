# yo-self stub inventory — every unfaithful port, measured (2026-07-26)

Each yo-self module read against its TS counterpart in `src/`. Produced because
bugs traced this session were exactly this shape: a "simplified port" of
`find_methods_from_generic_impls`, a TOP-LEVEL-ONLY `type_contains_some_type`
where TS recurses, a closure path skipping TS's `resolvedConcreteType` stamp.

**300 findings** across 10 areas: 153 medium, 78 high, 35 low, 34 none-observable.

HIGH = can produce a MISCOMPILE or wrong C. Fix faithful-port-first: TS's
mechanism, in TS's place, via yo-self's EXISTING equivalents. Inventing a
yo-self-only heuristic is wrong even when it makes a test pass.

## Area summaries — the worst gap in each

### codegen-core

The codegen-core area (codegen_c.yo, constants.yo, utils/**, functions/**) is a substantially complete and unusually well-annotated port — the GC/RC runtime prelude, unwind-value buffer, ref-struct/ref-enum constructors, dyn emitters, and the prototype/body/main-wrapper skeleton are faithful, and several apparent stubs (generate_closure_constructor_functions, generate_closure_constructor_declarations, generate_closure_vtable_declarations, get_evidence_parameters, dyn.yo's traverse_fn=NULL TODO) are verified-faithful ports of TS no-ops, not gaps. The real gaps cluster in two places: (1) whole TS pipeline stages that compile_module simply never calls — preRegisterEffectfulFunctions, generateLibraryInitFunction, generateClosureDisposeFunctions, generateSpecializedFunction{Declarations,s} — and (2) the collection/skip boundary, where yo-self both over-skips (a merged should_skip_function_codegen that drops TS's `!specializedType && caches===0` guards on the hard-generic skip) and under-collects. The single worst gap is that compile_module never walks module-level mutable-variable initializer expressions with find_function_calls_in_expr (TS codegen-c.ts:121-125) even though generate_main_wrapper DOES emit those initializer RHS expressions into `__yo_main_module_init()` — so any function reachable only from a global's initializer is emitted at its call site but never collected, declared, or defined. A close second is generate_main_wrapper omitting `__yo_async_wait_all()`, which silently drops in-flight async work at program exit, and the yo-self-only `abort()` rewrites (generation.yo:509, dyn.yo:412) that convert untranspilable emissions into runtime traps and can mask codegen failures as green builds.

### codegen-exprs

The `codegen/exprs` + `parallelism` + `shared`/`c`/`utils`/`codegen_c` area is much further along than its module headers claim — several headers are demonstrably STALE (atom.yo:12 says the `inout` deref is omitted but `_var_read_code` implements it; recur.yo:4 says the ref-strip is deferred but it is ported; downcast.yo:11 says `is_boxed_type` is hardcoded false but it is a real predicate; other*fn_call.yo:6-10 says the call dispatcher is a TODO stub but it is ~1800 lines and live; init_assignment.yo:15 and return.yo:12 both call live code \"gated dead\"), so the headers cannot be trusted as an inventory and every claim here was verified against the code. Faithful, semantically-equivalent adaptations are common and I have called them out as such (the empty `get_evidence_parameters`, the dead `continuationVariables`/`closureCaptureMap` branches, `random_id` for TS counters, SM c_names registered with the `*`already attached). The single worst gap is that the async/effect state-machine WRITE side is missing while the READ side is ported:`other_fn_call.yo`'s `\_store_temp_var_to_state_machine_if_needed`is a`()`no-op that is not even called (TS calls its counterpart at ~18 sites),`match.yo`never writes destructured arm variables into`sm->var\*<id>`(TS does at 4 sites), and`assignment.yo`skips the SM save-old-value entirely — so inside an async block, atom.yo faithfully resolves reads to`sm->var\_<id>`fields that nothing ever wrote, yielding zero-initialised values and NULL/garbage deferred drops after every suspension. Close behind it are three silent-miscompile holes with no diagnostic at all:`asm`/`global_asm`emit a comment instead of the assembly (tests/asm.test.yo exercises this),`begin.yo` assigns its final expression to the block temp with no deferred-`\_\_\_dup`rewrite (RC undercount → UAF, and`begin`is everywhere), and`downcast.yo`omits the`wasBoxed`extraction while`dyn.yo`genuinely boxes value types (type confusion on`dyn.data`). The effect subsystem is the largest wholly-unported region: no `in_effect_state_machine`context field and no`pre_register_effectful_functions` stage.

### evaluator-calls

yo-self/evaluator/calls/\*\* is far past "stub" for the hot paths (function.yo, helper.yo, comptime_fn.yo, index_trait.yo are large, heavily-annotated real ports), but three files are still materially unfinished — closure_type.yo, function_type.yo, and trait_type.yo — and every file leaks small TS branches. There are no TODO/FIXME markers at all; every divergence is written as prose in a `//!` header or an inline comment, and several headers are now STALE (helper.yo:1 still says "stub", function.yo:12 says method calls/CTFE/macros are "deferred to Phase 4" when they are implemented, function_type.yo:408 says def-time body eval is skipped when it now happens). Ranked by blast radius the single worst gap is `create_specialized_function_inline` (helper.yo:1249-1263, "Phase 3 simplification: all regular params are treated as runtime"): TS pushes every `isCompileTimeOnly` regular parameter's VALUE into `compileTimeArgValues` and excludes it from `runtimeParameterTypes` (helper.ts:2229-2254), while yo-self pushes only forall + implicit values and dumps ALL regular arg TYPES into the runtime key — so two calls that differ only in a `comptime(n)` argument compute identical cache keys AND an identical specialization signature, silently reusing the first call's monomorphized body (and its emitted C function) for the second. Close behind: closure_type.yo is missing the pre-compat `synthesizeTypes` on the closure return (closure-type.ts:186-196 — the exact mechanism that binds `io.async`'s outer forall T), the captured-ARC `___dup` generation, and the DynType `attachTempVariableToExpr`; and evaluator/calls/type.yo leaves `runtime_arg_exprs_in_order[i]` pointing at the type-callee expression for every defaulted struct field. Two soft fallbacks (helper.yo:3808 non-Func callee → unit-typed FuncCallResult; numeric_type.yo:337 non-numeric cast source → UnknownVal with no `__yo_as`) convert what TS treats as hard errors into silently wrong emissions.

### evaluator-core

The top-level `evaluator/*.yo` files are structurally near-complete ports — `memory_safety.yo` and `type_of.yo` are faithful 1:1, `context.yo` reproduces all but one `EvaluatorContext` field, and the two big files (`trait_checking.yo`, `utils.yo`) are dense, well-annotated ports whose divergences are mostly documented in prose. `eval.yo` (370 KB) and `index.yo` are dead weight for the compiler binary — neither is reachable from `main.yo`, so their many stubs are inert. The real damage is concentrated in a handful of silently-omitted branches rather than in the loudly-labelled "Phase 3 stubs". The single worst gap is `evaluator/utils.yo:1030/1058`: `merge_and_check_envs` collects a per-column `case_types` array and never reads it, dropping BOTH of TS's cross-branch type checks (`src/expr.ts:2013-2088`) — including the one that rejects an `Impl(...)` local whose `resolvedConcreteType` differs between cond/match arms. Since `Impl` is static dispatch and yo-self _does_ now carry a real `SomeT.resolved_concrete` cell, branch-divergent concrete types are accepted and codegen commits to one of them: a straight miscompile with no diagnostic. Close behind are three more high-impact omissions in the same family: `attach_temp_variable_to_expr` (utils.yo:112) lost TS's `isRef` and `isOwningTheSameRcValueAs` parameters, so `ref(T)`-returning calls get a temp declared `T` instead of `T*` and the RC borrow-alias chain is permanently empty; `type_contains_some_type_for_codegen_param` (trait_checking.yo:1265) never consults `SomeT.resolved_concrete`, so already-monomorphized parameters still read as generic in the C declaration path; and the entire associated-type-constraint mechanism is absent (no field on `TraitT`, a hardcoded `satisfied:true` stub that is never even called, and no `synthesize_types` binding propagation), so `where(T <: Iterator(Item := i32))` is satisfied by any `Iterator` at all.

### evaluator-exprs

yo-self/evaluator/exprs is a broadly faithful port at the control-flow/dispatch level (atom dispatch, `->`/`=>` forms, builtin routing, match exhaustiveness, cond, destructuring, test, typeof, unwind, subtype*of all track their TS counterparts closely, and several files are LARGER than TS), but the ownership/RC, FFI-metadata, and comptime-mutation layers have real holes, and — importantly — several module headers are STALE in both directions: `begin.yo` lines 5-11, `assignment.yo` 10-14 and `initialization_assignment.yo` 11-16 all advertise stubs (`type_contains_rc_type = false`, `clone_value`, `attach_temp_variable_to_expr`, `generate_deferred_drop_expressions`) that have since been fully implemented, so the headers cannot be trusted as a stub index. The single worst gap is that the evaluator drops \_all* C-header provenance: `c_include.yo` computes `c_header_file` (line 141) purely to validate it and then never attaches it to any field type or registry, where TS `c-include.ts:141/145/162` stamps `cInclude` onto every field type — yo-self's codegen `collect_c_includes` therefore reads `c_include` slots that `codegen/functions/collection.yo:674` always registers as `.None`, so no `#include <header>` is ever emitted for c_include'd FFI symbols. Close behind: `while.yo` never populates `comptime_unrolled_bodies` (its codegen consumer at `codegen/exprs/while_loop.yo:235` is dead code), `extern.yo` deliberately drops the `ioBuiltin` marker forcing name-based structural io detection everywhere, `_expr.yo`'s non-raw wrapper silently swallows every sub-evaluator error into an `err` expr (contradicting its own doc comment), and comptime pointer writes (`p.* = v`, `ptrTargetValue`, `ComptimeRef.StructRef`/`TupleRef`) are unreachable because nothing ever produces them.

### evaluator-misc

The async/suspension core is the weakest part of this area: yo-self replaces TS's `ioBuiltin` TYPE marker with purely syntactic `io.<method>` name matching (await_analysis.yo:85), so an Io bound to any other name emits no await state machine at all, while `is_join_handle_await_call` conversely claims every non-`io` `x.await(...)`; the typed AwaitPoint fields are then re-attached through a `token.character`-keyed side channel that can collide or silently drop points. Everything under shared/suspension_analysis.yo is otherwise a faithful (indeed enhanced) port, and effects/\*\* is a faithful port of a TS module that is now dead on both sides, so it is inert. builtins/ are broadly complete — full op coverage in the comptime numeric/string/list/index/rc/expr families — but three real correctness gaps hide there: comptime integers are i64-only with silent hex wraparound and no 64-bit clamping where TS uses bigint (`0xFFFFFFFFFFFFFFFF` → `-1`), `Impl(Concrete(T))` never stamps resolvedConcreteType (std/sys/future.yo's IoFuture depends on it, and codegen has to sniff the leftover trait), and `&(...)` skips TS's comptime→runtime type conversion so `converted_runtime_type` is never set and the codegen branch reading it is dead. utils/closure.yo is the other soft spot: three declared no-ops (move-consumption, path collection, capture trait validation) plus `enrich_captured_variables` ignoring the recorded `frame_level` and taking the last whole-env match, which mis-types capture fields under shadowing. asm, signature contracts, and the CTFE-capability module are outright unported (the first two fail loudly; the third silently forgoes nested-function comptime upgrades). The single worst gap is the structural Io detection: it is the only one that can silently emit a function with the await sequence missing entirely rather than erroring.

### evaluator-types

yo-self/evaluator/types/ is broadly complete for the "shape" work — struct/enum/tuple/union/field/trait/function/synthesizer all build the right TypeValues, and several module headers understate how much has since been ported (union auto-derive, dyn self-constraint expansion, macro registry, GADT support are all live despite headers saying "stub"). The real gaps are concentrated in three places: (1) `expr_synthesizer.yo` is still a literal identity no-op against a 263-line TS function, which makes the annotated-initialization compatibility check in `initialization_assignment.yo` VACUOUS (`are_types_compatible(pre_type, synth.ty)` compares `pre_type` with itself) and drops TS's `synthesizeTypes` unification of SomeTypes in the declared type — this is the single worst gap and is a direct miscompile vector; (2) `array.yo` silently substitutes `usize(0)` for any array length it cannot fold to an `IntLit` when the length expression is not a bare atom, producing `Array(T, 0)` (wrong sizeof / wrong C layout) instead of TS's stored `UnknownValue` length; (3) `synthesizer.yo` inverts TS's first-wins `resolvedConcreteType` stamp into last-wins and never places a fresh SomeType binding at `definitionFrameLevel` (TS's `deltaFrame`), both of which feed generic specialization and the async/FSM concrete-type reader. Beyond those, a broad class of _validation_ work is simply not wired: `validate_type_availability` exists but has zero callers, `definedInModulePath` is absent from every nominal type, atomic-object `Send` enforcement and the pre-field-eval `beginSendDerivation` cycle-break are missing, tuple auto-derive is a documented no-op, and trait where-clause constraints that fail on retry are silently DROPPED where TS re-runs them to produce a hard error.

### evaluator-values

yo-self/evaluator/values/ is broadly complete for the literal evaluators and the non-generic impl path, but it carries a dense cluster of real gaps. The single worst is the generic-impl method pipeline in impl.yo: `find_methods_from_generic_impls` (impl.yo:970-997) does a purely STRUCTURAL `substitute()` where TS's `reEvaluateFunctionType` re-evaluates the type in a specialized environment — TS's own comment (impl.ts:1443) says nominal Yo types cannot be substituted structurally — and it never re-evaluates the body or mints a per-instantiation funcId, while `GenericImplEntry` drops `traitTypeArgExprs`/`traitFunctionParamNames` entirely so parametric-trait impls never rebind their trait parameters. Close behind are four independent MISCOMPILE-class defects that produce wrong output with no diagnostic: float literals round-trip through `%g` and lose all precision past 6 significant digits (float.yo:60); non-ASCII char literals decode the first UTF-8 byte instead of the code point (char.yo:79); array.yo and anonymous_struct.yo both miss the `Some(UnknownVal)`-vs-`undefined` convention that tuple.yo already fixed, so runtime literals get bogus comptime values; and `type_id_or_empty` returns "" for Pointer/Array/Tuple/Func/Dyn receivers, silently discarding every concrete impl on those shapes. The closure path in anonymous_function.yo is the other hotspot: no temp-variable attachment, a FuncVal stored where TS stores `undefined`, the plain Func recorded instead of the resolved wrapper SomeT, and the missing `__impl_fn` intermediary that TS explicitly added to stop the Fn trait being stripped. Remaining findings are diagnostics-only (orphan/duplicate impl, uninitialized module vars, impl field syntax) or documented deliberate trades (where-clause scoping, allow-listed SomeT substitution). generic_impl_registry.yo is entirely dead code holding a stale pre-Phase-3.5 copy of the same API.

### root

The root-level modules split sharply into two tiers. The pure syntactic layer — lexer.yo, token.yo, parser.yo, error.yo, formatter.yo, and the small tooling modules (cache/lock_file/version/pkg_config/init/fetch/install_command/version_cache) — is a genuinely faithful 1:1 port with explicit, well-argued fidelity notes (the lexer even documents that TS has no unterminated-string check and matches that; the parser documents removing over-strict guards a previous port added). The semantic layer is where the real gaps live: env.yo, expr_info.yo, value.yo, function_value.yo and expr_traversal.yo each carry documented "first-cut" / "still owed" ports of TS functions that TS uses to make correctness decisions. The single worst gap is `_filter_receiver_methods` (yo-self/env.yo:2535): it never runs TS's final `areTypesCompatible(firstParam, receiver, isMethodReceiver=true)` gate, never applies the "receiver has SomeType but method doesn't → skip" rule, and never applies the Dyn object-safety filter (self-by-value / returns-Self) — so the candidate set handed to overload resolution is strictly larger than TS's and a method TS rejects can win dispatch, producing a wrong or signature-mismatched C call. Close behind are three more high-impact items: `ExprInfo` has no `is_return_slot` field (expr_info.yo:317), which makes every `&(ref-returning-call)` in a return slot emit TS's documented use-after-free shape `T* temp = call(); return &temp;`; `keep_top_level_frame_and_comptime_variables_from_env` (env.yo:1412) has zero callers, so the runtime-local hiding TS performs at nested non-closure function definitions never happens; and main.yo:1136 resolves the `--target` only after evaluation and never calls `set_target_pointer_size`, leaving the pointer width pinned at 64 bits for every cross-compile.

### types

yo-self/types/\*\* is far more complete than its \"Phase 2\" comments suggest — compatibility.yo, utils.yo's RC/size/cycle walkers, type_key.yo and intern.yo have all been hardened past their original ports with issue-linked fixes — but the completeness is uneven, and the gaps cluster in one place: yo-self's `SomeT.resolved_concrete` and the recursive descent into composite types. Three separate predicates (`is_rc_type` guards.yo:430, `_type_is_control_bound_inner` utils.yo:526, `_type_refs_back_to_cyclic` utils.yo:710) refuse to follow `resolved_concrete` and justify it with comments claiming yo-self's SomeT has no such field — a claim that `_type_contains_rc_inner` (utils.yo:414) disproves twenty lines away; `type_contains_some_type` (utils.yo:860) is top-level-only while every evaluator call site expects TS's full recursion; `substitute` (substitution.yo:276) silently zeroes `is_effects_row` and `kind_function_type` on every SomeT it rebuilds; and SomeT-vs-SomeT compatibility (compatibility.yo:720) is name+frame_level only. The single worst gap is the interaction between `intern_type` (intern.yo:559) and that same field: interning merges two structurally-identical UNRESOLVED SomeTs into one instance, and because `resolved_concrete` is a deliberately SHARED MUTABLE cell that synthesizer.yo:1314/1399 mutates in place, a resolution stamped at one call site now silently rewrites an unrelated type variable's resolution — the intern header's soundness argument (\"TypeValues are rebuilt-not-mutated\") is contradicted by definitions.yo's own HAZARD note on that field, and the bad resolution flows straight into codegen's parameter lowering.

---

## CORRECTION (2026-07-26): the `ioBuiltin` gap IS fixable — the stated blocker is false

`yo-self/evaluator/async/await_analysis.yo:84` justifies its purely syntactic Io
detection with:

> This replaces the TypeScript `expr.func.$?.type?.ioBuiltin` marker which is
> not available in the Yo self-hosted type system.

Both halves of that are wrong, verified:

1. **The marker's information IS in yo-self's type system.** TS derives
   `ioBuiltin` from the extern field LABEL (`src/evaluator/exprs/extern.ts:141-158`:
   `__yo_io_async` -> `"io_async"`, `__yo_io_await`, `__yo_io_state`,
   `__yo_io_spawn`, `__yo_join_handle_await`). yo-self's Func meta already has
   `extern_name : Option(String)` (types/definitions.yo) and
   `evaluator/exprs/extern.yo:208` already stamps it with that same label. So the
   classification is derivable today — no new meta slot required, which is what
   makes this a cheap faithful port rather than a schema change.
2. **The analysis pass CAN see types.** `analyze_await_points`
   (await_analysis.yo:385) takes
   `get_info : Impl(Fn(e : AstExpr) -> Option(ExprInfo))` precisely so it can
   look up evaluated expression info.

Consequence of the current syntactic scheme, both already recorded below as
HIGH: Io calls are recognised only when the receiver's token text is literally
`io`, and `is_join_handle_await_call` (await_analysis.yo:188) returns true for
ANY `x.await(...)` with a non-`io` receiver, with no JoinHandle check at all.

Prime suspect for cluster C (thread/worker). Note the related deliberate
omission at `evaluator/exprs/extern.yo:207`, whose comment says "`ioBuiltin` is
codegen-only and stays skipped" — also false, since await analysis needs it.

**COST CORRECTION (same day).** An earlier revision of this note called the
port "cheap". That was wrong and is retracted. The two claims above hold — the
information is present in `extern_name`, and `analyze_await_points` does take
`get_info` — but the predicates that need it
(`is_io_await_call`, `is_io_async_call`, `is_io_state_call`, `is_io_spawn_call`,
`is_join_handle_await_call`) are `fn(expr : AstExpr) -> bool` with **12+ callers**
across `expr_traversal.yo`, `evaluator/calls/helper.yo` and
`evaluator/calls/function.yo`, and at least one of them —
`expr_contains_await` (expr_traversal.yo:282) — is a PURE AST predicate with no
`ctx` and no `get_info` in scope.

The reason is a genuine architectural divergence, not an oversight: TS hangs
evaluated info on the AST node itself, so `exprContainsAwait` reads
`expr.func.$?.type?.ioBuiltin` for free (src/expr-traversal.ts:371-376).
yo-self keeps `ExprInfo` in an id-keyed SIDE TABLE reachable only through
`ctx.expr_info_table`, so the faithful port must thread the table (or `ctx`)
through every one of those predicates and their callers.

Still worth doing — it removes the whole class of "receiver must literally be
named `io`" fragility — but budget it as a threading refactor across 4 files,
not a local edit.

---

## SPOT-VERIFIED entries (read directly, 2026-07-26)

The findings below are agent-reported. These three were re-read in the source
and are confirmed VERBATIM — treat them as facts, not reports:

- **`types/guards.yo:584`** — the whole definition is
  `is_function_specializable :: (fn(t : TypeValue) -> bool)(false);`
  A predicate whose body is the constant `false`. TS computes
  `isFunctionTypeGeneric(functionValue.type) || ...` (src/types/guards.ts:537-549).
  Note the signature also takes a `TypeValue` where TS takes a `FunctionValue`.

- **`types/compatibility.yo:708`** — Union-vs-Union is
  `(((aname == ename) || (aname.len() == usize(0))) || (ename.len() == usize(0)))`
  i.e. name-only with the EMPTY NAME AS A WILDCARD, in the exact-match path
  too. Since yo-self routinely leaves union/enum names empty, this makes
  unrelated unions mutually compatible. TS rejects on field-count mismatch or
  distinct ids (src/types/compatibility.ts:407-439).

- **`evaluator/trait_checking.yo:450`** — body is
  `AssocTypeCheckResult(satisfied : true, env : env)` with the comment
  "Phase 3 stub ... conservatively return satisfied=true", AND it has ZERO call
  sites (grep over all non-test yo-self files returns only its own definition,
  its doc comment, and the module header). So associated-type constraints such
  as `where(T <: Iterator(Item := i32))` are satisfied by ANY `Iterator`, and
  the check is not wired in at all. TS calls
  `checkAssociatedTypeConstraints` from step 4 of `typeImplementsTrait`
  (src/evaluator/trait-checking.ts:240-322, called at :311).

---

# HIGH

### `yo-self/codegen/codegen_c.yo:216` — partial _(codegen-core)_

**yo-self:** compile_module collects functions only from the module value's exported fields. It never walks the module-level mutable-variable initializer expressions. Types ARE collected from them (types/collection.yo:640 calls collect_types_from_expr over get_module_level_init_exprs()), but functions are not — grep confirms find_function_calls_in_expr is never applied to init exprs anywhere in yo-self.

**TS:** src/codegen/codegen-c.ts:121-125 — immediately after collectRequiredFunctions: `if (context.moduleLevelInitExprs) { for (const initExpr of context.moduleLevelInitExprs) { findFunctionCallsInExpr(initExpr, context); } }`

**Evidence:** codegen_c.yo:216 `collect_required_functions(module_value, base, info, true);` with no init-expr loop; types/collection.yo:602 `(Signature-type collection omitted — Gap 2; the moduleLevelInitExprs pass is deferred until the context carries them.)` — yet types/collection.yo:640 later DOES add the type-side loop, leaving only the function side missing.

### `yo-self/codegen/functions/dyn.yo:412` — conservative-fallback _(codegen-core)_

**yo-self:** In generate_dyn_wrapper_functions' regular-trait-method pass, if should_skip_function_codegen says the impl function was dropped, the wrapper body becomes `abort(); /* dyn method unavailable: impl fn skipped (degraded type) */` instead of forwarding to the impl.

**TS:** src/codegen/functions/dyn.ts — the wrapper always emits the forwarding call to the impl's cName; there is no skip check and no abort path in the wrapper emitter.

**Evidence:** dyn.yo:405-413 `// A method whose DEFINITION the generic/comptime skip drops ... must not be CALLED from the wrapper ... Emit a visible runtime trap instead` then `if(should_skip_function_codegen(...), { em.emit_declaration_string_line(\` abort(); /_ dyn method unavailable: impl fn skipped (degraded type) _/\`); }, { \_emit_wrapper_call(...) });`

### `yo-self/codegen/functions/generation.yo:509` — conservative-fallback _(codegen-core)_

**yo-self:** After emitting a function body, generate_function re-reads the emitted text; if it contains the string `// Failed to transpile` AND fid_fully_specialized(func_id), it TRUNCATES the emitter buffer back to stub_mark and re-emits the signature with a body of `abort(); /* superseded generic original: all call sites dispatch a specialization */`.

**TS:** none found — no equivalent post-emission rewrite exists in src/codegen/functions/generation.ts. TS avoids the situation structurally: resolution replaces the value on the shared AST node so the abstract original never reaches the emitter (the yo-self comment at :502-504 says exactly this).

**Evidence:** generation.yo:508-514 `emitted_fn := em.code.substring(stub_mark, em.code.len()); if(emitted_fn.contains("// Failed to transpile") && fid_fully_specialized(func_id.clone()), { em.code = em.code.substring(usize(0), stub_mark); ... em.emit_string_line(String.from("  abort(); ...")); })`

### `yo-self/codegen/functions/generation.yo:790` — partial _(codegen-core)_

**yo-self:** generate_main_wrapper emits `__yo_user_main${main_call_args};` and returns. It never emits `__yo_async_scheduler_init();` or `__yo_async_wait_all();`, and never emits the `if (__yo_effect_escaped) return NULL;` guard after the module-init call.

**TS:** src/codegen/functions/generation.ts:936-944 builds asyncInit/asyncWait from context.usesAsync, and generation.ts:1015-1022 emits `${asyncInit}`, `__yo_main_module_init(); if (__yo_effect_escaped) return NULL;`, then `__yo_user_main${mainCallArgs}; ${asyncWait}`. Both the POSIX worker path and the direct path emit them.

**Evidence:** generation.yo:712 `/// DEFERRED (documented): async runtime init/wait (no async in corpus — emitted empty), evidence-param mains (Phase 5).` and the emitted block at :786-820 / :826-835 contains neither call. `grep -rn '__yo_async_wait_all' yo-self/codegen/` matches only runtime_core.yo:187 (the definition) and parallelism/runtime.yo.

### `yo-self/codegen/exprs/begin.yo:232-239` — partial _(codegen-exprs)_

**yo-self:** The expression-form `begin` block assigns its final expression to the result temp verbatim (`temp_var = last_arg_code;`) with no deferred-`___dup` rewrite of that final expression.

**TS:** src/codegen/exprs/begin.ts:104-153 — when `lastArg.$.deferredDupExpressions` is non-empty, TS re-emits the last expr into its own temp (skipping the decl for `inout` atoms), calls `generateDeferredDupExpressions(lastArg, ...)`, and assigns the DUP RESULT variable to the block temp.

**Evidence:** begin.yo:14 header — "DEFERRED (documented, not hit by the no-RC corpus): the deferred-dup rewrite of the return value … The no-RC corpus has no deferred dups, so the last expression is assigned to the result temp as-is." Code at 232-239 confirms a bare assignment.

### `yo-self/codegen/exprs/closures.yo:119-121` — hardcoded _(codegen-exprs)_

**yo-self:** A `Dyn(Fn(...))` closure construction returns the string `"// Error: Dyn(Fn(...)) closure construction not yet ported"`, which the caller splices into an EXPRESSION position.

**TS:** src/codegen/exprs/closures.ts:296-330 — TS heap-allocates the capture struct (`allocateClosureCapture` with `useStackAllocation=false`), then returns `__yo_create_<closureCName>(captureTempVar, __yo_dispose_<closureCName>, (ret (*)(void*, params))fn)`; the capture-less case returns the same with `NULL`.

**Evidence:** `if(is_dyn_type(ei.ty), {\n    return(String.from("// Error: Dyn(Fn(...)) closure construction not yet ported"));\n  });`

### `yo-self/codegen/exprs/downcast.yo:9-13 and the emitter body` — partial _(codegen-exprs)_

**yo-self:** The `wasBoxed` path is entirely absent: `generate_downcast` always emits the unboxed object cast over `dyn.data`. There is no scan of `context.dyn_impls` for an impl whose `data_type` is a `Box(T)`.

**TS:** src/codegen/exprs/downcast.ts:88-160 — TS walks `context.dynImpls`, and when the matching impl's `dataType` `isBoxedType`, emits `((BoxCName*)dyn.data)->{field}` plus the correct dup (`__yo_incr_rc` / `___dup` / memcpy) depending on whether the target is a reference struct, has a dup fn, or is a plain value.

**Evidence:** downcast.yo:9-13 — "DEFERRED (documented): the `wasBoxed` branch … is UNREACHABLE — yo-self `is_boxed_type` is hardcoded false (Box is not modeled in the type system yet)." Contradicted by types/guards.yo:591 and dyn.yo:37.

### `yo-self/codegen/exprs/generation.yo:472-473` — no-op _(codegen-exprs)_

**yo-self:** `asm(...)` and `global_asm(...)` return the literal string `/* TODO[codegen-port]: asm not yet ported */` instead of emitting anything. There is no `yo-self/codegen/exprs/asm.yo` at all — the entire 761-line TS emitter is unported.

**TS:** src/codegen/exprs/generation.ts:651-658 dispatches to `generateAsm` / `generateGlobalAsm` (src/codegen/exprs/asm.ts, 761 lines) which emit real `__asm__ __volatile__(...)` blocks with operand/clobber lowering.

**Evidence:** `if(ast_expr_is_fn_call_of(expr, BF_ASM, Option(usize).None), return(String.from("/* TODO[codegen-port]: asm not yet ported */")));`

### `yo-self/codegen/exprs/match.yo:828 (_emit_destructure_binds) and 1056` — partial _(codegen-exprs)_

**yo-self:** Tagged-union arm destructuring emits only the local C binds (`<T> v = subj.data.Variant.f;`). There is no state-machine write-back of the destructured variables; the file contains no `sm->` emission at all.

**TS:** src/codegen/exprs/match.ts:673-699, 752-781, 906-927, 983-1008 — four sites where, when `inAsyncStateMachine || inEffectStateMachine` and the destructured var's id is in `stateMachineVariables`, TS additionally emits `sm->${getStateMachineFieldName(varId, "local", …)} = ${varName};`.

**Evidence:** match.yo:14 header — "DEFERRED (documented …): state-machine storage of destructured variables (Phase 5, gated on in_async)". `grep 'sm->' match.yo` returns only a comment at line 409.

### `yo-self/codegen/exprs/other_fn_call.yo:246-250 (and the absence of any call site)` — no-op _(codegen-exprs)_

**yo-self:** `_store_temp_var_to_state_machine_if_needed` has body `()` — a pure no-op — AND is never invoked anywhere in the file (only re-exported at line 1803). The direct-call emission path (1612-1651) declares `T tv = f(args);` as a plain C local and never writes it back to the state-machine struct.

**TS:** src/codegen/exprs/other-fn-call.ts:215-253 defines `storeTempVarToStateMachineIfNeeded`, which emits `sm->var_<id> = <tempVar>;` (skipping Future-typed temps and `outer` captures). It is called at ~18 sites (620, 1501, 1797, 1956, 2207, 2316, 2384, 2456, 2516, 2551, 2572, 2596, 2684, 2756, 3201, …).

**Evidence:** `_store_temp_var_to_state_machine_if_needed :: (fn(temp_var : String, indent : String, context : FunctionGenerationContext) -> unit)(\n  ()\n);` with doc "SM temp-var store (Phase 5) — no-op outside a state machine."

### `yo-self/codegen/exprs/property_access.yo:13-16` — partial _(codegen-exprs)_

**yo-self:** Two whole resolution branches are absent: (a) the late-dispatch trait walk that resolves `obj.method` at emit time when the evaluator left the value unresolved, and (b) the Rc-method (`___drop`/`___dup`/`___dispose`) trait lookup fallback. `grep 'trait' property_access.yo` matches only the header comment.

**TS:** src/codegen/exprs/property-access.ts:154-222 (late dispatch: strips pointer layers, finds the type's trait, skips names that are real data fields, checks direct trait fields then nested trait impls, and returns the method's C function name) and 227-265 (Rc-method trait lookup returning the function name directly).

**Evidence:** Header: "Late-dispatch trait-walk + Rc-method (\_\_\_drop/dup/dispose) trait lookup: TS reads `objectType.trait.fields[].assignedValue`, but yo-self's Struct/EnumT carry NO `.trait` field — methods live in a separate type-method registry. Porting these requires routing through that registry (Phase 3/4)."

### `yo-self/codegen/exprs/ptr_fns.yo:9-13 (generate_address_of)` — partial _(codegen-exprs)_

**yo-self:** The `is_return_slot` ref-forward is omitted: `&(call_returning_inout)` in a `-> *(T)` return position always falls through to the rvalue-spill path, emitting `T* tmp = call(...); … (&tmp)`.

**TS:** src/codegen/exprs/ptr-fns.ts:123-139 — when `expr.$.isReturnSlot` and the arg's last env binding `isRef`, TS returns `argCode` unchanged (forwards the already-`T*` pointer). Its own comment: "Without this, the body emits `T* temp = call(...); return &temp;` — a use-after-free because `temp` dies when the function returns."

**Evidence:** ptr_fns.yo:9-13 — "DEFERRED (documented): the `is_return_slot` ref-forward … yo-self ExprInfo has no `is_return_slot` field and Variable has no `is_ref` flag." (The `is_ref` half of that claim is stale — env.yo:115 has `is_ref`.)

### `yo-self/codegen/exprs/recur.yo:33-57` — partial _(codegen-exprs)_

**yo-self:** Per-argument deferred-`___dup` emission is missing: after generating each arg, yo-self only does the `(*name)`→`name` ref strip and pushes `arg_code`. It also never calls `generate_deferred_drop_expressions(expr, …)` for the recur node itself.

**TS:** src/codegen/exprs/recur.ts:54-68 — if `arg.$.deferredDupExpressions.length > 0`, TS calls `generateDeferredDupExpressions(arg, indent, functionContext)` and substitutes the dup-result variable for the arg. recur.ts:92-94 additionally emits `generateDeferredDropExpressions(expr, …)` for moved RC arguments.

**Evidence:** recur.yo:3-6 header lists this as deferred; the loop body at 33-57 goes straight from `arg_code := _call_generate_expr(...)` + ref-strip to `args_list.push_string(arg_code);` with no dup handling and no drop call anywhere in the function.

### `yo-self/codegen/exprs/return.yo:993-999 (generate_unwind)` — partial _(codegen-exprs)_

**yo-self:** The unwind-with-argument path generates the arg code and then immediately emits handler-param drops, pending deferred drops, and consumed-var escape drops. It does not snapshot/truncate the drop lists around arg evaluation, and does not filter out a pre-existing drop whose target IS the arg's C expression.

**TS:** src/codegen/exprs/generation.ts:345-390 — TS records `consumedDropsBaselineForEscapeArg` / `pendingDropsBaselineForEscapeArg` BEFORE `generateExpr(arg, …)`, truncates both lists back to the baselines afterwards, then filters both lists removing any drop whose `getDeferredDropTargetAtomName` equals the trimmed arg code. Its comment: "The value's ownership escapes via \_\_yo_unwind_value, so dropping it here would cause a use-after-free at the handler installation site."

**Evidence:** return.yo:993-999 goes `argc := _call_generate_expr(arg, …); _emit_effect_handler_param_drops(…); generate_pending_deferred_drops(…); generate_consumed_var_drops_for_escape(…);` with no baseline capture and no filter.

### `yo-self/codegen/functions/context.yo:210 (and yo-self/codegen/codegen_c.yo:187-300)` — deferred-todo _(codegen-exprs)_

**yo-self:** The effect state-machine subsystem is entirely unmodelled: `FunctionGenerationContext` has `in_async_state_machine` but no `in_effect_state_machine` field, and `compile_module` never calls a `pre_register_effectful_functions` equivalent.

**TS:** src/codegen/functions/generation.ts:1109-1140 `preRegisterEffectfulFunctions` (registers effect-SM structs + forward declarations for every function whose body has `effectAnalysis.hasEffects`), called from src/codegen/codegen-c.ts:228 BEFORE any body is generated "so that call sites can find effectStateMachineInfo". ~10 exprs files then branch on `inAsyncStateMachine || inEffectStateMachine`.

**Evidence:** `grep 'in_effect' yo-self/codegen/functions/context.yo` → no match; line 210 shows only `in_async_state_machine : Option(InAsyncStateMachine),`. `grep -r 'pre_register_effectful\|preregister_effectful' yo-self` → no match.

### `yo-self/evaluator/calls/closure_type.yo:250` — partial _(evaluator-calls)_

**yo-self:** The closure return type is compared with `are_types_compatible(body_ty, result_type)` with NO prior `synthesize_types` against the FnTrait's declared return. There is no `synthesize_types` call anywhere in the file (grep: 0 hits). An outer forall T referenced only in the closure's return therefore stays unbound after the closure is created.

**TS:** src/evaluator/calls/closure-type.ts:186-196 — `try { synthesizeTypes({ type: fnTraitType.isFn.callType.return.type, env }, { type: closureBodyReturnType, env }) } catch {}`, whose comment says this is what lets `io.async`'s outer forall(T)/(E) get bound so `Impl(Future(T, E))` is derived correctly.

**Evidence:** if(!(are_types_compatible(body_ty, result_type)), { exn.throw(... `Incompatible closure return type` ...) });

### `yo-self/evaluator/calls/closure_type.yo:264` — no-op _(evaluator-calls)_

**yo-self:** Captured variables are enriched and turned into a capture struct, but no `___dup` expressions are generated for captured ARC values and no `deferred_dup_expressions` is recorded on the closure's ExprInfo. (The helper `generate_captured_variable_dup_expressions` exists in evaluator/utils/closure.yo:407 but is itself a documented no-op stub — closure.yo:9 "→ no ARC (returns None)" — and closure_type.yo never calls it.)

**TS:** src/evaluator/calls/closure-type.ts:232-240 calls `generateCapturedVariableDupExpressions(...)` (src/evaluator/utils/closure.ts:393) and closure-type.ts:313-317 stores the result as `deferredDupExpressions` on `expr.$`.

**Evidence:** captured_vars_with_values_opt := … enrich_captured_variables(cv, caller_env) … cap_result := create_capture_type_and_value(...) // no dup generation in between

### `yo-self/evaluator/calls/closure_type.yo:304` — no-op _(evaluator-calls)_

**yo-self:** After building the capture struct and ExprInfo the function returns `Option(AstExpr).Some(expr)` with no temp-variable attachment. `attach_temp_variable_to_expr` appears 0 times in the file.

**TS:** src/evaluator/calls/closure-type.ts:323-326 — `if (isDynType(wrapperType)) { attachTempVariableToExpr(expr, true); }` (comment: attach for DynType because the closure value is ARC-managed).

**Evidence:** // Determine the final type (use wrapper_type).\n final_ty := wrapper_type; … Option(AstExpr).Some(expr)

### `yo-self/evaluator/calls/function_type.yo:601` — partial _(evaluator-calls)_

**yo-self:** The def-time body-eval block runs the flowability check and the SomeT resolved-concrete stamping, but omits (a) the post-body `areTypesCompatible(return, bodyType)` check, (b) the `return.isCompileTimeOnly && !body.value` error, and (c) the unwind detection that sets isControlFunction and rejects `unwind` in a non-`ctl` body. `mark_as_control_fn` is never called from function_type.yo (grep: only helper.yo:1989 and helper.yo:2247).

**TS:** src/evaluator/calls/function-type.ts:561-569 (`if (evaluatedBodyContainsEscape(...)) { if (!isControl && !isClosure) throw ...; functionValue.isControlFunction = true; }`), :594-611 (return-type compatibility throw), :633-642 (comptime-return value throw).

**Evidence:** function_type.yo:601-764 contains only: \_trial_eval_fn_body → flow_violation_pending → propagate_def_time_errors → type_representation_contains_raw_ptr flowability → SomeT resolved-concrete stamping.

### `yo-self/evaluator/calls/helper.yo:1176` — no-op _(evaluator-calls)_

**yo-self:** create_specialized_function_inline never computes `has_control_function_implicit_params`; the field is defined (evaluator/context.yo:269), defaulted to false (context.yo:346), and only ever saved/restored by builtins/comptime_expect_error.yo — it is set to `true` nowhere in yo-self.

**TS:** src/evaluator/calls/helper.ts:2388-2397 — `const hasControlFunctionImplicitParams = argValues.implicitArgs?.some(arg => (isFunctionValue(arg.value) && arg.value.isControlFunction) || (isEffectRecordValue(arg.value) && effectRecordTypeContainsCtlField(...)))` — used so calls inside the specialized body skip direct ctl-call handling.

**Evidence:** /// NOTE: Effects analysis (isControlFunction detection, effectCtlParams, etc.) is not yet implemented here — it is the TS function's largest section (~600 lines) … deferred to Phase 4k.

### `yo-self/evaluator/calls/helper.yo:1249` — partial _(evaluator-calls)_

**yo-self:** create_specialized_function_inline builds the specialization cache key from forall args + implicit args only, and pushes EVERY regular argument's type into runtime_param_tys. A `comptime(n) : usize` / `comptime(T) : Type` regular parameter's VALUE never enters compile_time_args, and compute_compile_time_signature (helper.yo:787) likewise omits comptime regular params, so f(1) and f(2) produce byte-identical cache keys and an identical specialized_func_id.

**TS:** src/evaluator/calls/helper.ts:2229-2254 — `functionType.parameters.forEach((param, index) => { if (param.isCompileTimeOnly) { compileTimeArgValues.push(arg.value) } else { runtimeParameters.push({...param, type: concreteType}) } })`; and helper.ts:2153-2164 pushes each comptime regular param into the signature string.

**Evidence:** // Build runtime parameter types from regular args\n// Phase 3 simplification: all regular params are treated as runtime.\n// This means we track all regular arg types for cache differentiation.

### `yo-self/evaluator/calls/helper.yo:3806` — no-op _(evaluator-calls)_

**yo-self:** Both FuncCallResult return sites hard-code `deferred_drop_expressions : Option(ArrayList(AstExpr)).None`. The ported `generate_deferred_drop_expressions` (helper.yo:251) and `env.yo:get_variables_needing_drop` are never called from the call path (grep: no call sites outside the definition).

**TS:** src/evaluator/calls/helper.ts:2069-2084 — `const variablesNeedingDrop = getVariablesNeedingDrop(callerEnv).filter(v => !variableIsCapturedByCurrentFunction(v, context)); if (variablesNeedingDrop.length > 0) { deferredDropExpressions = generateDeferredDropExpressions({...}).deferredDropExpressions; }`.

**Evidence:** deferred_drop_expressions : Option(ArrayList(AstExpr)).None (helper.yo:3806 and helper.yo:3834)

### `yo-self/evaluator/calls/helper.yo:3808` — conservative-fallback _(evaluator-calls)_

**yo-self:** The `_ =>` arm of try_to_call_function_with_arguments (callee type is not `.Func(...)`) returns a fabricated FuncCallResult with `return_type : t_unit()`, empty arg_values, empty runtime_arg_exprs_in_order and no specialization, instead of raising.

**TS:** src/evaluator/calls/helper.ts:845 `_tryToCallFunctionWithArgumentsImpl({ functionType: FunctionType, ... })` — TS is only ever entered with a resolved FunctionType; the caller in src/evaluator/calls/function.ts throws before reaching it, so no unit-typed result can ever be produced.

**Evidence:** // Soft fallback: when the callee's type isn't `.Func(...)` … return a placeholder `FuncCallResult` with `t_unit()` return instead of aborting the surrounding eval. … Tracked as an evaluator coverage gap in `issues/yo-self-evaluator-gaps.md`.

### `yo-self/evaluator/calls/helper.yo:562` — partial _(evaluator-calls)_

**yo-self:** `arg_value := arg_info.value;` is bound unconditionally into callee_env at Step 9 (helper.yo:666-679). yo-self coerces the comptime TYPE to the runtime type (helper.yo:542-561) but never clears the comptime VALUE for a runtime parameter.

**TS:** src/evaluator/calls/helper.ts:507-516 — `if (!parameter.isCompileTimeOnly && isComptimeOnlyType(argType, ...)) { if (!context.forceCompileTimeBindings) { argValue = undefined; } ... }`.

**Evidence:** (arg_type : TypeValue) = arg_info.ty; … arg_type = convert_comptime_type_to_runtime_type_with_expected(arg_type, ...); … arg_value := arg_info.value;

### `yo-self/evaluator/calls/helper.yo:562` — partial _(evaluator-calls)_

**yo-self:** No `assignedValue` equality gate on parameters. helper.yo imports no `are_values_equal` (it lives in evaluator/utils.yo:1324) and never compares a parameter's assigned value against the argument value.

**TS:** src/evaluator/calls/helper.ts:482-497 — `if (parameter.assignedValue && evaluatedArgExpr.$?.value) { if (!areValuesEqual(...)) throw ... }` with the comment "used for overload resolution based on value matching (e.g. TryInto(i32) vs TryInto(i64))".

**Evidence:** helper.yo import block (lines 25-137) has no are_values_equal; parameter matching goes Step 5 comptime check → Step 6 synthesize → Step 8 are_types_compatible with no value comparison.

### `yo-self/evaluator/calls/numeric_type.yo:337` — conservative-fallback _(evaluator-calls)_

**yo-self:** When the cast source type is not numeric/comptime-numeric/enum, try_to_convert_to_numeric_type stores an `UnknownVal` of the target type and returns success, so no `__yo_as` lowering and no macro_expansion are recorded.

**TS:** src/evaluator/calls/numeric-type.ts:330-342 — `throw formatErrorMessage({ ... "Cannot convert X to Y. Expected a numeric type." })`.

**Evidence:** // Soft fallback: when the source is not numeric … emit an `UnknownVal` of the target type instead of aborting. … Tracked as evaluator coverage gap in `issues/yo-self-evaluator-gaps.md`.

### `yo-self/evaluator/calls/type.yo:324` — placeholder _(evaluator-calls)_

**yo-self:** runtime_arg_exprs_in_order is pre-filled with `function_callee_expr` for every field (type.yo:114) and, for a field that falls back to its default/assigned value, is LEFT at that placeholder — only `values(ci)` is set.

**TS:** src/evaluator/calls/type.ts:206-209 — `runtimeArgExprsInOrder[i] = (memberElement.exprs.defaultValueExpr ?? memberElement.exprs.assignedValueExpr)!` for every unchecked field.

**Evidence:** // Note: we can't set the real expr here (TypeField doesn't store exprs),\n// so runtime_arg_exprs_in_order[ci] remains the function_callee_expr placeholder.

### `yo-self/evaluator/trait_checking.yo:1265` — partial _(evaluator-core)_

**yo-self:** `type_contains_some_type_for_codegen_param` treats EVERY `SomeT` as codegen-generic (returns `true`) after only excluding Fn-trait / Future-trait / extern-named SomeTypes. It never consults the SomeT's resolved concrete type, so a SomeType that has ALREADY been resolved to a concrete type still reports "contains a generic". The doc comment asserting yo-self `SomeT` has no `resolved_concrete_type` is STALE — the field exists and is stamped.

**TS:** src/types/utils.ts:702-713 — `if (isSomeType(type)) { if (type.isExtern) return false; if (type.resolvedConcreteType) { return typeContainsSomeTypeForCodegenParam(type.resolvedConcreteType, checkedTypes); } if (typeImplementsFn(type)) return false; ... return true; }`. The `resolvedConcreteType` recursion is the branch yo-self omits.

**Evidence:** trait_checking.yo:1262-1264: `... yo-self \`SomeT\` has no \`is_extern\` / \`resolved_concrete_type\`, so those TS exclusions are no-ops here.`— contradicted by yo-self/types/definitions.yo:286`resolved_concrete : ArrayList(Self)` and yo-self/evaluator/types/synthesizer.yo:1305-1320 which stamps that shared cell.

### `yo-self/evaluator/trait_checking.yo:450` — no-op _(evaluator-core)_

**yo-self:** `_check_associated_type_constraints` is a hardcoded `AssocTypeCheckResult(satisfied : true, env : env)` — AND it is never called from anywhere (grep over all non-test yo-self finds only the definition and the header comment). Combined with the fact that yo-self's `TraitT` variant carries no `associated_type_constraints` field at all (types/definitions.yo:226-241), the entire associated-type-constraint mechanism is unrepresentable. Step 4 of `type_implements_trait` (:603) resolves a trait match purely by `is_type_registered_as_trait(type_id, trait_type, env)`, which compares only `_trait_type_id` (the base trait `id`).

**TS:** src/evaluator/trait-checking.ts:240-322 (`checkAssociatedTypeConstraints`) — called at :311 inside step 4 of `typeImplementsTrait` and at :540 inside step 8 (whose return value is `implemented: assocResult.satisfied`). It walks `traitType.associatedTypeConstraints` (src/types/definitions.ts:614), resolves each label from the target's trait fields or via `findAssociatedTypeFromGenericImpls`, and returns `{satisfied:false}` on mismatch. Constraints are built at src/evaluator/calls/trait-type.ts:53-116 for `Trait(Assoc := T)` syntax.

**Evidence:** `// Phase 3 stub: the full implementation needs the generic impl registry to resolve associated types. For now, conservatively return satisfied=true (permissive — avoids false-negative rejections at the cost of not catching mismatched associated types until Phase 3).`

### `yo-self/evaluator/trait_checking.yo:565` — deferred-todo _(evaluator-core)_

**yo-self:** `type_implements_trait` never propagates type bindings: it returns `TraitCheckResult(implemented : ..., env : env)` with the ORIGINAL env at every exit. TS calls `synthesizeTypes` at three points and returns `expectedEnv`. `synthesize_types` exists and is fully ported in yo-self (evaluator/types/synthesizer.yo:128), so this is a wiring gap, not a missing dependency.

**TS:** src/evaluator/trait-checking.ts:390 (step 3, Fn-trait: `const { expectedEnv } = synthesizeTypes({type: traitType.isFn.callType, env}, {type: targetType, env}); return { implemented: true, env: expectedEnv };`), :426 (step 4, direct trait field match, using `assocResult.env`), and :316 (inside `checkAssociatedTypeConstraints`). Function doc at :330-336: "When a where-clause constraint such as `where(Self <: Iterator(Item := A))` is checked ... the SomeType `A` gets bound to `i32` in the returned env via synthesizeTypes."

**Evidence:** trait_checking.yo:565 `// Phase 3 TODO: call synthesize_types for binding propagation.`; :469-470 `(Phase 3: binding propagation via \`synthesize_types\` is deferred; env is returned unchanged).`; step 3 exit at :601 `return(TraitCheckResult(implemented : true, env : env));`

### `yo-self/evaluator/utils.yo:1030` — partial _(evaluator-core)_

**yo-self:** `merge_and_check_envs` builds a per-column `case_types := ArrayList(TypeValue).new()` and pushes each branch's `case_var.ty` into it at :1058 — and then NEVER READS IT. The entire cross-branch type-compatibility block of TS's `mergeAndCheckEnvs` is absent: both the generic `areTypesCompatible` check across initialized branches AND the `isSomeType(firstType) && isSomeType(currentType)` check that rejects an `Impl(...)` variable whose `resolvedConcreteType` differs between branches.

**TS:** src/expr.ts:2013-2088 — `const initializedCases = ...; if (initializedCases.length > 1) { ... if (isSomeType(firstType) && isSomeType(currentType)) { const firstConcreteType = firstType.resolvedConcreteType; ... throw ... 'has type Impl(...) but different concrete types across branches' } ... if (!areTypesCompatible(...)) throw 'has incompatible types across different cases' }`. yo-self DOES have the underlying data: `SomeT.resolved_concrete` is a real shared cell (yo-self/types/definitions.yo:286) stamped by yo-self/evaluator/types/synthesizer.yo:1305.

**Evidence:** utils.yo:1030 `case_types := ArrayList(TypeValue).new();` / :1058 `case_types.push(case_var.ty);` — `grep -n case_types utils.yo` returns exactly those two lines.

### `yo-self/evaluator/utils.yo:112` — partial _(evaluator-core)_

**yo-self:** `attach_temp_variable_to_expr :: (fn(expr, is_owning_the_rc_value, ctx) -> unit)` — a 3-parameter signature. TS's `attachTempVariableToExpr(expr, isOwningTheRcValue, isOwningTheSameRcValueAs?, isRef?)` has FOUR. The `isRef` parameter is dropped entirely, so the temp created for a call whose return slot is `ref(T)` gets `is_owning_the_rc_value = _is_owning_rc` (TS forces `false`) and never gets `is_ref = true` on the Variable. Nothing else in yo-self sets `is_ref` on a temp — `grep 'is_ref = true'` across non-test yo-self finds only `evaluator/calls/helper.yo:690` (a bound PARAMETER), and `evaluator/calls/function.yo` has no `result_is_ref`/`call_return_is_ref` handling at all.

**TS:** src/expr.ts:1657-1799 — signature at :1668 (`isRef?: boolean`), semantics at :1750 (`isOwningTheRcValue: isRef ? false : _isOwningTheARCValue`) and :1754 (`isRef: isRef || undefined`). Callers that pass it: src/evaluator/calls/function.ts:2263, :2461, :2527, :2567 (`attachTempVariableToExpr(expr, true, undefined, callReturnIsRef)`). The doc comment at src/expr.ts:1661-1667 states codegen reads `isRef` to emit `T*` as the declared type and `(*name)` for atom reads (plans/ITERATOR_REDESIGN.md Phase B).

**Evidence:** yo-self signature: `attach_temp_variable_to_expr :: (fn(expr : AstExpr, is_owning_the_rc_value : bool, ctx : EvalContext) -> unit)`. TS: `// A ref-yielding call's temp holds the raw \`T\*\` returned by the C function — it borrows, doesn't own. Skip RC tracking.`/`isOwningTheRcValue: isRef ? false : \_isOwningTheARCValue, ... isRef: isRef || undefined`

### `yo-self/evaluator/exprs/_expr.yo:1018` — conservative-fallback _(evaluator-exprs)_

**yo-self:** `_evaluate_expression_wrapper` installs `Exception(throw : ((err) -> { unwind(make_err_expr()); }))` — it discards `err` entirely, prints nothing, and returns an `err` AstExpr with no ExprInfo. Every caller reached through the non-raw `evaluate_expression` seam (import.yo:291, c_include.yo:99, test.yo, open.yo callers, etc.) therefore loses the real diagnostic and continues evaluating.

**TS:** src/evaluator/exprs/\_expr.ts:220 `_evaluateExpression` has no swallow layer at all — thrown `formatErrorMessage` objects propagate to the top-level compile driver with full token/message.

**Evidence:** \_expr.yo:1018-1024 is the handler body; the doc comment immediately above at 968-973 claims `We now print the caught error's to_string() output to stderr before aborting, so the user sees the real diagnostic` — which the code does not do.

### `yo-self/evaluator/exprs/assignment.yo:659` — partial _(evaluator-exprs)_

**yo-self:** Step 6 handles `lhs_info.comptime_ref` but there is no equivalent of TS's `ptrTargetValue`/`ptrTargetIndex` block: `grep -rn 'ptr_target_value' yo-self/` returns nothing. A comptime pointer-deref assignment `y.* = value` therefore never writes back into the pointee and never sets `is_compile_time_only_assignment`.

**TS:** src/evaluator/exprs/assignment.ts:1152-1173 — reads `evaluatedLhs.$.ptrTargetValue` / `.ptrTargetIndex` (stamped by src/evaluator/exprs/property-access.ts:346-352), writes `target.elements[i]` / `target.fields[i]` / `ptrTargetValue[0] = rhs.$.value`, and sets `isCompileTimeOnlyAssignment = true`.

**Evidence:** assignment.yo:659-660 `// Step 6 — Handle comptimeRef: direct in-place mutation of shared ArrayList. // Mirrors the comptimeRef block in assignment.ts (lines ~982-1001).` — only the comptimeRef half of TS's two-block sequence is ported.

### `yo-self/evaluator/exprs/begin.yo:1252` — partial _(evaluator-exprs)_

**yo-self:** `_schedule_scope_end_drops` is a local re-implementation of the drop predicate that (a) collects in FORWARD declaration order and never reverses, (b) omits the `variable_is_captured_by_current_function` filter, and (c) never looks at the parameters frame — its `_is_evaluating_function_body_begin_block` parameter is underscore-prefixed and unused (begin.yo:1320, documented at 568-571).

**TS:** src/env.ts:2233-2267 `getVariablesNeedingDrop` ends with `return variables.reverse();` (comment: 'Return in reverse order (end to start) for proper drop order'). src/evaluator/exprs/begin.ts:1788-1803 additionally unions in `getVariablesNeedingDrop(parametersFrameEnv)` when `isEvaluatingFunctionBodyBeginBlock`, then filters with `variableIsCapturedByCurrentFunction`. Note yo-self/env.yo:2253 DOES reverse — only this begin-local copy does not.

**Evidence:** begin.yo:1261 `// Mirrors TS getVariablesNeedingDrop (src/env.ts)` immediately above the e1..e7 predicate chain (1269-1283), which contains no capture check and no reverse; `_variable_is_captured_by_current_function` is used only at begin.yo:1074 and 2029, not here.

### `yo-self/evaluator/exprs/c_include.yo:141` — partial _(evaluator-exprs)_

**yo-self:** `c_header_file` is extracted from the first argument and length-checked (line 146), then NEVER used again — it is not attached to any field type, not stored in a registry, and not written to any ExprInfo. Only `is_extern`/`extern_name` are stamped, and only onto `.Func` field types (line 203-236); every non-Func field (`O_RDONLY : i32`, `time_t : Type`) keeps its raw type unchanged.

**TS:** src/evaluator/exprs/c-include.ts:132-163 — for EVERY field: `field.type = {...field.type, isExtern: "c", cInclude: cHeaderFile, externName: field.label}` (140-142 for functions, 145 for all others), and 161-163 sets `underlyingType.isExtern/cInclude/externName` for type fields. src/codegen then collects `type.cInclude` to emit `#include`.

**Evidence:** c_include.yo:200-202 `// Mirrors c-include.ts:138-145 (the isFunctionType branch). Non-Func field types (type declarations like time_t : Type) carry no is_extern slot and are never called. cInclude is codegen-only.` — and `grep -n c_header_file c_include.yo` returns only lines 98,99,115,129,141,146.

### `yo-self/evaluator/exprs/extern.yo:207` — intentional-divergence _(evaluator-exprs)_

**yo-self:** The `ioBuiltin` marker is intentionally not stamped onto extern function field types (only `is_extern` and `extern_name` are, lines 208-241), on the stated grounds that it is 'codegen-only'.

**TS:** src/evaluator/exprs/extern.ts:141-158 — sets `ioBuiltin: "io_async" | "io_await" | "io_state" | "io_spawn" | "join_handle_await"` on the extern field's function type. src/evaluator/calls/helper.ts:378-384 and 471 read `functionType.ioBuiltin` in the EVALUATOR, not codegen.

**Evidence:** extern.yo:205-207 `Non-Func field types (e.g. __yo_argc : i32) carry no is_extern slot in yo-self's TypeValue and are never called, so the gate does not need them. ioBuiltin is codegen-only and stays skipped.` vs helper.yo:3098-3099 `(TS helper.ts:378-384 functionType.ioBuiltin skip). yo-self has no ioBuiltin marker, so detect the call structurally here (once).`

### `yo-self/evaluator/exprs/property_access.yo:1378` — no-op _(evaluator-exprs)_

**yo-self:** The struct/tuple field-access path dereferences through `PtrVal` to read the field value (1379-1414) but never records a `ComptimeRef` for the access. `ComptimeRef.StructRef` and `ComptimeRef.TupleRef` (yo-self/expr_info.yo:281,283) are consequently never constructed anywhere in yo-self.

**TS:** src/evaluator/exprs/property-access.ts:1081-1097 — after resolving the field through a `PtrValue`, TS sets `expr.$.comptimeRef = {kind:"struct", structValue, fieldIndex}` or `{kind:"tuple", tupleValue, fieldIndex}`, explicitly 'to enable mutation via assignment (p(0) = value) and &(self.x) in ComptimeIndex'.

**Evidence:** `grep -n 'comptime_ref' property_access.yo` returns only line 1002 (a prose comment); the module header at line 14 states `comptimeRef setting for pointer-through-struct access — skipped (Phase 3).`

### `yo-self/evaluator/exprs/recur.yo:189` — partial _(evaluator-exprs)_

**yo-self:** `create_unknown_val(return_type)` produces a bare `EvalValue.UnknownVal(ty)`; the value carries neither `variable_name` nor `is_runtime_only`. yo-self's `EvalValue.UnknownVal` (yo-self/value.yo:199) has exactly one field, `ty`, so the whole flag is structurally absent from the port.

**TS:** src/evaluator/exprs/recur.ts:92-106 sets `recurUnknown.isRuntimeOnly = true` explicitly to stop comptime overload selection. src/evaluator/calls/index-trait.ts:327 also sets it; src/evaluator/exprs/property-access.ts:366-367, 1047-1050, 1178-1181 propagate it; it is consumed at src/evaluator/calls/function.ts:1706, 2441, 2504, src/evaluator/calls/helper.ts:471 and src/evaluator/exprs/assignment.ts:1207.

**Evidence:** recur.yo:189-193 `// TODO (Phase 3): extend UnknownVal with variable_name and is_runtime_only to match TypeScript's createUnknownValue({variableName, ...}) and the recurUnknown.isRuntimeOnly = true flag that prevents comptime overload selection on recur(...) results. See issues/recur-runtime-result-not-marked-runtime-only.md.` Also property_access.yo:13 `isRuntimeOnly propagation on UnknownVal — skipped (no flag in Phase 2).`

### `yo-self/evaluator/exprs/while.yo:516` — deferred-todo _(evaluator-exprs)_

**yo-self:** The comptime-loop-unrolling branch is absent. When the condition folds to comptime-true, yo-self just `recur`s on the SAME (uncloned) `expr` with `next_count+1` (line 526-530), re-evaluating the body over the same AST ids until the condition folds false or MAX_COMPTIME_LOOP_ITERATIONS throws. `ExprInfo.comptime_unrolled_bodies` is never set anywhere in yo-self.

**TS:** src/evaluator/exprs/while.ts:533-635 — when `isBooleanValue(effectiveConditionValue) && value===true && bodyHasRuntimeValue`, TS `cloneExpr`s the condition/body/step and unrolls up to MAX iterations, collecting `unrolledBodies` and storing them as `expr.$.comptimeUnrolledBodies` (613, 626). src/codegen/exprs/while.ts:147-148 emits each unrolled body instead of a loop.

**Evidence:** while.yo:516-518 `// Phase 2 stub: comptime while loop unrolling with runtime body is deferred to Phase 3. // TypeScript's evaluateWhile (lines 449-547) deep-clones and re-evaluates the loop body multiple times when the condition is compile-time true but the body has runtime values. // Without clone_expr, we fall through to the iteration counter check below.`

### `yo-self/evaluator/async/await_analysis.yo:188` — conservative-fallback _(evaluator-misc)_

**yo-self:** `is_join_handle_await_call` returns true for ANY `x.await(...)` method call whose receiver is not literally named `io` — there is no JoinHandle type check at all. A user type with an `await` method, or an Io renamed to `io2`, is classified as a JoinHandle await.

**TS:** src/evaluator/async/await-analysis.ts:164 — `isJoinHandleAwaitCall` requires `expr.func.$?.type?.ioBuiltin === "join_handle_await"`, i.e. the callee is specifically the JoinHandle.await builtin.

**Evidence:** /// Structurally: any `x.await(..., x)` where x is NOT "io". … is_method_await := … (tok.value == "await") … !(is_io_await_call(expr))

### `yo-self/evaluator/async/await_analysis.yo:85` — conservative-fallback _(evaluator-misc)_

**yo-self:** `_is_dot_access` identifies Io calls PURELY SYNTACTICALLY: the receiver atom's token text must literally be `io` (or `<x>.io` for an effect-bundle field named `io`). `is_io_await_call` / `is_io_async_call` / `is_io_state_call` / `is_io_spawn_call` are all thin wrappers over it. Any Io value bound to a different name (`io2`, `my_io`, a closure param named other than `io`, a struct field not named `io`) produces NO await point at all.

**TS:** src/evaluator/async/await-analysis.ts:128-158 — `isIoAwaitCall`/`isIoAsyncCall`/`isIoStateCall`/`isIoSpawnCall` all test `expr.func.$?.type?.ioBuiltin === "io_await"` etc., a TYPE marker (src/types/definitions.ts:83 `ioBuiltin?`), so the receiver's spelling is irrelevant.

**Evidence:** //! No `ioBuiltin` type marker exists in Yo, so Io calls are identified structurally by matching `io.await` / `io.async` dot-access patterns. … `.Atom(_, tok) => (tok.value == obj_name)`

### `yo-self/evaluator/builtins/comptime_numeric_fns.yo:46` — partial _(evaluator-misc)_

**yo-self:** All comptime integer arithmetic is done in `i64`. `apply_bounds` clamps/wraps only 8/16/32-bit types and falls through with `true => n` for u64/i64/usize/isize (no clamp). Literals are parsed by `parse_raw_int` (yo-self/evaluator/utils.yo:1424) which accumulates hex/bin/oct digits into an i64 with silent wraparound — `0xFFFFFFFFFFFFFFFF` becomes `-1` and is then emitted as the IntLit `"-1"` for a u64 — while an out-of-range DECIMAL literal returns `.None` and degrades to `create_unknown_val` (comptime_numeric_fns.yo:310/327/504/513).

**TS:** src/evaluator/builtins/comptime-numeric-fns.ts:206-251 `applyNumericBounds` — for U64/I64/Usize/Isize it converts to `bigint` and clamps to `getNumericBounds(type)` min/max; all arithmetic paths (lines 151-170, 291-300, 554-620) promote to `bigint` when either operand is bigint, so comptime integers are arbitrary precision.

**Evidence:** apply_bounds :: (fn(n : i64, ty : TypeValue) -> i64)( … ((bits == u8(32)) && !(signed)) => { abs_n % i64(4294967296) }, true => n

### `yo-self/evaluator/builtins/contracts.yo:9` — deferred-todo _(evaluator-misc)_

**yo-self:** Only the expression-position contract markers are ported (requires/ensures/invariant/ghost evaluate their args and return unit; ghost_fn/old are pass-throughs). `wrap_function_body_with_contracts` is absent, and yo-self's function types carry no `requires_exprs`/`ensures_exprs` at all (grep finds the identifiers nowhere outside this comment), so SIGNATURE contracts are silently erased.

**TS:** src/evaluator/builtins/contracts.ts:396-460 `wrapFunctionBodyWithContracts` — builds `assert(...)`/`comptime_assert(...)` calls from `fnType.requiresExprs`/`ensuresExprs`, hoists `old(...)` snapshots, honours `pragma(Pragma.NoContracts)`, and wraps the body; called from src/evaluator/calls/function-type.ts:402 and src/evaluator/values/anonymous-function.ts:662.

**Evidence:** //! NOT yet ported: `wrap_function_body_with_contracts` — the signature→assert //! lowering that turns `requires(...)` / `ensures(...)` in a function SIGNATURE //! into runtime `assert(...)` / `comptime_assert(...)` calls wrapping the body.

### `yo-self/evaluator/builtins/impl_constraint.yo:149` — deferred-todo _(evaluator-misc)_

**yo-self:** `Concrete(T)` inside `Impl(...)` is treated as an ordinary required trait: it is pushed into `required_trait_types` and the constructed `TypeValue.SomeT` gets `Option(TypeValue).None` for its resolved-concrete cell (line ~177). No duplicate-Concrete error, and nothing calls `register_some_resolved_concrete`. `is_concrete_trait_type` is imported at line 33 but never called — and it is no longer a stub (yo-self/types/guards.yo:417 checks `is_concrete.is_some()`), so the comment is stale as well.

**TS:** src/evaluator/builtins/impl-constraint.ts:103-132 — `if (isConcreteTraitType(sourceNamespaceType)) { … concreteType = sourceNamespaceType.isConcrete.concreteType; /* Don't add Concrete to requiredTraits */ }` then `someType.resolvedConcreteType = concreteType`, plus a `Impl can only have one Concrete(T) specifier` error.

**Evidence:** // Note: is_concrete_trait_type is a stub that returns false. // Concrete(T) support is deferred.

### `yo-self/evaluator/builtins/ptr_fns.yo:136` — partial _(evaluator-misc)_

**yo-self:** `evaluate_address_call` takes `arg_type := arg_info.ty` and builds `t_ptr(arg_type)` directly. The comptime→runtime conversion step is absent: a comptime_int / comptime_float / comptime_str argument yields `*(comptime_int)` / `*(comptime_str)`, and `ExprInfo.converted_runtime_type` is never set on the argument.

**TS:** src/evaluator/builtins/ptr-fns.ts:106-124 — if the arg type is comptime int/float/string it calls `convertComptimeTypeToRuntimeType({...})`, writes it back to `evaluatedArgExpr.$.type` AND sets `evaluatedArgExpr.$.convertedRuntimeType = runtimeType` before `createPtrType(argType)`.

**Evidence:** arg_type := arg_info.ty; pointer_type := t_ptr(arg_type); — no is_comptime_int_type / convert_comptime_type_to_runtime_type anywhere in the file

### `yo-self/evaluator/utils/closure.yo:141` — top-level-only _(evaluator-misc)_

**yo-self:** `enrich_captured_variables` uses `cap_info.frame_level` ONLY as a bounds guard (`if(fl < n_frames, …)`) and then resolves the variable with `get_variables_from_env(env, var_name)`, which scans EVERY frame; the loop overwrites `result` for each hit, so the LAST match in env order wins rather than the variable in the recorded frame.

**TS:** src/evaluator/utils/closure.ts:363-372 — `const frame = env.frames[captureInfo.frameLevel]!; const variable = frame.variables.find((v) => v.name === varName);` — exactly the frame the capture was recorded at, and the FIRST match inside it.

**Evidence:** fl := cap_info.frame_level; n_frames := env.frames.len(); if(fl < n_frames, { vars := get_variables_from_env(env, var_name.clone()); … while(j < m, … \_s := result.set(vn_copy.clone(), enriched); …

### `yo-self/evaluator/types/array.yo:226` — conservative-fallback _(evaluator-types)_

**yo-self:** When the evaluated length value is not `.IntLit`, yo-self sets `len_is_var = true` and `len_usize = usize(0)`. It only recovers the abstract length via `t_array_var(child_type, <token text>)` when `ast_expr_is_atom(length_expr)` is ALSO true (line 237-241). For any non-atom length expression that did not fold to an integer literal — `Array(T, N + 1)`, `Array(T, Cfg.CAP)`, `Array(T, f(x))` — the fallback `t_array(child_type, usize(0))` silently produces a ZERO-LENGTH array type.

**TS:** src/evaluator/types/array.ts:144-158. TS requires a length value (`if (!lengthValue) throw "Expected compile-time known value for length"`), retypes an `UnknownValue` to usize, and passes the VALUE itself into `createArrayType(childType, lengthValue)` — the abstract length is preserved in `ArrayType.length` regardless of expression shape, and the synthesizer later binds it via `length.variableName`.

**Evidence:** `.UnknownVal(_) => { len_is_var = true; usize(0) }` and `_ => { len_is_var = true; usize(0) }`, preceded by "until the Array variant carries an EvalValue length, the placeholder is a deliberate simplification"

### `yo-self/evaluator/types/expr_synthesizer.yo:39` — no-op _(evaluator-types)_

**yo-self:** `synthesize_expr_and_type` returns `SynthesizeResult(expr : expr, ty : ty, env : env)` — the inputs, verbatim. It implements none of TS's five branches. Its live caller is `yo-self/evaluator/exprs/initialization_assignment.yo:386`, which then does `rhs_type_opt = Some(synth.ty)` and `if(!(are_types_compatible(pre_type, synth.ty)), throw)`. Because `synth.ty == ty == pre_type`, that compatibility check compares `pre_type` against itself and can never fire: every user-annotated `(x : T) := rhs` initialization is UNCHECKED.

**TS:** src/evaluator/types/expr-synthesizer.ts:34-263. TS handles: (a) tuple types — recursively synthesizes each field and stamps `expr.$ = {env, type}`; (b) `_(args)` against struct/union/source-namespace/trait — calls `evaluateFunctionCall` with the target type as `givenFunc` so `(p : Point) := _(3, 4)` actually constructs a Point; (c) `.Variant` against an enum — returns `{...type, selectedVariantName}`; (d) `.Variant(args)` — constructs the variant via `evaluateFunctionCall`; (e) the general case (line 236-256) — runs `synthesizeTypes({type, env}, {type: expr.$.type, env})` to bind SomeTypes in the DECLARED type from the RHS type, returning the expected type on success and, in the catch, `expr.$.type` (the RHS type, explicitly commented "NOTE: Here we should return the type of expr, not `type`"); (f) an else branch that throws `Failed to synthesize the type and expr`.

**Evidence:** //! Phase 2w stub: returns `expr`, `ty`, and `env` unchanged. / `SynthesizeResult(expr : expr, ty : ty, env : env)`

### `yo-self/evaluator/types/synthesizer.yo:1305` — intentional-divergence _(evaluator-types)_

**yo-self:** The `set_resolved_concrete_type` stamp is LAST-WINS: `register_some_resolved_concrete(exp_id2, given_ty)` calls `g_some_resolved_concrete.set(...)` (expr_info.yo:563), and the per-lineage cell is cleared (`exp_cell.remove(0, exp_cell.len())`) before pushing. The in-code comment asserts "Last-wins like TS", which is wrong. The symmetric given-side site at line 1394 has the same behaviour.

**TS:** src/evaluator/types/synthesizer.ts:461-465 — `if (options?.setResolvedConcreteType && !expected.type.resolvedConcreteType) { expected.type.resolvedConcreteType = given.type; }`. The `!expected.type.resolvedConcreteType` guard makes it FIRST-WINS: once a SomeType has been resolved to a concrete type, later unifications never overwrite it. (The given-side site at synthesizer.ts:595 is the mirror.)

**Evidence:** `register_some_resolved_concrete(exp_id2, given_ty);` … `if(exp_cell.len() > usize(0), { exp_cell.remove(usize(0), exp_cell.len()); }); exp_cell.push(given_ty);` with the comment "Last-wins like TS"

### `yo-self/evaluator/values/anonymous_function.yo:1436-1446` — partial _(evaluator-values)_

**yo-self:** When lowering the expected `Impl(Fn(...))` wrapper SomeT, yo-self unconditionally does `register_some_resolved_concrete(expected_wrapper_some_id, capture_type)` — it stamps the bare capture STRUCT onto the wrapper id. It never builds the synthetic `__impl_fn` intermediary.

**TS:** src/evaluator/values/anonymous-function.ts:1200-1226: TS first tests `wrapperType.requiredTraits.some(t => t.traitType.id === expectedFnTraitType.id)`; when the Fn trait is NOT in requiredTraits (it came from a where-clause) it creates `createSomeType(..., "__impl_fn", {requiredTraits:[expectedFnTraitType]})`, sets THAT as the wrapper's resolvedConcreteType, and points it at the capture struct. The comment states that stamping the bare struct "strips the Fn trait info. Subsequent where-clause checks would then fail with 'Type struct() does not implement required trait Fn(...)'".

**Evidence:** anonymous_function.yo:1436-1446 `// Lower the expected Impl(Fn) wrapper SomeT to this capture struct ... register_some_resolved_concrete(expected_wrapper_some_id.clone(), ct_w)` — single unconditional branch.

### `yo-self/evaluator/values/anonymous_function.yo:1451-1459` — partial _(evaluator-values)_

**yo-self:** The closure's ExprInfo is built as `new_expr_info(env, function_type)` with `info.value = Some(func_val)` and no temp-variable attachment. Three divergences at once: (a) the recorded TYPE is the plain `Func`, not the expected `Impl(Fn(...))` wrapper SomeT; (b) the VALUE is a FuncVal where TS deliberately sets `undefined` because closures are runtime-only; (c) `attach_temp_variable_to_expr(expr, true)` is never called for closures.

**TS:** src/evaluator/values/anonymous-function.ts:1237-1258 — `finalType` is the wrapper SomeType carrying `resolvedConcreteType`, `finalValue = undefined` for closures ("Closures are always runtime values"), and `if (isClosureFunction) attachTempVariableToExpr(expr, true);`.

**Evidence:** anonymous_function.yo:1451-1459 `info := new_expr_info(env, function_type); info.value = Option(EvalValue).Some(func_val); ... info.capture_type = closure_capture_type;` — no attach_temp call anywhere in the file (grep).

### `yo-self/evaluator/values/anonymous_function.yo:564-568` — intentional-divergence _(evaluator-values)_

**yo-self:** When `ctx.expected_type` is `.None`, yo-self calls `_synthesize_default_func_type(param_decl, env)` — a Func whose parameter types are fresh `SomeT`s NAMED AFTER THE PARAMETER LABELS and whose return is a fresh `SomeT("_ret")`. TS throws instead.

**TS:** src/evaluator/values/anonymous-function.ts:190-195 — `if (!expectedType) throw formatErrorMessage({... 'Expected a function type, got: ...'})`.

**Evidence:** anonymous_function.yo:556-567 `// TS reference throws here; the bootstrap is more lenient ... Tracked in issues/yo-self-evaluator-gaps.md §5c.` + `_synthesize_default_func_type` at 168-184.

### `yo-self/evaluator/values/anonymous_struct.yo:189-227` — partial _(evaluator-values)_

**yo-self:** Same UnknownVal-vs-undefined gap as array.yo: the `all_comptime` loop treats `.Some(_) => ()` as "has a comptime value" (line 224) without testing `is_unknown_val`, so a struct literal with runtime fields still gets a `StructVal`.

**TS:** src/evaluator/values/anonymous-struct.ts:202-204 `structValue = values.some((value) => !value) ? undefined : createStructValue(...)`.

**Evidence:** anonymous*struct.yo:218-225 `.Some(fvo) => match(fvo, .None => { ac = false; }, .Some(*) => ())`

### `yo-self/evaluator/values/array.yo:184-192` — partial _(evaluator-values)_

**yo-self:** The `all_have_values` scan only rejects `Option.None`; it never checks `is_unknown_val`. yo-self represents a runtime (non-comptime) result as `Some(UnknownVal)`, so every runtime array literal is judged fully comptime-known and an `ArrayVal` is built containing UnknownVal holes. array.yo does not even import `is_unknown_val`.

**TS:** src/evaluator/values/array.ts:130 `const arrayValue = arrayElementValues.every((val) => !!val) ? createArrayValue(...) : undefined;` — TS runtime elements have `$.value === undefined`, so the array value is correctly `undefined`.

**Evidence:** array.yo:186-191 `opt_v := ...; if(opt_v.is_none(), { all_have_values = false; });` vs tuple.yo:311-318 `// yo-self runtime results are Some(UnknownVal) where TS uses undefined ... codegen's comptime short-cut emits ._0 = /* skip generating value */ — invalid C.`

### `yo-self/evaluator/values/char.yo:79` — partial _(evaluator-values)_

**yo-self:** `parse_char_literal`'s non-escape branch is `true => u32(b1)` where `b1 := tok_value.byte_at(usize(1))` — the FIRST UTF-8 BYTE after the opening quote. For any non-ASCII char literal this is a UTF-8 lead byte, not the code point: `'é'` yields 195 (0xC3) instead of 233.

**TS:** src/evaluator/values/char.ts:36 `return innerValue.charCodeAt(0);` — a UTF-16 code unit, i.e. the true code point for every BMP character.

**Evidence:** char.yo:77-79 `// Simple character: tok_value looks like 'x' — b1 is the char byte` / `true => u32(b1)`. The module header (char.yo:8-13) reasons about `'é'` having inner byte-length 2 but only drops the LENGTH check; the byte-based decode is left in.

### `yo-self/evaluator/values/dyn.yo:513-545` — partial _(evaluator-values)_

**yo-self:** The EXECUTING path's auto-box builds the synthetic call as `AstExpr.Atom(usize(0), box_tok)` / `AstExpr.FnCall(usize(0), ...)` — expr id 0 for both — evaluates it with NO expected type, and never records `runtime_arg_exprs_in_order`. The non-executing path (dyn.yo:439-474) does all three correctly and explicitly warns that id=0 is wrong.

**TS:** src/evaluator/values/dyn.ts:255-305 — TS calls `createBoxedType(valueType, env, context)` and evaluates the synthetic box call with `expectedType: { type: boxType, env }` so `box`'s `forall(V)` binds.

**Evidence:** dyn.yo:515-519 `box_atom := AstExpr.Atom(usize(0), box_tok); ... box_call := AstExpr.FnCall(usize(0), box_atom, box_args, false, expr_tok); boxed_expr := evaluate_expression(box_call, cur_env, ctx);` vs dyn.yo:379-381 `// The synthetic atom/call get REAL ids (alloc_global_expr_id) — id=0 breaks the call's ExprInfo/forall setup. The boxed expr is surfaced via runtime_arg_exprs_in_order (the field generate_dyn_call reads).`

### `yo-self/evaluator/values/float.yo:60` — partial _(evaluator-values)_

**yo-self:** FloatLit's raw string is produced by `parse_raw_float(tok.value).to_string()`. `f64.to_string()` is `snprintf(buf, 64, "%g", self)` (std/fmt/to_string.yo:148) — %g is SIX significant digits. So `3.141592653589793` is stored as the string "3.14159" and that truncated literal is what codegen emits.

**TS:** src/evaluator/values/float.ts:16 — `const floatValue = parseFloat(expr.token.value)` stored as a JS number in the Value; nothing re-formats it at 6 digits. Precision is preserved to the C emitter.

**Evidence:** float.yo:59-60 `// Parse to f64, normalize to decimal string` / `raw := parsed.to_string();` + std/fmt/to_string.yo:147-148 `// Use %g for general format (removes trailing zeros)` / `snprintf(..., "%g", f64(self))`

### `yo-self/evaluator/values/impl.yo:163-193` — deferred-todo _(evaluator-values)_

**yo-self:** `GenericImplEntry` has no `trait_type_arg_exprs` / `trait_function_param_names` fields, and there is no counterpart to TS `extractTraitTypeArgsFromImplExpr` anywhere in yo-self (grep over yo-self/\*\*.yo finds nothing). So a generic impl of a PARAMETRIC trait never re-binds the trait's own parameters at specialization time.

**TS:** src/evaluator/values/impl.ts:375-419 `extractTraitTypeArgsFromImplExpr` captures the trait-constructor arg exprs plus the trait function's param labels; impl.ts:1443-1477 re-evaluates each arg expr in the specialized env and binds it ("For Eq(Box(T)) with T=i32, we re-evaluate Box(T) to get Box(i32), then bind Rhs=Box(i32)"). It also extracts associated-type field exprs (Output : T) for the same re-evaluation.

**Evidence:** impl.yo:163-193 field list ends at `where_constraint_some_types` / `where_constraint_traits`; no arg-expr storage. `grep -rn "trait_type_arg_exprs|trait_function_param_names" yo-self` → no matches.

### `yo-self/evaluator/values/impl.yo:970-997` — simplified-port _(evaluator-values)_

**yo-self:** `find_methods_from_generic_impls` specializes a matched method by building a name+level substitution map from the impl's forall bindings and calling the STRUCTURAL `substitute(spec_s, ftype)`. The method BODY is never re-evaluated, the FuncVal keeps its original `func_id`, and no specialized FunctionValue is produced — only `_inject_forall_captures` appends the bindings as captures.

**TS:** src/evaluator/values/impl.ts:1404-1556 (`shouldCreateSpecializedValue` path): TS pushes a frame on `impl.definitionEnv`, binds every substitution AND valueSubstitution, re-evaluates trait type-arg exprs, calls `reEvaluateFunctionType` (which RE-EVALUATES the type in that env), re-evaluates the cloned body via `evaluateBeginExpression`, and mints `funcId = ${orig}_specialized_${...}`. impl.ts:1443 states explicitly: "types in Yo are nominal, so we can't just substitute structurally".

**Evidence:** impl.yo:970-977 `// Specialize the method TYPE with the impl's forall bindings — mirrors TS reEvaluateFunctionType ... (impl.ts:1484)` then `results.push(MethodCandidate(method_type : substitute(spec_s, ftype), ...))`. Header impl.yo:11 `tryCreateForwardShell / reEvaluateFunctionType: still deferred.`

### `yo-self/evaluator/values/tuple.yo:355` — no-op _(evaluator-values)_

**yo-self:** `evaluate_tuple_value` ends without calling `attach_temp_variable_to_expr` — the line is a bare comment `// attachTempVariableToExpr — Phase 3 stub (no-op).` The real helper exists and works (yo-self/evaluator/utils.yo:112) and sibling files array.yo:217, dyn.yo:636 and anonymous_struct.yo:289 all call it.

**TS:** src/evaluator/values/tuple.ts:289 `attachTempVariableToExpr(expr, true);` (after `expr.$` is populated).

**Evidence:** tuple.yo:15-17 `//! Phase 3 stubs preserved as no-ops: ... * attach_temp_variable_to_expr — temp-variable assignment is not yet ported.` and tuple.yo:355.

### `yo-self/evaluator/values/type_trait_methods.yo:108` — partial _(evaluator-values)_

**yo-self:** `type_id_or_empty` falls through to `_ => String.from("")` for Pointer, Array, Tuple, Func, Union, ComptimeListT, TypeAppT, EffectsRowT, DynT, FnTraitT and FutureTraitT. Every registration site in impl.yo is gated on `receiver_type_id != ""` (impl.yo:1994, 2049, 2322, 2434), so a concrete impl on any of those receiver shapes silently registers NOTHING.

**TS:** src/types/definitions.ts:70 — every TS Type carries an `id` and a `trait?: TraitType` slot; `attachTraitToReceiverType` (impl.ts:2808) merges methods onto whatever receiver type it is given, pointer/array/tuple included.

**Evidence:** type*trait_methods.yo:58-109 with `* => String.from("")`at 108; impl.yo:1157-1158`// Same landmine family as type_id_or_empty's missing Pointer case.`

### `yo-self/env.yo:1412` — no-op _(root)_

**yo-self:** `keep_top_level_frame_and_comptime_variables_from_env` (a) adds an extra `&& !(v.is_implicit)` filter TS does not have, and (b) has ZERO callers anywhere in yo-self — the env narrowing TS performs when defining a non-closure nested function is simply never applied.

**TS:** src/env.ts:2206-2226 — filter is only `(variable) => variable.isCompileTimeOnly`, with no `isImplicit` clause. Call sites TS has and yo-self lacks: src/evaluator/calls/function-type.ts:303 (`keepTopLevelFrameAndComptimeVariablesFromEnv(callerEnv)` when NOT in a closure context and NOT at module level) and src/evaluator/values/anonymous-function.ts:637.

**Evidence:** env.yo:1433 `if(v.is_compile_time_only && !(v.is_implicit), {` vs TS `frame.variables.filter((variable) => variable.isCompileTimeOnly)`. `grep -rn "keep_top_level_frame_and_comptime" yo-self --include=*.yo` outside env.yo → no matches.

### `yo-self/env.yo:2535` — partial _(root)_

**yo-self:** `_filter_receiver_methods` applies only 3 rules (drop 0-arg Funcs; annotate `*(T)` first-param with `needs_pointer_conversion`; pass everything else through). It NEVER runs the final `are_types_compatible(first_param, receiver, isMethodReceiver=true)` gate, so every candidate whose first param is not a pointer is KEPT regardless of whether the receiver type is compatible.

**TS:** src/env.ts:1260-1470 `filterMethodsByReceiverType`. TS additionally: (a) src/env.ts:1452-1463 the final `areTypesCompatible(methodFirstParamType, receiverType, true)` check that DROPS incompatible candidates; (b) src/env.ts:1381-1386 `!typeContainsSomeType(param) && typeContainsSomeType(receiver)` → `continue` (skip); (c) src/env.ts:1362-1378 the `isSomeType(receiver) && receiver.resolvedConcreteType && !typeImplementsFuture(receiver)` accept path; (d) src/env.ts:1390-1410 the comptime→runtime compat retry OUTSIDE the pointer branch; (e) src/env.ts:1413-1449 the Dyn object-safety filter.

**Evidence:** Doc comment at env.yo:2507-2534: "Mirrors a subset of TS `filterMethodsByReceiverType` in `src/env.ts:1288-1499`. Rules applied: 1. Drop 0-arg `Func`-typed entries … 2. … 3. … Still owed (deferred to follow-up commits …): - SelfType specialization (TS:1958-1961). - SomeType-with-resolvedConcreteType matching (TS:1390-1406). - The env-frames \"compatible-SomeType\" scan (TS:1927-1948)". The `true =>` arm at env.yo:2623-2625 unconditionally does `out.push(m);`.

### `yo-self/expr_info.yo:317` — partial _(root)_

**yo-self:** `ExprInfo` has no `is_return_slot` field. Nothing in yo-self can mark an `&(ref-returning-call)` that sits in a `return(...)` slot, so `generate_address_of` always falls through to the spill-to-temp-then-take-its-address path.

**TS:** src/expr.ts:457 `isReturnSlot?: boolean` on `EvaluatedExprData`; set at src/evaluator/exprs/begin.ts:1193 (`candidate.$.isReturnSlot = true` for `__yo_address_of` args of `return`); consumed at src/codegen/exprs/ptr-fns.ts:134-140, which returns `argCode` (forwarding the already-`T*` temp) instead of `(&temp)`.

**Evidence:** yo-self/codegen/exprs/ptr_fns.yo:9-12: "DEFERRED (documented): the `is_return_slot` ref-forward (when `&(arg)` is the … ) `is_return_slot` field and Variable has no `is_ref` flag." No `is_return_slot` appears anywhere in `yo-self/expr_info.yo`'s `ExprInfo :: ref(struct(...))` field list (lines 319-406).

### `yo-self/main.yo:1136` — hardcoded _(root)_

**yo-self:** `run_compile` resolves the compilation target only AFTER `evaluate_anonymous_module_begin_exprs` has already run (module value obtained at main.yo:1127), and it never calls `set_target_pointer_size(...)`. `g_target_pointer_size_bits` (yo-self/types/utils.yo:62) therefore stays at its hard-coded `u32(64)` for every compilation.

**TS:** src/codegen/index.ts:183-188 — `const targetInfo = options.targetTriple ? parseTarget(...) : hostTarget(); setCurrentTarget(targetInfo); setTargetPointerSize(targetInfo.pointerSizeBits);` — both run BEFORE `this.moduleManager.compileModule(...)` (line 201), i.e. before evaluation.

**Evidence:** main.yo:1135 comment "// Resolve the compilation target: --target <triple> if given, else host." placed after the evaluation block; `grep -rn "set_target_pointer_size(" yo-self --include=*.yo` (excluding types/utils.yo) returns NOTHING.

### `yo-self/target.yo:329` — conservative-fallback _(root)_

**yo-self:** `set_current_target` / `get_current_target` are not ported at all — target.yo has no module-level 'current target' slot. Consumers fall back to `detect_host()`, i.e. the HOST rather than the requested TARGET.

**TS:** src/target.ts:296-317 `let currentTarget; setCurrentTarget(target); getCurrentTarget()` (falls back to `hostTarget()`). Consumed by src/evaluator/builtins/process.ts:41 and :64 for `__yo_process_platform` / `__yo_process_arch`, and by src/codegen/codegen-c.ts:108.

**Evidence:** `grep -rn "set_current_target|get_current_target|current_target" yo-self --include=*.yo` → no matches. yo-self/evaluator/builtins/process.yo:43 `host := detect_host();` where TS has `const target = getCurrentTarget();`.

### `yo-self/types/compatibility.yo:423` — partial _(types)_

**yo-self:** The `.Func` arm compares forall count, param count, pairwise forall types, pairwise param types and the return type. It never reads `meta.is_control`, never compares per-parameter comptime-ness, and performs no forall synthesis. `are_function_types_compatible` (compatibility.yo:926) is just `_compat_impl(..., require_exact=false, ...)`, i.e. the same arm.

**TS:** src/types/compatibility.ts:969-1091 `areFunctionTypesCompatible` — (1) §4 typing rule 5 subtyping: `if (givenIsControl && !expectedIsControl) return false` (and under requireExactMatch both must agree); (2) `synthesizeTypes` on the forall parameters, returning false when synthesis fails; (3) `if (expectedParam.isCompileTimeOnly !== givenParam.isCompileTimeOnly) return false` per parameter.

**Evidence:** `grep -n "is_control" yo-self/types/compatibility.yo` returns nothing; the arm at compatibility.yo:423-452 destructures only `forall_types`, `param_types`, `result` and never binds `meta`.

### `yo-self/types/compatibility.yo:708` — partial _(types)_

**yo-self:** Union-vs-Union is `((aname == ename) || (aname.len() == 0) || (ename.len() == 0))` — name-only, with EMPTY name as a wildcard, in BOTH the non-exact and the `require_exact` paths. Field labels and field types are never compared. Root cause: `TypeValue.Union` (definitions.yo:215) carries only `name`, `field_labels`, `field_types` — no `id`.

**TS:** src/types/compatibility.ts:407-439 — rejects on field-count mismatch or on distinct ids when neither side contains a SomeType, fast-accepts on equal id, then compares every field's label AND recursively its type.

**Evidence:** compatibility.yo:708-711, the entire `.Union` arm is a three-way name/empty test; contrast the immediately preceding `.EnumT` arm (compatibility.yo:659-703), which was explicitly upgraded to a structural compare with the comment `Under require_exact (cache identity), name-only is unsound for the same reason as the Struct arm: all yo-self enums carry an empty name`.

### `yo-self/types/compatibility.yo:720` — partial _(types)_

**yo-self:** SomeT-vs-SomeT compatibility is `((aname == ename) && (alvl == elvl))` — name plus frame level, nothing else. It never looks at `id`, `resolved_concrete`, required traits, or negative traits, and it behaves identically under `require_exact`.

**TS:** src/types/compatibility.ts:675-790 — id equality then `resolvedConcreteType` comparison; otherwise compares `getEffectiveRequiredTraitTypes` (SomeType requiredTraits UNIONed with scoped where-clause constraints), rejects on trait-count mismatch under requireExactMatch, checks negative traits, compares both `resolvedConcreteType`s, and under requireExactMatch demands that both or neither carry one.

**Evidence:** compatibility.yo:719 `// SomeT: name + frame_level identity (Phase 2f: no env resolution)` followed by the two-field comparison; `resolved_concrete` appears nowhere in compatibility.yo.

### `yo-self/types/guards.yo:430` — partial _(types)_

**yo-self:** `is_rc_type`'s `.SomeT` arm scans `required_trait_types` for a Future trait and returns that boolean. It never consults `SomeT.resolved_concrete`, so a SomeType already resolved to a `ref(struct …)` / `ref(enum …)` / `Dyn` / `Iso` reports NOT RC-managed.

**TS:** src/types/guards.ts:307-331 `isRcType` — for a SomeType: `if (typeImplementsFuture) return true; if (someType.resolvedConcreteType) return isRcType(someType.resolvedConcreteType);` before falling through to the ref-struct / ref-enum / Dyn / Iso tests.

**Evidence:** guards.yo:454-471 — the `.SomeT(required_trait_types : req_traits)` arm only loops `req_traits` looking for `is_future_trait_type`, then `_ => false`; no `resolved_concrete` read anywhere in the function.

### `yo-self/types/guards.yo:544` — partial _(types)_

**yo-self:** `is_function_type_hard_generic` checks only (a) `forall_labels.len() > 0` and (b) any param that is a bare `.SomeT` without a registered resolved-concrete. It omits three TS conditions: the `functionType.return.isCompileTimeOnly → return false` early-out, `parameters.some(p => p.isCompileTimeOnly)`, and `variadicParameter.isCompileTimeOnly || variadicParameter.isQuote`. It also omits TS's `!p.isCompileTimeOnly` filter and the `!typeImplementsFuture(p.type)` carve-out on the SomeType scan, so a comptime param or a `Future` SomeType param wrongly counts as hard-generic.

**TS:** src/types/guards.ts:491-518 `isFunctionTypeHardGeneric` — early-returns false when `return.isCompileTimeOnly`; `hasCompileTimeParams` covers per-param `isCompileTimeOnly` + variadic `isCompileTimeOnly`/`isQuote` + forall; `hasSomeTypeParams` filters `!p.isCompileTimeOnly && isSomeType(p.type) && !typeImplementsFuture(p.type) && !p.type.resolvedConcreteType`.

**Evidence:** guards.yo:539-543 `/// Partial Phase 2a implementation: detects forall parameters and SomeType parameters without a resolved concrete type.` `/// Phase 2b: extend to check per-parameter isCompileTimeOnly flags and resolvedConcreteType on SomeType parameters.`

### `yo-self/types/guards.yo:584` — hardcoded _(types)_

**yo-self:** `is_function_specializable :: (fn(t : TypeValue) -> bool)(false);` — a bare constant. It also takes a `TypeValue` where TS takes a `FunctionValue`, so the caches half of the test is unrepresentable.

**TS:** src/types/guards.ts:537-549 `isFunctionSpecializable(functionValue)` = `isFunctionTypeGeneric(functionValue.type) && (functionValue.specializedFunctionCaches?.length ?? 0) > 0`. Used at src/codegen/functions/collection.ts:403 and :584 to SKIP collecting a generic function that was never specialized (while still recursing into its args).

**Evidence:** guards.yo:583 `// Phase 2b: requires FunctionValue with \`specializedFunctionCaches\` field.`; yo-self/codegen/functions/collection.yo:9-13 `DEFERRED (Phase-3 … is_function_specializable is a \`false\` stub): specializedType / specializedFunctionCaches / isFunctionTypeHardGeneric / resolvedConcreteType branches`.

### `yo-self/types/intern.yo:559` — intentional-divergence _(types)_

**yo-self:** `intern_type` canonicalizes every structurally-equal TypeValue to ONE shared instance and is called on every level of every `substitute` result (substitution.yo:105). `SomeT.resolved_concrete` is a SHARED MUTABLE one-element ArrayList cell that is mutated in place (`exp_cell.remove(...)` + `exp_cell.push(...)` at evaluator/types/synthesizer.yo:1314-1319 and :1399-1404). Two UNRESOLVED SomeTs from different call sites render the same key (…|n) and are merged into one instance, so they end up sharing ONE cell: the first site to stamp a resolution silently stamps it for the other lineage too.

**TS:** src/types/creators.ts memoizes only atomic types; TS SomeTypes are distinct objects and `resolvedConcreteType` is mutated per object (src/types/definitions.ts:191, synthesizer.ts:463 'last-wins' per object). TS therefore cannot cross-contaminate two independent type variables.

**Evidence:** intern.yo:30-32 `A full-content key is at-least-as-fine as codegen's identity, so it can never wrong-merge … Sound because TypeValues are rebuilt-not-mutated.` vs definitions.yo:275-287 `HAZARD: a SomeT cloned from ONE declaration across many calls is ONE lineage … per-call resolutions must seed a FRESH SomeT + cell (rebuild), never mutate the shared cell`.

### `yo-self/types/substitution.yo:276` — partial _(types)_

**yo-self:** When a `.SomeT` is NOT matched by the substitution map, `substitute` rebuilds it as `.SomeT(orig_id, n, lvl, pt, new_rts, rlvls, new_nts, nlvls, false, Option(TypeValue).None, rcp)` — hardcoding field 9 `is_effects_row` to `false` and field 10 `kind_function_type` to `.None`, silently DROPPING whatever the original carried. `parent_type` is also passed through unsubstituted, and TraitT's `self_constraints`/`neg_self_constraints` (substitution.yo:184) are likewise not walked.

**TS:** There is no monolithic TS `substitute`; the equivalent rebuild is src/evaluator/calls/helper.ts:3037 `substituteType`, which returns the SAME type object for a non-matching SomeType, so no field can be lost. `SomeType.isEffectsRow` / `kindFunctionType` (src/types/definitions.ts:238) survive by construction.

**Evidence:** substitution.yo:276 literal `…, nlvls, false, Option(TypeValue).None, rcp)` against definitions.yo:249-287 where SomeT's 9th/10th fields are `is_effects_row : bool` and `kind_function_type : Option(Self)`.

### `yo-self/types/type_key.yo:414` — partial _(types)_

**yo-self:** `_type_key_at` has purpose-built arms only for Struct, EnumT, SomeT, TraitT, DynT, Pointer and Tuple. Everything else — `.Array`, `.Func`, `.IsoT`, `.Union`, `.ComptimeListT`, `.EffectsRowT`, `.TypeAppT`, `.FnTraitT`, `.FutureTraitT` — falls through to `_ => type_to_string(t)`, and `type_to_string` renders a Struct as its bare `name` (string.yo:161) and an EnumT as its bare `name` (string.yo:163).

**TS:** TS has no `type_key`: codegen keys every C type by the unique `type.id` (src/codegen/functions/collection.ts:805), so no rendering can ever merge two distinct types.

**Evidence:** type_key.yo:378-386 documents exactly this failure for Tuple: `key by the RECURSED keys of the field types … NOT by \`type_to_string\`. Tuples are structural — the render fallback embedded the EVALUATOR's type-argument spelling, so \`Tuple(0 : Box(V))\` … and \`Tuple(0 : Box(i32))\` minted TWO C types for one layout`. The same reasoning is not applied to `.Array`/`.IsoT`/`.Func`.

### `yo-self/types/utils.yo:1299` — partial _(types)_

**yo-self:** `get_size_of_type`'s Array arm is `.Array({ element : el, length : n }) => match(recur(el), .Some(bits) => .Some(bits * n), .None => .None)`. It ignores `length_var`. A variable-length array built by `t_array_var` (creators.yo:78) stores `length = usize(0)` as an explicit placeholder, so the arm returns `Some(0)` — a confidently-wrong size of zero — instead of "unknown".

**TS:** src/types/utils.ts:1541-1560 `getArrayTypeSize` — `const lengthValue = type.length; if (isNumberValue(lengthValue)) { … } return null;` i.e. a non-numeric (UnknownValue / variable) length yields `null` = unknown size, which propagates as null through getStructTypeSize / getEnumTypeSize.

**Evidence:** creators.yo:75-80 `\`length\` is a placeholder 0; the synthesizer binds \`length_var\` … (mirrors TS ArrayType.length being an UnknownValue with variableName)`; utils.yo:1299-1303 never mentions length_var. `length_var`is live: codegen/utils/index.yo:892 and codegen/exprs/drop_dup.yo:174 both branch on`length_var.len() > 0`.

### `yo-self/types/utils.yo:860` — top-level-only _(types)_

**yo-self:** `type_contains_some_type` inspects ONLY the top-level variant: it returns a real answer for `.SomeT` and `.TypeAppT` and `false` for EVERY composite (Array, Tuple, Struct, EnumT, Union, Func, Pointer). So `Struct{f : SomeT(T)}`, `Array(SomeT,4)`, `*(SomeT)`, `fn(SomeT)->…` all report "contains no SomeType". A recursive sibling `type_contains_some_type_deep` (utils.yo:1040) exists but is deliberately wired ONLY into codegen_c.yo:62/94 — all ~15 evaluator call sites (compatibility.yo, calls/helper.yo, types/function.yo, exprs/cond.yo, exprs/match.yo, trait_checking.yo) still use the shallow one.

**TS:** src/types/utils.ts:477-566 `typeContainsSomeType` — recurses through Array.childType, Tuple/Struct(skipping isEffectParam fields)/Enum/Union fields, Function forall+params+return, Ptr.childType, and follows `resolvedConcreteType` recursively; TypeApplication always true.

**Evidence:** utils.yo:856 `/// Phase 2 partial port: checks top-level variant only.` / `/// Full recursive traversal is Phase 3.`; utils.yo:1018 `type_contains_some_type above is TOP-LEVEL ONLY … TS's typeContainsSomeType (src/types/utils.ts:477) instead walks the whole type structure`; utils.yo:1036 `Deliberately NOT swapped in for type_contains_some_type everywhere`.

---

# MEDIUM

### `yo-self/codegen/codegen_c.yo:273` — no-op _(codegen-core)_

**yo-self:** compile_module goes generate_function_declarations → register_impl_closure_call_mappings → generate_all_functions. The preRegisterEffectfulFunctions stage between declarations and bodies is not ported anywhere in yo-self (grep for preregister_effectful / pre_register_effectful returns only the stale mention in the codegen_c.yo header comment).

**TS:** src/codegen/codegen-c.ts:228 `preRegisterEffectfulFunctions(context);`, implemented at src/codegen/functions/generation.ts:1109. Its doc: "This must run BEFORE any function bodies are generated, so that call sites can find the effectStateMachineInfo when generating calls to effectful functions." It creates SM structs + forward declarations for every effectful function across both the regular and specialized function sets.

**Evidence:** codegen_c.yo:184 lists `preRegisterAsyncBlockTypes / preRegisterEffectfulFunctions` as DEFERRED; preRegisterAsyncBlockTypes has since been ported (codegen_c.yo:271) but preRegisterEffectfulFunctions has not.

### `yo-self/codegen/codegen_c.yo:286` — no-op _(codegen-core)_

**yo-self:** compile_module ends at generate_deferred_async_blocks → module vars → main wrapper → emit_dispose_dispatch. The two specialized-function stages are never called and no yo-self equivalent exists.

**TS:** src/codegen/codegen-c.ts:269-272 — `generateSpecializedFunctionDeclarations(context); generateSpecializedFunctions(context);` (declarations.ts:753, generation.ts:1852), a fifth and sixth pass that emit declarations and bodies for specializations collected during body generation.

**Evidence:** codegen_c.yo:186 `generateSpecialized* (Gap 2)` listed as DEFERRED; generation.yo:554-559 documents the re-read-len workaround that stands in for it.

### `yo-self/codegen/codegen_c.yo:295` — partial _(codegen-core)_

**yo-self:** `if(!(is_library), { generate_main_wrapper(ctx, module_vars); });` — in library mode nothing is emitted. emit_module_level_variable_declarations has already emitted the `static <T> <name>;` declarations, but nothing ever assigns their initializer RHS.

**TS:** src/codegen/codegen-c.ts:256-261 — `if (!options.isLibrary) { generateMainWrapper(context); } else { generateLibraryInitFunction(context, moduleLevelVars); }`, implemented at src/codegen/functions/generation.ts:839.

**Evidence:** codegen_c.yo:186 lists `generateLibraryInitFunction` as DEFERRED; codegen_c.yo:290-297 emits the declarations unconditionally but the init only via generate_main_wrapper.

### `yo-self/codegen/functions/collection.yo:1021` — partial _(codegen-core)_

**yo-self:** collect_trace_methods_from_generic_impls calls find_methods_from_generic_impls(ct, "trace", module_env) and then processes ONLY `candidates.get(usize(0))` — the first candidate.

**TS:** src/codegen/functions/collection.ts:724-746 — `for (const method of methods) { ... }`: TS iterates EVERY method returned by findMethodsFromGenericImpls, registering and recursing into each. The sibling collectDisposeMethodsFromGenericImpls (collection.ts:669-698) does the same.

**Evidence:** collection.yo:1021-1033 `if(candidates.len() > usize(0), { match(candidates.get(usize(0)), .Some(cand) => ... ) })` — no loop over candidates.

### `yo-self/codegen/functions/collection.yo:229` — partial _(codegen-core)_

**yo-self:** collect_effect_record_members registers the effect-record fn field and recurses its body, then stops. The loop over the field's specialized function caches is absent.

**TS:** src/codegen/functions/collection.ts:232-247 — after registering the field, TS iterates `fieldValue.specializedFunctionCaches`, marks each `specialized.isEffectRecordMember = true`, registers it, and recurses into its body. TS's own comment: "Also collect specialized versions (e.g., forall throw handlers specialized for concrete ResumeTypes ...). Without this, the codegen emits a call to the specialized name but never defines it."

**Evidence:** collection.yo:229 `// specializedFunctionCaches: deferred (Phase 3).` inside the fn-field branch.

### `yo-self/codegen/functions/collection.yo:784` — partial _(codegen-core)_

**yo-self:** The dyn-impl registration inside find_function_calls_in_expr builds its key with `type_key(concrete)` / `type_key(ei.ty)`, which structurally walks the type. The code comments that this can loop forever on a self-referential dyn trait and is only safe because the current corpus's Dyn types are acyclic.

**TS:** src/codegen/functions/collection.ts:352 — `const implKey = \`${concreteType.id}_${dynType.id}\`;` uses opaque numeric type ids, which cannot recurse regardless of type cyclicity.

**Evidence:** collection.yo:784-786 `NOTE: type_key on a cyclic dyn (Dyn(Error)) could loop — the corpus's Dyn(Speak) is acyclic so this is corpus-safe; a cycle-safe key is future work for compiling std's self-referential traits.`

### `yo-self/codegen/functions/declarations.yo:186` — partial _(codegen-core)_

**yo-self:** generate_function_prototype's non-function-parameter branch does `pts := get_type_string(pt, context)` for every parameter, with no special case for SomeType parameters that implement Future.

**TS:** src/codegen/functions/declarations.ts:411-425 — `if (isSomeType(param.type) && typeImplementsFuture(param.type)) { if (param.type.resolvedConcreteType) { paramTypeStr = getTypeString(param.type.resolvedConcreteType, context) + "*"; } else { paramTypeStr = getTypeString(param.type, context); } }`

**Evidence:** declarations.yo:125-126 `the SomeType-Future resolvedConcreteType param branch is omitted (Gap 6)`.

### `yo-self/codegen/functions/declarations.yo:462` — partial _(codegen-core)_

**yo-self:** should_skip_function_codegen is a single merged predicate shared by the prototype loop and the body loop. It omits two skips TS applies: (a) `value.specializedFunctionCaches?.length > 0 && !value.type.isClosure` (skip the unspecialized BASE when specializations exist), and (b) `value.specializedType && !isSpecializedImplMethod`. It adds one skip TS does not have: skip_comptime_result (:506).

**TS:** src/codegen/functions/declarations.ts:151-171 (base-skip with the hasRegisteredReplacement carve-out), declarations.ts:192-193, and src/codegen/functions/generation.ts:699-703 `(value.specializedFunctionCaches?.length > 0 && !value.type.isClosure) || (value.specializedType && !isSpecializedImplMethod)`.

**Evidence:** declarations.yo:660-663 `DEFERRED (documented, Gap 2 — yo-self FuncVal/Func model lacks these fields): the specialization skips (specializedFunctionCaches / specializedType / isConcreteSpecialization) ... all evaluate to false here.`

### `yo-self/codegen/functions/declarations.yo:488` — partial _(codegen-core)_

**yo-self:** skip_unemittable = `!is_user_main && ((!is_erm && is_function_type_hard_generic(function_type)) || _func_has_expr_param(function_type))`. The hard-generic half is applied with only the effect-record-member exemption and the is_closure_fn early-return at :512.

**TS:** src/codegen/functions/generation.ts:667-685 gates the same hard-generic skip with FOUR extra conditions: `!value.specializedType && (value.specializedFunctionCaches?.length ?? 0) === 0 && !value.type.isClosure && (!value.isEffectRecordMember || hasComptimeParams)`. src/codegen/functions/declarations.ts:186-196 gates its copy with `!isEffectfulFunction && !hasEvidenceParams && !value.isEffectRecordMember && !isConcreteSpecialization`.

**Evidence:** declarations.yo:457-461 documents only three skip classes; the code at :488 has no specializedType/caches guard, and the ERM exemption is unconditional (TS's is `!isEffectRecordMember || hasComptimeParams`).

### `yo-self/codegen/functions/declarations.yo:649` — no-op _(codegen-core)_

**yo-self:** generate_capture_dispose_function_declarations has a body of `()`. Its doc says the driving closure_capture_map is not modelled on yo-self's context. The paired body emitter generateClosureDisposeFunctions is not ported at all (no yo-self symbol exists).

**TS:** src/codegen/functions/declarations.ts:723-740 emits `static void __yo_dispose_closure_${closureInstanceId}(void* closure_ptr);` for every closureCaptureMap entry; src/codegen/functions/generation.ts:3304 generateClosureDisposeFunctions emits the bodies (cast closure → cast data to capture type → call the capture's drop → free). Called from src/codegen/codegen-c.ts:265.

**Evidence:** declarations.yo:645-651 `DEFERRED: driven by closureCaptureMap, which yo-self's context does not model yet (Phase 5 closure support) — the map is empty for the corpus, so this emits nothing.` Confirmed absent from utils/index.yo's CodeGenContext field list.

### `yo-self/codegen/utils/fixup.yo:41` — partial _(codegen-core)_

**yo-self:** fixup*dyn_impl_keys computes `concrete_key := type_key(impl_entry.concrete_type)` directly from the stored concrete type, with no SomeType resolution step, then falls back to extract_fn_trait_from_type and finally to the literal `unknown*${concrete_key}`.

**TS:** src/codegen/utils/fixup.ts:26-30 — TS first does `const resolvedConcreteType = isSomeType(impl.concreteType) && impl.concreteType.resolvedConcreteType ? impl.concreteType.resolvedConcreteType : impl.concreteType;` and looks the C name up on THAT.

**Evidence:** utils/fixup.yo:5-7 `yo-self's DynT carries no .id and no resolvedConcreteType, so the key components use type_key(...) directly (the registry key) and the concrete type is used as-is (no SomeType-resolve step).`

### `yo-self/codegen/utils/index.yo:768` — intentional-divergence _(codegen-core)_

**yo-self:** get_type_string has no global extern early-return. The only extern handling is inside the SomeT arm (`is_extern_type_name(snm)` at :930).

**TS:** src/codegen/utils/index.ts:433-436 — the FIRST thing getTypeString does after the undefined check: `if (type.isExtern && type.externName) { return type.externName; }`, applying to every tag (structs, enums, unions, pointers).

**Evidence:** utils/index.yo:768-770 `DIVERGENCE: TS's \`type.isExtern && type.externName\` early return is omitted (Gap 3 — yo-self models is_extern only on Func; extern-C struct types are a later-phase concern).`

### `yo-self/codegen/utils/index.yo:919` — partial _(codegen-core)_

**yo-self:** get_type_string's SomeT arm resolves in the order: per-object resolved_concrete (or the id-keyed global) → recur WITHOUT appending `*`; else extern name; else context.get_type_c_name(type_key(t)) verbatim; else `__yo_io_future_t*` if the SomeT requires Future, else `void*`. Future-ness is never checked FIRST and no `*` is ever appended by this arm.

**TS:** src/codegen/utils/index.ts:620-745 — TS branches on `typeImplementsFuture(someType)` FIRST, and inside it the order is: resolvedConcreteType.isExtern → `${externTypeName}*`; then `context.types[someType.id]?.cName` → `${cName}*`; then resolvedConcreteType-as-SomeType → `${innerCName}*`; then resolvedConcreteType-as-struct → scan context.types for the SM whose capture struct matches → `${cName}*`; then extractFutureTraitFromType → `${cName}*`; else THROW. Only after that does it fall through to typeImplementsFn / plain resolvedConcreteType.

**Evidence:** utils/index.yo:919-952; the fallback comment at :940 explicitly cites `Mirrors TS getTypeString case 3 (utils/index.ts:615)` while implementing only that one case of the five-case ladder.

### `yo-self/codegen/utils/index.yo:976` — intentional-divergence _(codegen-core)_

**yo-self:** get_type_string's FnTraitT and FutureTraitT arms call \_\_yo_panic with a phase marker instead of producing a type string.

**TS:** src/codegen/utils/index.ts:426-812 — the getTypeString switch has NO case for the FnTrait or FutureTrait tags (verified by enumerating every `case TypeTag.` in the function). They fall out of the switch to the tail `return \`// Unknown type: ${typeToString(type)}\`;` at index.ts:812.

**Evidence:** utils/index.yo:976-977 `.FnTraitT({}) => __yo_panic("get_type_string: Fn-trait lowering is Phase 3/5 — not yet ported"), .FutureTraitT({}) => __yo_panic("get_type_string: Future-trait lowering is Phase 5 — not yet ported")`

### `yo-self/codegen/codegen_c.yo:216-222 (compile_module)` — partial _(codegen-exprs)_

**yo-self:** `compile_module` collects functions only from the module exports (`collect_required_functions`) — it never walks the module-level mutable-variable initialiser expressions to collect the functions they call.

**TS:** src/codegen/codegen-c.ts:120-126 — `if (context.moduleLevelInitExprs) { for (const initExpr of context.moduleLevelInitExprs) findFunctionCallsInExpr(initExpr, context); }`, run right after `collectRequiredFunctions`.

**Evidence:** codegen_c.yo:181-182 header — "DEFERRED (documented, gated dead for the corpus): module-level mutable-var init collection + emission (no field)". `register_find_function_calls_in_expr()` is wired at line 190 but the init-expr loop TS runs is absent from the pipeline.

### `yo-self/codegen/codegen_c.yo:280-300` — partial _(codegen-exprs)_

**yo-self:** `compile_module` omits three TS pipeline stages entirely: `generateSpecializedFunctionDeclarations`, `generateSpecializedFunctions`, and (library mode) `generateLibraryInitFunction`.

**TS:** src/codegen/codegen-c.ts:260 `generateLibraryInitFunction(context, moduleLevelVars)` (emits `__yo_module_init()` so a library initialises its module-level vars), 268 and 271 (the fifth/sixth passes that declare and emit specialized function bodies collected during body generation).

**Evidence:** codegen_c.yo:186 header lists "generateSpecialized\* (Gap 2), generateLibraryInitFunction" as deferred; the `if(!(is_library), { generate_main_wrapper(...) });` at 295-297 has no `else` branch.

### `yo-self/codegen/exprs/assignment.yo:100-118` — partial _(codegen-exprs)_

**yo-self:** When the assignment is inside an async state machine and the LHS lowers to an `sm->` field, yo-self emits NOTHING for the save-old-value step (`if(!(in_sm), …)`), yet still returns `ei.variable_name` as the expression result.

**TS:** src/codegen/exprs/assignment.ts:106-141 — in the SM case TS looks the temp up in `stateMachineVariables` (by key, then by name) and emits `sm->var_<id> = <lhsCode>; // Save old value for deferred drop`; if no field is found it sets `skippedTempVar = true` and returns `""` instead of the variable name.

**Evidence:** assignment.yo:104-115: `in_sm := match(context.in_async_state_machine,.Some(_) => lhs_code.starts_with("sm->"),.None => false); if(!(in_sm), if(!(is_unit_type(lhs_type)), { …emit save… }));` — the `in_sm` arm is empty.

### `yo-self/codegen/exprs/closures.yo:147-185` — partial _(codegen-exprs)_

**yo-self:** The capture-struct literal iterates the Struct's `field_labels` and initialises every field from a deferred `___dup` (matched by target name) or else `get_variable_name_for_codegen(label, env)`. There is no `is_effect_param` check, and no use of the field's own source expression / atom token as a dup-lookup candidate.

**TS:** src/codegen/exprs/closures.ts:132-171 — `allocateClosureCapture` returns `NULL` immediately for `field.isEffectParam` ("zero-initialized at closure construction time … populated at io.spawn/io.await time"), then tries `field.exprs.expr.$.deferredDupExpressions[0]`, then a name lookup over BOTH `field.label` and the field expr's atom token, and finally re-emits the field expr as an atom.

**Evidence:** closures.yo:147-185 loop over `field_labels` only; `grep 'is_effect_param' yo-self/codegen` → no match.

### `yo-self/codegen/exprs/comptime_value.yo:183-198` — intentional-divergence _(codegen-exprs)_

**yo-self:** `FloatLit(raw)` emits the stored raw text directly (with `.0`/`f` fixups). yo-self's CTFE produces that text via `f64.to_string()`, which is `snprintf("%g")` — 6 significant digits.

**TS:** src/codegen/exprs/comptime-value.ts:49-59 uses JS `value.value.toString()`, which round-trips a double exactly, then appends `.0` when there is no radix point.

**Evidence:** comptime_value.yo:185-187 — "yo-self float raws come from f64 `.to_string()` (C `%g`), which renders large magnitudes in exponent form (`1e+09`) — unlike TS's JS `Number.toString()` (`1000000000`)." std/fmt/to_string.yo:151 confirms `snprintf(..., "%g", self)`.

### `yo-self/codegen/exprs/generation.yo:445` — partial _(codegen-exprs)_

**yo-self:** The SomeType-implementing-Future `___drop`/`___dup` method-call fast path is omitted (a bare comment marks the spot); such calls fall through to `generate_other_function_call`.

**TS:** src/codegen/exprs/generation.ts:493-523 — when the callee is `recv.___drop` / `recv.___dup` and `isSomeType(receiverType) && typeImplementsFuture(receiverType)`, TS short-circuits to `if (recv != NULL) { __yo_decr_rc((void*)recv); }` / `__yo_incr_rc((void*)recv)`, explicitly because those wrapper functions were never collected.

**Evidence:** `// (SomeType-Future ___drop/___dup fast path — Phase 5, omitted.)`

### `yo-self/codegen/exprs/other_fn_call.yo:1615` — partial _(codegen-exprs)_

**yo-self:** The call-result temp's C type is `get_type_string(result_type, context.base)` with no `*` suffix when the callee's `result_is_ref` (a `-> inout(T)` / `-> ref(T)` function whose C signature returns `T*`), and no Future/state-machine struct-name resolution.

**TS:** src/codegen/exprs/other-fn-call.ts:1468-1473 appends `*` when `functionValueType.return.isRef && !cTypeString.endsWith("*")`; 1408-1454 resolves an `Impl(Future)` return to the async block's `asyncStateMachineStructName*` and records it in `context.tempVarAsyncStructNames` for the later binding.

**Evidence:** other_fn_call.yo:1615 `c_type := get_type_string(result_type, context.base);` — `grep -n 'result_is_ref' other_fn_call.yo` matches only line 1322 (constructing a Func with `result_is_ref : false`). `grep -r 'temp_var_async_struct_names' yo-self/codegen` → no match.

### `yo-self/codegen/exprs/other_fn_call.yo:281 and 311` — no-op _(codegen-exprs)_

**yo-self:** `_emit_borrow_acquires` and `_emit_borrow_releases` are fully implemented (they emit `__yo_borrow_acquire((void*)(...))` / `__yo_borrow_release(...)`) but are never called from any emission path — only re-exported at line 1803. No call site brackets a call with borrow flags.

**TS:** src/codegen/exprs/other-fn-call.ts:1351, 1476, 2179 — `emitBorrowAcquires` is called before the call emission and `emitBorrowReleases` after it, at three sites (unit-return call, temp-return call, closure call).

**Evidence:** `grep -n '_emit_borrow_acquires(\|_emit_borrow_releases(' other_fn_call.yo` returns nothing but the definitions and the export line.

### `yo-self/codegen/exprs/parallelism.yo:136` — partial _(codegen-exprs)_

**yo-self:** The spawn wrapper drops the heap-copied capture struct without first NULLing the capture fields the closure consumed via `own(self)`.

**TS:** src/codegen/exprs/parallelism.ts:89-99 — for each name in `closureInfo.consumedCaptures` whose field `typeContainsRcType`, TS emits `((<captureCName>*)closure)-><field> = NULL;` before the drop, "to prevent double-free when a closure consumes a captured variable via own(self)".

**Evidence:** parallelism.yo:136 `// (consumed-capture NULLing omitted — see module doc.)`; `consumed_captures : Option(ArrayList(String)).None` is hardcoded at closures.yo:210, 241, 286 so the data is never available.

### `yo-self/codegen/utils/index.yo:976-977` — deferred-todo _(codegen-exprs)_

**yo-self:** `get_type_string` panics on `.FnTraitT` ("Fn-trait lowering is Phase 3/5 — not yet ported") and `.FutureTraitT` ("Future-trait lowering is Phase 5 — not yet ported"). The final catch-all at 979-983 returns the string `"// Unknown type: …"` as a C TYPE.

**TS:** src/codegen/utils/index.ts getTypeString handles both tags structurally (the Future case at 621-660 resolves through `resolvedConcreteType`/registered cName/`__yo_io_future_t*`); the TS fallback at 811 also returns `// Unknown type: …` but is reached far less often because the tag cases above it are complete.

**Evidence:** `.FnTraitT({}) => __yo_panic("get_type_string: Fn-trait lowering is Phase 3/5 — not yet ported"), .FutureTraitT({}) => __yo_panic("get_type_string: Future-trait lowering is Phase 5 — not yet ported"),`

### `yo-self/evaluator/calls/array_type.yo:68` — partial _(evaluator-calls)_

**yo-self:** `expected_len` is read directly out of `.Array(_, len, _)` (a concrete usize) and the argument count must equal it exactly; there is no unknown-length branch.

**TS:** src/evaluator/calls/array-type.ts:60-66 — when the length is unknown, `expectedLengthValue = argExprs.length` and `finalArrayType = createArrayType(arrayType.childType, createComptimeIntValue(BigInt(expectedLengthValue)))`.

**Evidence:** //! Note: `Array(T, _)` length inference is NOT supported in yo-self because `TypeValue.Array` stores a concrete `usize` length.

### `yo-self/evaluator/calls/closure_type.yo:70` — partial _(evaluator-calls)_

**yo-self:** Three definition-time closure checks are absent: no where-clause re-application before body eval, no `unwind`-in-closure rejection, no control-bound-capture rejection, and no capture-trait (Send) validation. `validate_capture_trait_requirements` exists but is a documented no-op (evaluator/utils/closure.yo:8) and is not called here.

**TS:** src/evaluator/calls/closure-type.ts:71-84 (applyWhereClauseConstraints), :132-140 (`evaluatedBodyContainsEscape` → "Closure bodies cannot contain `unwind`"), :142-171 (`typeIsControlBound(variable.type)` → "Closures cannot capture a value of control-bound type"), :263-271 (validateCaptureTraitRequirements for Send).

**Evidence:** closure_type.yo:19 — "Where-clause re-application skipped (deferred to Phase 4)."; grep for evaluated_body_contains_unwind / validate_capture_trait_requirements in closure_type.yo: 0 hits.

### `yo-self/evaluator/calls/function.yo:1783` — partial _(evaluator-calls)_

**yo-self:** Unary minus on a comptime integer is pre-folded by a special case on the callee atom `"-"` with exactly one argument, because the general `ModuleT`/`Call`-field overload dispatch for `(-) :: impl({ Call :: (neg, comptime_neg); })` is not implemented.

**TS:** src/evaluator/calls/function.ts — infix operators funnel through the common call path (evaluateFunctionCall) so `ComptimeNegate.neg` is selected by ordinary overload resolution; there is no literal-shape special case.

**Evidence:** // yo-self does not yet implement full ModuleT/Call overload dispatch for the prelude's `(-) :: impl({ Call :: (neg, comptime_neg); })`, so unary-minus on a comptime int falls into a soft fallback that produces UnknownVal.

### `yo-self/evaluator/calls/function.yo:1943` — approximation _(evaluator-calls)_

**yo-self:** An operator method whose return is an associated type (`comptime(Self.Output)`) that came back as a bare SomeT is resolved by scanning the receiver's registered trait methods of that name and adopting the value only when ALL candidates agree; on disagreement the SomeT is left unresolved.

**TS:** src/evaluator/calls/function.ts / src/env.ts:1970 — TS resolves the associated type by matching the receiver's trait impl against the operator's trait id, which is exact rather than unanimity-based.

**Evidence:** // yo-self's registry records `source_trait_id` as "" for direct-on-type trait impls, so we approximate SOUNDLY: adopt the receiver's registered associated types of this name only when they UNANIMOUSLY agree … Diverging → leave unresolved (no wrong resolution).

### `yo-self/evaluator/calls/function_type.yo:212` — intentional-divergence _(evaluator-calls)_

**yo-self:** \_trial_eval_fn_body installs `inner_exn := Exception(throw : ((_err) -> unwind(())))`, so EVERY definition-time body-evaluation error is swallowed (only a pre-flagged flow violation and the `propagate_def_time_errors()` comptime_expect_error mode are re-raised).

**TS:** src/evaluator/calls/function-type.ts:499-511 — the def-time `evaluateBeginExpression` is NOT wrapped in try/catch and additionally throws "Failed to evaluate the function body." when `!evaluatedFunctionBody.$`.

**Evidence:** // Trial-evaluate a function body at definition time, swallowing any eval error (mirrors the def-time `evaluateBeginExpression` in `function-type.ts:499`, made non-fatal).

### `yo-self/evaluator/calls/function_type.yo:234` — partial _(evaluator-calls)_

**yo-self:** \_build_def_time_body_env binds each parameter under its own declared label only. There is no `needs_parameter_aliasing` path and `parameter_alias` is never set on a parameter created here.

**TS:** src/evaluator/calls/function-type.ts:306-377 — when `context.expectedType` is a FunctionType whose parameter labels differ, TS adds each parameter with `parameterAlias: anonymousParamName !== expectedParamName ? expectedParamName : undefined` (env.ts:205-208 documents the trait-method rename case); src/codegen/exprs/atom.ts:492/575 reads it.

**Evidence:** add_parameter_to_env(fresh_env, pn, pt, pv, false, p_ref, false, false, p_ref, true, synthetic_token(pn, module_path)); // no alias argument exists

### `yo-self/evaluator/calls/function_type.yo:413` — deferred-todo _(evaluator-calls)_

**yo-self:** try_to_implement_function_by_function_type never wraps the body with signature contracts and never re-applies the function type's where clauses before body evaluation. `wrap_function_body_with_contracts` does not exist in yo-self (evaluator/builtins/contracts.yo:9 states it is NOT ported) and `apply_where_clause_constraints` (evaluator/types/function.yo:2142) is not called from this file.

**TS:** src/evaluator/calls/function-type.ts:402-405 — `const effectiveBodyExpr = wrapFunctionBodyWithContracts(functionBodyExpr, newFunctionType);` (the `requires(...)` → assert/comptime_assert splice) and :425-438 — `if (newFunctionType.whereClauseExprs?.length) { ... applyWhereClauseConstraints({ constraintExprs, env, ... }); env = result.env; }`.

**Evidence:** contracts.yo:9 — "NOT yet ported: `wrap_function_body_with_contracts` — the signature→assert lowering that turns `requires(...)` / `ensures(...)` in a function SIGNATURE into runtime `assert(...)` / `comptime_assert(...)` calls wrapping the body."

### `yo-self/evaluator/calls/function_type.yo:413` — partial _(evaluator-calls)_

**yo-self:** After creating the FuncVal, yo-self never runs CTFE-capability analysis on it. `_analyze_ctfe_capability` exists (evaluator/builtins/comptime_fn.yo:75) but is not called from function_type.yo.

**TS:** src/evaluator/calls/function-type.ts:668-679 — `if (context.isAnalyzingCtfeCapability || context.forceCompileTimeBindings) { const comptimeFunctionValue = analyzeCtfeCapability(functionValue, finalCallerEnv, context); if (comptimeFunctionValue) { finalFunctionValue = comptimeFunctionValue; finalFunctionType = comptimeFunctionValue.type; } }`.

**Evidence:** function_type.yo:592-596 builds the ExprInfo directly from `func_val` / `function_type` with no CTFE-capability branch.

### `yo-self/evaluator/calls/function_type.yo:75` — no-op _(evaluator-calls)_

**yo-self:** check_deferred_generic_return_type is a bare no-op: it names its six parameters as statements and returns `()`.

**TS:** src/evaluator/calls/function-type.ts:67-169 — clones the body, builds a trial context, runs evaluateBeginExpression, skips on unwind-only control flow, carves out bare-SomeType returns that are not the function's OWN forall, and otherwise throws "Incompatible function return type".

**Evidence:** /// Phase 2bm: no-op stub. Full trial-evaluation deferred to Phase 3. … function_body_expr; function_type; function_value; env; ctx; ()

### `yo-self/evaluator/calls/helper.yo:2331` — intentional-divergence _(evaluator-calls)_

**yo-self:** validate_where_constraints_for_call enforces only MARKER traits (a TraitT with no function-typed field) and only against fully concrete bound types; every method-bearing constraint and every constraint whose bound type still contains a SomeT is skipped.

**TS:** src/evaluator/calls/helper.ts:1493-1506 → applyWhereClauseConstraints → src/evaluator/types/function.ts:974 validateSingleTraitOnConcreteType — TS validates every re-applied whereClauseExpr constraint at the call site.

**Evidence:** /// DOCUMENTED DIVERGENCE (narrower than TS): only MARKER-trait constraints (traits without methods — Send/Acyclic/user markers) are enforced, and only against FULLY CONCRETE bound types

### `yo-self/evaluator/calls/helper.yo:3259` — partial _(evaluator-calls)_

**yo-self:** Variadic arguments are handled only for the non-quote runtime case: each extra arg is evaluated and pushed to rt_args. Nothing binds a `...(quote(elems))` ExprList or a comptime ComptimeList variadic into callee_env, and the returned ArgValues always carry `variadic_args : ArrayList(VarArgEntry).new()` (helper.yo:3776/3802/3830).

**TS:** src/evaluator/calls/helper.ts:1618-1710 — collects every variadic arg into `variadicArgs`, handles `variadicParameter.isQuote` by wrapping the raw Expr, then binds an ExprList (`createComptimeListValue(createExprType(), ...)`) or a comptime ComptimeList into calleeEnv; helper.ts:1747 returns them in argValues.

**Evidence:** // Mirrors TS helper.ts:1618-1662 (the non-quote runtime branch). yo-self models a variadic function only as `has_variadic : bool` (no per-variadic `isQuote`/`isCompileTimeOnly`/label), so we handle the C-extern runtime case

### `yo-self/evaluator/calls/helper.yo:3797` — partial _(evaluator-calls)_

**yo-self:** Both FuncCallResult return sites hard-code `return_value : Option(EvalValue).None`, and the `skip_ctfe_execution` parameter is discarded as a bare statement at helper.yo:2546.

**TS:** src/evaluator/calls/helper.ts:1752-1821 — when `functionType.return.isCompileTimeOnly`, TS sets `returnValue` to an UnknownValue under skipCtfeExecution, otherwise executes `evaluateComptimeFunctionCall` and also overwrites `returnType`/`callerEnv`/`calleeEnv`; for a bare-SomeType comptime return with no expected type it throws "Cannot infer comptime return type".

**Evidence:** /// \* CTFE is not executed — return_value is always None. … skip_ctfe_execution; (helper.yo:2546)

### `yo-self/evaluator/calls/helper.yo:492` — partial _(evaluator-calls)_

**yo-self:** check_if_function_parameter_matches_argument evaluates the argument and immediately reads its ExprInfo; there is no use-after-move gate. `require_expr_not_consumed` (evaluator/utils.yo:381) is not imported by helper.yo.

**TS:** src/evaluator/calls/helper.ts:392 — `requireExprNotConsumed(evaluatedArgExpr, callerEnv);` immediately after the argument evaluation, before the ownership/dup handling.

**Evidence:** evaled_arg := evaluate_expression_raw(actual_arg, caller_env, ctx, exn);\n ctx.expected_type = saved_exp;\n // Extract ExprInfo for the evaluated arg.

### `yo-self/evaluator/calls/helper.yo:572` — deferred-todo _(evaluator-calls)_

**yo-self:** The owned-parameter move path consumes/dups the argument but does not record the consumed name in `ctx.own_consumed_captures`.

**TS:** src/evaluator/calls/helper.ts:419-428 — `if (argVarName && context.isEvaluatingFunctionBodyOrAsyncBlock && context.capturedVariables?.has(argVarName)) { context.ownConsumedCaptures.add(argVarName) }`; the set is later read into `functionValue.closureInfo.consumedCaptures` (closure-type.ts:255-262).

**Evidence:** // NOTE: the own(self)-captured-variable tracking (`ctx.own_consumed_captures`, TS helper.ts:419-428) is deferred until a thread-spawn capture test needs it.

### `yo-self/evaluator/calls/helper.yo:617` — partial _(evaluator-calls)_

**yo-self:** After synthesis, no where-clause constraints are propagated from a TypeValue argument's SomeType into callee_env. `get_where_clause_constraints_for_some_type` / `add_where_clause_constraint_to_env` (env.yo:1852 / env.yo:1788) are not imported by helper.yo.

**TS:** src/evaluator/calls/helper.ts:585-612 — `if (argValue && isTypeValue(argValue) && isSomeType(argValue.value)) { ... for (const requiredTrait of whereConstraints.requiredTraits) calleeEnv = addWhereClauseConstraintToEnv({...}); for (const negativeTrait of whereConstraints.negativeTraits) ... }`.

**Evidence:** // Step 6: Synthesize forall bindings from arg type into callee_env. … synth := synthesize_types(...); callee_env_r = synth.expected_env; // Step 7 immediately follows

### `yo-self/evaluator/calls/helper.yo:657` — intentional-divergence _(evaluator-calls)_

**yo-self:** Step 9 binds the parameter with `bind_pt` = the re-evaluated PARAMETER type (optionally receiver-adopted), never the argument's type, and never consults where-clause constraints on the parameter SomeType.

**TS:** src/evaluator/calls/helper.ts:541-566 — `bindingType = useConstrainedSomeType ? { ...parameterType, resolvedConcreteType: argType } : argType`, where `useConstrainedSomeType` requires a runtime param whose SomeType actually carries `requiredTraits` from a where clause; otherwise the CONCRETE argType is bound.

**Evidence:** (bind_pt : TypeValue) = final_pt; match(adopt_receiver_struct_instance(final_pt, arg_type), .Some(bind_adopted) => { bind_pt = bind_adopted; }, .None => ());

### `yo-self/evaluator/calls/index_trait.yo:485` — partial _(evaluator-calls)_

**yo-self:** `IndexCallResult` (evaluator/context.yo:485) has no comptime_ref field, so no index-trait path ever produces one; `evaluate_comptime_fn_call` (comptime_fn.yo:982) likewise returns only value/caller_env/callee_env.

**TS:** src/evaluator/calls/index-trait.ts:870 (`comptimeRef: { kind: "array", arrayValue, index }` on the comptime array-index result), :554-595 (array/struct/tuple comptimeRef from a returned PtrValue), :615 (propagates `result.comptimeRef`), and src/evaluator/calls/comptime-fn.ts:297 (`comptimeRef: evaluatedFunctionBody.$.comptimeRef`).

**Evidence:** comptime_fn.yo:14 — "No `comptimeRef` in the return (skipped for Phase 3a)."; grep comptime_ref in index_trait.yo/comptime_fn.yo: 0 hits.

### `yo-self/evaluator/calls/index_trait.yo:871` — deferred-todo _(evaluator-calls)_

**yo-self:** Step 5 of the index dispatch is a comment only — custom comptime types with a ComptimeIndex impl fall straight through to the runtime path.

**TS:** src/evaluator/calls/index-trait.ts:423-542 — `tryComptimeIndexDispatch` finds a ComptimeIndex method via `findComptimeIndexMethod` (index-trait.ts:382), calls it as a comptime function, derefs a returned PtrValue and returns the folded element with a comptimeRef.

**Evidence:** // 5. Custom comptime type (ComptimeIndex): not yet implemented in Phase 3u.\n// Fall through to runtime dispatch.

### `yo-self/evaluator/calls/iso.yo:167` — deferred-todo _(evaluator-calls)_

**yo-self:** evaluate_iso_type_call creates the Iso type and returns it without injecting RC functions into the env.

**TS:** src/evaluator/calls/iso.ts:79-85 — `env = addRcFunctionsToIsoType({ isoType, env, context });` (src/evaluator/types/utils.ts) before the type value is returned.

**Evidence:** // Phase 2bd deferred: addRcFunctionsToIsoType — generates atomic dispose/drop/dup for the Iso type. Not yet implemented (same status as addRcFunctionsToDynType).

### `yo-self/evaluator/calls/numeric_type.yo:187` — no-op _(evaluator-calls)_

**yo-self:** \_make_comptime_info computes the range check and DISCARDS the boolean: `_int_raw_in_range(raw, bounds);` is a bare expression statement with no branch. Also \_int_raw_in_range itself returns `true` when the string cannot be parsed (numeric_type.yo:168).

**TS:** src/evaluator/calls/numeric-type.ts:200-208 — `if (numericValue < bounds.min || numericValue > bounds.max) throw formatErrorMessage({ ... "Value X is out of range for type T (min to max)" })`.

**Evidence:** // Soft fallback — don't abort prelude eval on bounds-check failures … Correctness is best-effort; codegen catches genuine out-of-range issues later.\n \_int_raw_in_range(raw, bounds);

### `yo-self/evaluator/calls/record_type.yo:241` — partial _(evaluator-calls)_

**yo-self:** A record/source-namespace field that is not supplied by any argument throws unconditionally; there is no default/assigned-value fallback. Additionally the arg evaluation (record_type.yo:199-201) sets only expected_type and does not clear ctx.self_type / ctx.receiver_type, and a FunctionValue argument never gets a `specializedType` stamped from the resolved field type.

**TS:** src/evaluator/calls/record-type.ts:255-280 (unprovided field falls back to `recordField.defaultValue ?? recordField.assignedValue` and writes it into `workingRecordType.fields[i].assignedValue`), :186-189 (`ReceiverType: undefined, SelfType: undefined` when evaluating the argument), :214-232 (`if (isFunctionValue(argValue)) { ... argValue.specializedType = { ...functionType, parametersFrame } }`).

**Evidence:** //! - `ModuleT` has no `assignedValue`/`defaultValue` per field → error if field missing.\n//! - `isFunctionValue` / `specializedType` / `ioBuiltin` propagation omitted (codegen deferred).

### `yo-self/evaluator/calls/trait_type.yo:209` — no-op _(evaluator-calls)_

**yo-self:** try_to_specialize_trait_type validates the `:=` arguments fully (label exists, is an associated type, evaluates to a type) and then throws the results away, returning `specialized_trait_type : trait_type` — the unmodified input.

**TS:** src/evaluator/calls/trait-type.ts:112-120 — builds `associatedTypeConstraints` and returns `{ ...traitType, associatedTypeConstraints }`; those constraints are later resolved and enforced at trait-type.ts:537-563 and consulted by typeImplementsTraitBool.

**Evidence:** // NOTE: associatedTypeConstraints cannot be stored in yo-self's TraitT yet. Return the original trait type unchanged. Phase 3 will add constraint storage.

### `yo-self/evaluator/calls/trait_type.yo:221` — partial _(evaluator-calls)_

**yo-self:** The impl loop stores each bound value into `field_values(i)` only. It never (a) extends `receiverType.trait` with the trait's fields, (b) substitutes `SelfType := receiverType` into function-typed fields, or (c) progressively writes `assignedValue` back onto the working trait type so later fields' `Self.X` references resolve.

**TS:** src/evaluator/calls/trait-type.ts:175-205 (receiverType.trait extension + `type: { ...f.type, SelfType: receiverType }` for function-typed fields, with the comment about recursive types like `TreeNode` containing `Box(Self)`) and :393-400 (`workingRecordType`/`receiverType.trait.fields[i].assignedValue = argValue` — "allows subsequent Self.X references to resolve to this concrete value").

**Evidence:** /// - Skips receiverType.trait mutation and where-clause checking (Phase 3).

### `yo-self/evaluator/calls/trait_type.yo:437` — deferred-todo _(evaluator-calls)_

**yo-self:** try_to_implement_trait_with_arguments_by_trait_type builds the TraitVal immediately after the field loop with no where-clause verification of the bound associated types.

**TS:** src/evaluator/calls/trait-type.ts:517-578 — for each field with an `unassignedSomeType`, resolves the requiredTrait's associatedTypeConstraints against the sibling bindings and calls `typeImplementsTraitBool`, throwing "Where clause constraint not satisfied" on failure.

**Evidence:** // NOTE: where-clause checking (typeImplementsTraitBool) deferred to Phase 3.

### `yo-self/evaluator/calls/type.yo:272` — partial _(evaluator-calls)_

**yo-self:** The comptime→runtime conversion of a struct-field argument is done with `convert_comptime_type_to_runtime_type(arg_info.ty, env)` — no expected type.

**TS:** src/evaluator/calls/type.ts:146-151 — `convertComptimeTypeToRuntimeType({ type: argType, expectedType: memberElement.type, expr: evaluatedArgExpr, env: callerEnv })`.

**Evidence:** arg_type := if(\_is_comptime_only_type_approx(member_element.ty), arg_info.ty, convert_comptime_type_to_runtime_type(arg_info.ty, env));

### `yo-self/evaluator/calls/type.yo:50` — hardcoded _(evaluator-calls)_

**yo-self:** \_is_comptime_only_type_approx matches only TypeUni / ComptimeInt / ComptimeFloat / ComptimeString, and is the sole gate on whether a struct field's argument type gets comptime→runtime conversion (type.yo:269-273). yo-self's real env-aware `is_comptime_only_type` (types/utils.yo:6) is not used here.

**TS:** src/types/utils.ts:113 — `isComptimeOnlyType(type, env) { return typeImplementsComptime(type, env) && !typeImplementsRuntime(type, env); }`, called at src/evaluator/calls/type.ts:145.

**Evidence:** /// Approximation for `isComptimeOnlyType` (Phase 2 — full version deferred).

### `yo-self/evaluator/context.yo:207` — partial _(evaluator-core)_

**yo-self:** `EvalContext` omits TS's `deferGenericFnTypeCheckToAssignment` flag. Every other `EvaluatorContext` field is present (down to `isAnalyzingCtfeCapability` and `currentlySpecializingFunctionStack`); this one is absent, and the consequence is visible downstream: yo-self/evaluator/exprs/binding.yo:292 throws "Runtime variables with generic function types are not allowed" unconditionally, with no flag to suppress it.

**TS:** src/evaluator/context.ts:261 (`deferGenericFnTypeCheckToAssignment?: boolean;`). Set at src/evaluator/exprs/assignment.ts:210 when `evaluateAssignment` delegates to `evaluateBinding`; honoured at src/evaluator/exprs/binding.ts:165 (`&& !context.deferGenericFnTypeCheckToAssignment`). The docs at binding.ts:156-160 explain the purpose: re-run the check after the RHS is evaluated so it can be relaxed for `ctl` handlers whose body always unwinds (`allPathsUnwind`, src/expr-traversal.ts) — the C ABI never delivers the forall'd return value in that case.

**Evidence:** context.yo:207-320 field list has no `defer_generic_fn_type_check_to_assignment`; `grep -rn 'defer_generic_fn_type_check' yo-self` (non-test) returns nothing; binding.yo:292 `if((!(is_compile_time_only)) && (is_function_type(...) && is_function_type_generic(...)), { ... exn.throw(...) });`

### `yo-self/evaluator/context.yo:485` — partial _(evaluator-core)_

**yo-self:** `IndexCallResult` mirrors TS's fields except the last one: `comptimeRef?: ComptimeRef` is omitted (yo-self stops at `index : Option(usize)` on :499). Consistently, no file under yo-self/evaluator/calls/ mentions `comptime_ref` at all — the whole index-trait path produces no compile-time element reference.

**TS:** src/evaluator/context.ts, `IndexCallResult` — `/** Unified compile-time element/field reference for mutation and pointer creation. */ comptimeRef?: ComptimeRef;`. Produced at src/evaluator/calls/index-trait.ts:554-595, propagated at :615 and :870; consumed at src/evaluator/exprs/assignment.ts:1175-1191, where a comptime `arr(0) = v` / `list(i) = v` writes directly into the compile-time aggregate.

**Evidence:** context.yo:485-500 `IndexCallResult :: ref(struct(value, ty, ptr_type, index_method_type, index_method_value, caller_env, index : Option(usize)))` — no `comptime_ref` member; `grep -rn comptime_ref yo-self/evaluator/calls/` returns nothing.

### `yo-self/evaluator/trait_checking.yo:1519` — partial _(evaluator-core)_

**yo-self:** `find_some_type_missing_comptime_constraint`, in its SomeType branch, checks only `SomeT.required_trait_types` for the Comptime trait id. TS also consults the env-frame where-clause constraints before concluding the constraint is missing.

**TS:** src/evaluator/trait-checking.ts:694-705 — after scanning `type.requiredTraits`, TS runs `const whereConstraints = getWhereClauseConstraintsForSomeType(env, type); if (whereConstraints) { for (const trait of whereConstraints.requiredTraits) if (trait.id === comptimeTraitType.id) return undefined; }` and only then `return type`.

**Evidence:** trait_checking.yo:1519-1552 walks `required_trait_types` only, then `return(Option(TypeValue).None)`; no call to `get_where_clause_constraints_for_some_type` anywhere in the file.

### `yo-self/evaluator/trait_checking.yo:428` — hardcoded _(evaluator-core)_

**yo-self:** `_find_associated_type_from_generic_impls :: (fn(_target, _prop_name, _env) -> bool)(false)` — a bare `false`. It also has the wrong return type (TS returns the resolved `{type, value}`, not a bool), and no real implementation of this function exists anywhere in yo-self.

**TS:** src/evaluator/values/impl.ts:1911-1960 — `findAssociatedTypeFromGenericImpls` resolves a SomeType via the env, then scans the whole `genericImplRegistry`, runs `tryMatchGenericImpl` on each, and returns the matched impl's non-function trait field for `propertyName`. Consumed at src/evaluator/trait-checking.ts:290 and src/evaluator/exprs/property-access.ts:715.

**Evidence:** `/// Phase 3 stub for \`findAssociatedTypeFromGenericImpls\`. /// Always returns false.`

### `yo-self/evaluator/trait_checking.yo:493` — intentional-divergence _(evaluator-core)_

**yo-self:** Step 0's generic negative-impl probe runs unconditionally on any target type: `if(find_matching_negative_generic_impl(target, trait_type, env), { return(...implemented:false...) });`. TS gates the same call behind `isStructType(targetType)`.

**TS:** src/evaluator/trait-checking.ts:352-357 — `if (isStructType(targetType) && findMatchingNegativeGenericImpl(targetType, traitType, env)) { return { implemented: false, env }; }`

**Evidence:** trait_checking.yo:490-495 has `has_negative_impl(...)` then an ungated `if(find_matching_negative_generic_impl(target, trait_type, env), ...)`; the surrounding comment claims to mirror `trait-checking.ts:345-358` but omits the `isStructType` conjunct present at :353.

### `yo-self/evaluator/trait_checking.yo:773` — partial _(evaluator-core)_

**yo-self:** Step 6 (SomeType where-clause check) inspects ONLY `SomeT.required_trait_types` / `SomeT.negative_trait_types` carried on the type value. TS additionally queries the env frames for where-clause constraints registered against that SomeType. yo-self HAS the lookup (`get_where_clause_constraints_for_some_type`, env.yo:1852) and uses it elsewhere (env.yo:2964, method-candidate collection) — it is just not called here.

**TS:** src/evaluator/trait-checking.ts:466-482 — `const whereConstraints = getWhereClauseConstraintsForSomeType(env, targetType); if (whereConstraints) { for (const requiredTrait of whereConstraints.requiredTraits) {...foundRequiredTraitInConstraints = true} for (const negativeTrait of whereConstraints.negativeTraits) {...foundNegativeTraitInConstraints = true} }`

**Evidence:** trait_checking.yo:773-775: `// 6. SomeType where-clause check. // In yo-self, constraints stored directly on SomeT.required_trait_types // via _add_where_clause_constraint (no separate env lookup needed).`

### `yo-self/evaluator/utils.yo:112` — partial _(evaluator-core)_

**yo-self:** Same signature gap as the `is_ref` finding, second dropped parameter: `isOwningTheSameRcValueAs`. yo-self never sets `Variable.is_owning_the_same_rc_value_as` to `Some(...)` anywhere in non-test code — every occurrence is an initializer to `.None`, a field copy, or a clear. So the borrow-alias chain is permanently empty.

**TS:** src/expr.ts:1660 (param), :1722 / :1751 / :1782 (stored on the Variable). Set by callers at src/evaluator/exprs/begin.ts:2268 and :2270 (`attachTempVariableToExpr(expr, true, returnVariable)` when the begin-block result dups or consumes an outer variable) and src/evaluator/exprs/assignment.ts:788-798 (old-value temp). Read by src/evaluator/utils.ts:96-99 (`findRcValueOwnerRelationship`), src/evaluator/calls/iso.ts:164-168, src/evaluator/types/flowability.ts:474, src/evaluator/shared/suspension-analysis.ts:160, src/evaluator/async/await-analysis.ts:74.

**Evidence:** `grep -rn is_owning_the_same_rc_value_as` over non-test yo-self: env.yo:159/862/919/1005/1073 (`= .None`), env.yo:1215/1677 + synthesizer.yo:323 (copies), utils.yo:1226/1264 (`= Option(Box(Variable)).None`), utils.yo:269/281 + iso.yo:196 (reads). No assignment of a `Some`.

### `yo-self/evaluator/utils.yo:1228` — partial _(evaluator-core)_

**yo-self:** The partial-ownership error in `merge_and_check_envs` fires on `(any_owning && !all_owning) && !base_var.is_owning_the_rc_value`. TS's equivalent has an extra `else if (frameVariables[j]!.isRef)` arm BEFORE the throw that exempts `inout(name) : T` second-class-reference parameters entirely — yo-self has no such arm.

**TS:** src/expr.ts:2237-2262 — `} else if (frameVariables[j]!.isRef) { // inout(name) : T parameters are second-class references — the slot always points to a valid caller-side Rc. Assignment in some branches and not others is fine ... So skip the consistency check that applies to value-typed locals. } else { ...throw 'might be holding the Rc value in some cases but not...' }`

**Evidence:** utils.yo:1228-1229 `// Partial ownership → error` / `if((any_owning && !(all_owning)) && !(base_var.is_owning_the_rc_value), {` — no `is_ref` test anywhere in the function.

### `yo-self/evaluator/utils.yo:1324` — partial _(evaluator-core)_

**yo-self:** `are_values_equal` handles exactly three shapes: `VarRef` (env-resolved), `UnknownVal` (type compare), and a catch-all `_ => (val1 == val2)` that delegates to `eval_value_eq`. It is missing TS's leading reference-identity fast path, and the catch-all loses the two-env structure: `eval_value_eq` takes NO environments, so a `VarRef` nested inside a `StructVal`/`EnumVal`/`ArrayVal` field is compared by variable NAME (value.yo:223 `.VarRef(an) => match(b, .VarRef(bn) => (an == bn), ...)`) instead of being resolved against its own side's env and recursed.

**TS:** src/value.ts:678-860 — `if (value1 === value2) return true;` at :691 (identity, covers FunctionValue where yo-self's `eval_value_eq` returns a hard `false` at value.yo:259); then every aggregate arm recurses via `areValuesEqual({value: v1.fields[i], env: expected.env}, {value: v2.fields[i], env: given.env})` (:711-765, :777-806), preserving the per-side env. Struct/enum arms also gate on `areTypesCompatible({type: value1.type, env: expected.env}, {type: value2.type, env: given.env}, true)` (:769) where yo-self compares only the type NAME string (value.yo:277 `(!(atn == btn)) => false`).

**Evidence:** utils.yo:1324 arms are `.VarRef(name1) => ...`, `.UnknownVal(ty1) => ...`, `_ => match(val2, .VarRef(name2) => ..., .UnknownVal(_) => false, _ => (val1 == val2))`. No identity check; `eval_value_eq` (yo-self/value.yo:210) has no `env` parameter.

### `yo-self/evaluator/utils.yo:938` — intentional-divergence _(evaluator-core)_

**yo-self:** `merge_and_check_envs` carries three documented RELAXATIONS of TS's branch-consistency rules, all in the permissive direction: (1) the arm frame-depth equality check is replaced by a floor against a 0-frame env only (:890-919); (2) a case env SHORTER than the base at a non-innermost frame is not an error — a missing case var is read as the base var (:965-1004); (3) extra NON-temp variables in a case frame are silently skipped, and extra TEMP variables are adopted into the base frame with `extra_var2.is_owning_the_rc_value = false` forced (:938-963).

**TS:** src/expr.ts:1832-1845 (`if (caseEnv.frames.length - 1 !== maxFrameLevel) throw 'Frame level is different for different cases.'`), :1876-1935 (`if (i !== maxFrameLevel && frameVariables.length !== caseEnvFrameVariables.length)` → adopt ONLY when `allExtraAreTemps`, otherwise `throw 'Frame level N has different number of values for different cases.'`), :1939-1959 (name equality, temps exempt).

**Evidence:** utils.yo:951-952 `// yo_id_264770/yo_id_360923). Third relaxation of this merge — // see [[yo-self-branch-merge-trivial-arm]] for the first two.`; :890 `// FURTHER RELAXED: even the "outer frames all present" pre-check ... is too strict`; :975-977 `// — a yo-self recorded-env divergence from TS (TS arm envs sit at the outer level with enclosing bindings intact).`

### `yo-self/evaluator/exprs/_expr.yo:956` — partial _(evaluator-exprs)_

**yo-self:** The function-call dispatch cond has no arm for `&+` / `&-` / `&/` / `__yo_ptr_add` / `__yo_ptr_sub` / `__yo_ptr_diff`; those fall straight through to the `true => evaluate_function_call(...)` default at line 960. `grep -rn 'Pointer arithmetic' yo-self/` finds only an unrelated comment in types/flowability.yo:323.

**TS:** src/evaluator/exprs/\_expr.ts:1293-1335 — matches those six callee names and throws `Pointer arithmetic ('&+') requires 'unsafe(...)'.` unless `context.unsafeContext || isImplicitlyUnsafeCapableFile(expr.token.modulePath)`.

**Evidence:** Set-difference of `grep 'exprIsFunctionCallOf(expr,' src/evaluator/exprs/_expr.ts` vs `grep 'ast_expr_is_fn_call_of(expr,' yo-self/evaluator/exprs/_expr.yo`: only `&+`, `&-`, `&/`, `__yo_ptr_add/sub/diff` and the (dead in TS) `Exists` are missing.

### `yo-self/evaluator/exprs/assignment.yo:140` — hardcoded _(evaluator-exprs)_

**yo-self:** `resolve_unknown_values_and_some_type_in_type` is a hardcoded identity — its entire body is the parameter `ty` (line 146). It is also never CALLED anywhere in the file (only re-exported at line 1032). More importantly, the whole TS recovery path it belongs to is missing: at assignment.yo:922 an incompatible `variable.ty` vs `rhs_type` throws immediately.

**TS:** src/evaluator/exprs/assignment.ts:369-425 — on incompatibility TS checks `typeRequiresInference(variable.type)`, calls `synthesizeExprAndType`, re-checks compatibility, then calls `resolveUnknownValuesAndSomeTypeInType(variable.type, env)` (399) and `updateExistingVariable` with the resolved type; only if synthesis fails does it throw. The real body (122-142) resolves an array's unknown `length` from the env variable named by `unknownLength.variableName`.

**Evidence:** assignment.yo:131 `// resolve_unknown_values_and_some_type_in_type  (Phase 2v stub)` and 135-136 `In yo-self all array lengths are concrete, so the full TS logic is not needed here.  Returns ty unchanged.` — contradicted by `TypeValue.Array(element, length, length_var)` in yo-self/types/definitions.yo:130.

### `yo-self/evaluator/exprs/begin.yo:1798` — partial _(evaluator-exprs)_

**yo-self:** The return-type compatibility check calls only `are_types_compatible(return_type, expected_ret)` guarded by `!is_some_type(expected_ret)` (lines 1818-1819), and handles only `fctx.kind == .FunctionBody` (1808) — the async-block arm falls into `_ => ()`.

**TS:** src/evaluator/exprs/begin.ts:1599-1677 — TS first calls `synthesizeTypes(declaredReturn, actualReturn)` inside a try (1605, 1644), which UNIFIES e.g. `[i32; n]` against `[i32; 5]`, and only on synthesis failure falls back to `areTypesCompatible`. It runs the same two-step for `kind === "async-block"` using `context.expectedType`.

**Evidence:** begin.yo:1798 `// Return-type compatibility check (partial port — synthesize_types deferred)`

### `yo-self/evaluator/exprs/begin.yo:1863` — deferred-todo _(evaluator-exprs)_

**yo-self:** `optimizeLoopTraversalBorrowChain` is not ported at all — `grep -rn 'optimize_loop_traversal|loop_traversal' yo-self/` returns nothing. The linked-list-traversal borrow-chain detection that removes the initial dup, the per-iteration dup, the per-iteration old-value save+drop, and the scope-exit drop is entirely missing.

**TS:** src/evaluator/exprs/begin.ts:704-... (declaration) and 1810-1818 (call site inside the always-on `OPTIMIZE_DUP_AND_DROP_PAIRS` block, which filters the removed names out of `variablesNeedingDrop`).

**Evidence:** begin.yo:1866-1867 `// The following passes are no-ops in Phase 2aa: //   - Loop traversal borrow-chain optimisation` (the sibling bullets on lines 1868-1870 are now STALE — dup/drop pair elimination is implemented at 934-1220).

### `yo-self/evaluator/exprs/binding.yo:153` — no-op _(evaluator-exprs)_

**yo-self:** The 'array type with inferred length in a type annotation' rejection is absent — the comment stands where the check should be, and evaluation proceeds straight to `prohibit_void_type`.

**TS:** src/evaluator/exprs/binding.ts:74-82 — `if (isArrayType(userDefinedType) && isUnknownValue(userDefinedType.length)) throw ... 'Array type with inferred length '_' is not allowed in type annotations.'`

**Evidence:** binding.yo:153-156 `// Array types with inferred length are not allowed in type annotations. // NOTE: yo-self TypeValue.Array stores length as usize (always concrete), so this check only applies when a future UnknownLen variant is added. // (TS: isArrayType(t) && isUnknownValue(t.length) — skipped for now.)`

### `yo-self/evaluator/exprs/identifer_and_operator.yo:152` — conservative-fallback _(evaluator-exprs)_

**yo-self:** When `find_variable_in_env` misses, yo-self checks `string_is_operator(identifier)` and, if so, silently stamps an ExprInfo of type `unit` with value `UnknownVal(unit)` and returns successfully instead of erroring.

**TS:** src/evaluator/exprs/identifer-and-operator.ts:488-493 — `if (!variables.length) throw formatErrorMessage({... `Variable "${identifier}" not found.`})`. There is no operator escape hatch.

**Evidence:** identifer_and_operator.yo:151 `// Unresolved OPERATOR names keep the soft fallback.` followed by `fallback_info := new_expr_info(env, t_unit()); fallback_info.value = ...create_unknown_val(t_unit());`

### `yo-self/evaluator/exprs/identifer_and_operator.yo:189` — partial _(evaluator-exprs)_

**yo-self:** `resolved_value := variable.value` unconditionally — the extern-C constant coercion is skipped. yo-self's TypeValue carries `is_extern` only inside `FuncMeta`, so a `c_include`d scalar constant can never be identified as extern here.

**TS:** src/evaluator/exprs/identifer-and-operator.ts:510-524 — `variable.type.isExtern === "c" && isUnknownValue(variable.value?.[0]) && !(isFunctionType || isTypeHierarchyType) ? undefined : variable.value?.[0]`, i.e. the ExprInfo value is deliberately dropped to force runtime operator selection.

**Evidence:** identifer_and_operator.yo:187-190 `// c_include constants (e.g. O_RDONLY from <fcntl.h>) have UnknownValue. Treat them as runtime values so operators like | use runtime BitOr. NOTE: is_extern is not yet ported to yo-self; skip this special-case and always use the variable's compile-time value.`

### `yo-self/evaluator/exprs/identifer_and_operator.yo:228` — intentional-divergence _(evaluator-exprs)_

**yo-self:** The closure-capture 'is this variable inner?' test is rewritten: yo-self scans frames at/above `closure_frame_level` for a variable with the same NAME (228-251), then tracks captures in TWO branches — `!inner && frame_level < closure_level` (252) and additionally `!inner && frame_level >= closure_level` with a synthesised `cap_rec_level` (261-277).

**TS:** src/evaluator/exprs/identifer-and-operator.ts:542-569 — a single condition, `if (variable.frameLevel < closureEvaluationFrameLevel) trackVariableUsage(variable.name, variable.frameLevel, "own", ...)`. There is no name-based inner scan and no second branch.

**Evidence:** identifer_and_operator.yo:216-227 `Generation-safe INNER test: variable.frame_level is stamped at the variable's CREATION env — for the enclosing fn's PARAMS that is a DEEP call-time generation ... A variable is inner iff its NAME is bound within the closure's OWN frames`

### `yo-self/evaluator/exprs/import.yo:425` — conservative-fallback _(evaluator-exprs)_

**yo-self:** When `ctx.load_module` is `.None`, `evaluate_import` synthesises the module value by scraping EVERY comptime-known binding out of the CURRENT evaluation env (`_build_module_val_from_env`, line 193-...), filtering only names containing '.', and returns `module_type : TypeValue.Unit`.

**TS:** src/evaluator/exprs/import.ts loads and evaluates the resolved file and returns that module's own exports; there is no env-scrape fallback path in TS at all.

**Evidence:** import.yo:415-421 `When no module loader is registered (e.g. run_check flatten-eval path), synthesise a ModuleVal from the current evaluation env. Because collect_module_deps flattens all dep exprs into one big list evaluated in a shared env, every name declared in the imported module is already in env at the time import("…") is evaluated.`

### `yo-self/evaluator/exprs/import.yo:91` — partial _(evaluator-exprs)_

**yo-self:** Step 4 of `resolve_module_path` resolves ANY non-relative, non-absolute import against CWD. There is no module-import-root lookup, no path-dependency lookup, no git-dependency/yo.lock resolution, and no transitive root-project fallback. `_find_project_root` (line 123) and `_resolve_dependency_entry_point` (line 168) are defined but never called and never exported.

**TS:** src/evaluator/exprs/import.ts:113-198 — `getModuleImportRoot(modulePathToImport)`, then `findProjectRoot` + `getBuildRegistry().findPathDependency` + `resolveDependencyPath(projectDir, name)` + `getRootBuildProjectDir()` fallback + `resolveDependencyEntryPoint`, and finally the specific error `Module "X" not found. If this is a dependency, add it to build.yo and run 'yo fetch'.`

**Evidence:** import.yo:5-10 `Phase 2 limitations ... Dependency name resolution (getBuildRegistry, getModuleImportRoot, resolveDependencyPath) is not yet ported.  Any import that is neither a std/ import nor a relative path ... will fail with a descriptive error until those helpers are ported.` — plus the two dead helpers.

### `yo-self/evaluator/exprs/initialization_assignment.yo:555` — partial _(evaluator-exprs)_

**yo-self:** After computing `final_lhs_type := lhs_type`, the SomeType `resolvedConcreteType` copy from the RHS is skipped, and separately the `funcName` / `typeName` / `isModuleEffectMember` type mutations are skipped (line 449-451).

**TS:** src/evaluator/exprs/initialization-assignment.ts performs both: it copies the resolved concrete type onto the declared SomeType and stamps the naming/effect-member hints TS codegen and later evaluation read back.

**Evidence:** initialization_assignment.yo:555-556 `// NOTE: SomeType resolvedConcreteType copy is skipped in Phase 2w. // yo-self's TypeValue.SomeT does not carry resolvedConcreteType.` and 449-451 `// NOTE: Type mutations (funcName, typeName, isModuleEffectMember) are intentionally skipped in Phase 2w.`

### `yo-self/evaluator/exprs/property_access.yo:1064` — partial _(evaluator-exprs)_

**yo-self:** Field access on a module TYPE (`.Struct` with is_source_namespace, line 967-972) and on a trait TYPE (1062-1064) always sets `out.value = create_unknown_val(field_type)`. yo-self's `TypeValue.Struct`/`TraitT` (yo-self/types/definitions.yo:166-189, 226-239) have parallel `field_labels`/`field_types` lists and NO per-field assigned-value slot.

**TS:** src/evaluator/exprs/property-access.ts:755-770 (source namespace) and 873-888 (trait) — both use `value: field.assignedValue ?? createUnknownValue(field.type, {variableName: field.label, env, context})`, i.e. the field's stored comptime value wins when present.

**Evidence:** property_access.yo:7-8 `TypeValue.Struct has no .trait field; struct type-val access searches field_labels directly instead of trait.fields.` — the same missing-assigned-value shape applies to both branches.

### `yo-self/evaluator/exprs/property_access.yo:1070` — partial _(evaluator-exprs)_

**yo-self:** In the struct/union `TypeVal` branch the chain ends after `find_methods_from_generic_impls` (842) and the `is_evaluating_generic_impl_specialization` env lookup (~860-898) with `.None => { // Not found — let function.ts handle it. return(expr); }`. There is no associated-type-from-generic-impls lookup; `find_associated_type_from_generic_impls` exists in yo-self only as `_find_associated_type_from_generic_impls :: (fn(...) -> bool)(false)` (yo-self/evaluator/trait_checking.yo:428).

**TS:** src/evaluator/exprs/property-access.ts:714-730 — after the specialization env check TS calls `findAssociatedTypeFromGenericImpls({concreteType, propertyName, env})` (implemented at src/evaluator/values/impl.ts:1911) and, on a hit, stamps `associatedType.type` / `.value` onto `expr.$`.

**Evidence:** property_access.yo:10-11 `findAssociatedTypeFromGenericImpls, findMethodFromGenericImplForTrait: stubbed (no associated-type support yet).` and trait_checking.yo:15 `_find_associated_type_from_generic_impls — always returns false`.

### `yo-self/evaluator/exprs/property_access.yo:983` — partial _(evaluator-exprs)_

**yo-self:** The `TypeVal + TraitT` branch implements only a minimal witness path: it reads the receiver out of `is_concrete` and queries `find_methods_from_generic_impls` filtered by trait key (1002-1044). The concrete-impl scan over the receiver's own trait fields is not implemented.

**TS:** src/evaluator/exprs/property-access.ts:794-846 — TS first iterates `traitType.receiverType.trait.fields`, finds `label === ""` entries whose `assignedValue` is a TraitValue, checks `areTypesCompatible(traitType, implTraitType)`, and returns the CONCRETE impl's method value (preferring `methodValue.specializedType`); only if that finds nothing does it fall through to `findMethodFromGenericImplForTrait` (850).

**Evidence:** property_access.yo:1009-1011 `TS also scans CONCRETE impls first (ts:651-849) — not yet needed by any red test; add if a concrete-impl witness shape surfaces.` and the header at line 12 `traitType.receiverType block (TS lines 651-723) is skipped — Phase 3.`

### `yo-self/evaluator/exprs/subtype_of.yo:378` — intentional-divergence _(evaluator-exprs)_

**yo-self:** `T <: Trait` stores the receiver type into the SAME `TraitT.is_concrete : Option(Self)` slot that `Concrete(T)` uses, so the two are structurally indistinguishable.

**TS:** src/types/definitions.ts:555 `receiverType?: Type` and :600 `isConcrete?: { concreteType: Type }` are SEPARATE fields on TraitType.

**Evidence:** subtype_of.yo:378-379 `// Create a new trait with receiver type (is_concrete) set to lhs_ty. // Mirrors TypeScript's { ...traitType, receiverType: typeValue.value }.` vs concrete_trait.yo:6 `The is_concrete field on TraitT stores the wrapped [Concrete] type for Impl.`

### `yo-self/evaluator/async/await_analysis.yo:392` — intentional-divergence _(evaluator-misc)_

**yo-self:** Async-specific AwaitPoint fields travel through a `HashMap(String, AwaitPointExtra)` keyed by `expr.token.character.to_string()`, then are zipped back in `analyze_await_points`. Two await expressions that share a token character offset (a cloned/duplicated sub-tree, a comptime-unrolled body, or exprs from two different files in one analyzed body) overwrite each other's extras; a point whose key is missing is silently DROPPED from the typed list (`.None => ()` at line 418) while the base SuspensionPoint list keeps it, so indices desynchronise.

**TS:** src/evaluator/async/await-analysis.ts:59-104 — `SuspensionPointDetector<AwaitPoint>` pushes fully-typed points directly into `points`, so result_type/future_type/future_variable_id are attached by identity, never by position or token offset.

**Evidence:** expr_char_key := ast_expr_token(sp.expr.clone()).character.to_string(); match(await_extras.get(expr_char_key.clone()), .None => (), // should not happen …

### `yo-self/evaluator/builtins/asm.yo:1` — no-op _(evaluator-misc)_

**yo-self:** `evaluate_asm` and `evaluate_global_asm` both throw `not yet implemented (Phase 3)` and return `make_err_expr()`.

**TS:** src/evaluator/builtins/asm.ts:1-830 — a full operand parser (register classes, in/out/inout/lateout/const_val/sym, clobber/clobber_abi, asm_options, template placeholder validation, output-variable initialisation marking, return-type inference incl. tuple for multiple outputs, the AllowUnsafe privilege gate, and the CTFE block).

**Evidence:** //! Phase 3 stub. Full implementation planned for Phase 3. … String.from("evaluate_asm: not yet implemented (Phase 3)")

### `yo-self/evaluator/builtins/derive.yo:304` — intentional-divergence _(evaluator-misc)_

**yo-self:** `process_trait_arg` resolves the derive rule by the trait's EXPRESSION-LEVEL NAME through a global registry (`extract_derive_key` → `get_derive_rule(key)`), and hard-errors when the key is absent.

**TS:** src/evaluator/builtins/derive.ts:294-417 `processTraitArg` — evaluates the trait argument and reads `traitType.deriveRule ?? traitType.functionValue?.deriveRule` off the resolved TYPE (also handling the plain-FunctionValue case), so identity, not spelling, selects the rule.

**Evidence:** //! Key difference from TypeScript: we use the global g_derive_rules registry … Trait args are resolved by expression-level name (not by evaluating the trait arg).

### `yo-self/evaluator/builtins/dup.yo:104` — intentional-divergence _(evaluator-misc)_

**yo-self:** The struct branch of `___dup` is not ported: for an RC-containing struct/dyn receiver the builtin falls through to the plain path (stamp arg_type, no rewrite) and, unlike TS, never flips the source variable's `is_owning_the_rc_value` to false after the dup.

**TS:** src/evaluator/builtins/dup.ts:150-266 — rewrites to `(v).___dup()` via `evaluateFunctionCall`, then `if (variable.isOwningTheRcValue) updateExistingVariable(..., { isOwningTheRcValue: false })`.

**Evidence:** //! DIVERGENCE from TS: the struct `.___dup()` branch is NOT ported — yo-self synthesizes no evaluator-side \_\_\_dup methods (ref-struct RC is lowered directly in codegen)

### `yo-self/evaluator/builtins/macro_expand.yo:216` — partial _(evaluator-misc)_

**yo-self:** The expansion loop calls `evaluate_function_call(current_expr, current_env, t_unit(), .None, ctx, exn)` with NO error containment and no macro-expansion flag: an error inside one expansion step propagates out and aborts compilation, and the `for_macro_expansion` behaviour has no parameter at all (`grep for_macro_expansion` over yo-self returns nothing).

**TS:** src/evaluator/builtins/macro-expand.ts:122-155 — the call is wrapped in `try { … } catch (error) { if (error instanceof YoError && error.isAssertionError) throw error; break; }`, i.e. a failed step just STOPS expansion; and it passes `forMacroExpansion: true`, which changes behaviour at src/evaluator/calls/function.ts:780 (skips the range→slice_copy rewrite) and :1936 (re-evaluates an unquote-returning macro with the real arg exprs, clearing validation flags).

**Evidence:** // Note: Cannot use given() inner handler due to closure capture limitations. // Errors propagate to the outer exn handler.

### `yo-self/evaluator/builtins/pragma.yo:143` — partial _(evaluator-misc)_

**yo-self:** `evaluate_pragma` never evaluates its argument: it only pattern-matches the literal `Pragma.<Variant>` AST shape via `recognize_pragma_arg`, and `pragma_kind_from_variant_name` (line 39) knows only AllowUnsafe / SkipPrelude / SkipWasm / SkipWasm32Emscripten / SkipWasm32Wasi. Anything else — an aliased/rebound `Pragma`, `pragma(42)`, `Pragma.Verify`, `Pragma.VerifyOrAssert`, `Pragma.NoContracts` — is silently ignored with no registration and no error. (The module header claiming AllowUnsafe is a no-op in yo-self is stale: the gates ARE ported and consult `is_implicitly_unsafe_capable_file`.)

**TS:** src/evaluator/builtins/pragma.ts:39-131 — only `SkipPrelude` takes the AST fast path; everything else is fully evaluated, must be an enum of typeName `Pragma` with a selected variant (throws otherwise), unknown variants throw, and Verify/VerifyOrAssert emit a one-time warning. `pragmaKindFromVariantName` (line 162) covers all 8 variants incl. NoContracts, which codegen honours.

**Evidence:** //! yo-self uses the syntactic `recognize_pragma_arg` (the `Pragma.X` shape) rather than fully evaluating the arg. + cond((name == "AllowUnsafe") … (name == "SkipWasm32Wasi") …, true => Option(Pragma).None)

### `yo-self/evaluator/builtins/process.yo:43` — hardcoded _(evaluator-misc)_

**yo-self:** `__yo_process_platform`, `__yo_process_arch` and `__yo_pointer_size_bits` all call `detect_host()`. yo-self has no current-target concept at all (`grep get_current_target` over yo-self returns nothing).

**TS:** src/evaluator/builtins/process.ts:41,64,~85 — all three use `getCurrentTarget()` (src/target.ts:312), i.e. the target set by `--target`, falling back to host only when unset.

**Evidence:** host := detect_host(); os_str := String.from(os_to_str(host.platform));

### `yo-self/evaluator/builtins/the.yo:138` — no-op _(evaluator-misc)_

**yo-self:** On a compatibility failure `the(T, v)` throws immediately. The inference-retry path is missing entirely, and the synthesizer it would call is itself a whole-module stub: yo-self/evaluator/types/expr_synthesizer.yo:39 `synthesize_expr_and_type` returns `SynthesizeResult(expr, ty, env)` unchanged.

**TS:** src/evaluator/builtins/the.ts:83-116 — `if (typeRequiresInference(expectedType)) { try { synthesizeExprAndType(...) } … }` before throwing; src/evaluator/types/expr-synthesizer.ts:34-263 implements tuple-field recursion, `_(...)` placeholder construction via `evaluateFunctionCall` with `givenFunc`, and `.Variant` shorthand resolution.

**Evidence:** //! Note: `synthesizeExprAndType` is a stub in Phase 2; synthesis is skipped. + expr_synthesizer.yo: "//! Phase 2w stub: returns `expr`, `ty`, and `env` unchanged."

### `yo-self/evaluator/ctfe/ctfe_analysis.yo:6` — deferred-todo _(evaluator-misc)_

**yo-self:** The whole module is a documentation-only stub (no code). `analyzeCtfeCapability` is inlined only into builtins/comptime_fn.yo; the two OTHER TS call sites — nested function definitions and nested anonymous functions evaluated while `isAnalyzingCtfeCapability || forceCompileTimeBindings` — have no yo-self counterpart (`grep ctfe` in yo-self/evaluator/calls/function_type.yo finds only the context field; anonymous_function.yo has none).

**TS:** src/evaluator/ctfe/ctfe-analysis.ts:70-213; call sites src/evaluator/calls/function-type.ts:669 and src/evaluator/values/anonymous-function.ts:1127 both upgrade a nested function to its comptime version so it can be called at compile time.

**Evidence:** //! Status: stub. The yo-self port currently performs the analogous analysis //! inline in `yo-self/evaluator/calls/comptime_fn.yo` (Phase 2/3 wiring)

### `yo-self/evaluator/utils/closure.yo:106` — no-op _(evaluator-misc)_

**yo-self:** `build_path_collection_from_captured_variables` always returns an empty `ArrayList(ArrayList(String))`.

**TS:** src/evaluator/utils/closure.ts:85-96 — pushes `[variableName]` for every captured variable; the result becomes the closure expression's `pathCollection` (src/evaluator/calls/function-type.ts:686).

**Evidence:** /// Phase 3 simplification: returns an empty list.

### `yo-self/evaluator/utils/closure.yo:123` — no-op _(evaluator-misc)_

**yo-self:** `validate_capture_trait_requirements` is `)(());` — a literal no-op.

**TS:** src/evaluator/utils/closure.ts:105-175 — walks `wrapperType.requiredTraits`, skips Fn traits, then per captured variable and for the aggregate capture struct calls `typeImplementsTraitBool` and throws (`Captured variable 'x' … does not implement Send`, `Closure does not implement …`).

**Evidence:** validate_capture_trait_requirements :: ( fn(\_wrapper_type …, \_capture_type …, \_env …, \_error_token …) -> unit )(());

### `yo-self/evaluator/utils/closure.yo:89` — no-op _(evaluator-misc)_

**yo-self:** `consume_captured_variables` returns `env` unchanged — closure move semantics are not applied to `own`-usage captures.

**TS:** src/evaluator/utils/closure.ts:40-73 — for each capture with `usageType === "own"` and `frameLevel < env.frames.length`, it sets `consumedAtToken: closureToken` via `updateExistingVariable`.

**Evidence:** /// Phase 3 stub: no move semantics yet — returns env unchanged.

### `yo-self/types/utils.yo:303` — conservative-fallback _(evaluator-misc)_

**yo-self:** `_type_contains_rc_inner` guards recursion with a DEPTH CAP (`(depth > u32(8)) => false`) instead of an identity-based checked-set, and has no `isExtern` short-circuit. A type whose only RC member sits deeper than 8 levels is reported NON-RC. (Cited from my area because builtins/drop.yo, dup.yo and type_fns.yo all key their behaviour on it; type_fns.yo:398/460 still documents both helpers as "stub: always false in Phase 2", which is stale.)

**TS:** src/types/utils.ts:131-201 `typeContainsRcType(type, checkedTypes = [])` — unbounded recursion guarded by an identity list, plus `if (type.isExtern) return false` and the Future/resolvedConcreteType SomeType cascade.

**Evidence:** cond( // Depth limit — conservative: return false at max depth (depth > u32(8)) => false,

### `yo-self/evaluator/types/array.yo:172` — no-op _(evaluator-types)_

**yo-self:** The length-expression validation is disabled: `len_info.ty;` is a bare no-op statement and the guard is literally `if(false, { exn.throw(... "Expected compile-time known value for length" ...) })`. Neither the usize-compatibility check nor the compile-time-known check can ever fire. The missing-value case falls through to `create_unknown_val(t_usize())` at line 189 instead of erroring.

**TS:** src/evaluator/types/array.ts:126-150 — TS runs `areTypesCompatible({type: createUsizeType(), env}, {type: evaluatedLengthExpr.$.type, env})` and throws `Expected usize for length`, then throws `Expected compile-time known value for length` when `$.value` is absent.

**Evidence:** `len_info.ty;` then `if(false, { exn.throw(... ) });` under the comment "Length type / value checks are best-effort under the bootstrap's partial HKT support ... silently accept and continue with `usize(0)` placeholder"

### `yo-self/evaluator/types/array.yo:65` — intentional-divergence _(evaluator-types)_

**yo-self:** `Array(T, _)` is rejected with a hard error (`Array length inference with "_" is not supported in the self-hosted compiler`).

**TS:** src/evaluator/types/array.ts:71-106 — TS creates an `UnknownValue(usize)` with a fresh `variableName`, adds it to the env as a compile-time variable, builds `createArrayType(childType, unknownLength)`, and returns; the length is later inferred by the synthesizer's array-length binding (synthesizer.ts:900-937).

**Evidence:** //! Note: `Array(T, _)` (underscore length inference) is NOT supported in the self-hosted compiler because `t_array` requires a concrete `usize` length.

### `yo-self/evaluator/types/dyn.yo:278` — partial _(evaluator-types)_

**yo-self:** Three checks TS performs on the assembled required-trait list are absent, marked by three consecutive comment lines: the cross-trait duplicate-function-name conflict check, the reserved-function-name check, and `addRcFunctionsToDynType`.

**TS:** src/evaluator/types/dyn.ts:107-125 — the O(n²) scan over `traitTypeA.fields` × `traitTypeB.fields` throwing "Trait types A and B have conflicting function name 'x' in 'Dyn' expression." src/evaluator/types/dyn.ts:127-148 — rejects `___dup`, `___drop`, `___dispose`, `dispose` as function-typed trait fields. src/evaluator/types/dyn.ts:162-167 — `addRcFunctionsToDynType` (utils.ts:1005).

**Evidence:** `// Phase 2aq deferred: function-name conflict check across required traits.` / `// Phase 2aq deferred: reserved function-name check.` / `// Phase 2aq deferred: addRcFunctionsToDynType ARC injection.`

### `yo-self/evaluator/types/fn_trait.yo:176` — partial _(evaluator-types)_

**yo-self:** `t_fn_trait(...)` is built from only the ordinary parameter labels/types, the return type, and the implicit-parameter triple. `params_result.forall_params`, the variadic parameter, and the where-clause expressions returned by `evaluate_function_parameters` are read for nothing on this path and never reach the FnTraitT. Per-parameter `is_compile_time_only` is also dropped.

**TS:** src/evaluator/types/fn-trait.ts:107-128 — `createFunctionType({ parameters, forallParameters: forallParameters as FunctionForallParameter[], variadicParameter, whereClauseExprs, return_: {...}, env, parametersFrame, isClosure: true })`, then `fnTraitType.isFn = { callType: fnType }`. The whole FunctionType — foralls, variadic, where clauses, per-param comptime flags — is the Fn trait's call type.

**Evidence:** `fn_trait_type := t_fn_trait(String.from(BK_FN_TRAIT), call_param_labels, call_param_types, return_type, implicit_labels, implicit_types, implicit_spreads);` — no forall/variadic/where arguments exist in the call

### `yo-self/evaluator/types/function.yo:1168` — deferred-todo _(evaluator-types)_

**yo-self:** Between the two comptime/runtime availability checks there is NO `find_some_type_missing_comptime_constraint` validation. `find_some_type_missing_comptime_constraint` exists in yo-self (evaluator/trait_checking.yo:1489) but is not called from function.yo. The same check is skipped in trait.yo (header line 15 says so explicitly).

**TS:** src/evaluator/types/function.ts:510-531 — `if (isCompileTimeOnly && typeContainsSomeType(parameterType) && !context.SelfTraitType) { const missingSomeType = findSomeTypeMissingComptimeConstraint(parameterType, env); if (missingSomeType) throw ... "is used with \"comptime\" but type parameter ... does not implement the Comptime trait. Add \"<name> <: Comptime\" to the where clause." }`. src/evaluator/types/trait.ts:1074-1122 does the same for trait field return types and parameters.

**Evidence:** function.yo:1153-1178 contains only the `type_prohibits_comptime_modifier` and `type_requires_comptime_modifier` checks; trait.yo header: `//!   - `findSomeTypeMissingComptimeConstraint` check skipped (same as function.yo)`

### `yo-self/evaluator/types/function.yo:1714` — conservative-fallback _(evaluator-types)_

**yo-self:** In the pending-constraint RETRY path, a concrete-type LHS whose constraint is violated calls `validate_concrete_type_constraints(b, unwrapped_trait_expr, original_constraint_expr, env_mut, ctx, exn)` with the OUTER exception — a hard throw. The same pattern repeats at function.yo:1877-1878 and 1992 in `_parse_where_clauses` with `collect_pending` set.

**TS:** src/evaluator/types/function.ts:1058-1068 and 1099-1109 — inside `applySingleTraitConstraint` (the retry helper) TS wraps `validateSingleTraitOnConcreteType` in `try { … } catch { return { env, success: false }; }`, and likewise wraps the LHS and RHS `evaluateExpression` calls. A retry failure yields `success: false` and the constraint is retried again / reported only by the final non-pending re-run.

**Evidence:** "// Use outer exn directly (hard failure) — the given/using soft-failure pattern generates incomplete C calls (missing exn\_\_throw argument)." and "collect_pending behavior is simplified: hard failure on constraint violation."

### `yo-self/evaluator/types/record.yo:77` — no-op _(evaluator-types)_

**yo-self:** The `is_for_module_type` parameter is discarded with a bare `is_for_module_type;` statement (alongside `module_field_idx;` on the previous line). Nothing gated on it is implemented.

**TS:** src/evaluator/types/record.ts:335-366 — under `isForEvaluatingRecordType`, TS validates that EVERY forall parameter, every parameter, and the return type of a function-typed record field has an explicit `typeExpr`, throwing "…must have an explicit type annotation. Type expressions are required for all function parameters in record type fields to support proper type specialization." src/evaluator/types/record.ts:369-379 — also under that flag, `?=` defaults are restricted to function-typed fields ("Default values (?=) are only allowed for function-typed record fields").

**Evidence:** lines 76-77: `module_field_idx;` / `is_for_module_type;` — both parameters referenced solely to silence unused warnings

### `yo-self/evaluator/types/record.yo:78` — partial _(evaluator-types)_

**yo-self:** `evaluate_module_field` throws hard errors for three field forms instead of implementing them: `?=` default value (line 79-90), `=` / `:=` assigned value (line 105-116), and — in `evaluate_module_type` — the `...` spread/extend operator (line 216-227). The result type `EvalModuleFieldResult(label, field_type, env)` cannot even carry a default or assigned value.

**TS:** src/evaluator/types/record.ts:58-81 handles `?=` (defaultValueExpr) and `=`/`:=` (assignedValueExpr), rejecting only `::`; :204-262 evaluates the assigned value with the field's expected type and checks `areTypesCompatible`; :264-323 does the same for the default value; :381-390 stamps `labelExpr.$.value = assignedValue ?? createUnknownValue(...)`. It returns a full `TypeField` with `defaultValue`, `assignedValue`, `exprs`, and `docComment`.

**Evidence:** `// Stub: ?= default value form` … `"evaluate_module_field: ?= (default value) is not yet supported (Phase 3)"`; `// Stub: spread (...) extend form — Phase 3`

### `yo-self/evaluator/types/struct.yo:179` — partial _(evaluator-types)_

**yo-self:** Two atomic-object behaviours are missing. (a) `begin_send_derivation(struct_id)` is only called INSIDE `auto_derive_traits_for_struct_type` (utils.yo:140), i.e. AFTER all fields are evaluated — yo-self has no pre-field-evaluation cycle break for `is_atomic_rc`. (b) There is no post-derive `type_implements_send` enforcement at all; the `is_atomic_rc` block at line 179-211 only bans `Arc(Iso(T))`.

**TS:** src/evaluator/types/struct.ts:82-85 — `const needsSendCycleBreak = isAtomicRc; if (needsSendCycleBreak) beginSendDerivation(structType.id);` BEFORE the field loop, with the comment that self-referential `atomic object(_next: Option(Self))` triggers Option creation during field evaluation which checks Send for this type. src/evaluator/types/struct.ts:159-173 — after `endSendDerivation`, `if (isAtomicRc && !typeImplementsSend(structType, env)) throw "atomic object must implement Send (all fields must be Send) …"` listing the non-Send fields.

**Evidence:** struct.yo:179 `if(is_atomic_rc, {` contains only the `Arc(Iso(T))` ban; the header lists `beginSendDerivation`, `endSendDerivation`, `typeImplementsSend` as "not yet ported (see plans/BOOTSTRAPPING.md Phase 3)".

### `yo-self/evaluator/types/struct.yo:92` — deferred-todo _(evaluator-types)_

**yo-self:** `TypeValue.Struct` has no `defined_in_module_path` field (types/definitions.yo:166-189) and none is recorded anywhere. A repo-wide grep for `defined_in_module` in yo-self returns exactly one hit — the union.yo header comment noting it as a stub. The same omission applies to `EnumT` (enum.yo), `Union` (union.yo:166), `TraitT` (trait.yo), and the module/source-namespace struct (record.yo:266 carries an explicit `// TODO (Phase 3): propagate ctx.current_module_path to module type (orphan rule checks).`).

**TS:** src/evaluator/types/struct.ts:65-76 sets `structType.definedInModulePath` and `structType.trait.definedInModulePath` from `expr.token.modulePath || context.currentModulePath`; enum.ts:51-59, union.ts:42-49, trait.ts:901-903 do the same. Consumers: src/evaluator/values/impl.ts:1205-1227 (orphan-rule check: "Trait defined in: … Type defined in: …") and src/evaluator/exprs/property-access.ts:564, :1009 (`typeDefinedInModulePath` for the Phase P private-field visibility check).

**Evidence:** `prelim_ty := TypeValue.Struct(struct_id.clone(), String.from(""), …)` — field 2 is `name`, and the variant has no module-path field at all; union.yo header: `//!   - `definedInModulePath` propagation (orphan rule checks)`

### `yo-self/evaluator/types/synthesizer.yo:243` — partial _(evaluator-types)_

**yo-self:** In the `n == usize(0)` (no existing binding) arm of `_bind_some_type`, the new variable is added with plain `add_variable_to_env`, which unconditionally places it on the TOP frame (`idx := n - 1`, env.yo:853). There is no `delta_frame` parameter anywhere in yo-self's `add_variable_to_env`, so the SomeType's `definition_frame_level` is ignored.

**TS:** src/evaluator/types/synthesizer.ts:477-500 — TS computes `deltaFrame = defLevel - (expected.env.frames.length - 1)` from `expected.type.definitionFrameLevel` and passes it to `addVariableToEnv`, with the comment: "Place the binding at the SomeType's definitionFrameLevel when possible, so subsequent lookups via getValueOfSomeTypeFromEnv (which keys off definitionFrameLevel) can find it. Without this the binding goes onto the top frame and the fast/fallback paths in env-lookup miss it, returning the SomeType as 'unbound'."

**Evidence:** `add_variable_to_env(env, name, ty, Option(EvalValue).Some(val), true, false, false, false, token)` under "// No existing binding — add one", with no frame-level argument available in the signature (env.yo:836-847)

### `yo-self/evaluator/types/trait.yo:1130` — partial _(evaluator-types)_

**yo-self:** Two things TS does right after creating `Self` are skipped: `selfType.trait = traitType` (no `trait` field on yo-self's `SomeT`) and the follow-up `attachTraitToReceiverType("Runtime", selfType, env, context)`. `traitType.definedInModulePath = context.currentModulePath` is also not set.

**TS:** src/evaluator/types/trait.ts:901-921 — sets `traitType.definedInModulePath`, then `selfType.trait = traitType`, then `if (getTraitTypeFromEnv(env, "Runtime")) env = attachTraitToReceiverType("Runtime", selfType, env, context);` with the comment that this must happen AFTER `selfType.trait = traitType`.

**Evidence:** `// Note: selfType.trait = traitType is skipped — SomeT has no `trait` field in yo-self.` plus header line 14 `//!   - `attachTraitToReceiverType` for Runtime trait skipped`

### `yo-self/evaluator/types/trait.yo:1316` — conservative-fallback _(evaluator-types)_

**yo-self:** Pending where-clause constraints that still fail on retry are silently DISCARDED: the retry runs through `_drop_where_constraint_failures`, described in the adjacent comment as "a unit-returning wrapper with a local Exception handler so constraints that still can't resolve … are silently dropped rather than aborting the whole trait". Compounding this, `_lhs_should_defer_for_pending` (trait.yo:256-268) defers EVERY non-atom LHS on the first pass rather than deferring only what actually failed.

**TS:** src/evaluator/types/trait.ts:1041-1071 — TS collects `stillPending`, and if non-empty re-runs `parseTraitWhereClauseConstraints({constraintExprs: [failedConstraint.originalConstraintExpr], …, collectPendingTraits: false})` specifically so the real error is THROWN. TS never silently drops a constraint.

**Evidence:** "are silently dropped rather than aborting the whole trait. Mirrors TS's lenient pending-constraint flow." — TS is not lenient here; it re-throws.

### `yo-self/evaluator/types/tuple.yo:168` — no-op _(evaluator-types)_

**yo-self:** Tuple auto-derive is an explicit no-op comment: `// TODO (Phase 3): autoDeriveTraitsAndAddRcFunctionsForTupleType stub — no-op for now.` Nothing registers Send/Comptime/Runtime for a tuple. This is structurally unfixable in the current representation: `TypeValue.Tuple(field_labels, field_types)` has no `id`, and `g_type_trait_registry` is keyed by type id.

**TS:** src/evaluator/types/utils.ts:1981-2016 — `autoDeriveTraitsAndAddRcFunctionsForTupleType` runs `autoDeriveSendForTupleType` (1663), `autoDeriveComptimeForTupleType` (1689), `autoDeriveRuntimeForTupleType` (1715), each attaching the marker via `attachTraitToReceiverType` when every field satisfies it, then `validateTypeAvailability`.

**Evidence:** `// TODO (Phase 3): autoDeriveTraitsAndAddRcFunctionsForTupleType stub — no-op for now.` immediately before `tuple_ty := TypeValue.Tuple(...)`

### `yo-self/evaluator/types/union.yo:126` — conservative-fallback _(evaluator-types)_

**yo-self:** Union field runtime validation uses `type_implements_runtime` imported from `../../types/utils.yo` — a TAG-ONLY function (types/utils.yo:292-298) that returns `false` for every undecided tag. `type_implements_runtime_builtin` (types/utils.yo:239-285) returns `.None` for `TStruct`, `TEnum`, `TArray`, and `TTuple`.

**TS:** src/evaluator/types/union.ts:85-93 calls `typeImplementsRuntime(field.type, env)` from `../trait-checking` — the ENV-AWARE version (src/evaluator/trait-checking.ts) that falls back to looking up the `Runtime` trait in the environment, so nominal struct/enum fields resolve correctly. yo-self even has the env-aware twin (`type_implements_runtime_full`, evaluator/trait_checking.yo:972) but union.yo does not import it.

**Evidence:** `{ type_implements_runtime, type_is_comptime_only } :: import("../../types/utils.yo");` at union.yo:40, used at line 126 as `!(type_implements_runtime(field.ty))`; types/utils.yo:292 doc says "for undecided cases it conservatively returns `false` (Phase 3 will consult the `Runtime` trait in `env`)"

### `yo-self/evaluator/types/utils.yo:179` — deferred-todo _(evaluator-types)_

**yo-self:** `auto_derive_traits_for_struct_type` (and the enum/union twins at lines 209 and 243) end after registering the trait markers. `validate_type_availability` is never invoked from anywhere in yo-self — it is defined at evaluator/trait_checking.yo:1473 and exported at :1621, and a repo-wide grep finds ZERO call sites.

**TS:** src/evaluator/types/utils.ts:1795, :1865, :2013 — `validateTypeAvailability(structType|enumType|tupleType, env, errorToken, context)` is the LAST statement of `autoDeriveTraitsAndAddRcFunctionsFor{Struct,Enum,Tuple}Type`. It throws `Type X has incompatible field contexts and cannot be used in any evaluation context` when the type implements neither Comptime nor Runtime (src/evaluator/trait-checking.ts:991-1014).

**Evidence:** `end_send_derivation(struct_id);` is the last statement of `auto_derive_traits_for_struct_type`; the header lists only the auto-derive concern and says the rest of utils.ts is "still scattered/stubbed".

### `yo-self/evaluator/values/anonymous_function.yo:1394-1447` — no-op _(evaluator-values)_

**yo-self:** After building the capture struct, yo-self never calls `validate_capture_trait_requirements`; the file does not import it. (Its yo-self counterpart in evaluator/utils/closure.yo:123 is itself documented as a no-op.)

**TS:** src/evaluator/values/anonymous-function.ts:1182-1191 — `if (isSomeType(wrapperType) && captureType) validateCaptureTraitRequirements({wrapperType, captureType, env, errorToken, capturedVariablesWithValues})` — verifies the capture struct implements the wrapper's non-Fn required traits (e.g. Send).

**Evidence:** anonymous_function.yo imports list (lines 82-87) pulls `enrich_captured_variables`, `generate_captured_variable_dup_expressions`, `create_capture_type_and_value` from ../utils/closure.yo but NOT `validate_capture_trait_requirements`; closure.yo:8 `//!   - validate_capture_trait_requirements    → no-op`.

### `yo-self/evaluator/values/anonymous_function.yo:1451` — no-op _(evaluator-values)_

**yo-self:** The closure's ExprInfo `path_collection` is left at the empty default from `new_expr_info`; nothing builds it from the captured-variable map.

**TS:** src/evaluator/values/anonymous-function.ts:1240-1244 — `pathCollection: isClosureFunction && capturedVariables ? buildPathCollectionFromCapturedVariables(capturedVariables) : []`.

**Evidence:** anonymous_function.yo:1451 `info := new_expr_info(env, function_type);` — expr_info.yo:421 initialises `path_collection : ArrayList(ArrayList(String)).new()` and the field is never assigned in this file.

### `yo-self/evaluator/values/anonymous_function.yo:18-21` — deferred-todo _(evaluator-values)_

**yo-self:** `analyzeCtfeCapability` is never invoked for a nested anonymous function, even though a port exists at yo-self/evaluator/ctfe/ctfe_analysis.yo — anonymous_function.yo does not import it.

**TS:** src/evaluator/values/anonymous-function.ts:1121-1135 — when `context.isAnalyzingCtfeCapability || context.forceCompileTimeBindings` and not creating a closure, TS replaces the FunctionValue with `analyzeCtfeCapability(functionValue, env, context)`'s CTFE version.

**Evidence:** anonymous_function.yo:20 `//!   - analyzeCtfeCapability skipped` (header) — confirmed by grep: no `analyze_ctfe_capability` reference in the file.

### `yo-self/evaluator/values/anonymous_function.yo:24-26` — deferred-todo _(evaluator-values)_

**yo-self:** The declared-return-type vs evaluated-body-type compatibility check is not ported; there is no "Incompatible return type" throw anywhere in the file (grep).

**TS:** src/evaluator/values/anonymous-function.ts:1015-1029 — `if (!areTypesCompatible({type: functionType.return.type, env}, {type: evaluatedBodyReturnType, env})) throw 'Incompatible return type: - Expected ... - Got ...'`.

**Evidence:** anonymous_function.yo:24-26 `//!   - return-type-vs-body compatibility check skipped (would over-fire on def-eval porting gaps; the swallow philosophy admits only deliberately-gated rejections)`

### `yo-self/evaluator/values/anonymous_function.yo:294-330` — intentional-divergence _(evaluator-values)_

**yo-self:** `_subst_some_types_from_env` adds an ALLOW-LIST gate (`if(!(allow.contains(ssn)), return(ty))`) so only forall names bound by this pass's own annotation frame are substituted, and it deliberately does NOT consult the SomeT's `resolvedConcreteType`. TS does neither restriction. The second TS substitution site (against `expectedTypeEnv`) is also dropped.

**TS:** src/evaluator/values/anonymous-function.ts:110-145 — step 1 is `if (type.resolvedConcreteType) return substituteSomeTypesFromEnv(type.resolvedConcreteType, ...)`, then an unrestricted `getVariablesFromEnv(env, type.name)` walk. anonymous-function.ts:249-257 substitutes the whole functionType against `expectedTypeEnv` ("Without this, lambda parameters keep unresolved SomeType refs and the closure's C function is skipped by codegen").

**Evidence:** anonymous_function.yo:283-293 `DIVERGENCE (deliberate): TS's step 1 resolves through the SomeT's own resolvedConcreteType ... Only ENV BINDINGS ... drive this substitution.` and 298-307 `ALLOW-LIST gate: only substitute forall names THIS pass itself bound`.

### `yo-self/evaluator/values/anonymous_function.yo:583-584` — intentional-divergence _(evaluator-values)_

**yo-self:** `is_creating_closure := (!(op_is_arrow))` — closure-ness is decided purely by the source operator (`=>`/`=>>` vs `->`). There is no check that the operator agrees with the expected type.

**TS:** src/evaluator/values/anonymous-function.ts:205-275 — TS sets `isCreatingClosure = true` only in the SomeType/Impl(Fn) branch (from the expected TYPE), then computes `expectedOperator = isCreatingClosure ? "=>" : "->"` and throws `Expected ${expectedOperator} for anonymous ${operatorDescription}` on mismatch.

**Evidence:** anonymous_function.yo:583-584 `op_is_arrow := (op_str == "->"); is_creating_closure := (!(op_is_arrow));`

### `yo-self/evaluator/values/anonymous_struct.yo:193` — no-op _(evaluator-values)_

**yo-self:** `autoDeriveTraitsAndAddRcFunctionsForStructType` is a bare comment — `// TODO (Phase 3): autoDeriveTraitsAndAddRcFunctionsForStructType — no-op stub.` — even though yo-self HAS `auto_derive_traits_for_struct_type` (evaluator/types/utils.yo:129) and struct.yo:273 / closure.yo:322 both call it.

**TS:** src/evaluator/values/anonymous-struct.ts:193-198 calls it; src/evaluator/types/utils.ts:1743-1798 runs Send/Rc/Acyclic/Comptime/Runtime derivation, then `addRcFunctionsToStructType` (generates `___dup`/`___drop`), then `validateTypeAvailability`.

**Evidence:** anonymous_struct.yo:7 `//! autoDeriveTraitsAndAddRcFunctionsForStructType is a no-op stub (Phase 3).` and line 193.

### `yo-self/evaluator/values/clone_value.yo:11-13` — deferred-todo _(evaluator-values)_

**yo-self:** `clone_value` takes no `target_value_mapping` parameter and never maintains one; with `preserve_pointer_refs = false` every `PtrVal` deep-clones its own target independently.

**TS:** src/evaluator/values/clone-value.ts:41-124 — `cloneValue(value, preservePointerReferences, targetValueMapping)` consults `targetValueMapping.get(ptrValue.targetValue)` and registers each new target so that two pointers to the same cell in the source clone to two pointers to ONE cell.

**Evidence:** clone_value.yo:11-13 `//! The TypeScript targetValueMapping (to maintain aliasing between cloned pointers inside the same environment) is not yet ported — each Box gets an independent clone, which is sufficient for Phase 3 bootstrap purposes.`

### `yo-self/evaluator/values/comptime_list.yo:78-94` — partial _(evaluator-values)_

**yo-self:** The "element must be compile-time known" gate is `has_value := info.value.is_some()`. Because yo-self encodes a runtime result as `Some(UnknownVal)`, a runtime element passes the gate and an `UnknownVal` is pushed into the `ComptimeListVal`.

**TS:** src/evaluator/values/comptime-list.ts:47-52 — `if (!evaluatedArg.$ || !evaluatedArg.$.value) throw 'Failed to evaluate expr_list element. Expected compile-time known value'`.

**Evidence:** comptime_list.yo:78-82 `has_value := match(arg_info_opt, .Some(info) => info.value.is_some(), .None => false);`

### `yo-self/evaluator/values/dyn.yo:510-514` — partial _(evaluator-values)_

**yo-self:** The auto-box gate is `!is_reference_struct_type(value_type) && !is_dyn_type(value_type)`. Two differences from TS: the `typeImplementsFuture(SomeType)` exclusion is dropped (so a Future-implementing SomeT payload IS boxed), and a `!is_dyn_type` exclusion is ADDED (so a Dyn payload is NOT boxed, where TS boxes it).

**TS:** src/evaluator/values/dyn.ts:250-253 — `if (!isReferenceStructType(valueType) && !(isSomeType(valueType) && typeImplementsFuture(valueType)))`.

**Evidence:** dyn.yo:510-512 `// Note: Future-implementing SomeType check (typeImplementsFuture) is omitted in Phase 3 — all non-object, non-dyn values are wrapped in box().`

### `yo-self/evaluator/values/dyn.yo:605-623` — partial _(evaluator-values)_

**yo-self:** When the DynType can be derived from neither the context nor a DynT/SomeT value type, yo-self THROWS `'dyn' requires a SomeType (Impl), DynType, or an expected Dyn type context. Concrete types without trait fields are not supported in Phase 3.` There is no path for a concrete type carrying a `.trait`.

**TS:** src/evaluator/values/dyn.ts:311-320 — the equivalent guard is COMMENTED OUT (`/// if (!isSomeType(valueType) && !valueType.trait) { throw ... }`), and the DynType is then derived from the concrete type's own `.trait` fields further down.

**Evidence:** dyn.yo:552-553 `//   4. Otherwise: unsupported in Phase 3 (concrete .trait not available).` and the throw at 606-615.

### `yo-self/evaluator/values/impl.yo:12` — deferred-todo _(evaluator-values)_

**yo-self:** `checkOrphanRule` and `checkDuplicateImpl` have no yo-self counterpart (grep for `check_orphan_rule` / `check_duplicate_impl` over yo-self returns nothing), and there is no `typeImplRegistry` equivalent recording (typeId, traitId, modulePath).

**TS:** src/evaluator/values/impl.ts:1129-1153 (`checkDuplicateImpl` — throws "Trait X is already implemented for type Y") and impl.ts:1188-1232 (`checkOrphanRule` — throws on a foreign-trait/foreign-type impl outside prelude/std).

**Evidence:** impl.yo:12 `//!   - checkOrphanRule / checkDuplicateImpl: still skipped.`

### `yo-self/evaluator/values/impl.yo:1379-1464` — partial _(evaluator-values)_

**yo-self:** `_collect_impl_where_constraints` only recognises `X <: Trait` (and a tuple RHS split). It has no representation for a NEGATED constraint (`X <: !(Trait)`), and `try_match_generic_impl` (impl.yo:687-697) does `.None => ()` when the bound type is still abstract — so the constraint is silently skipped rather than checked against the SomeT's attached constraints.

**TS:** src/evaluator/values/impl.ts:2372-2400 handles `actualConstraintTrait.isNegatedConstraint` (bound type must NOT implement, and for a SomeT bound uses `someTypeHasNegatedTraitConstraint`); impl.ts:2402-2409 handles the positive-SomeT case via `someTypeHasTraitConstraint`. Neither helper exists in yo-self (grep).

**Evidence:** impl.yo:1400 `if(ast_expr_is_fn_call_of(c, "<:", Option(usize).Some(usize(2))), {` — only shape handled; impl.yo:696 `.None => ()` for an unresolved binding.

### `yo-self/evaluator/values/impl.yo:1502-1525` — no-op _(evaluator-values)_

**yo-self:** Case 1 (anonymous impl `impl({ ... })`) calls `evaluate_anonymous_module_begin_exprs` without ever setting `ctx.is_inside_impl_block = true`. Grep over all of yo-self shows the flag is READ (binding.yo:311, initialization_assignment.yo:582) and saved/restored (comptime_expect_error.yo:103) but never assigned `true` anywhere — it is permanently false.

**TS:** src/evaluator/values/impl.ts:3080-3090 — the anonymous-impl branch passes `context: { ...context, expectedType: undefined, SelfType: context.SelfType, isInsideImplBlock: true }`.

**Evidence:** impl.yo:1509-1519 saves/clears only `ctx.expected_type`; no `is_inside_impl_block` assignment. `grep -rn 'is_inside_impl_block' yo-self` shows read sites only.

### `yo-self/evaluator/values/impl.yo:2164-2218` — partial _(evaluator-values)_

**yo-self:** The Case-3 field loop accepts any non-colon FnCall as a trait constructor and silently ignores anything it cannot interpret. Three TS rejections are missing: `impl(T, { begin... })` begin-block, `::`/`:=` field syntax, and the `isValidVariableName` check on the field label.

**TS:** src/evaluator/values/impl.ts:652-661 ("impl receiverType, ... no longer accepts begin blocks"), impl.ts:662-672 ('impl fields must use ":". "::" and ":=" are not allowed here.'), impl.ts:684-691 ("Expected identifier for impl field name").

**Evidence:** impl.yo:2168-2170 `if((ast_expr_is_fn_call(field_expr) && !(ast_expr_is_fn_call_of(field_expr, BK_COLON,.Some(usize(2))))) && !(...BK_WHERE...), { // Non-colon FnCall: treat as trait constructor, extract its colon-pair args.`

### `yo-self/evaluator/values/impl.yo:2275` — conservative-fallback _(evaluator-values)_

**yo-self:** In the Case-3 (non-generic) field loop, a field whose evaluation produced no value falls back to `EvalValue.UnitVal` and is then registered into the trait-method registry and bound in the env as a real method.

**TS:** src/evaluator/values/impl.ts:712-717 — `if (!fieldValue) throw formatErrorMessage({ ... 'impl field "X" must be a compile-time value.' })`.

**Evidence:** impl.yo:2275 `method_val := match(fi.value,.Some(v) => v,.None => EvalValue.UnitVal);`

### `yo-self/evaluator/values/impl.yo:369-376` — partial _(evaluator-values)_

**yo-self:** For a VALUE-level forall param (`forall(U : usize)`) whose synthesizer binding is an `IntLit`, `_resolve_one_forall_binding` returns the variable's DECLARED TYPE (`usize`) as the "binding" instead of the value. There is no `valueSubstitutions` concept anywhere in yo-self's generic-impl path.

**TS:** src/evaluator/values/impl.ts:2456-2472 builds a separate `valueSubstitutions` map ("if forall(U : usize) and the value is 3 ... store it as 3 with type usize") and impl.ts:1433-1449 / 1595-1611 binds those values into the specialized env before re-evaluating the type and body.

**Evidence:** impl.yo:369-375 `// VALUE-level forall (forall(U : usize) array lengths) ... KNOWN GAP: method types that mention U in a LENGTH position would need a value substitution, which substitute() cannot express`

### `yo-self/evaluator/values/impl.yo:676` — conservative-fallback _(evaluator-values)_

**yo-self:** The where-clause satisfaction check is wrapped in `if(all_bound && is_some_type(entry.receiver_type_pattern), ...)` — it runs ONLY for blanket impls (bare type-variable receiver). Every specific-pattern generic impl's where-clauses are ignored during matching.

**TS:** src/evaluator/values/impl.ts:2333-2422 — TS iterates `impl.whereConstraints` unconditionally for every impl and returns `noMatch` when a constraint fails.

**Evidence:** impl.yo:666-675 `// Enforce where-clause constraints ONLY for BLANKET impls ... (TS enforces all where-clauses, but its predicate is complete; this scoping is the safe yo-self adaptation.)`

### `yo-self/evaluator/values/integer.yo:55-72` — hardcoded _(evaluator-values)_

**yo-self:** Integer literals are parsed with `parse_raw_int` (evaluator/utils.yo:1465), which returns `Option(i64)` — decimal via `String.parse_i64`, prefixed via `_parse_prefixed_int(..., i64 radix)`. There is no unsigned/bignum path.

**TS:** src/evaluator/values/integer.ts:70-89 — TS parses as `BigInt` for ComptimeInt, U64, I64, Usize and Isize ("to preserve precision") and only falls back to `parseInt` for the smaller tags.

**Evidence:** integer.yo:56 `parse_raw_int(tok.value)` / 72 `raw := parsed.to_string();`; utils.yo:1465 `parse_raw_int :: (fn(raw : String) -> Option(i64))`.

### `yo-self/emitter.yo:53` — partial _(root)_

**yo-self:** `_emitter_record_declared_temp` recognises a declaration ONLY via a literal `" = "` substring, and further requires exactly one space between the type and the name (`byte_at(ns-1) == ' '` and `byte_at(ns-2) != ' '`). A declaration with no initialiser (`T _yo_temp_5;`) or with a tab / multiple spaces is never recorded.

**TS:** src/emitter.ts:27 `DECL_RE = /[\w>*\]]\s+([A-Za-z_]\w*)\s*(?:=(?!=)|;)/` — matches `\s+` (any whitespace run) and accepts BOTH `=` (not `==`) and `;` as the terminator, so uninitialised declarations are recorded.

**Evidence:** emitter.yo:44-52 doc: "the drop-emission gate skips a `___drop` for any minted temp NOT in declared_c_var_names … otherwise leave their temps untracked → the gate wrongly skips their (live-RC) drops → LEAK." Code: emitter.yo:57 `eq_opt := line.index_of(String.from(" = "));` and emitter.yo:80-85 the single-space guards.

### `yo-self/env.yo:2253` — partial _(root)_

**yo-self:** `get_variables_needing_drop` skips any `SomeT` with an empty `required_trait_types` list, without ever consulting the resolved-concrete-type side table that yo-self already maintains.

**TS:** src/env.ts:2254-2260 — TS skips only when `isSomeType(varType) && !varType.resolvedConcreteType && varType.requiredTraits.length === 0`. A SomeType that HAS a resolved concrete type IS dropped.

**Evidence:** env.yo:2245-2252 doc: "Divergence from TS: yo-self's `SomeT` variant does not carry a `resolvedConcreteType` field … The equivalent fast path is to check `required_trait_types.len() > 0`". Code at env.yo:2290 `(rtt.len() == usize(0)) => false,`.

### `yo-self/env.yo:3170` — partial _(root)_

**yo-self:** The `Dyn` vtable-dispatch branch pulls the first same-named method out of every required trait, with NO object-safety filtering and without looking at the dyn wrapper's own Rc trait (`___drop`/`___dup`/`___dispose`), and with no first-parameter compatibility check.

**TS:** src/env.ts:2095-2145 (the dyn branch) plus src/env.ts:1413-1449 inside `filterMethodsByReceiverType`: for `isDynType(receiverType)` with `method.value === undefined`, TS SKIPS the method when the `Self` parameter is passed by value (not `isReferenceStructType` / `isDynType` / `isPtrType`, line 1428-1434) and when `typeContainsSelfTypeForDynamicDispatchCheck(returnType, method.type.SelfType)` (line 1440-1447).

**Evidence:** env.yo:3157-3169: "Skipped vs TS: - \"First, check the dyn object's own trait for its Rc methods (**_drop / _**dup / \_\_\_dispose).\" … - `areTypesCompatible` first-parameter filtering. yo-self's `are_types_compatible` lives in `types/compatibility.yo` which already imports `env.yo` (cycle); the call site handles the compatibility check post-lookup until that cycle is broken".

### `yo-self/env.yo:836` — partial _(root)_

**yo-self:** `add_variable_to_env` supports none of TS's four options and performs NO shadowing check. It always appends to the TOP frame with a freshly minted counter id.

**TS:** src/env.ts:599-689 `addVariableToEnv({ env, variable, deltaFrame, variableId, addToBeginBlockFrame, allowVariableShadowing })`. TS: (a) `deltaFrame` shifts the target frame level (used at src/evaluator/types/synthesizer.ts:478); (b) `variableId` lets the caller preserve identity across re-evaluations (src/codegen/async/state-machine.ts:551); (c) src/env.ts:644-660 THROWS `Variable "..." is already defined here (variable shadowing is not allowed)` unless `allowVariableShadowing` (~20 call sites across function.ts / helper.ts / trait.ts / impl.ts / anonymous-function.ts opt in); (d) src/env.ts:669-671 sets `id = variable.name` for temp variables and uses `addTempVariableToFrame`.

**Evidence:** env.yo:827-835 doc lists only "`id` and `frame_level` are filled in by `add_variable_to_env` itself" and "The Yo env is mutable, so `add_variable_to_env` mutates `env` in place … this is a deliberate divergence". The body (env.yo:848-885) has no `get_variables_from_env` shadowing probe and no frame-level parameter.

### `yo-self/expr.yo:422` — partial _(root)_

**yo-self:** `ast_expr_to_string`'s operator/dot branch has a `true =>` fall-through (line 479-492) for operator-callee calls with an arity other than 1 or infix-2. That path emits `${func_str}(${args})` WITHOUT the parenthesisation TS applies to an operator callee. The tuple branch also omits TS's `token.type === TokenType.Identifier` guard.

**TS:** src/expr.ts:1421-1435 — after the operator/dot special cases fall through, TS does `func = exprIsInfixOperatorFunctionCall(expr.func) || exprIsAtomAndOperator(expr.func) ? \`(${func})\` : func;` before `${func}(${args})`. src/expr.ts:1401-1403 guards the tuple case on `expr.func.token.type === TokenType.Identifier`.

**Evidence:** expr.yo:512-518 (the general branch) applies the paren wrap `cond((ast_expr_is_infix_op_fn_call(func_box) || ast_expr_is_atom_and_operator(func_box)) => \`(${func_str0})\`, ...)`, while the operator-callee branch at expr.yo:479-491 emits `\`${func_str}(${sb.to_string()})\`` with no such wrap.

### `yo-self/expr.yo:684` — conservative-fallback _(root)_

**yo-self:** `is_function_boundary_arrow` returns TRUE for ANY `->` / `=>` / `=>>` FnCall (and for `(fn|unsafe_fn|ctl|Fn)(...)->T` shapes). It has no access to `ExprInfo`, so it cannot distinguish an evaluated arrow that is NOT an anonymous-function definition.

**TS:** src/expr-traversal.ts:36-67. TS gates on `expr.$?.isAnonymousFunctionDefinition === true` (line 40), `isFunctionValue(expr.$.value)` (line 46), the fn-type-arrow syntax check (49-58), and `if (!expr.$) return true;` (64) — then `return false` (66). So an EVALUATED `->`/`=>` that is neither an anon-fn def nor a function value is NOT a boundary and IS recursed into. TS also matches only `["->", "=>"]` — never `=>>`.

**Evidence:** expr.yo:682-683 doc: "A simplified port: checks for `->`, `=>`, `=>>` operators, and the `(fn(...) -> T)({body})` pattern". Body at expr.yo:690-693 is purely `v == "->" || v == "=>" || v == "=>>"`.

### `yo-self/expr_traversal.yo:1` — partial _(root)_

**yo-self:** `all_paths_unwind` is not ported at all, and neither is the `deferGenericFnTypeCheckToAssignment` deferral that depends on it. `yo-self/evaluator/exprs/binding.yo:292` throws unconditionally for a runtime binding whose declared type is a generic function type.

**TS:** src/expr-traversal.ts:116-245 `allPathsUnwind` (handles begin / cond / match exhaustiveness / if / while / `__yo_panic`/`abort`/`unreachable`). Consumed at src/evaluator/exprs/assignment.ts:457 `const proven = lambdaBody ? allPathsUnwind(lambdaBody) : false;` which relaxes the 'Runtime variables with generic function types are not allowed' ban — the carve-out `Exception { throw : ctl(forall(ResumeType), ...) }` relies on. src/evaluator/exprs/binding.ts:156-164 shows the deferral flag.

**Evidence:** `grep -rn "all_paths_unwind" yo-self --include=*.yo` → no matches; `grep -rn "defer_generic_fn_type_check" yo-self --include=*.yo` → no matches. binding.yo:291-304 throws with no escape hatch.

### `yo-self/expr_traversal.yo:118` — partial _(root)_

**yo-self:** None of the four traversal helpers follow `macro_expansion`. They walk the raw pre-expansion AST only.

**TS:** src/expr-traversal.ts:124-126, 261-263, 322-324, 378-380, 444-446 — every traversal begins with `if (expr.$?.macroExpansion) return <self>(expr.$.macroExpansion);`, i.e. TS analyses the POST-expansion shape that codegen actually sees.

**Evidence:** expr_traversal.yo:114-117: "Mirrors `exprTreeContainsReturn` … The macro expansion case from TS is omitted — `ExprInfo.macro_expansion` lives in a side table (`ExprInfoTable`) and is not reachable from a raw `AstExpr`, so this helper is an AST-only baseline."

### `yo-self/expr_traversal.yo:196` — partial _(root)_

**yo-self:** `expr_contains_loop_terminator` uses a bare `ast_expr_is_fn_call_of(expr, "=>", .None)` boundary test (line 212) instead of calling `is_function_boundary_arrow` like its two siblings in the same file. It therefore does NOT skip `->` arrows, `fn(...) -> T` type arrows, or `(fn(...) -> T)({body})` function-value constructions.

**TS:** src/expr-traversal.ts:456 `if (isFunctionBoundaryArrow(expr)) return false;` plus src/expr-traversal.ts:459-474, the two additional `isTypeValue(expr.func.$.value) && isFunctionType(...)` / `typeImplementsFn(...)` callee skips.

**Evidence:** expr_traversal.yo:211-214: "// => is a function boundary: do not recurse into it" then `if(ast_expr_is_fn_call_of(expr, "=>",.None), { return(false); });` — while `evaluated_body_contains_unwind` (line 89) and `expr_tree_contains_return` (line 168) both call `is_function_boundary_arrow(e)`.

### `yo-self/function_value.yo:81` — partial _(root)_

**yo-self:** `ClosureCaptureInfo :: ref(struct(capture_type : TypeValue, frame_level : usize))` carries only two of the four fields TS's `ClosureInfo` has — `effectParamNames` and `consumedCaptures` are absent, and no side table replaces them.

**TS:** src/function-value.ts:170-195 `ClosureInfo { closureType, captureType, effectParamNames?, consumedCaptures? }`. TS documents `consumedCaptures` as "Captured field names that are consumed inside the closure body (passed to an own(self) parameter). Used by thread/worker spawn codegen to NULL these fields in the heap-copied capture struct after the closure runs, preventing double-free."

**Evidence:** function_value.yo:81 struct definition; yo-self/evaluator/calls/helper.yo:572-573: "NOTE: the own(self)-captured-variable tracking (`ctx.own_consumed_captures`, TS helper.ts:419-428) is deferred until a thread-spawn capture test needs it."

### `yo-self/main.yo:1413` — partial _(root)_

**yo-self:** `run_test` filters tests with `tname.contains(name_pattern)` (plain substring) and ignores `--parallel` entirely (parsed at main.yo:1372, never used). Test bodies are re-serialised through `ast_expr_to_string(tbody)` (main.yo:1415) with no evaluation first.

**TS:** src/test-runner.ts:1542-1544 `tests = tests.filter((test) => testNameRegex.test(test.name));` — a real RegExp. src/test-runner.ts:1565 uses `exprToString(test.bodyExpr.$?.originalExpr ?? test.bodyExpr)` — the original expr recovered AFTER evaluation. src/test-runner.ts also threads `testBatchSize` and parallel workers.

**Evidence:** main.yo:1413 `keep := if(name_pattern.len() > usize(0), tname.contains(name_pattern.clone()), true);`; main.yo:1344 "(--parallel accepted for CLI compatibility)".

### `yo-self/target.yo:162` — hardcoded _(root)_

**yo-self:** `detect_linux_abi :: (fn() -> Abi)(Abi.Gnu)` — a bare constant. musl detection is not performed.

**TS:** src/target.ts:118-130 `detectLinuxAbi()` reads `fs.readdirSync("/lib")` and returns `"musl"` when any entry starts with `ld-musl-`; falls back to `"gnu"` on error. Feeds `defaultAbi(os)` (src/target.ts:132-145) and thus the target triple.

**Evidence:** target.yo:157-161 doc: "Currently returns Abi.Gnu — musl detection via /lib filesystem reads requires synchronous I/O which is not yet available in yo-self's compile-time evaluation (Phase 1 tracker)." and target.yo:187 "Linux musl detection is deferred to Phase 1."

### `yo-self/utils.yo:40` — intentional-divergence _(root)_

**yo-self:** `generate_temp_variable_name_prefix` builds the module prefix from the FIRST 12 characters of the module path with non-alphanumerics replaced by `_`, instead of SHA-1(modulePath)[0..8]. For absolute paths every module in a project collapses to the same prefix (`__Users_yiyiw_temp_`), making `is_temp_variable_name(module_path, name)` effectively module-agnostic.

**TS:** src/utils.ts:51-53 `generateTempVariableNamePrefix` → `_${generateModuleId(modulePath)}_temp_` where `generateModuleId` (src/utils.ts:16-25) is `"yo" + sha1(modulePath).slice(0,8)`; src/utils.ts:64-69 `isTempVariableName` is a `startsWith` on that module-specific prefix.

**Evidence:** utils.yo:34-37 doc: "In TypeScript this uses the first 10 characters of SHA-1(modulePath). Here we use a simplified sanitisation: replace every non-alphanumeric character with `_` and take the first 12 bytes, which is unique enough for the yo-self bootstrap."

### `yo-self/value.yo:210` — partial _(root)_

**yo-self:** `eval_value_eq` diverges from TS in three ways: `.IntLit`/`.FloatLit` compare RAW TOKEN TEXT (`ar == br`) rather than numeric value; `.FuncVal(_, _) => false` unconditionally, even for the identical function; `.UnknownVal(aty)` compares only `are_types_compatible(aty, bty)` with no attempt to resolve either side from the env.

**TS:** src/value.ts:678-880 `areValuesEqual`. Identity short-circuit `if (value1 === value2) return true;` (line 691) covers FunctionValue. Numeric branch (line 721-733) normalises to BigInt so `1` == `0x1` == `1_000`≡`1000`. Unknown branch (line 839-880) first resolves BOTH via `getVariablesFromEnv(env, value.variableName)` and compares the RESOLVED concrete values; only if NEITHER resolves does it fall back to type compatibility, and if only ONE resolves it returns false.

**Evidence:** value.yo:217-218 `.IntLit(ar) => match(b,.IntLit(br) => (ar == br), _ => false)`; value.yo:260 `.FuncVal(_, _) => false,`; value.yo:520 `.UnknownVal(aty) => match(b,.UnknownVal(bty) => are_types_compatible(aty, bty), _ => false)`.

### `yo-self/types/compatibility.yo:112` — partial _(types)_

**yo-self:** Compatibility takes no `Environment`, so nothing in the file can consult where-clause constraints. Every SomeType constraint check reads only the SomeT's own `required_trait_types` / `negative_trait_types` lists.

**TS:** src/types/compatibility.ts:47-83 `getEffectiveRequiredTraitTypes` / `getEffectiveNegativeTraitTypes` merge `someType.requiredTraits` with `getWhereClauseConstraintsForSomeType(env, someType)`; these are used at compatibility.ts:718, :722, :746 and :809.

**Evidence:** `_compat_impl` signature at compatibility.yo:113-121 takes `(actual, expected, require_exact, visited)` only; the trait hook `g_compat_type_implements_trait_fn` (compatibility.yo:105) is env-free by construction — `compatibility.yo (types/) cannot import evaluator/ modules`.

### `yo-self/types/compatibility.yo:124` — intentional-divergence _(types)_

**yo-self:** The comptime*int widening fast path accepts `.Float(*)`and`.ComptimeFloat`as valid expected types for a`comptime_int` actual (compatibility.yo:135-136).

**TS:** src/types/compatibility.ts:148-168 — the accepted expected tags for a comptime_int given are exactly ComptimeInt, U8/I8/U16/I16/U32/I32/U64/I64, Usize, Isize and the C-compatible types. F32/F64/ComptimeFloat are NOT in the list; comptime_float widening is a separate rule (compatibility.ts:175-186) that only accepts a comptime_float given.

**Evidence:** compatibility.yo:134-137 `.Isize => true, .Float(_) => true, .ComptimeFloat => true,` inside the `is_comptime_int_type(actual)` branch.

### `yo-self/types/compatibility.yo:410` — intentional-divergence _(types)_

**yo-self:** The `.Tuple` arm rejects when field LABELS differ (`if(al != el, return(false))`), in both the exact and non-exact paths.

**TS:** src/types/compatibility.ts:242-266 — compares only field types and explicitly documents the opposite rule: `// QUESTION: Should we check the label here? // NOTE: We don't check labels, as the Tuple is a structural type, not a nominal type.`

**Evidence:** compatibility.yo:405-412 `al := match(alabels.get(i),…); el := match(elabels.get(i),…); if(al != el, { return(false); });` with no comment justifying the departure.

### `yo-self/types/compatibility.yo:714` — partial _(types)_

**yo-self:** TraitT-vs-TraitT compatibility is `(aname == ename)` — nominal by NAME. TS is nominal by `id`. yo-self also has no equivalent of TS's fallback that compares a TraitType against a `TypeHierarchyType` carrying `baseType.trait` (that pair is killed earlier by the blanket tag-mismatch guard at compatibility.yo:345).

**TS:** src/types/compatibility.ts:468-556 — `// NOTE: Trait type is now a NOMINAL type (compared by id).` then `if (expected.type.id === given.type.id) return true; return false;`, plus the TypeHierarchyType/`baseType.trait` fallback at :540-554.

**Evidence:** compatibility.yo:712-718 `// TraitT: nominal comparison; FnTraitT/FutureTraitT: structural` followed by `.TraitT(name : aname) => match(expected, .TraitT(name : ename) => (aname == ename), _ => false)`.

### `yo-self/types/creators.yo:427` — partial _(types)_

**yo-self:** `_patch_self_shell_guarded` (and its gate `_contains_self_shell`, creators.yo:347) walks only `.EnumT`, `.Struct`, `.Pointer`, `.Array` and `.ComptimeListT`. A `Self` shell reached through a `.Tuple` field, a `.Func` parameter/return, an `.IsoT`, a `.DynT` trait list, a `.FnTraitT` call signature, a `.FutureTraitT` output, or a `.SomeT` constraint list is neither detected nor patched — `_ => t` returns the type unchanged with the empty shell still embedded.

**TS:** No TS counterpart exists: TS mutates the single `Self` type object in place while the definition is being built, so every holder sees the finalized fields regardless of what container it sits behind (definitions are shared by identity).

**Evidence:** creators.yo:409-412 `Replace an empty-variant/empty-field \`Self\` shell … One-level rebuild over the standard type containers; the inserted \`final*ty\` itself still carries shells one level deeper — those resolve via the enum/struct-final registries at use sites`; the match in creators.yo:431-492 ends in `* => t`.

### `yo-self/types/env_lookup.yo:487` — partial _(types)_

**yo-self:** `convert_comptime_type_to_runtime_type_with_expected` drops TS's side effect: it never stamps the conversion onto the expression's `ExprInfo.converted_runtime_type`. yo-self has 53 call sites of the convert functions but only 12 references to `converted_runtime_type` in the whole tree. It also adds a divergent rule: when the expected type IS `comptime_str`, it returns the comptime type unchanged instead of converting to `str`.

**TS:** src/types/utils.ts:946-991 `convertComptimeTypeToRuntimeType({type, expectedType, expr, env})` — `if (convertedType && expr?.$) { expr.$.convertedRuntimeType = convertedType; }`, and the comptime_str branch only special-cases `*(u8)` / `*(char)`, otherwise always `createStrType(env)`.

**Evidence:** env_lookup.yo:483-486 `The TS-side \`expr\` parameter (which mutates \`expr.$.convertedRuntimeType\`) is not threaded through here — yo-self callers that need the side-table update will assign through \`ExprInfo.converted_runtime_type\` directly.`

### `yo-self/types/guards.yo:318` — partial _(types)_

**yo-self:** `is_function_type_and_returns_comptime_value` tests the return type STRUCTURALLY via `is_comptime_only_type_simple(result)` instead of reading the declared flag. `FuncMeta.result_is_comptime_only` exists (definitions.yo, used by declarations.yo's `_func_result_is_comptime_only`) and is not consulted.

**TS:** src/types/guards.ts:252-257 `isFunctionTypeAndReturnsComptimeValue` = `type.tag === Function && (type as FunctionType).return.isCompileTimeOnly` — the declared per-return flag, not a structural test.

**Evidence:** guards.yo:318-324, the body is `match(t, .Func({ result : r }) => is_comptime_only_type_simple(r), _ => false)`; `meta` is never bound.

### `yo-self/types/guards.yo:501` — partial _(types)_

**yo-self:** `is_function_type_generic` returns true when forall_labels OR implicit_labels are non-empty, or when any param is a `.SomeT`. Missing: the `return.isCompileTimeOnly → false` early-out, per-parameter `isCompileTimeOnly`, variadic `isCompileTimeOnly`/`isQuote`, and the `!typeImplementsFuture(p.type)` exclusion. Conversely it ADDS an `implicit_labels` test that TS's version does not have.

**TS:** src/types/guards.ts:457-481 `isFunctionTypeGeneric` — same three missing conditions; its `hasSomeTypeParams` is `!p.isCompileTimeOnly && isSomeType(p.type) && !typeImplementsFuture(p.type)`; it never inspects implicit parameters directly.

**Evidence:** guards.yo:496-500 `/// Partial Phase 2a implementation: detects forall parameters and implicit (using/effect) parameters …` `/// Phase 2b: extend to also check per-parameter isCompileTimeOnly flags, variadic isQuote flags, and non-Future SomeType parameters.`; guards.yo:508 `// Partial: check if any param is SomeT (Phase 2b: exclude Future SomeType)`.

### `yo-self/types/hierarchy.yo:133` — partial _(types)_

**yo-self:** Three separate divergences in `type_of_type_with_visited`: (1) the recursive-type cycle guard is keyed on the type's NAME and silently returns `TypeUni(0)` — yo-self struct/enum names are frequently `""`, so ANY empty-named aggregate nested inside another empty-named aggregate short-circuits without walking its fields; (2) TS THROWS "Recursive type has infinite size in field …" on the same condition; (3) `.FnTraitT` and `.FutureTraitT` are mapped to `TypeUni(1)` (hierarchy.yo:174-175); (4) reference-semantics struct/enum fields are recursed into rather than skipped.

**TS:** src/types/hierarchy.ts:60-105 `determineTypeUniverse` — `checkedTupleElements.includes(element)` throws `Recursive type has infinite size in field "…" / Insert some indirection`; `if (isReferenceStructType(type) || isReferenceEnumType(type)) continue;` skips ref fields; src/types/hierarchy.ts:144-147 `isFnTraitType(type) → createType0` with the comment "FnTraitType (closures) are level 0 types"; :190 `isFutureTraitType(type) → createType0`.

**Evidence:** hierarchy.yo:133 `_name_in_visited(visited, sname) => TypeValue.TypeUni(usize(0))` and :143 the same for enums; hierarchy.yo:10-12 `Cycle detection uses a \`visited_names\` list … This mirrors the TypeScript \`includes(element)\` check but uses name identity instead of reference identity.`

### `yo-self/types/string.yo:309` — approximation _(types)_

**yo-self:** `type_to_string_key :: (fn(t) -> String)(_tts(t, usize(36)))` — starts the renderer at depth 36 against a cap of 40 (string.yo:20), so it renders only 4 levels and then emits `…`. It is used as an identity key for the synthesizer's anti-circularity check.

**TS:** src/types/utils.ts:1210-1233 `typeToString` uses an id-keyed `visited` set with proper push/pop; the synthesizer's anti-circularity uses O(1) object identity (`checkedTypePairs`), never a rendered string.

**Evidence:** string.yo:302-308 `A cheap, shallow key for the synthesizer's anti-circularity check … For shallow types it's identical to \`type_to_string\`; only deep types are truncated. (TS uses O(1) object identity for \`checkedTypePairs\`; this is the value-semantic proxy.)`

### `yo-self/types/type_key.yo:251` — partial _(types)_

**yo-self:** In the `.EnumT` arm, `if(depth > usize(4), if(eid.len() > usize(0), eid.clone(), type_to_string(rs)), { …structural sig… })` — past depth 4 an enum is keyed by bare id, and an EMPTY-id enum by its NAME alone via `type_to_string`.

**TS:** No TS counterpart (TS keys C types by the unique `type.id`), so TS has no depth-dependent key at all.

**Evidence:** type_key.yo:249-251 `Only the DEPTH guard keeps the name-only shortcut (recursion bound); empty-id enums are leaf-shaped here (no id-keyed cycle guard), so the depth bound suffices.` — an assumption, not a proof, and false for an empty-id enum nested under a struct.

### `yo-self/types/utils.yo:292` — conservative-fallback _(types)_

**yo-self:** `type_implements_runtime` is the tag-only fast path with `.None → false`: every Struct, EnumT, Array, Tuple, Pointer, SomeT and TypeAppT is UNDECIDED at the tag level and therefore reported as NOT implementing Runtime. `type_is_comptime_only` (utils.yo:180) is the same shape. The env-aware versions exist as `type_is_comptime_only_full` / `type_is_runtime_only` in evaluator/trait_checking.yo but are not used at this predicate's call sites.

**TS:** src/types/utils.ts:113-125 `isComptimeOnlyType` / `isRuntimeOnlyType` = `typeImplementsComptime(type, env) && !typeImplementsRuntime(type, env)` — full env-driven trait resolution; src/evaluator/types/union.ts:87 gates union fields on `!typeImplementsRuntime(field.type, env)`.

**Evidence:** utils.yo:287-290 `/// Best-effort \`typeImplementsRuntime\`. Uses the tag fast path; for undecided cases it conservatively returns \`false\` (Phase 3 will consult the \`Runtime\` trait in \`env\`).`; utils.yo:236-238 `\`TStruct\` with reference semantics ("object types") would also return \`Some(true)\` in TS but we don't yet carry that flag`.

### `yo-self/types/utils.yo:315` — conservative-fallback _(types)_

**yo-self:** `_type_contains_rc_inner` guards recursion with `depth > u32(8) => false` instead of an identity-keyed visited set, and it omits TS's `type.isExtern → return false` early-out entirely (yo-self keeps extern-ness in the `g_extern_type_names` side table, which this function never consults).

**TS:** src/types/utils.ts:131-204 `typeContainsRcType(type, checkedTypes)` — object-identity `checkedTypes` set (never a depth cap, so nesting depth is unbounded), plus `if (type.isExtern) return false` at line 145.

**Evidence:** utils.yo:301-302 `/// Uses a depth limit instead of a checkedTypes set to prevent infinite recursion on self-referential types (e.g. recursive enums).`; utils.yo:314 `// Depth limit — conservative: return false at max depth`.

### `yo-self/types/utils.yo:526` — partial _(types)_

**yo-self:** `_type_is_control_bound_inner` has no `.SomeT` arm — it falls to `_ => false`. The comment justifying this ("SomeT carries no resolved concrete type in yo-self") is factually stale: `SomeT.resolved_concrete` exists (definitions.yo:287) and is read 20 lines earlier in this same file (utils.yo:414).

**TS:** src/types/utils.ts:269-275 `typeIsControlBound` case TypeTag.SomeType: `if (someType.resolvedConcreteType) return typeIsControlBound(someType.resolvedConcreteType, checkedTypes); return false;`

**Evidence:** utils.yo:525-527 `// SomeT carries no resolved concrete type in yo-self → conservatively` / `// false (mirrors TS returning false when \`resolvedConcreteType\` is unset).` — but TS only returns false when it is UNSET; when set it recurses.

### `yo-self/types/utils.yo:710` — conservative-fallback _(types)_

**yo-self:** `_type_refs_back_to_cyclic`'s `.SomeT` arm returns `true` unconditionally, and its `.DynT` arm (utils.yo:744) likewise. Neither follows `resolved_concrete`, and neither consults the Acyclic trait.

**TS:** src/types/compatibility-adjacent src/types/utils.ts:2085-2100 `typeCanFormCyclicRcReference` SomeType case — `if (typeImplementsAcyclic(type, env)) return false; if (type.resolvedConcreteType) return typeCanFormCyclicRcReference(type.resolvedConcreteType, …); else return true;`

**Evidence:** utils.yo:709-711 `// A SomeType could resolve to anything — be conservative (TS returns true when there is no \`resolvedConcreteType\`, which yo-self's \`SomeT\` lacks).`— the parenthetical is stale;`resolved_concrete` exists.

### `yo-self/types/utils.yo:852` — no-op _(types)_

**yo-self:** `type_requires_inference :: (fn(_ty : TypeValue) -> bool)(false);` — a bare constant, and it has NO caller anywhere in yo-self (only the export at utils.yo:1568). The stated justification — "yo-self Array length is always concretely known" — is false: `TypeValue.Array` carries a `length_var : String` field precisely for unresolved forall lengths.

**TS:** src/types/utils.ts:869-916 `typeRequiresInference` — for Array returns `isUnknownValue(arrayType.length) || typeRequiresInference(childType)`. Called at src/evaluator/builtins/the.ts:83 and src/evaluator/exprs/assignment.ts:373 to trigger length inference.

**Evidence:** utils.yo:844-851 `**Stub returning \`false\`\*\* — yo-self's \`Array(element, length)\` stores \`length\` as a plain \`usize\`, which is always concretely known … Once yo-self gains the same deferred-length mechanism this stub should walk \`Array.length\``; contradicted by definitions.yo:125-129 and evaluator/types/array.yo:239's call to `t_array_var`.

---

# LOW

### `yo-self/codegen/functions/declarations.yo:694` — partial _(codegen-core)_

**yo-self:** generate_function_declarations skips the async-runtime forward-declaration block entirely, because uses_async lives on FunctionGenerationContext while this function only receives the base CodeGenContext.

**TS:** src/codegen/functions/declarations.ts:90-97 — `if (context.usesAsync) { emitDeclarationLine('/// Async runtime functions'); emitDeclarationLine('static void __yo_async_spawn_task(void (*resume_fn)(void*), void* state_machine);'); }`

**Evidence:** declarations.yo:694-695 `// Async runtime forward declarations are gated on uses_async (deferred — corpus is synchronous; the flag lives on FunctionGenerationContext, not the base).`

### `yo-self/codegen/functions/generation.yo:541` — hardcoded _(codegen-core)_

**yo-self:** `generate_async_runtime(context.base.emitter, context.base.target_info, false, opts);` — the debug-async-await argument is hardcoded to `false` even though `context.base.debug_async_await` is populated from compile_module's parameter (codegen_c.yo:199).

**TS:** src/codegen/functions/generation.ts:447-450 — `generateAsyncRuntime(context.emitter, context.targetInfo, context.debugAsyncAwait, { ... })` threads the real flag.

**Evidence:** generation.yo:541 literal `false`; async/runtime.yo:25 `_debug_async_await : bool,` never referenced in the body.

### `yo-self/codegen/functions/generation.yo:714` — partial _(codegen-core)_

**yo-self:** generate_main_wrapper locates \_\_yo_user_main and proceeds; it never validates that main's return type is unit.

**TS:** src/codegen/functions/generation.ts:877-885 — `if (!returnsUnit) { throw new Error(\`main function must return unit, but it returns ${typeToString(returnType)} ... For exit codes, use 'exit(code)' from std/libc/stdlib.yo\`); }`

**Evidence:** generation.yo:714-747 goes straight from the \_\_yo_user_main lookup to `if(!(found), { return(); }); main_call_args := ...` with no return-type check.

### `yo-self/codegen/async/runtime.yo:41 and yo-self/codegen/async/runtime_io_common.yo:42` — deferred-todo _(codegen-exprs)_

**yo-self:** The WASM async-I/O runtime generator is unported; both entry points `__yo_panic("… WASM … is a Phase-5 follow-up (deferred)")`.

**TS:** src/codegen/async/runtime.ts and runtime-io-common.ts dispatch to a WASM branch that emits the WASM I/O runtime C.

**Evidence:** runtime.yo:8-9 header — "the WASM backend is deferred (its I/O generator is not yet ported), so that branch panics."

### `yo-self/codegen/exprs/atom.yo (tail, 690-736) — compare src/codegen/exprs/atom.ts:548-573` — partial _(codegen-exprs)_

**yo-self:** The `currentFunctionEntry.value.type.isClosure` fallback (used when `currentClosureCaptures` is unset) is absent; yo-self falls straight through to `_var_read_code`.

**TS:** src/codegen/exprs/atom.ts:549-573 — finds the current function entry by cName, and if its type `isClosure`, emits `((<closureCName>_capture*)closure_context->data)-><name>`.

**Evidence:** atom.yo:14-15 header — "The `value.type.isClosure` fallback closure-detection (Gap 2: FuncVal carries no TypeValue) is omitted."

### `yo-self/codegen/exprs/comptime_value.yo:82-101` — partial _(codegen-exprs)_

**yo-self:** `_c_string_literal` escapes only `"`, `\`, `\n`, `\t`, `\r`; every other byte is emitted raw, including control bytes 0x00-0x08, 0x0b, 0x0c, 0x0e-0x1f and 0x7f.

**TS:** src/codegen/exprs/comptime-value.ts:79, 91, 96 use `JSON.stringify(value.value)`, which escapes the full C0 control range as `\u00XX`.

**Evidence:** The cond chain in `_c_string_literal` has exactly five escape arms and `true => out.push_byte(b)`.

### `yo-self/codegen/exprs/generation.yo (no branch) — compare src/codegen/exprs/generation.ts:669-671` — partial _(codegen-exprs)_

**yo-self:** There is no dispatch branch for `__yo_thread_set_maximum_threads`; the call falls through to `generate_other_function_call`.

**TS:** src/codegen/exprs/generation.ts:669-671 routes it to `generateYoThreadSetMaximumThreads` (src/codegen/exprs/parallelism.ts:307-318), which emits `__yo_thread_set_maximum_threads(<numCode>)`.

**Evidence:** generation.yo:12 header — "…thread_set_maximum_threads (Phase 5 parallelism)" in the DEFERRED list; `grep 'thread_set_maximum' yo-self` matches only the emitted C runtime text in async/runtime_core.yo:250.

### `yo-self/evaluator/calls/helper.yo:251` — partial _(evaluator-calls)_

**yo-self:** generate_deferred_drop_expressions evaluates each `___drop(name)` with the caller's context unchanged (expected_type not cleared) and never threads the resulting env forward — `cur_env` is explicitly left unchanged across iterations.

**TS:** src/evaluator/calls/helper.ts:198-216 — evaluates with `context: { ...context, expectedType: undefined }` (comment: "\_\_\_drop returns unit, not whatever the outer context expects") and reassigns `finalEnv = evaluatedDropExpr.$.env`, throwing if the drop failed to evaluate.

**Evidence:** // Phase 3: env update from ExprInfo is skipped; cur_env stays unchanged.

### `yo-self/evaluator/calls/helper.yo:449` — partial _(evaluator-calls)_

**yo-self:** A `label : value` argument wrapper is stripped without validating the label: yo-self takes `colon_args.get(1)` and drops `colon_args.get(0)` entirely.

**TS:** src/evaluator/calls/helper.ts:268-300 — requires the label sub-expr to be an atom, rejects a labelled argument for a parameter with an empty label, and throws "Named argument is not supported…Expected label X…but got Y" on mismatch.

**Evidence:** if(ast_expr_is_fn_call_of(arg_expr_raw, ":", .Some(usize(2))), { colon_args := \_h_get_fn_call_args(arg_expr_raw); actual_arg = match(colon_args.get(usize(1)), ...); });

### `yo-self/evaluator/calls/index_trait.yo:80` — hardcoded _(evaluator-calls)_

**yo-self:** \_check_range_type classifies a range argument purely by struct-name prefix (`RangeInclusive…` / `Range…`) rather than resolving the std Range types and testing compatibility.

**TS:** src/evaluator/calls/index-trait.ts:745-774 — `getCachedRangeTypes(env, context)` then `areTypesCompatible({ type: rangeInclusiveType, env }, { type: argType, env })`, falling back to the non-inclusive Range type.

**Evidence:** /// Returns a `_RangeCheck` based on the struct type name heuristic.\n/// "RangeInclusive..." → { is_range: true, is_inclusive: true }

### `yo-self/evaluator/calls/pointer.yo:56` — partial _(evaluator-calls)_

**yo-self:** The argument of `*(T)` is evaluated with the ambient expected type; the pointer-unwrapping step is skipped.

**TS:** src/evaluator/calls/pointer.ts:30-40 — `if (expectedType && isPtrType(expectedType.type)) { expectedType = { ...expectedType, type: expectedType.type.childType }; }` before evaluating the argument.

**Evidence:** // TypeScript: if expectedType is a pointer type, pass the inner type as expected.\n// Phase 2am: expectedType modification skipped — simplified port.

### `yo-self/evaluator/context.yo:293` — deferred-todo _(evaluator-core)_

**yo-self:** `EvalContext.doc_comment_lookup : Option(HashMap(String, String))` is declared and initialized to `.None` (:358) and is READ by evaluator/types/field.yo:524 and copied by evaluator/calls/function_type.yo:194 — but it is never POPULATED anywhere in yo-self. There is no doc-comment extraction pass wired into either evaluator/index.yo or main.yo.

**TS:** src/evaluator/index.ts:172-201 — `const docExtractionResult = extractDocComments(this.tokens); const docCommentLookup = new Map<string,string>(); for (const assoc of docExtractionResult.declarations) { ... docCommentLookup.set(getDocCommentLookupKey({...}), assoc.comment.content); }` then passed into the context at :201. Consumed at src/evaluator/types/function.ts:741/2145, types/record.ts:415, types/trait.ts:873, types/field.ts:385/452, exprs/binding.ts (Variable.docComment).

**Evidence:** `grep -rn doc_comment_lookup yo-self --include=*.yo` (non-test): context.yo:293 (decl), context.yo:358 (`.None`), calls/function_type.yo:194 (copy), types/field.yo:524 (read). No writer.

### `yo-self/evaluator/module_loader.yo:1` — partial _(evaluator-core)_

**yo-self:** A minimal stand-in for TS's `ModuleManager`: a parallel-array path→ModuleVal cache plus an in-progress (`g_loading_keys`/`g_loading_envs`) registry. It has no dependency graph, no `delete_module` / `delete_module_and_dependents`, no extension-duplicate pruning, and `clear_module_cache` (:147) resets only its own arrays — it does not chain to the global-state resets TS's `clearAll` performs.

**TS:** src/module-manager.ts (458 lines) — `deleteModuleAndDependents` (:168/:181/:252 call `clearImplsFromModule`), `findExtensionDuplicates` (:311), `addDependency` (:285), and the reset at :260-266 (`this.loadingModules.clear(); clearAllGlobalImplState(); clearEnvContainingPrelude(); clearAllModuleCounters(); clearAllCachedTypes(); _clearPragmaRegistry();`). yo-self's `_clear_pragma_registry` exists (evaluator/memory_safety.yo:67) but nothing calls it.

**Evidence:** module*loader.yo:3-6 `yo-self has no equivalent of TypeScript's \`ModuleManager\` (\`src/module-manager.ts\`). For the \`check\` subcommand we still need \`ctx.load_module\` to return \_just* an imported file's exports ...`; :24-26 `This mirrors the _effect_ of TS's \`ModuleManager.loadModule\` (cache + per-module isolation) while keeping all effects at the orchestration layer.`

### `yo-self/evaluator/exprs/property_access.yo:1463` — intentional-divergence _(evaluator-exprs)_

**yo-self:** The module-value field-access path does not check whether the module is still loading before reporting a missing field.

**TS:** src/evaluator/exprs/property-access.ts consults `ModuleValue.isLoading` to give a circular-import-aware diagnostic rather than a plain 'field not found'.

**Evidence:** property_access.yo:1463 `// Phase 2: skip isLoading check (no such field in yo-self ModuleVal).`

### `yo-self/evaluator/exprs/while.yo:49` — hardcoded _(evaluator-exprs)_

**yo-self:** `MAX_COMPTIME_LOOP_ITERATIONS` is a fixed literal 10000 with no environment-variable override.

**TS:** src/evaluator/exprs/while.ts:34-35 reads `process.env["YO_MAX_COMPTIME_LOOP_ITERATIONS"]`, and the error text at :77 and :86 tells the user to set it.

**Evidence:** while.yo:49 `/// Phase 2 stub: fixed at 10000 (no YO_MAX_COMPTIME_LOOP_ITERATIONS env var).`

### `yo-self/evaluator/builtins/build.yo:694` — deferred-todo _(evaluator-misc)_

**yo-self:** `evaluate_yo_build_functions` validates and returns comptime types for the string-returning builtins (target_host / target_parse / option / dep_module) and returns UNIT for everything else (executable, static_library, shared_library, link, test, run, step, doc, dependency, module, add_import, add_cflags, …) without touching `BuildRegistry` and without any of TS's per-builtin arity/argument checks. The registry type + mutators above it are dead code.

**TS:** src/evaluator/builtins/build.ts:542-… — after the trial-evaluation early return it does `const registry = getBuildRegistry()` and each builtin extracts + validates its arguments (e.g. `__yo_build_executable expects at least 2 arguments`) and calls `registry.registerExecutable({...})` before returning unit.

**Evidence:** //! Part (3) is still a Phase 3 stub … "this handler validates arguments and returns each builtin's correct comptime TYPE (so a `build.yo` type-checks); it does not populate the `BuildRegistry`."

### `yo-self/evaluator/builtins/drop.yo:77` — intentional-divergence _(evaluator-misc)_

**yo-self:** `evaluate_drop` always takes the simple path (consume the variable, return unit). The tuple / array / SomeType / struct-`.___drop()` branches are absent, and unlike TS it does not error when the argument has no variable name — it just skips the consume.

**TS:** src/evaluator/builtins/drop.ts:129-355 — when `typeContainsRcType(concreteType)`: tuples rewrite to `begin(__yo_drop_tuple_element(v, i), …)`, arrays to `begin(__yo_drop_array_element(v, i), …)`, non-Future SomeTypes just consume, and everything else is rewritten to `(v).___drop()` (with a borrowed-receiver carve-out), each re-evaluated and spliced over the original node. Line 163 throws `Expected variable name as argument to "___drop"`.

**Evidence:** // For now, type_contains_rc_type() always returns false, so we always take // the simple path: consume the variable and return unit.

### `yo-self/evaluator/index.yo:287` — no-op _(evaluator-misc)_

**yo-self:** `clear_impls_from_module`, `clear_generic_impls_from_module`, `clear_all_global_impl_state` are all `)(())` no-ops, described as placeholders "until src/evaluator/values/impl.ts is ported" — but yo-self/evaluator/values/impl.yo IS ported (2100+ lines) with global impl registries, so the comment is stale and the registries are never cleared.

**TS:** src/evaluator/values/impl.ts — `clearImplsFromModule` / `clearGenericImplsFromModule` / `clearAllGlobalImplState` drop per-module impl registrations; called by the module manager on re-evaluation/LSP edits.

**Evidence:** /// No-op stub. Mirrors `clearImplsFromModule` in `src/evaluator/values/impl.ts`. clear_impls_from_module :: (fn(\_module_path : String) -> unit)(());

### `yo-self/evaluator/types/concrete_trait.yo:115` — hardcoded _(evaluator-types)_

**yo-self:** The Concrete trait's canonical id is built as `"concrete_module_" + type_to_string(concrete_ty)` rather than from the wrapped type's id.

**TS:** src/evaluator/types/concrete-trait.ts:79 — `concreteTraitType.id = `concrete*module*${concreteType.id}``uses the nominal type's unique`id`.

**Evidence:** `// yo-self does not yet have a uniform `type_id`accessor, so we use`type_to_string` as a stable identity proxy.`

### `yo-self/evaluator/types/enum.yo:568` — partial _(evaluator-types)_

**yo-self:** After collecting each variant's `-> recur(T…)` args, yo-self never validates that the arg COUNT matches the enclosing type constructor's comptime parameter count. The registration block at line 573-644 goes straight from `if(any_gadt, ...)` to `register_gadt_enum`.

**TS:** src/evaluator/types/enum.ts:354-368 — `if (context.isEvaluatingFunctionBodyOrAsyncBlock?.kind === "function-body") { const comptimeParams = fnType.parameters.filter(p => p.isCompileTimeOnly); if (comptimeParams.length !== gadtReturnTypeArgs.length) throw "GADT return type has N argument(s), but the type constructor has M type parameter(s)" }`

**Evidence:** the `while` loop ends at line 568 and the next statement is the `// GADT: record per-variant return-type args in the side-table` block — no count comparison in between

### `yo-self/evaluator/types/enum.yo:597` — intentional-divergence _(evaluator-types)_

**yo-self:** When deriving `typeConstructorArgs`, yo-self selects the constructor's type parameters with `is_type_0(p_ty)` — "declared type is the `Type` universe" — and counts `n_comptime` the same way (line 626).

**TS:** src/evaluator/types/enum.ts:381 — `const comptimeParams = fnType.parameters.filter((p) => p.isCompileTimeOnly);` filters on the COMPTIME flag, not on the parameter's type being `Type`. TS then registers only when `typeArgs.length === comptimeParams.length` (enum.ts:393).

**Evidence:** `// Comptime type param ≈ declared type is the `Type` universe.` followed by `if(is_type_0(p_ty), { … })`

### `yo-self/evaluator/types/synthesizer.yo:335` — partial _(evaluator-types)_

**yo-self:** When `_bind_some_type` updates an existing binding in place it rebuilds the `Variable` field-by-field but hardcodes the last two fields: `is_ref : false, is_parameter : false`, discarding whatever `old_var` carried.

**TS:** src/evaluator/types/synthesizer.ts:501-506 — `updateExistingVariable(expected.env, variable, { ...variable, value: [value] })` spreads the ENTIRE existing variable and changes only `value`; `isParameter` / ref-ness are preserved.

**Evidence:** `is_ref : false,` / `is_parameter : false` in the `new_var := Variable(...)` construction, while every other field is copied from `old_var`

### `yo-self/evaluator/types/union.yo:65` — intentional-divergence _(evaluator-types)_

**yo-self:** `union_id := `union\_${random_id(env_mut.module_path)}``— an eval-fresh id on EVERY evaluation, including module-level re-evaluation generations. struct.yo:79-83 and enum.yo deliberately use a DECLARATION-STABLE id at`ctx.ctfe_depth == 0` for exactly this reason.

**TS:** src/evaluator/types/union.ts:40 `createUnionType(env)` returns a fresh object, but TS's evaluator does not re-evaluate a module-level declaration into a distinct identity the way yo-self's value-semantics TypeValue does — struct.yo:74-78 documents the hazard: "re-evaluation generations of a module-level struct declaration share one identity; … the recorded tk2/Bucket hazard of the unconditional swap."

**Evidence:** `union_id := `union*${random_id(env_mut.module_path)}``with no`ctfe_depth`branch, versus struct.yo:79`struct_id := if(ctx.ctfe_depth == usize(0), `struct_decl*...`, `struct\_...`)`

### `yo-self/build_runner.yo:812` — no-op _(root)_

**yo-self:** `_parse_registry_from_json :: (fn(json : String) -> BuildRegistry)(BuildRegistry.new())` — the body is a bare constructor call that discards `json` entirely. Every `run_build` therefore executes against an EMPTY registry. Additionally `run_build`'s `--list-steps` path (line 887-891) `return(())`s before evaluating anything.

**TS:** src/build-runner.ts (1994 lines) evaluates `build.yo` through the real evaluator and reads the populated `BuildRegistry` — there is no JSON round-trip and no empty-registry path.

**Evidence:** build_runner.yo:810-814: "/// Parse a BuildRegistry from JSON produced by `yo-cli --serialize-registry`. /// TODO(phase-7): Implement using std/json once a Reader interface exists." followed by the constant body; build_runner.yo:888-890 "// TODO(phase-7): Replace with direct evaluator call." then `return(());`.

### `yo-self/env.yo:376` — conservative-fallback _(root)_

**yo-self:** `pop_frame` on an empty frame stack is a silent no-op rather than an error.

**TS:** src/env.ts:926-... `popEnvFrame`. TS's `addVariableToEnv` (src/env.ts:663-667) similarly throws `Frame at level ${frameLevel} does not exist in the environment.` rather than degrading silently; yo-self's `add_variable_to_env` returns `Option(Variable).None` (env.yo:851).

**Evidence:** env.yo:373-375: "/// Pop the innermost frame. Calling `pop_frame` on an empty stack is /// a no-op (Phase 2a doesn't yet have a panic API; the caller should /// check `frame_count` first when correctness matters)."

### `yo-self/error.yo:121` — partial _(root)_

**yo-self:** `format_error_message(token, error_message, is_assertion_error, kind)` has no `cause` parameter, so a wrapped underlying error's message is never appended.

**TS:** src/error.ts:117-145 `formatErrorMessage({ token, errorMessage, cause, isAssertionError, kind })` → `errorMessages + (cause?.message ? "\n" + cause.message : "")`.

**Evidence:** error.yo:121 signature `format_error_message :: (fn(token : Token, error_message : String, is_assertion_error : bool, kind : Option(ErrorKind)) -> YoError)` — four parameters, no `cause`.

### `yo-self/expr.yo:351` — conservative-fallback _(root)_

**yo-self:** `make_err_expr` returns an Atom with `ExprId` 0. It is used as the `.None` fallback in dozens of `match(args.get(i), .Some(a) => a, .None => make_err_expr())` sites across expr.yo, expr_traversal.yo, main.yo and the evaluator.

**TS:** TS has no equivalent — src/expr.ts indexes with `expr.args[i]!` (non-null assertion), so a missing arg is a hard TypeError rather than a silently substituted placeholder.

**Evidence:** expr.yo:350-364: "/// Build a placeholder Atom expression used as a fallback in error paths." `make_err_expr :: (fn() -> AstExpr)(.Atom(usize(0), Token(kind : TokenKind.Identifier, value : String.from("?"), ...)))`.

### `yo-self/main.yo:1606` — partial _(root)_

**yo-self:** The CLI dispatches only `compile`, `test`, `fmt`, `check`. Eleven TS subcommands have no entry point even though their implementation modules exist in yo-self (init.yo, fetch.yo, install_command.yo, build_runner.yo, cache.yo, version.yo, version_cache.yo, doc/).

**TS:** src/yo-cli.ts registers: compile (274), check (536), unsafe-report (620), public-safe-report (651), test (684), init (827), fetch (849), install (882), build (915), fmt (1027), doc (1070), cache (1128), lsp (1153), version (1169), skills (1298).

**Evidence:** main.yo:1615 `exn.throw(dyn(\`unknown subcommand '${subcmd}'. Usage: yo-self <compile|test|fmt|check> ...\`));`

### `yo-self/main.yo:991` — partial _(root)_

**yo-self:** `--allocator mimalloc` is honoured unconditionally (main.yo:1246 adds `vendor/mimalloc/src/static.c`). There is no wasm carve-out.

**TS:** src/codegen/index.ts:196-199 `const effectiveAllocator = requestedAllocator === "mimalloc" && !isWasm ? "mimalloc" : "libc";` with the comment "mimalloc isn't available on WASM (no malloc implementation strategy that fits the WASM target)."

**Evidence:** main.yo:1245-1248: "// Bundled mimalloc allocator (else libc): add static.c + its include path." `if(allocator == "mimalloc", { ... })` with no target predicate.

### `yo-self/utils.yo:20` — deferred-todo _(root)_

**yo-self:** `generate_module_id`, `reset_module_id_counter`, `generate_variale_id`, `hash_string`, `clear_all_module_counters` are not ported. `env.yo:50 generate_variable_id` is a substitute that ignores BOTH its `_module_path` and `_name` arguments and returns a bare decimal counter.

**TS:** src/utils.ts:16 `generateModuleId` (sha1), :46 `resetModuleIdCounter`, :76 `generateVarialeId` (moduleId + operator-index-sanitised name + collision suffix), :100 `hashString`, :106 `clearAllModuleCounters`.

**Evidence:** utils.yo:20-23: "Not yet ported from src/utils.ts: `generateModuleId`, `resetModuleIdCounter`, `generateVarialeId`, `hashString`, `clearAllModuleCounters`. These are deferred until their TS callers gain yo-self counterparts." env.yo:50-55 body: `local_c := g_var_id_counter; s := local_c.to_string(); ...`.

### `yo-self/value.yo:535` — partial _(root)_

**yo-self:** `value_to_string` renders `.ExprVal(_)` as the constant `"<expr>"`, `.UnknownVal(ty)` as `<unknown: T>`, `.FuncVal` as `<fn(params)>`, and `.StrLit(raw)` as raw text. Struct/enum/trait field labels that are operators are not parenthesised, and enum fields are printed without labels.

**TS:** src/value.ts:218-341 `valueToString`: `ValueTag.Expr` → `quote(${exprToString(value.value)})` (line 328); `ValueTag.Unknown` → `value.variableName` if set, else `<comptime ${typeToString(value.type)}>` (line 330-335); `ValueTag.Function` → `<fn ${funcName}>` / `<fn ${type.typeName}>` / `<fn>` (line 302-309); `ValueTag.ComptimeString` → `JSON.stringify(value.value)` (line 231); operator labels wrapped via `stringIsOperator(label)` → `(${label})` (lines 274-277, 291-294, 314-317); enum fields printed as `label: value`.

**Evidence:** value.yo:766 `.ExprVal(_) => String.from("<expr>"),`; value.yo:767-770 `.UnknownVal(ty) => { ts := type_to_string(ty); \`<unknown: ${ts}>\` }`.

### `yo-self/types/guards.yo:291` — hardcoded _(types)_

**yo-self:** `is_function_type_and_is_macro_function :: (fn(t : TypeValue) -> bool)(false);` — a bare constant. `FuncMeta` has no `result_is_unquote` field to read.

**TS:** src/types/guards.ts:246-250 `isFunctionTypeAndIsMacroFunction` = `type.tag === Function && (type as FunctionType).return.isUnquote`.

**Evidence:** guards.yo:290 `// Phase 2b: Func return type needs \`isUnquote\` flag.`

### `yo-self/types/hierarchy.yo:199` — deferred-todo _(types)_

**yo-self:** `getFunctionParameterToken` is not ported at all — only a comment marks its absence.

**TS:** src/types/hierarchy.ts:203-214 `getFunctionParameterToken(parameter)` — returns `parameter.exprs.labelExpr?.token ?? typeExpr?.token ?? defaultValueExpr?.token`, else throws.

**Evidence:** hierarchy.yo:199 `// get_function_parameter_token — TODO Phase 3: needs FunctionParameter.exprs (AST data)`; hierarchy.yo:16 `\`getFunctionParameterToken\` is deferred to Phase 3 (requires FunctionParameter.exprs).`

### `yo-self/types/intern.yo:127` — approximation _(types)_

**yo-self:** `type_intern_key` returns the constant `"~"` for any subtree deeper than 600, so two structurally different types that agree above depth 600 render the same key and `intern_type` canonicalizes them to ONE instance.

**TS:** No TS counterpart (TS memoizes only atomic types in src/types/creators.ts), but the divergence is against this module's own stated invariant.

**Evidence:** intern.yo:119-122 `type_intern_key — total, injective, recursion-safe structural key.`; intern.yo:126-128 `if(depth > usize(600), String.from("~"), …)`; intern.yo:22-25 `the key MUST NOT be coarser than codegen's type identity … else interning merges types codegen emits as distinct C types`.

### `yo-self/types/utils.yo:1257` — partial _(types)_

**yo-self:** `get_size_of_type`'s zero-size list covers Unit, ComptimeInt/Float/String, Void and TypeUni but omits `.ComptimeListT`, `.TraitT`, `.ExprT` and source-namespace structs (which instead take the ordinary Struct branch and get an aggregate size). Conversely `.Str` is given `2 × pointer bits` and `.Void` is given 0, where TS's chain has no Str or Void case and falls through to `return null`.

**TS:** src/types/utils.ts:1830-1898 `getSizeOfType` — returns 0 for `isUnitType || isTypeHierarchyType || isComptimeIntType || isComptimeFloatType || isComptimeStringType || isComptimeListType || isSourceNamespaceType || isTraitType || isExprType`; has no branch for Str or Void, so both reach the final `return null`.

**Evidence:** utils.yo:1270-1275 lists `.Unit/.ComptimeInt/.ComptimeFloat/.ComptimeString/.Void/.TypeUni => .Some(usize(0))`; utils.yo:1295 `.Str => .Some(usize(u32(2) * get_target_pointer_size_bits()))`; no `.ComptimeListT`/`.TraitT`/`.ExprT` arm exists before `_ => .None`.

---

# NONE-OBSERVABLE

### `yo-self/codegen/functions/constructors.yo:618` — intentional-divergence _(codegen-core)_

**yo-self:** generate_closure_constructor_functions has a body of `()`. Likewise generate_closure_constructor_declarations (declarations.yo:642) and generate_closure_vtable_declarations (declarations.yo:654).

**TS:** src/codegen/functions/generation.ts:3284-3290 `// No-op: Impl(Fn(...)) closures use concrete capture structs + direct calls. Dyn(Fn(...)) uses dyn constructors (generated elsewhere). void context;`; src/codegen/functions/declarations.ts:712-718 identical; declarations.ts:743-748 `// No static vtable instances - closures will create vtables dynamically`.

**Evidence:** constructors.yo:618-621 `No-op: Impl(Fn(...)) closures use concrete capture structs + direct calls, ... Faithful port of the TS no-op.`

### `yo-self/codegen/functions/declarations.yo:111` — intentional-divergence _(codegen-core)_

**yo-self:** get_evidence_parameters returns an empty ArrayList unconditionally; collect_evidence_from_record (:60) is fully implemented but never reached. This makes has_evidence in should_skip_function_codegen (:476) always false and adds no evidence params in generate_function_prototype.

**TS:** src/codegen/functions/declarations.ts:301-329 — getEvidenceParameters is likewise a no-op in TS: it iterates `expandImplicitParameters([] as FunctionParameter[])`, and expandImplicitParameters (declarations.ts:371-375) is `implicits.slice()` over a hardcoded empty array. Verified faithful.

**Evidence:** declarations.yo:104-110 `DIVERGENCE: TS hardcodes expandImplicitParameters([]) (the implicit-param expansion is currently a no-op ...), so this yields no evidence parameters.`

### `yo-self/codegen/functions/dyn.yo:160` — intentional-divergence _(codegen-core)_

**yo-self:** The dyn box constructor emits `box->header.traverse_fn = NULL; // TODO: Set if value contains GC types` on the needs_cycle_gc path.

**TS:** src/codegen/functions/dyn.ts:122-126 — byte-identical: `if (context.needsCycleGC) { emitter.emitLine(\` box->header.traverse_fn = NULL; // TODO: Set if value contains GC types\`); }`

**Evidence:** dyn.yo:160 matches src/codegen/functions/dyn.ts:124 character for character.

### `yo-self/codegen/utils/index.yo:13` — deferred-todo _(codegen-core)_

**yo-self:** The module header lists `isComptimeFunction` as DEFERRED ("yo-self FuncVal does not store the function's TypeValue; the return-comptime flag is reached via a func_id side-table (Gap 2)"), and codegen_c.yo:181-186 lists fixupDynImplKeys, generateDynBox\*, preRegisterAsyncBlockTypes, generateDeferredAsyncBlocks and module-level-var emission as DEFERRED.

**TS:** src/codegen/utils/index.ts:852-854 `isComptimeFunction(fv) { return fv.type.return.isCompileTimeOnly; }` — exactly what yo-self's \_func_result_is_comptime_only (declarations.yo:373) computes. And codegen_c.yo:256/257/271/289/293 now DO call fixup_dyn_impl_keys, generate_dyn_box_types, preregister_async_block_types, generate_deferred_async_blocks and emit_module_level_variable_declarations.

**Evidence:** utils/index.yo:13-15 vs declarations.yo:373-375; codegen_c.yo:181-186 vs the actual call sequence at codegen_c.yo:256-293.

### `yo-self/codegen/exprs/parallelism.yo:117-134 (_generate_spawn_wrapper)` — intentional-divergence _(codegen-exprs)_

**yo-self:** The wrapper's call to the closure passes only the runtime-param zero-inits; the `, NULL` evidence arguments TS appends are omitted, and the drop is not gated on `isStructType(captureType)`.

**TS:** src/codegen/exprs/parallelism.ts:40-47 builds `nullArgs` from `getEvidenceParameters(closureInfo.callType)`; 81-101 gates the drop on `isStructType(captureType)`.

**Evidence:** declarations.yo:104-110 — "DIVERGENCE: TS hardcodes `expandImplicitParameters([])` (the implicit-param expansion is currently a no-op…), so this yields no evidence parameters." Verified against declarations.ts:305.

### `yo-self/codegen/exprs/return.yo:535 and yo-self/codegen/exprs/generation.yo (generate_unwind, nested-escape branch)` — intentional-divergence _(codegen-exprs)_

**yo-self:** The ctl-handler resume machinery is unported: `generate_return` has no `continuation_variables` lookup and `generate_unwind` has no `hasDirectExit` branch (assign the outer handler's result var + `goto` its exit label).

**TS:** src/codegen/exprs/return.ts:489-529 and src/codegen/exprs/generation.ts:210-242 read `functionContext.continuationVariables.get("resume")` and emit `resumeInfo.directReturnVar = …; goto resumeInfo.directExitLabel;`.

**Evidence:** return.yo:535 `// (ctl-handler resume is Phase 5: FGC has no continuation_variables — omitted.)`; `grep -rn 'continuationVariables' src/` returns only context.ts:62 plus the two read sites.

### `yo-self/codegen/functions/declarations.yo:649-651 (and the absent generate_closure_dispose_functions)` — intentional-divergence _(codegen-exprs)_

**yo-self:** `generate_capture_dispose_function_declarations` has body `()`, and `compile_module` never calls a `generate_closure_dispose_functions` equivalent.

**TS:** src/codegen/functions/declarations.ts:729-736 and src/codegen/functions/generation.ts:3304-3380 both iterate `context.closureCaptureMap` to emit `__yo_dispose_closure_<id>` declarations and bodies; codegen-c.ts:265 calls the latter.

**Evidence:** declarations.yo:645-651 — "DEFERRED: driven by closureCaptureMap, which yo-self's context does not model yet … the map is empty for the corpus, so this emits nothing." Verified: `grep -rn 'closureCaptureMap' src/` shows construction + 3 reads, no writes.

### `yo-self/evaluator/calls/function.yo:2256` — intentional-divergence _(evaluator-calls)_

**yo-self:** The extern-wrapper dump mode (TS Phase C, `YO_EXTERN_WRAP_DUMP_FILE`) is not ported.

**TS:** src/evaluator/calls/function.ts — the YO_EXTERN_WRAP_DUMP_FILE debug side-channel that writes extern wrapper metadata to a file.

**Evidence:** // mode (TS Phase C, `YO_EXTERN_WRAP_DUMP_FILE`) is intentionally omitted

### `yo-self/evaluator/calls/record_type.yo:22` — intentional-divergence _(evaluator-calls)_

**yo-self:** ioBuiltin propagation from an extern function type onto a record field type is omitted; yo-self instead detects io builtins structurally by call shape (calls/helper.yo:479-485, evaluator/async/await_analysis.yo).

**TS:** src/evaluator/calls/record-type.ts:208-212 (`if (argType.ioBuiltin) { sourceNamespaceType.fields[i].type.ioBuiltin = argType.ioBuiltin }`) and src/evaluator/calls/type.ts:180-183 (the same for struct fields).

**Evidence:** //! - `isFunctionValue` / `specializedType` / `ioBuiltin` propagation omitted (codegen deferred).

### `yo-self/evaluator/eval.yo:1` — intentional-divergence _(evaluator-core)_

**yo-self:** A 370 KB parallel 'proto-evaluator' with its own giant `evaluate` dispatch and its own reduced handlers, containing many genuine stubs: `trait(...)` returns an empty `TraitT` (:5027-5029), macro expansion unsupported (:6995), `size_of`/`align_of` return a placeholder int (:7565), `HashMap(K,V)` is a type-constructor placeholder (:7573), function definitions do 'no type checking, just captures env' (:7654), `ArrayList` placeholder returns an empty ArrayVal (:1381).

**TS:** none found — src/ has no counterpart; src/ dispatches through `src/evaluator/exprs/*.ts` from the start. The corresponding real handlers in yo-self are `evaluator/exprs/*.yo` (23 files), which ARE the live path.

**Evidence:** eval.yo:3-21 `**Structural mapping vs src/**: this file is the yo-self bootstrap proto-evaluator. \`evaluator/index.yo\` ... now drives the REAL module evaluator ... \`evaluate_module_body\` here remains only as a legacy entry point used directly by a few \`yo-self/tests\` files ... this file is an **acceptable divergence (bootstrap-specific)**`

### `yo-self/evaluator/index.yo:19` — intentional-divergence _(evaluator-core)_

**yo-self:** Module header declares two omissions from the `src/evaluator/index.ts` port: doc-comment extraction, and `allowPartialModule` / `registerPartialModule` (which TS threads from ModuleManager into the Evaluator so a circular import can observe a partially-populated module). yo-self replaces the latter with a live-env read (module_loader.yo `loading_env`).

**TS:** src/evaluator/index.ts:196-205 — `evaluateAnonymousModuleBeginExprs({ ..., allowPartialModule: this.allowPartialModule, registerPartialModule: this.registerPartialModule })`; wired from src/module-manager.ts:326-329 where `registerPartialModule` writes into `loadingModules`, read back at module-manager.ts:298-305 to answer a circular import.

**Evidence:** index.yo:19-21 `Phase 2i: Structural port using the proto-evaluator (\`eval.yo\`) as the evaluation backend. Stubs for: impl registry cleanup, doc-comment extraction. \`allowPartialModule\` / \`registerPartialModule\` are not supported by the proto-evaluator and are omitted.`

### `yo-self/evaluator/index.yo:287` — no-op _(evaluator-core)_

**yo-self:** Three exported impl-registry cleanup entry points are bare no-ops: `clear_impls_from_module :: (fn(_module_path : String) -> unit)(())`, `clear_generic_impls_from_module` (:289), `clear_all_global_impl_state` (:291).

**TS:** src/evaluator/values/impl.ts:2753-2769 — `clearImplsFromModule` filters every registered trait's `fields` by `sourceModulePath`, deletes the module's `implRegistry` entry, and calls `clearImplRecordsFromModule`. `clearAllGlobalImplState` is invoked from src/module-manager.ts:262 alongside `clearEnvContainingPrelude()`, `clearAllModuleCounters()`, `clearAllCachedTypes()`, `_clearPragmaRegistry()`.

**Evidence:** index.yo:283-285 `// These will clear global impl state when \`src/evaluator/values/impl.ts\` is ported. Until then they are no-ops that callers (e.g. module-manager) can safely call.`

### `yo-self/evaluator/memory_safety.yo:11` — intentional-divergence _(evaluator-core)_

**yo-self:** `recordExternCallSite` is not ported. Everything else in the file (`register_file_pragma`, `file_has_pragma`, `_clear_pragma_registry`, `_clear_pragma_for_module`, `is_implicitly_unsafe_capable_file`, `is_auto_generated_expansion`) is a faithful 1:1 port, verified line-by-line against the TS.

**TS:** src/evaluator/memory-safety.ts:116-147 — a Phase-C migration helper that accumulates unwrapped extern call sites and, gated on the `YO_EXTERN_WRAP_DUMP_FILE` env var, flushes them to JSON from a `process.on("exit")` hook.

**Evidence:** memory_safety.yo:11-16 `Not yet ported from \`src/evaluator/memory-safety.ts\`: \* \`record_extern_call_site\` — a Phase-C migration helper that writes a JSON worklist on \`process.on("exit")\` ... it is not needed for evaluator correctness, so it is deferred.`

### `yo-self/evaluator/trait_checking.yo:34` — intentional-divergence _(evaluator-core)_

**yo-self:** `is_dyn_type` and `is_type_hierarchy_type` are imported from ../types/guards.yo and never used in the file. I checked the corresponding TS branch these would implement — `typeImplementsComptimeBuiltin`'s trailing `if (isTypeHierarchyType(type)) return true;` — and yo-self already covers it structurally via the `.TypeUni(_) => Option(bool).Some(true)` arm (:317), since `is_type_hierarchy_type` is exactly `match(t, .TypeUni(_) => true, _ => false)` (yo-self/types/guards.yo:329). Likewise step 5's `isDynType` is expressed as a `.DynT(...)` match arm.

**TS:** src/evaluator/trait-checking.ts:154-156 (`if (isTypeHierarchyType(type)) { return true; }`) and :493 (`if (isDynType(targetType))`).

**Evidence:** trait_checking.yo:33-35 imports `is_fn_trait_type, is_future_trait_type, is_dyn_type, is_type_hierarchy_type`; `grep -n 'is_type_hierarchy_type\|is_dyn_type' trait_checking.yo` returns only lines 34 and 35.

### `yo-self/evaluator/exprs/begin.yo:5` — intentional-divergence _(evaluator-exprs)_

**yo-self:** The module header lists six passes as 'stubbed as no-ops' that are in fact implemented: `type_contains_rc_type` (real, yo-self/types/utils.yo, used at begin.yo:686/1026/1062/1269), `generate_deferred_drop_expressions` (yo-self/evaluator/calls/helper.yo:251), `get_variables_needing_drop` (yo-self/env.yo:2253), `collect_dup_calls_conservatively` (begin.yo:509), `consume_case_body_temp_var` (yo-self/evaluator/utils.yo:764), and the OPTIMIZE_DUP_AND_DROP_PAIRS block (begin.yo:934-1220). The same staleness affects assignment.yo:10-14 (clone_value / attach_temp_variable_to_expr / ownership tracking — all now real) and initialization_assignment.yo:11-16.

**TS:** none found — this is a documentation-accuracy defect, not a behaviour divergence.

**Evidence:** begin.yo:5-11 `Complex optimization passes are stubbed as no-ops: - OPTIMIZE_DUP_AND_DROP_PAIRS block — no-op (type_contains_rc_type = false) - generateDeferredDropExpressions — returns empty list - getVariablesNeedingDrop — returns empty list ...` vs begin.yo:1026 which calls `type_contains_rc_type(cv.ty)` inside a live OPTIMIZE_DUP_AND_DROP_PAIRS port.

### `yo-self/evaluator/exprs/exists.yo:33` — intentional-divergence _(evaluator-exprs)_

**yo-self:** `evaluate_exists` unconditionally throws 'evaluate_exists: not yet implemented (Phase 2 stub)'.

**TS:** src/evaluator/exprs/exists.ts — the entire file is inside a `/* ... */` block; src/evaluator/exprs/\_expr.ts:1344-1348 shows the dispatch arm for `BuiltinKeywords.Exists` is likewise commented out.

**Evidence:** exists.yo:5-9 `The TypeScript source (exists.ts) has its entire implementation commented out as a class method in the legacy evaluator class.  The feature is therefore **not yet active** in the reference implementation.`

### `yo-self/evaluator/builtins/comptime_expect_error.yo:9` — intentional-divergence _(evaluator-misc)_

**yo-self:** The module header states the inner exception handler is disabled and that the builtin "currently panics when the inner expression evaluates without error" — this is STALE. The body (lines 42-52, 130, 194) implements the local-unwinding `Exception` catch and throws a proper formatted error.

**TS:** src/evaluator/builtins/comptime-expect-error.ts:20-42 — clones the arg, try/catches the evaluation, throws `Expected compile error, but the expression was evaluated successfully` otherwise; yo-self matches this behaviour today.

**Evidence:** //! Phase 3 note: The inner exception handler (given/unwind pattern) is temporarily disabled … The `comptime_expect_error` builtin therefore currently panics

### `yo-self/evaluator/builtins/consume.yo:96` — intentional-divergence _(evaluator-misc)_

**yo-self:** `set_variable_as_consumed` mutates the env Variable in place instead of TS's copy-then-write-back.

**TS:** src/expr.ts:2369-2440 `setExprAsConsumed` — `{...variable, consumedAtToken}` + `updateExistingVariable` returning a new Environment.

**Evidence:** // TS needs the write-back because its `{...variable}` spread makes a COPY; the alias-then-scan port of that was a pure no-op that dominated evaluation

### `yo-self/evaluator/builtins/var_fns.yo:57` — no-op _(evaluator-misc)_

**yo-self:** `evaluate_yo_var_print_info` evaluates its argument and returns unit without printing anything.

**TS:** src/evaluator/builtins/var-fns.ts:38-45 — looks the variable up and `console.log(getVariableInfo(variable))`.

**Evidence:** // Note: debug printing of variable info is a no-op in the self-hosted compiler. // The TS version calls console.log(getVariableInfo(variable)).

### `yo-self/evaluator/effects/effect_analysis.yo:781` — intentional-divergence _(evaluator-misc)_

**yo-self:** The whole effects module is live-looking but DEAD and stale: `analyze_effect_call_points` has no caller anywhere in yo-self (only tests import it), and yo-self implements a full 123-line `is_transitive_effect_call_` (line 415) plus `has_effect_in_spread_` (line 332) — code paths TS deleted.

**TS:** src/evaluator/effects/effect-analysis.ts:253-263 — `isTransitiveEffectCall` is itself a documented no-op (`Post-EXPLICIT_EFFECTS: functions have no implicit parameters … return undefined`), `hasEffectInSpread` no longer exists anywhere in src/, and the only caller (src/evaluator/calls/helper.ts:2499) iterates `effectCtlParams`, which is never pushed to.

**Evidence:** //! \* `hasEffectInSpread` — yo-self `SomeT` has no `isEffectsRow` flag … The `get_value_of_some_type_from_env` fallback is omitted (mirrors a TS function that no longer exists)

### `yo-self/evaluator/memory_safety.yo:11` — intentional-divergence _(evaluator-misc)_

**yo-self:** `record_extern_call_site` is not ported.

**TS:** src/evaluator/memory-safety.ts:135 `recordExternCallSite` — accumulates extern call sites and writes a JSON worklist on `process.on("exit")`, gated on `YO_EXTERN_WRAP_DUMP_FILE`.

**Evidence:** //! \* `record_extern_call_site` — a Phase-C migration helper … yo-self has no process-exit hook and it is not needed for evaluator correctness, so it is deferred.

### `yo-self/evaluator/utils/closure.yo:220` — deferred-todo _(evaluator-misc)_

**yo-self:** The explicit-capture-type branch of `create_capture_type_and_value` returns `capture_type: None, capture_value: None` instead of validating and using the expected struct.

**TS:** src/evaluator/utils/closure.ts:271-337 — validates that every captured var is a field, every field is captured, and the types are compatible, then builds the struct value.

**Evidence:** // Explicit capture type — deferred to Phase 4. // For now return None capture (will be refined).

### `yo-self/evaluator/types/proofs.yo:11` — intentional-divergence _(evaluator-types)_

**yo-self:** The file contains only a module doc comment and `pragma(Pragma.AllowUnsafe);` — no code at all.

**TS:** src/evaluator/types/proofs.ts:1-32 — the entire `evaluateProofAssumptions` helper is inside a `/* … */` block comment and was never wired into the dispatcher; the live file exports nothing.

**Evidence:** //! Status: stub. The TS file contains a single commented-out helper (`evaluateProofAssumptions`) that was never wired into the dispatcher.

### `yo-self/evaluator/types/validation.yo:13` — intentional-divergence _(evaluator-types)_

**yo-self:** The file contains only a module doc comment and `pragma(Pragma.AllowUnsafe);` — no code at all. `validate_dispose_function` does not exist.

**TS:** src/evaluator/types/validation.ts:14-42 — `validateDisposeFunction(moduleElement, token)` checks that a `dispose` field is a function type with exactly 1 parameter, 0 forall parameters, and a `unit` return, throwing otherwise. A repo-wide grep confirms nothing in the production TS evaluator calls it.

**Evidence:** //! Status: stub. … Nothing in the production TS evaluator currently calls it (the dispose-signature check is enforced elsewhere).

### `yo-self/evaluator/values/generic_impl_registry.yo:1-441` — intentional-divergence _(evaluator-values)_

**yo-self:** The entire file is DEAD — it was folded into impl.yo (impl.yo:143-160 says so) and nothing imports it (`grep -rn generic_impl_registry yo-self --include=*.yo` finds only three comment mentions, none an import). It still holds the OLD simplified implementations: `find_methods_from_generic_impls` with no specialization at all (returns the raw ftype/fvalue, no `source_trait_id`, no `_inject_forall_captures`), and a `try_match_generic_impl` with no where-clause check, no `_bind_forall_from_type_args` fallback and no root-shape prefilter.

**TS:** src/evaluator/values/impl.ts:1273 (`findMethodsFromGenericImpls`) and impl.ts:2212 (`tryMatchGenericImpl`) — the live behaviour these older copies pre-date.

**Evidence:** generic_impl_registry.yo:16-17 `//! Phase 3.5: Basic matching via synthesize_types. Where-clause checking and find_methods_from_generic_impls are present as simplified implementations.` and 353-354 `/// Simplified port of findMethodsFromGenericImpls — no specialization, just returns the original type/value for the field.`

### `yo-self/emitter.yo:305` — intentional-divergence _(root)_

**yo-self:** `Emitter.print` concatenates `headers + "\n" + declarations + "\n" + code` without trimming the code section.

**TS:** src/emitter.ts:57-59 `return this.headers + "\n" + this.declarations + "\n" + this.code.trim();`

**Evidence:** emitter.yo:305-313 body: `result.push_string(self.headers); result.push_str("\n"); result.push_string(self.declarations); result.push_str("\n"); result.push_string(self.code); result`.

### `yo-self/env.yo:1211` — intentional-divergence _(root)_

**yo-self:** `get_variable_info` deliberately omits the type and value rendering TS includes, printing only id/name/flags.

**TS:** src/env.ts:1010-1040 `getVariableInfo(variable)` builds the object literal including `type: typeToString(variable.type)` and the value rendering.

**Evidence:** env.yo:1204-1210: "NOTE: This slim form omits the type/value rendering present in the TS variant. Calling `type_to_string(v.ty)` and `value_to_string(...)` from inside the template-string interpolations below triggers a 10x compile-time regression in the TS reference evaluator (issues/ts-evaluator-slow-compile-of-nested-tostring-calls.md)."

### `yo-self/formatter.yo:9` — intentional-divergence _(root)_

**yo-self:** The module header still claims the main pipeline is stubbed, but `format_yo_source` (line 1484) is fully implemented: it tokenises, filters whitespace, precomputes inline-curly / redundant-paren / multiline index sets, and runs the emit loop.

**TS:** src/formatter.ts:1-1334 `formatYoSource`. Spot-checked helpers match: `IGNORED_FORMAT_DIRS` (src/formatter.ts:33-39) vs `is_ignored_format_dir` (formatter.yo:74-83) are identical sets.

**Evidence:** formatter.yo:9-11: "Status (Phase A.10): foundations + small helpers. The main `format_yo_source` pipeline is stubbed (returns the input unchanged) and will be filled in by successive commits." — contradicted by the 800-line implementation at formatter.yo:1484-2320.

### `yo-self/install_command.yo:573` — conservative-fallback _(root)_

**yo-self:** `_print_add_import_guidance` hardcodes `build_exists_sync := true` and unconditionally prints the 'add deps.yo to build.yo' guidance instead of reading build.yo to check whether the import is already present.

**TS:** src/install-command.ts — the TS flow reads the build file and only prints guidance when the `deps.yo` import is missing.

**Evidence:** install_command.yo:574-577: `build_exists_sync := true; // build_path was verified above` then "// Read build.yo synchronously would require Io — skip check and always print guidance. // (In practice the user already has deps.yo wired if they ran install before.)"

### `yo-self/main.yo:180` — hardcoded _(root)_

**yo-self:** `module_id_from_path :: (fn(path : String) -> String)(String.from("yo_module"))` — a hardcoded constant that ignores `path`. It has no callers.

**TS:** src/utils.ts:16-25 `generateModuleId(modulePath)` → `"yo" + sha1(modulePath).slice(0,8)`.

**Evidence:** main.yo:178-182: "/// Derive a simple module ID string from a file path String. /// For Phase 5a/5b: returns a fixed safe C identifier — sufficient for compilation." then `// path reserved for future use (filename stem extraction)` / `String.from("yo_module")`.

### `yo-self/main.yo:321` — deferred-todo _(root)_

**yo-self:** `collect_module_deps` — a ~110-line ad-hoc DFS import resolver with a `std/` skip whose behaviour depends on whether `std_base` is empty — is dead. The real path goes through `yo-self/evaluator/module_loader.yo` / `evaluator/exprs/import.yo`.

**TS:** src/module-manager.ts (458 lines) is the TS module resolution/compilation driver; main.yo has no port of it and the DFS here is not it.

**Evidence:** main.yo:302-303 header "// Phase 5g: import resolution helpers"; main.yo:332-335 "// Standard library imports: when std_base is empty, skip (legacy behavior — codegen handles std symbols via the C preamble)."

### `yo-self/utils.yo:94` — intentional-divergence _(root)_

**yo-self:** `random_id :: (fn(_module_path : String) -> String)` ignores its `module_path` argument and returns `yo_id_<global counter>`; the counter is process-global rather than per-module, and there is no `reset_module_id_counter`.

**TS:** src/utils.ts:37-49 `randomId(modulePath)` returns `${generateModuleId(modulePath)}_id_${counter}` with a PER-MODULE counter in `moduleIdCounters`, resettable via `resetModuleIdCounter` (src/utils.ts:46).

**Evidence:** utils.yo:87-89 doc: "Note: We use a single global counter (not per-module) for simplicity. The resulting IDs are globally unique and will not satisfy `is_temp_variable_name` (they start with `yo_id_`, not `_…_temp_`)."

### `yo-self/types/type_key.yo:1` — intentional-divergence _(types)_

**yo-self:** The whole `type_key` / `g_struct_cfid_keys` / `g_enum_sig_keys` cluster is a yo-self-only mechanism with no TS analogue: it reconstructs C-type identity structurally (constructor_func_id + type_arguments for structs, variant-name/discriminant/field signature for value enums) because yo-self's evaluator mints fresh ids per generic instantiation while TS unifies them through the comptime-fn cache.

**TS:** src/codegen/functions/collection.ts:805 — TS keys the codegen type registry directly by the unique `type.id`; there is no structural key.

**Evidence:** type_key.yo:22-25 `TS avoids this entirely: its eval unifies the ids via the comptime-fn cache and codegen keys the registry by \`type.id\` (collection.ts:805). yo-self's eval mints fresh ids per instantiation (same divergence the struct cfid scheme already compensates for), so we dedup at codegen here`.

### `yo-self/types/utils.yo:759` — intentional-divergence _(types)_

**yo-self:** `can_type_form_rc_cycle` omits TS's `typeImplementsAcyclic(type, env)` short-circuit, because the codegen call sites carry no `Environment` and yo-self's `TypeValue` has no `env` field.

**TS:** src/types/utils.ts:1959-1961 `if (typeImplementsAcyclic(type, env)) return false;` and the SomeType Acyclic check at :2087-2089.

**Evidence:** utils.yo:751-758 `EXCEPT the \`typeImplementsAcyclic\` short-circuit: that needs an \`Environment\` … Omitting it is conservative (an explicitly-\`Acyclic\`-marked but structurally-cyclic type is still GC-tracked — safe, just not optimized away) and keeps the evaluator and codegen call sites consistent.`
