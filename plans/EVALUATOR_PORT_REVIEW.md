# Evaluator port review — TS `src/evaluator/` → yo-self `yo-self/evaluator/`

## Status summary (2026-06-10)

**The `check`-observable surface is DONE and fully green:** `check ./std`
151/151 · per-file `check ./tests` **170/170 (zero failures)** · `check
./yo-self` 285/285. Every test that was red at any point in the port is now
closed, including the final def-eval-era gates (flowability ×4,
extern_unsafe_wrap, sync/mutex, algebraic_effects — see
`BOOTSTRAPPING_EVALUATOR.md`).

**"Fully ported" ≠ "fully green":** the remaining known divergences are
inventoried below (re-verified 2026-06-10). None is observable under `check`
today; each either needs a runtime/codegen milestone to be exercisable or is a
documented re-sync/feature item:

1. `builtins/impl_constraint.yo` — `Concrete(T)` extraction + single-Concrete
   gate deferred (`is_concrete_trait_type` stub returns false).
2. `builtins/rc_fns.yo` — `iso_extract` returns `Option(T)`; TS Phase-H
   returns `T`.
3. `builtins/type_fns.yo` — `get_info` lacks Function/Trait/Dyn/SomeType
   variants (SomeType → UnknownValue).
4. `calls/function.yo` — ModuleT/Call overload dispatch is PARTIAL:
   `_try_expand_call_overload` (the source-namespace `Call` candidate trial)
   is landed, but general prelude operator-module dispatch still relies on the
   literal-negation fold special case (see the in-file comment).
5. `effects/effect_analysis.yo` (885L) vs current TS (263L) — yo-self carries
   a richer pre-refactor version (full `has_effect_in_spread_` + transitive
   detection); needs a re-sync audit against the slimmed TS.
6. GADT **match-refinement** (match.ts `getGadtRefinedExpectedType` etc.) —
   construction is ported; refinement lives in fn bodies and is deferred to
   the codegen-selfhost milestone (the first point it can be exercised).
7. HKT partial application (`Result(_, i32)`) + TypeApplication substitution
   resolution — masked by test trial-eval swallowing; codegen-selfhost item.
8. Where-clause full enforcement beyond marker×concrete —
   `issues/yo-self-where-clause-full-enforcement.md` (two
   `type_implements_trait` gaps documented with the widening path).
9. `values/anonymous_function.yo` header simplifications —
   substituteSomeTypesFromEnv, await analysis, `checkDeferredGenericReturnType`
   for deferred generic bodies, body-vs-return compatibility check.
10. Comptime arithmetic **value folding** Tier 2 —
    `plans/COMPTIME_ARITHMETIC_FOLDING.md`.
11. Documented module-organization deferrals: `ctfe/ctfe_analysis.yo` (logic
    inline in comptime_fn/function), `exprs/_expr.yo` `&+`/`&-`/`&/`
    ptr-arith gate (no dispatch branch to attach to), `asm.yo` stub.

Verdict: **the evaluator port is complete for the bootstrap's purpose**
(type-checking the full corpus identically to TS at module/def level). The
items above are the tail to burn down opportunistically — several only become
testable once the self-hosted compiler can run codegen + execute fn bodies,
which is exactly the next phase (`BOOTSTRAPPING_CODEGEN.md`).

## Purpose

A systematic, file-by-file audit that every TypeScript evaluator module was
ported to yo-self **faithfully and completely**. The bootstrap was built phase
by phase under time pressure; some files were ported with shortcuts, stubs, or
hand-rolled logic that diverges from the TS source. This doc tracks the review
so nothing is silently wrong.

## When to start

**After all phases in `plans/BOOTSTRAPPING_EVALUATOR.md` are implemented.**
Until then this is a checklist-in-waiting; do not begin ticking files while the
evaluator is still being actively built (the targets are still moving).

## Review criteria (per file)

A file is **Reviewed ✅** only when ALL of the following hold:

1. **1-to-1 structural port.** The yo-self file mirrors the TS file's functions,
   branches, and control flow. Same function names (snake_case), same parameter
   order, same early-returns/guards. Divergence is allowed ONLY where the
   language forces it (e.g. yo-self side-table registries that exist to break
   circular imports) and must be explained in a header comment.
2. **No missing data structures.** Every TS type/interface/enum the file defines
   or relies on has a yo-self equivalent with the same fields. No dropped fields,
   no collapsed variants.
3. **No missing functions.** Every exported (and internal-but-load-bearing) TS
   function is present. No silently-omitted helpers, no `TODO`/stub bodies that
   `return None`/`unit` where TS does real work.
4. **No wrong hardcoded logic.** No hand-rolled enumerations where TS calls a
   shared predicate. _Concrete example that prompted this doc:_ the infix
   operator dispatch in `calls/function.yo` hardcoded a list of comparison
   operators (`== != < …`) instead of calling `string_is_operator(...)` (the
   port of TS `stringIsOperator`). Hardcoded lists drift from the lexer's real
   operator set and silently exclude cases (here: all arithmetic operators).
   Audit for: hardcoded keyword/operator/builtin-name lists, magic numbers,
   `cond` chains that should be a table/predicate, type-name string comparisons
   that should be id/structural checks.
5. **No behavior-masking fallbacks.** Soft fallbacks that swallow the real case
   (e.g. unbound-identifier → `UnknownVal(unit)`) are flagged: either they match
   TS, or they're a known gap with an `issues/` doc linked.
6. **Faithful error messages.** Error text matches TS (modulo path references —
   see memory `yo-docs-and-errors`).

Record findings inline: change `⬜` → `✅` (clean) or `⚠️` (issues found, with a
one-line note + an `issues/` doc link). A `⚠️` file is not done until its issues
are fixed and it flips to `✅`.

## Known divergences already on record (start here)

- `calls/function.yo` — infix operator dispatch was comparison-only via a
  hardcoded list; arithmetic/bitwise operators fall to the soft fallback →
  `unit`. See `issues/fixed/phase3-comptime-arithmetic-not-folded.md` +
  `plans/COMPTIME_ARITHMETIC_FOLDING.md`. (Gap 1 fix = use `string_is_operator`.)
- `builtins/comptime_assert.yo` — itself 1-to-1, but module-level eval runs with
  `is_executing=false`, so the strict path is never taken at module scope. See
  `issues/fixed/phase3-comptime-arithmetic-not-folded.md` (Bug C).
- `exprs/identifer_and_operator.yo` — unbound-identifier soft fallback yields
  `UnknownVal(t_unit())` (intentional bootstrap crutch; see
  `issues/yo-self-evaluator-gaps.md`). Confirm against TS behavior.

## yo-self-only files (no TS counterpart — review for justification, not 1-to-1)

These exist to break TS's module cycles (TS uses mutable module singletons /
direct imports yo-self can't replicate). Review that each is a faithful
extraction of TS state, not new logic:

- `evaluator/eval.yo`, `evaluator/module_loader.yo`, `evaluator/type_of.yo`
- `evaluator/types/control_fn_registry.yo`, `types/definition_site_registry.yo`,
  `types/macro_registry.yo`, `types/trait_registry.yo`
- `evaluator/values/generic_impl_registry.yo`, `values/type_trait_methods.yo`

## Checklist — 130 TS files → yo-self

Legend: ⬜ not reviewed · ✅ reviewed clean · ⚠️ issues found (see note) ·
🔧 issue found AND fixed (faithful port landed) · ⏸️ partially audited, a known
gap is deferred on a larger feature (see note)

### evaluator/ (root)

- ⬜ `context.ts` → `evaluator/context.yo`
- ⬜ `index.ts` → `evaluator/index.yo`
- ✅ `memory-safety.ts` → `evaluator/memory_safety.yo` — reviewed clean. All 6
  present functions 1-to-1. Two language-forced divergences, both documented in
  the header: `PragmaKind` union → reuses the language `Pragma` enum (self-host);
  `Map<string,Set>` → `ArrayList(PragmaEntry)`. One omission: `recordExternCallSite`
  (a `YO_EXTERN_WRAP_DUMP_FILE` migration tool needing a process-exit hook) —
  documented, not eval-correctness.
- 🔧 `trait-checking.ts` → `evaluator/trait_checking.yo` — step-0
  negative-impl gate (dc1c5c59); Send/Acyclic/Comptime/Runtime builtin fast
  paths + on-demand marker re-derivation audited earlier; SomeT ids now
  participate in the step-4 registry lookup (a821ed30 — registration/query key
  mismatch; closed Mutex(i32) <: Send).
- ⬜ `utils.ts` → `evaluator/utils.yo`
- ⬜ `utils/closure.ts` → `evaluator/utils/closure.yo`

### evaluator/async/

- ⬜ `async/await-analysis-types.ts` → `async/await_analysis_types.yo`
- ⬜ `async/await-analysis.ts` → `async/await_analysis.yo`

### evaluator/shared/

- ⬜ `shared/suspension-analysis-types.ts` → `shared/suspension_analysis_types.yo`
- ⬜ `shared/suspension-analysis.ts` → `shared/suspension_analysis.yo`

### evaluator/ctfe/

- ⚠️ `ctfe/ctfe-analysis.ts` → `ctfe/ctfe_analysis.yo` — DOCUMENTED STUB (18L vs
  213L). `createComptimeFunctionType` + `analyzeCtfeCapability` are NOT extracted
  into this module; the equivalent logic runs INLINE in `calls/comptime_fn.yo` +
  `calls/function.yo` (per the file's own header). Structural divergence (module
  organization), not necessarily behavioral. Extraction-to-module deferred —
  refactoring working, regression-prone comptime logic purely for tree-parity is
  low-reward; revisit if/when comptime_fn is otherwise touched.

### evaluator/effects/

- ⬜ `effects/effect-analysis-types.ts` → `effects/effect_analysis_types.yo`
- ⬜ `effects/effect-analysis.ts` → `effects/effect_analysis.yo`

### evaluator/exprs/

- ⏸️ `exprs/_expr.ts` → `exprs/_expr.yo` — safe-code-gate audit: the `&+`/`&-`/`&/`
  pointer-arithmetic gate (`_expr.ts:1237-1255`) is UNPORTED, but blocked on a
  larger gap — yo-self `_expr.yo` has no `&+` operator-dispatch branch (routes
  through the prelude impl), so the gate has nowhere to attach. Deferred with the
  ptr-arith dispatch work, not a standalone insertion. (Otherwise unreviewed.)
- 🔧 `exprs/assignment.ts` → `exprs/assignment.yo` — **fixed a missing gate**: the
  Phase-O atomic-object-field-write ban (`assignment.ts:793-803`) had no yo-self
  equivalent. Ported `getRootExprOfFieldAccess` + `getAtomicObjectRootType`
  (`utils.ts:22-59`) as file-local helpers and wired the gate at the start of the
  property/index-LHS branch. Faithful 1:1; reject-case is mostly def-eval-wall-
  blocked (fn-body assignments aren't evaluated by `check`) so 0 aggregate test
  delta, but the divergence is closed. **Also (fb92038d):** assignment-target
  capture tracking ported (assignment.ts:667 — a write to an outer var is a
  capture; was the make_writer blocker).
- 🔧 `exprs/begin.ts` → `exprs/begin.yo` — the explicit-`return(arg)` raw-ptr
  flowability gate (`begin.ts:1243-1282`) is now PORTED (commit 8c8bc6d8,
  slice-flowability cluster). Also fixed here earlier: return-arg expected-type
  threading (begin.ts:1148-1163) and `pop_frame_nonmutating` for the
  recorded-env aliasing fix (f6fa7132).
- 🔧 `exprs/binding.ts` → `exprs/binding.yo` — **fixed a structural divergence**:
  `is_valid_variable_name` was defined in BOTH `binding.yo` (live; 11 importers)
  and `evaluator/utils.yo` (TS-faithful; only a test imported it). TS defines
  `isValidVariableName` once in `utils.ts` and all 13 modules import it from
  there. Removed the `binding.yo` copy, repointed all 11 importers (+ the test)
  to `../utils.yo`, dropped it from `binding.yo`'s export and removed the now-
  unused `TokenKind` import. The two copies were behaviorally identical, so 0
  test delta; the duplicate is gone and the structure now matches TS.
- 🔧 `exprs/c-include.ts` → `exprs/c_include.yo` — **fixed a missing gate**: the
  Phase-C privilege gate (`c-include.ts:46-66` — `c_include(...)` is FFI, only
  pragma-AllowUnsafe files may use it) was absent. Ported after the shape check.
  Fires at MODULE level (declaration eval), so NOT def-eval-wall-blocked.
- ⬜ `exprs/cond.ts` → `exprs/cond.yo`
- ⬜ `exprs/destructuring-assignment.ts` → `exprs/destructuring_assignment.yo`
- ⬜ `exprs/exists.ts` → `exprs/exists.yo`
- ⬜ `exprs/expr.ts` → `exprs/expr.yo`
- 🔧 `exprs/extern.ts` → `exprs/extern.yo` — **fixed a missing gate**: the Phase-C
  privilege gate (`extern.ts:46-66` — `extern(...)` FFI declarations require
  pragma AllowUnsafe) was absent. Ported after the shape check. Fires at MODULE
  level, so NOT def-eval-wall-blocked.
- ⬜ `exprs/identifer-and-operator.ts` → `exprs/identifer_and_operator.yo`
- ⬜ `exprs/import.ts` → `exprs/import.yo`
- 🔧 `exprs/initialization-assignment.ts` → `exprs/initialization_assignment.yo` —
  three faithful ports landed 2026-06-10: §4 escape-boundary-2 (module-level
  control-bound binding rejected, ts:186-210); typeName stamping extended to
  TraitT (ts:343-367 — fixes nameless-trait diagnostics); `ref(name) := ...`
  locals stamp `Variable.is_ref` (ts:510).
- ⬜ `exprs/match.ts` → `exprs/match.yo`
- ⬜ `exprs/open.ts` → `exprs/open.yo`
- 🔧 `exprs/property-access.ts` → `exprs/property_access.yo` — **fixed a missing
  gate**: the `.*` pointer-dereference memory-safety gate (`property-access.ts:
292-310` — `isPtrType && !unsafeContext && !isImplicitlyUnsafeCapableFile` →
  "Pointer dereference requires 'unsafe(...)'") had no yo-self equivalent; the
  `.Pointer` branch dereferenced unconditionally. Ported the gate at the top of
  the `is_pointer_type(ot)` branch. std/yo-self exempt via the pragma file check;
  faithful 1:1 (def-eval-wall-blocked in fn bodies → 0 aggregate delta).
- ⬜ `exprs/recur.ts` → `exprs/recur.yo`
- ⬜ `exprs/runtime.ts` → `exprs/runtime.yo`
- ⬜ `exprs/subtype-of.ts` → `exprs/subtype_of.yo`
- ⬜ `exprs/test.ts` → `exprs/test.yo`
- ⬜ `exprs/typeof.ts` → `exprs/typeof.yo`
- 🔧 `exprs/unwind.ts` → `exprs/unwind.yo` — 0-arg path + arity throw +
  expected-type threading fixed earlier (6cb21378); the enclosing-function
  check (ts:26-32) is now ACTIVE for anonymous-fn bodies since the
  closure-body def-eval wall (fb92038d) — it is what rejects module-level ctl
  handlers (algebraic_effects rule 8).
- ⬜ `exprs/while.ts` → `exprs/while.yo`

### evaluator/calls/

- ⬜ `calls/array-type.ts` → `calls/array_type.yo`
- ⬜ `calls/closure-type.ts` → `calls/closure_type.yo`
- ⬜ `calls/comptime-fn.ts` → `calls/comptime_fn.yo`
- ⬜ `calls/comptime-list-type.ts` → `calls/comptime_list_type.yo`
- 🔧 `calls/function-type.ts` → `calls/function_type.yo` — the raw-ptr
  return-flowability gate (`function-type.ts:535-560`) is now PORTED (commit
  8c8bc6d8, slice-flowability cluster), along with the def-time body-eval
  machinery this file hosts (`_trial_eval_fn_body`,
  `create_function_body_evaluation_context`, flow-violation +
  propagate-def-time-errors re-raise channels). `check_deferred_generic_return_type`
  remains a no-op stub.
- 🔧 `calls/function.ts` → `calls/function.yo` — operator-dispatch Tier 1 landed
  (cf6219f0, `string_is_operator` routing); the extern-"c" call-site
  `unsafe(...)` gate (function.ts:1786-1832) PORTED (9d2e40c2, with
  `is_extern`/`extern_name` restored on the `Func` TypeValue);
  `_try_expand_call_overload` (ModuleT/Call source-namespace candidate trial)
  landed. REMAINING: general prelude operator-module `Call` dispatch is still
  partial (literal-negation fold special case; see in-file comment) and
  comptime VALUE folding Tier 2 (`plans/COMPTIME_ARITHMETIC_FOLDING.md`).
- 🔧 `calls/helper.ts` → `calls/helper.yo` — call-site where-clause validation
  ported (7a67b961): `validate_where_constraints_for_call` from the
  WhereConstraintEntry side table (TS whereClauseExprs mirror), called from
  BOTH call paths (Step 8b + the inline FuncVal CTFE arm in calls/function.yo).
  Documented scope: marker traits × fully-concrete types
  (`issues/yo-self-where-clause-full-enforcement.md`). Earlier Phase-3
  deferrals (partial application etc.) still apply.
- ⬜ `calls/index-trait.ts` → `calls/index_trait.yo`
- ⬜ `calls/iso.ts` → `calls/iso.yo`
- ⬜ `calls/numeric-type.ts` → `calls/numeric_type.yo`
- ⬜ `calls/pointer-type.ts` → `calls/pointer_type.yo`
- 🔧 `calls/pointer.ts` → `calls/pointer.yo` — §4 rule 11 ported (dfed0e28):
  `*(T)` with a control-bound pointee rejected, verified byte-identical to the
  TS error on `*(Raise)`.
- ⬜ `calls/record-type.ts` → `calls/record_type.yo`
- ⬜ `calls/trait-type.ts` → `calls/trait_type.yo`
- ⬜ `calls/type.ts` → `calls/type.yo`

### evaluator/types/

- ⬜ `types/array.ts` → `types/array.yo`
- ⬜ `types/closure.ts` → `types/closure.yo`
- ⬜ `types/comptime-list.ts` → `types/comptime_list.yo`
- ⬜ `types/concrete-trait.ts` → `types/concrete_trait.yo`
- ⬜ `types/dyn.ts` → `types/dyn.yo`
- ⬜ `types/enum.ts` → `types/enum.yo`
- ⬜ `types/expr-synthesizer.ts` → `types/expr_synthesizer.yo`
- ⬜ `types/field.ts` → `types/field.yo`
- ⏸️ `types/flowability.ts` → `yo-self/types/flowability.yo` (note: lives in the
  std-types dir, not `evaluator/types/`). `is_flowable_expr` + `FlowOptions`
  present (~334L). This entry is the home of the **def-eval wall / flowability
  cluster** work. The full blow-by-blow history is in memory
  `yo-self-defeval-wall` + the `issues/` docs; current state (2026-06):
  - **Def-eval wall crossed (784cb67a).** Def-time body eval now runs
    unconditionally for non-generic functions (faithful to `function-type.ts:499`),
    made safe by a SWALLOWING trial-eval wrapper (`_trial_eval_fn_body`). The
    flowability _check_ is gated on `result_is_ref` (`function-type.ts:524`).
    Validated std 151/0, tests 171/11, yo-self 228/0.
  - **Two codegen bugs fixed TS-first** (per faithful-porting directive), both now
    in `issues/fixed/`: unwind-buffer overflow (cb4a4a4a) and
    ref-binding-from-project clone (8179d57a).
  - **Return-slot modifier rule landed (44d74823).** Labeled returns carry
    `ref`/`comptime` on the LABEL, not the type — flips `ref_return_labeled`
    (tests 170→171). A RETURN-POSITION/type gate, checked OUTSIDE the body eval.
  - **Gates split two ways (KEY finding).** Return-position/type gates are
    reachable and work; **in-body** gates (binding-site `ref(r) := <non-flowable>`,
    closure-capture, slice-in-body) are **SWALLOW-BLOCKED** — their rejections are
    eaten by the trial-eval wrapper, so the 7 remaining `comptime_expect_error`
    tests don't surface (ref_flowability, ref_local_binding, ref_closure_capture,
    slice_flowability, algebraic_effects, extern_unsafe_wrap, sync/mutex). The
    binding-site gate is ported (8090ecc1) but inert until the swallow is removed.
  - **Surfacing them is NOT incremental.** Measured the swallow gap surface
    (log-and-swallow diagnostic over std+tests) = **104 DISTINCT incidental
    failure categories** during def-time body eval in type-check mode
    (`issues/def-time-body-eval-swallow-surface.md`). Un-swallowing would propagate
    all 104 → massive regression. So surfacing the in-body gates = the **def-eval
    robustness project**: faithfully completing the def-time body-eval paths that
    were shortcut during the port. Root cause: `Func` TypeValue dropped TS's
    `parametersFrame`, so generic params (`T`/`Self`/`Idx`) are unbound at
    def-time; plus trait-field type eval, comptime reflection (`__yo_type_*`,
    `fields.get`), and unification under `is_executing=false`. Each fix is
    swallow-protected (reduces the surface WITHOUT regressing `check`). See memory
    `yo-self-check-masks-porting-gaps` — green `check` never proved faithful
    porting (it doesn't eval fn bodies), which is how these body-level shortcuts
    rode unnoticed.
  - **DRAIN PROGRESS (2026-06, ~60%+ drained, each commit zero-regression
    std 151/0 · tests 171/11 · yo-self 228/0):** - `2b91e5e4` — **the real lever**: bind comptime-type params (`comptime(T):Type`)
    as `TypeVal(SomeT)` (not `create_unknown_val`) in `_build_def_time_body_env`,
    mirroring function.yo:1169 + deep Self defer-check. Cleared the TWO biggest
    categories (element-typevar ~3000 AND trait-field ~5000 as free collateral).
    NOTE: the earlier "params-frame" idea was a measured **no-op** (non-deferred
    fns have no free type params; the manual `create_unknown_val` binding shadowed
    the frame's correct SomeT) — reverted. Don't re-attempt it. - `269adc88` — while-gate excludes `UnknownVal` from "comptime-known" (yo-self
    `Some(UnknownVal)` ≡ TS `undefined`); drains the comptime-while category. - `e6e79dc2` — `check --exclude <path>` (TS + yo-self) → validate via
    single-process dir-checks (`check ./std`; `check ./yo-self --exclude
yo-self/tests`) ≈ 5 min vs ≈ 40 min per-file (prelude evaluated once per dir).
    Method that works: location-tagged swallow diagnostic (print body location
    BEFORE eval, not in the handler — can't capture `body`) → pin the throwing
    functions → root-cause → fix → measure category drop. DON'T guess the lever.
  - **✅ REFLECTION-ON-UNKNOWN ROOT-CAUSED + FIXED (two faithful-port fixes,
    zero regression — std 151/151, yo-self 228/228, tests 171 pass/11 fail
    identical set):** the prior analysis above ("make reflection builtins return
    typed UnknownVal") was WRONG — the builtins were already robust. Bisecting
    the actual chain with a fixme-propagating `_trial_eval_fn_body` + the
    type-revealing probe trick (`(comptime(x) : bool) = rhs;` — the mismatch
    error prints the RHS's real type) showed `Type.get_enum_variants(T)` itself
    returned `unit`, with two stacked root causes: 1. **`TypeUni` had no id** in `type_id_or_empty`
    (`values/type_trait_methods.yo`) → the prelude's `impl(Type, get_info :
...)` registration was SILENTLY SKIPPED (impl.yo skips empty-id
    registration) and lookups early-returned `[]` → every `Type.*` method
    soft-fell to `unit` under check — even at module level with concrete
    args (derives only worked because executing CTFE resolves via the
    env-level qualified binding). TS has no such gap: `createTypeHierarchy`
    (creators.ts:1030) is a cached singleton with `id: "Type(${level})"` and
    a trait slot. Fix: `.TypeUni(level) => "Type(" + level + ")"`. 2. **`find_methods_from_generic_impls` returned RAW method types**
    (`self : ComptimeList(T)`) where TS returns SPECIALIZED ones
    (`reEvaluateFunctionType`, impl.ts:1484). Call-time SomeT synthesis
    can't compensate — the registered `T`'s frame level is stale at the
    call site (same root as `_substitute_self_in_method_ty`). Minimal
    module-level repro: `comptime_list("a","b").get(usize(0))` — TS
    resolves `comptime_string`, yo-self threw "Expected ComptimeList(T)".
    Fix: build a `Substitution` of each forall `(name, frame_level)` →
    matched binding, return `substitute(s, ftype)`.
    After both: the full `__derive_eq` enum-branch chain
    (`Type.get_enum_variants(T)` → `.get` → `.fields` → `.get` → `.name`)
    def-evaluates with a PROPAGATING exception — fully typed, no swallow.
    See `issues/fixed/yo-self-typeuni-id-impl-on-type-dispatch.md`.
  - **✅ UNIFICATION-FAMILY HEAD ROOT-CAUSED + FIXED (three faithful-port
    fixes, zero regression — std 151/151, yo-self 228/228, tests 171/11
    identical set):** generic call-time unification failed on the TYPE-ONLY
    call path (extern builtins / `functionToCall.value == undefined`) — even
    at module level: `extern("C", zid : (fn(forall(T), x : T) -> T));
unsafe(zid(u8(7)))` threw "Expected T, Got u8" where TS passes. The
    structural root: TS builds the callee env as
    `pushEnvFrame(functionType.env)` (helper.ts:1009) — extending the
    definition env whose forall frame holds the intact self-binding
    `T := SomeT(T)` that TS ownership-verification
    (`thisSomeTypeWasBound`, env-lookup.ts:141-167) looks for. yo-self's
    flattened `Func` carries no env → callee_env is fresh → the marker never
    existed → `synthesize_types`' fresh concrete binding was DISCARDED by
    `_was_self_bound`. Fixes: (1) `calls/helper.yo` Step 6 recreates the
    marker (self-bind each forall label's SomeT, extracted from param/return
    types, beneath the `UnknownVal` call binding); (2)
    `evaluate_function_parameter_type_again`/`..return..` now resolve SomeTs
    at ANY structural depth (`_resolve_some_types_deep`: `get_all_some_types`
    → env-resolve → `substitute`) mirroring TS's type-EXPRESSION
    re-evaluation, so `*(T)` → `*(u8)`; (3) ported TS's definitionFrameLevel
    fallback (env-lookup.ts:170-200) as `_def_frame_confirms_binding`.
    Verified: the per-prelude-load noise print `Expected *(T) / Got *(u8)`
    (prelude.yo:5832, `str.from_raw_parts` def-eval) is GONE. NOTE fix #3
    alone was a measured no-op (frame levels are meaningless in a fresh
    callee env) — the marker (#1) is the load-bearing piece. See
    `issues/fixed/yo-self-extern-generic-unification.md` (incl. why a dedicated
    regression test is not addable today).
  - **✅ FAMILY-1 DRAIN (commit 6922a067, zero regression):** three more
    fixes + a std bug they exposed. (a) Step-6 self-bound markers extended
    to ALL signature SomeTs (`Impl(...)`-sugar vars hit the same
    discarded-binding mechanism; non-forall SomeTs need marker + a second
    updatable self-binding) — "Type mismatch for parameter" 121→0 in std.
    (b) Infix arithmetic routed UNCONDITIONALLY (TS function.ts:452); the
    old concrete-comptime-only gate predated the specialization/unification
    fixes — drains the `usize vs unit` flood. (c) CTFE execution gate:
    never execute a comptime body with an `UnknownVal` arg → return
    `UnknownVal(return_type)` (TS outcome — its runtime-unknowns are
    `undefined` and throw at comptime-fn.ts:78); without it, recursive
    prelude comptime fns (`__yo_comptime_fold_range`, `__sN`) recursed
    forever under def-eval. (d) **std bug**: `HashMap.keys()/values()`
    never advanced under manual `it.next()` (wrapped-`_inner` delegation
    advanced a COPY; `for(...)` masked it) — hung
    `enrich_captured_variables` on a 1-entry map; restructured to direct
    ctrl-byte scans + manual-next() regression tests.
    Measured: prelude swallows 21→11, std 620→356 raw.
  - **✅ ROUND-3 DRAIN (3 more fixes):** (a) return-arg expected type —
    `return(.Variant)` evaluated its arg with `expected_type = None` (a
    documented Phase-3 stub in begin.yo); TS passes the enclosing return
    type (begin.ts:1148-1163) — "Failed to infer enum variant type" 58→0.
    (b) variadic `Func` flag restored — flattened `Func` dropped TS's
    `variadicParameter`; `has_variadic` computed but DIED UNCONSUMED in
    `FuncParamsResult`. Restored as a Func field + TS's count-check guard
    (helper.ts:965) — snprintf-style "Argument count mismatch" 43→0, and
    module-level variadic extern calls flip reject→accept (TS parity).
    (c) index-trait registry lookup — `_find_all_index_methods` scanned
    only TraitT fields (stale "no generic impl registry" premise);
    `x(i)` on a struct receiver (ArrayList) with unknown value soft-fell
    to unit (TS: u8), poisoning every comparison built on it (32×
    "Expected bool for and/or argument"). Now consults
    `get_receiver_methods_by_name_from_env` (the TS
    `concreteType.trait.fields` mirror).
  - **⚠️ PINNED, UNPORTED FEATURE — ModuleT/Call overload dispatch:**
    `(!)`/`(-)`/`(~)` are prelude overload impl-modules
    (`Call :: (not, comptime_not)`); calling them soft-falls (the
    `-(IntLit)` fold at function.yo:284 is the only workaround, per its
    own comment). `!(x)` on an unknown bool → unit (TS: bool) — ~11+
    swallows + every unary-operator use under def-eval. Feature-sized:
    TS's checking-phase overload machinery (function.ts:807).
  - **REMAINING TAIL:** unify-residue (49), incompatible (27), `&+`
    ptr-arith (~15, known unported branch), casts on unit (~17), "Frame
    level is different for different cases" (5 prelude + 12 std, inert,
    uninvestigated). The `ComptimeIndex` call form `zlist(usize(0))`
    soft-falls (likely related to the Call/comptime-index dispatch gaps).
  - **✅ IN-BODY FLOWABILITY GATES — ref_flowability CLOSED (2026-06-09, zero
    regression std 151 · yo-self 228 · tests 171→172).** Three coordinated
    faithful fixes (commit `454b14ca`): (1) **binding-site flow-violation
    propagation through the swallow** — the trial-eval handler is a capture-free
    `->` effect handler (cannot close over a propagating `exn`), so the
    binding-site (`ref(r) := <non-flowable>`) flags a global box
    (`flag_flow_violation`, flowability.yo) before throwing; the throw is
    swallowed; the def-time CALLER re-raises it via the real `exn` after
    `_trial_eval_fn_body` returns (unconditionally — the fn may return any type).
    (2) **return-position fallback** to the raw body when the swallowed eval left
    `flow_out` empty. (3) **cond.yo `isPtrRelaxedMatch`** (port of cond.ts:352) —
    when expected is `*(T)` and a cond arm yields raw `T`, accept it. Plus:
    **operator/comptime-routing gate** (`a4977828`) — don't route an operator to
    comptime folding when an operand is a runtime unknown (yields `UnknownVal`
    instead of throwing "Failed to call for compile-time"); and the **R3
    method-callee side-table** (`308c854d`) — `expr_info.yo`
    `record_/lookup_method_callee_type` (ExprId→method Func type), recorded at
    method resolution, read by flowability R3 as a fallback so a ref/slice-returning
    METHOD call rooted in a `ref` param type-checks (writing the method type INTO
    the `.method` node's ExprInfo is destructive — regressed std 151→15).
  - **REMAINING in-body flowability (the other 2+ tests):** **ref_local_binding /
    ref_closure_capture** need the ref-capture-escape check (anonymous-function.ts: 1082) which relies on the PRECISE free-var capture set — blocked by yo-self
    deferring _closure_ body eval (`issues/yo-self-flowability-swallow.md`).
    **slice_flowability** is a long tail of distinct positive-case gaps: the slice
    return-check itself ports + is std-clean, but each positive hits its own gap —
    the first, `comptime_str`, is blocked by a confirmed general bug: recorded
    `ExprInfo.env` aliases the live env, and begin's in-place `pop_frame()` drops
    begin-local bindings from it (`issues/fixed/yo-self-recorded-env-aliasing.md`).
    Fixing that is a central begin/env change (env snapshot at record + non-aliasing
    begin threading), in progress with full sweeps after each step.
  - **✅ slice_flowability CLOSED (2026-06-10, tests 172→173, zero regression).**
    The env-aliasing fix landed (f6fa7132 — `new_expr_info` snapshots env frames +
    begin `pop_frame_nonmutating`), closing the `comptime_str` positive. Then the
    slice long-tail resolved via 4 coordinated fixes: (1) **TS-first** fix to
    `isFlowableExpr` for QUALIFIED variant ctors `Enum.Variant(args)` (commit
    3fa201d6 — a genuine TS flowability false-positive; `./yo-cli check` rejected
    yo-self/codegen/exprs/asm.yo too) + yo-self port (ac9734d2); (2) the in-body
    slice/ref flow checks (return / explicit-return / assignment-escape, commit
    6a681f82); (3) the env-aliasing fix above; (4) keystone — coerce a
    `comptime_string` cond arm to runtime vs a `str` expected return (commit
    5e67cd07), which let `assign_escape_slice`'s body def-evaluate past its cond so
    the assignment-escape check fires (it was upstream-blocked by the cond
    comptime-string swallow, NOT a frame-level bug). Restored asm.yo (yo-self
    228/228). Flowability scorecard: **2/4 closed** (ref_flowability,
    slice_flowability); ref_local_binding + ref_closure_capture remain
    (ref-capture-escape, closure-body-eval blocked).
  - **✅ FLOWABILITY CLUSTER COMPLETE — 4/4 (2026-06-10, fb92038d).**
    ref_local_binding + ref_closure_capture closed by crossing the
    closure-body def-eval wall (see the `values/anonymous_function.yo` entry):
    def-time body eval populates the precise capture set, the Phase B
    ref-capture gate fires, assignment-target writes count as captures
    (assignment.ts:667 port in exprs/assignment.yo), and `ref(name) := ...`
    locals stamp `Variable.is_ref` (ts:510 port in initialization_assignment.yo).
    **Final: tests 170/170, zero failures.**
    `issues/yo-self-flowability-swallow.md` → `issues/fixed/`.
- ⬜ `types/fn-trait.ts` → `types/fn_trait.yo`
- 🔧 `types/function.ts` → `types/function.yo` — where-constraint side table
  added (7a67b961, the TS `whereClauseExprs` stand-in: WhereConstraintEntry
  collected from constraint-bearing SomeTs at fn-type-eval end, re-keyed to the
  FuncVal id); `is_control` stamped from the `ctl` param-list head (dfed0e28).
  requires/ensures + zone-order + HKT-where notes from the sweep still apply.
- ⬜ `types/future-trait.ts` → `types/future_trait.yo`
- ⬜ `types/newtype.ts` → `types/newtype.yo`
- ⬜ `types/object.ts` → `types/object.yo`
- ⬜ `types/proofs.ts` → `types/proofs.yo`
- ⬜ `types/record.ts` → `types/record.yo`
- ⬜ `types/slice.ts` → `types/slice.yo`
- ⬜ `types/struct.ts` → `types/struct.yo`
- ⬜ `types/synthesizer.ts` → `types/synthesizer.yo`
- ⬜ `types/trait.ts` → `types/trait.yo`
- ⬜ `types/tuple.ts` → `types/tuple.yo`
- ⬜ `types/union.ts` → `types/union.yo`
- ⬜ `types/utils.ts` → `types/utils.yo`
- ⬜ `types/validation.ts` → `types/validation.yo`

### evaluator/values/

- 🔧 `values/anonymous-function.ts` → `values/anonymous_function.yo` — **the
  closure-body def-eval wall was crossed here (fb92038d, 2026-06-10)**:
  definition-time body evaluation for non-generic anonymous fns
  (`shouldDeferBodyEvaluation` mirror, capture-free trial swallow + 3 surfacing
  channels), the capture gates (regular-fn-no-capture ts:867; Phase B
  ref-capture ts:1078; §4 rule-4 ctl-capture ts:1088), and §4 rule 1
  (unwind-needs-ctl, ts:894). Closed the final 3 tests (algebraic_effects,
  ref_local_binding, ref_closure_capture) → tests 170/170. Remaining
  header-documented simplifications: substituteSomeTypesFromEnv, await
  analysis, checkDeferredGenericReturnType (generic bodies), body-vs-return
  compatibility, the raw-ptr return-flowability gate (ts:954-975).
- ⬜ `values/anonymous-module.ts` → `values/anonymous_module.yo`
- ⬜ `values/anonymous-struct.ts` → `values/anonymous_struct.yo`
- ⬜ `values/array.ts` → `values/array.yo`
- ⬜ `values/boolean.ts` → `values/boolean.yo`
- ⬜ `values/char.ts` → `values/char.yo`
- ⬜ `values/clone-value.ts` → `values/clone_value.yo`
- ⬜ `values/comptime-list.ts` → `values/comptime_list.yo`
- ⬜ `values/dyn.ts` → `values/dyn.yo`
- ⬜ `values/float.ts` → `values/float.yo`
- ⬜ `values/impl.ts` → `values/impl.yo`
- ⬜ `values/integer.ts` → `values/integer.yo`
- ⬜ `values/string.ts` → `values/string.yo`
- ⬜ `values/tuple.ts` → `values/tuple.yo`

### evaluator/builtins/

- ⬜ `builtins/alignof.ts` → `builtins/alignof.yo`
- ⬜ `builtins/and-or.ts` → `builtins/and_or.yo`
- ⬜ `builtins/array-fns.ts` → `builtins/array_fns.yo`
- ⬜ `builtins/as.ts` → `builtins/as.yo`
- ⏸️ `builtins/asm.ts` → `builtins/asm.yo` — safe-code-gate audit: the
  `asm(...)`/`global_asm(...)` privilege gates (`asm.ts:510,786`) are N/A —
  yo-self `asm.yo` is a documented Phase-3 STUB (both `evaluate_asm` and
  `evaluate_global_asm` throw "not yet implemented"), so asm is already
  unavailable to everyone. The gate becomes relevant only when asm is
  implemented. (Otherwise unreviewed.)
- ⬜ `builtins/build.ts` → `builtins/build.yo`
- ⬜ `builtins/comptime-assert.ts` → `builtins/comptime_assert.yo` ⚠️ (see Known divergences — Bug C)
- ⬜ `builtins/comptime-bool-fns.ts` → `builtins/comptime_bool_fns.yo`
- ⬜ `builtins/comptime-expect-error.ts` → `builtins/comptime_expect_error.yo`
- ⬜ `builtins/comptime-fn.ts` → `builtins/comptime_fn.yo`
- ⬜ `builtins/comptime-index-fns.ts` → `builtins/comptime_index_fns.yo`
- ⬜ `builtins/comptime-list-fns.ts` → `builtins/comptime_list_fns.yo`
- ⬜ `builtins/comptime-numeric-fns.ts` → `builtins/comptime_numeric_fns.yo`
- ⬜ `builtins/comptime-print.ts` → `builtins/comptime_print.yo`
- ⬜ `builtins/comptime-string-fns.ts` → `builtins/comptime_string_fns.yo`
- ⬜ `builtins/consume.ts` → `builtins/consume.yo`
- ⬜ `builtins/contracts.ts` → `builtins/contracts.yo`
- ⬜ `builtins/derive-rule.ts` → `builtins/derive_rule.yo`
- ⬜ `builtins/derive.ts` → `builtins/derive.yo`
- ⬜ `builtins/downcast.ts` → `builtins/downcast.yo`
- ⬜ `builtins/drop.ts` → `builtins/drop.yo`
- ⬜ `builtins/dup.ts` → `builtins/dup.yo`
- ⬜ `builtins/expr-fns.ts` → `builtins/expr_fns.yo`
- ⬜ `builtins/gc.ts` → `builtins/gc.yo`
- ⬜ `builtins/gensym.ts` → `builtins/gensym.yo`
- ⬜ `builtins/impl-constraint.ts` → `builtins/impl_constraint.yo`
- ⬜ `builtins/macro-expand.ts` → `builtins/macro_expand.yo`
- ⬜ `builtins/panic.ts` → `builtins/panic.yo`
- ⬜ `builtins/pragma.ts` → `builtins/pragma.yo`
- ⬜ `builtins/process.ts` → `builtins/process.yo`
- ⬜ `builtins/ptr-fns.ts` → `builtins/ptr_fns.yo`
- ⬜ `builtins/quote.ts` → `builtins/quote.yo`
- ⬜ `builtins/rc-fns.ts` → `builtins/rc_fns.yo`
- ⬜ `builtins/rc.ts` → `builtins/rc.yo`
- ⬜ `builtins/sizeof.ts` → `builtins/sizeof.yo`
- ⬜ `builtins/the.ts` → `builtins/the.yo`
- ⬜ `builtins/type-fns.ts` → `builtins/type_fns.yo`
- ⬜ `builtins/typeid.ts` → `builtins/typeid.yo`
- ⬜ `builtins/unsafe.ts` → `builtins/unsafe.yo`
- ⬜ `builtins/va-start.ts` → `builtins/va_start.yo`
- ⬜ `builtins/var-fns.ts` → `builtins/var_fns.yo`

## Progress

- Total TS evaluator files: **130**
- **ALL 130 reviewed** (Session-2 full sweep, see below). Rough tally: ~40 CLEAN,
  ~30 MINOR, ~40 DIVERGENCE (of which ~25 are documented Phase-3 deferrals and
  ~15 are tractable behavioral-fix candidates — prioritized backlog below).
  5 fixed this session (🔧 assignment, binding, c_include, extern, property_access).
- Pre-flagged earlier: `calls/function.yo` — Tier 1 operator-dispatch landed
  (cf6219f0); `types/flowability.ts` — ported to wrong path, call-sites unwired.
- **2026-06-10 re-verification:** the tractable backlog is mostly DRAINED —
  see the re-verified statuses in the backlog section (6 of 9 fixed; #10 #11
  #14 remain) and the Status summary at the top for the authoritative
  remaining-divergence inventory. All `check`-observable behavior now matches
  TS (tests 170/170).

## Session review log (2026-06)

**Methodology established:** per file — diff function inventories (TS vs yo-self),
read both, check the 6 criteria, mark ✅/⚠️, fix behavioral divergences (validate
per-file), document structural/justified ones.

**Findings:**

- `memory-safety.ts` → ✅ clean (see checklist).
- `ctfe-analysis.ts` → ⚠️ documented stub (logic inline in comptime_fn.yo).
- **Repo cleanliness:** removed 22 stray git-tracked `*.yo-E` files (stale
  `sed -iE` backups; commit b6b59d25). They tripped the stub-marker scan and are
  unreferenced/never-built.

**High-signal next targets** (from the inventory scan): `evaluator/utils.yo`
(1264L vs TS 106L — yo-self folded much in; verify the 4 TS fns + audit the
extra ~15), then the `builtins/*` (small, self-contained, fast to clear), then
the larger `calls/`/`types/` cores. The trait-membership re-port + Send/Acyclic
builtin audit done earlier this session effectively reviewed the core of
`trait_checking.yo`.

## Session 2 — FULL 130-file sweep results (2026-06)

Reviewed every TS↔yo-self file pair via parallel review agents against the 6
criteria. Verdict legend: CLEAN = faithful 1-to-1 (modulo documented
language-forced/intentionally-stripped-error-detail differences); MINOR = small
structural/cosmetic delta, no behavioral impact for valid programs; DIVERGENCE =
real behavioral gap (may be a documented Phase-3 deferral — noted).

**CLEAN (faithful):** alignof, and_or, as, comptime_bool_fns, comptime_expect_error,
comptime_print, downcast, gc, sizeof, typeid, unsafe, va_start, var_fns,
values/{array,boolean,comptime_list,float,integer}, exprs/{exists,expr,runtime,test,typeof},
calls/{comptime_list_type,iso,pointer_type}, types/{closure,comptime_list,field,newtype,
proofs,slice,union,validation}, async/await_analysis_types, shared/suspension_analysis_types,
effects/effect_analysis_types, memory_safety.

**MINOR (no behavioral impact):** array_fns, comptime_index_fns (computeComptimeStringIndex
relocated to calls/index_trait.yo — present, not missing), comptime_list_fns, consume,
expr_fns, gensym, process, ptr_fns, quote, rc, the, comptime_assert (type-mismatch text
hardcoded "unknown"), exprs/{cond,destructuring_assignment,recur,subtype_of},
calls/{numeric_type,type,comptime_fn}, types/{concrete_trait,synthesizer,tuple,object},
values/{anonymous_module,clone_value,string,tuple}, evaluator/{utils,context,index},
async/await_analysis, shared/suspension_analysis.

**DIVERGENCE — documented/intentional Phase-3 deferrals (large features, NOT quick fixes):**

- `calls/function.yo`, `calls/helper.yo` — no overload resolution / partial application /
  extern-c call-site gate / macro expansion (function.yo); CTFE not executed, non-Func
  soft-fallback→unit, no variadics/RC-ownership/where-clause/io-builtin special-casing (helper.yo).
- `calls/function_type.yo` — `check_deferred_generic_return_type` is a no-op stub.
  (UPDATE 2026-06: def-time body eval is now LIVE via 784cb67a — see the
  `types/flowability.yo` entry — but errors are swallowed, so in-body
  definition-time gates still don't surface. No longer "the def-eval-wall root".)
- `values/impl.yo` (4 throws vs TS 32), `types/utils.yo` (~88% unported — RC gen), `types/function.yo`
  (no requires/ensures + zone-order; HKT where stub), `types/record.yo` + `calls/record_type.yo`
  (pre-refactor module-type port), `calls/trait_type.yo` (no where-clause gate / constraint storage),
  `values/dyn.yo` + `types/dyn.yo` (missing trait-satisfaction + fn-name-conflict/reserved gates),
  `builtins/{contracts,build,drop,dup,derive,derive_rule}.yo`, `exprs/import.yo` (dep resolution),
  `exprs/identifer_and_operator.yo` (unbound→UnknownVal soft fallback — known bootstrap crutch),
  `utils/closure.yo` (capture validation/move/ARC stubs), `types/array.yo` + `calls/array_type.yo`
  (`Array(T,_)` unknown-length inference rejected).

**DIVERGENCE — real behavioral gaps that are TRACTABLE FIX CANDIDATES (prioritized backlog):**

**SAFE/SURGICAL TIER — ✅ ALL LANDED (Session 2 fix phase, 0 regressions each):**

1. ✅ **Migration-mangled error strings** — FIXED (commit 86cda8b5). De-mangled ~22 strings
   across helper/closure_type/fn_trait/function/cond/while/match/types-utils/comptime_fn.
2. ✅ **`trait_checking.yo` step-0 negative-impl gate** — FIXED (commit dc1c5c59). Exported
   has_negative_impl, wired the step-0 short-circuit with registration-matching keys
   (type_id_or_empty + get_trait_key). Generic-negative-impl branch still unported.
3. ✅ **`values/char.yo` unknown-escape throw** — FIXED (commit ec2f3dec). Invalid-length throw
   intentionally skipped (byte-vs-UTF16 model would mis-reject multibyte chars; documented).
4. ✅ **`exprs/unwind.yo` no-arg `unwind()`** — FIXED (commit 6cb21378). Added 0-arg unit path +
   `>1` arity throw + expected-type threading. Kept the given-handler gate (compensating control).

**REMAINING — LARGER/FEATURE TIER (each warrants its own focused effort; mostly def-eval-wall-blocked = 0 aggregate `check` delta):** 4. **GADT** — ✅ **enum construction LANDED (commit e2bdcc65); flips `gadts.test.yo` (tests 168→169, the only test-count gain in the fix phase).** New `evaluator/types/gadt_registry.yo` side-table (per-variant gadtReturnTypeArgs + per-instantiation typeConstructorArgs, keyed by enum id — EnumT is positional so no field add) + enum.yo detect→strip→build→eval-recur path (enum.ts:61-85,313-366). The construction fires at MODULE level so it WAS the real blocker. **STILL UNPORTED (wall-blocked → 0 `check` impact, NOT validatable via check):** the match-refinement — match.ts getGadtRefinedExpectedType/isGadtBranchReachable + 6 call sites + synthesizer typeConstructorArgs propagation. Lives entirely in fn bodies, so defer until full-codegen self-hosting (which evaluates fn bodies) is the milestone — the first point it can be exercised. The gadt_registry tca table is already in place for it.

**HKT (higher_kinded_types)** — ✅ **LANDED (commits eaaa4827 producers + b3886f08 where-clause); flips `higher_kinded_types.test.yo` (tests 169→170).** The `TypeAppT` data model + all consumers (compatibility/substitution/synthesizer/env-dispatch) already existed; only the PRODUCERS were missing: (A) kind-annotated forall binding `F : (fn(comptime(T):Type)->comptime(Type))` → `t_some_t_with_kind` (value.ts:598-624); (B) `F(A)` FnCall SomeT-callee with `kind_function_type` → `t_type_app` (function.ts:1248-1328); (C) where-clause `F(A) <: Trait` → `add_where_clause_constraint_for_type_application` + a TypeApp/SomeT/concrete if-else so TypeApp doesn't hit concrete-validate (function.ts:1265-1348). **STILL UNPORTED but masked by test trial-eval swallowing (→ 0 `check` impact):** partial application `Result(_, i32)` (#4, a whole feature) + TypeApplication substitution resolution `identity(forall(Option,i32),x)` (#5, flagged circular-import — belongs in helper.yo). These matter only under full-codegen self-hosting.

**Backlog re-verification (2026-06-10, via review agents — statuses current):**

6. ✅ **`builtins/comptime_numeric_fns.yo`** — FIXED: checkOverflow-equivalent
   throws on overflow (no clamping); fn-name validation throws on unknown ops.
7. ✅ **`builtins/comptime_string_fns.yo`** — FIXED (10fff48e): result type
   from `type_of_eval_value(result_val)`, not the value tag. (Same fix in
   comptime_bool_fns, a1130681.)
8. ✅ **`builtins/macro_expand.yo`** — FIXED: benign-error-swallow vs
   assertion-rethrow distinction ported.
9. ✅ **`builtins/panic.yo`** — FIXED: `ctx.expected_type` priority +
   `result_is_ref` → `t_ptr` wrapping present.
10. ⚠️ **`builtins/impl_constraint.yo`** — STILL OPEN: `Concrete(T)`
    extraction + single-Concrete gate deferred (`is_concrete_trait_type` stub).
    **`builtins/type_fns.yo`** — PARTIAL: `can_type_form_rc_cycle` is real
    (consulted in types/utils.yo:135) but `get_info` still lacks
    Function/Trait/Dyn/SomeType variants.
11. ⚠️ **`builtins/rc_fns.yo`** — STILL OPEN: `iso_extract` returns
    `Option(T)`; TS Phase-H returns `T`.
12. ✅ **`types/enum.yo`** — FIXED (e2bdcc65): GADT construction fully
    supported via `gadt_registry`. (Match-REFINEMENT still deferred — fn-body
    feature, codegen-selfhost milestone.)
13. ✅ **`types/struct.yo`** — FIXED: atomic-object Send-enforcement present
    (auto_derive path consults `type_implements_send`; the Mutex(T) chain is
    exercised by tests/sync/mutex.test.yo). `exprs/open.yo` extras unaudited.
14. ⚠️ **`effects/effect_analysis.yo`** — STILL OPEN (re-verified): yo-self
    885L vs current TS 263L; yo-self carries the richer pre-refactor
    `has_effect_in_spread_`/transitive machinery. Needs a re-sync audit
    against the slimmed TS (which still calls `isTransitiveEffectCall` but
    dropped the rest).

Remaining open set: #10, #11, #14 above + the codegen-selfhost-gated items in
the Status summary (GADT refinement, HKT partial application, where-clause
widening, anonymous-function header simplifications, comptime folding Tier 2).
