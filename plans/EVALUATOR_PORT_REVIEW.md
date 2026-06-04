# Evaluator port review — TS `src/evaluator/` → yo-self `yo-self/evaluator/`

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
  `unit`. See `issues/phase3-comptime-arithmetic-not-folded.md` +
  `plans/COMPTIME_ARITHMETIC_FOLDING.md`. (Gap 1 fix = use `string_is_operator`.)
- `builtins/comptime_assert.yo` — itself 1-to-1, but module-level eval runs with
  `is_executing=false`, so the strict path is never taken at module scope. See
  `issues/phase3-comptime-arithmetic-not-folded.md` (Bug C).
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
- ⬜ `trait-checking.ts` → `evaluator/trait_checking.yo`
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
  delta, but the divergence is closed.
- ⏸️ `exprs/begin.ts` → `exprs/begin.yo` — safe-code-gate audit: the raw-ptr
  return-flowability gate (`begin.ts:1268`) is UNPORTED but belongs to the
  slice/ref-flowability cluster (needs `isFlowableExpr` +
  `typeRepresentationContainsRawPtr` + fn-body eval = the deferred def-eval-wall
  feature; cf. wall-blocked ref_flowability/slice_flowability tests). Not a
  standalone gate. (Otherwise unreviewed.)
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
- ⬜ `exprs/initialization-assignment.ts` → `exprs/initialization_assignment.yo`
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
- ⬜ `exprs/unwind.ts` → `exprs/unwind.yo`
- ⬜ `exprs/while.ts` → `exprs/while.yo`

### evaluator/calls/

- ⬜ `calls/array-type.ts` → `calls/array_type.yo`
- ⬜ `calls/closure-type.ts` → `calls/closure_type.yo`
- ⬜ `calls/comptime-fn.ts` → `calls/comptime_fn.yo`
- ⬜ `calls/comptime-list-type.ts` → `calls/comptime_list_type.yo`
- ⏸️ `calls/function-type.ts` → `calls/function_type.yo` — safe-code-gate audit:
  the raw-ptr return-flowability gate (`function-type.ts:535-560`) is UNPORTED but
  belongs to the slice/ref-flowability cluster (deferred def-eval-wall feature),
  not a standalone gate. (Otherwise unreviewed.)
- ⬜ `calls/function.ts` → `calls/function.yo` ⚠️ operator dispatch (see Known divergences)
- ⬜ `calls/helper.ts` → `calls/helper.yo`
- ⬜ `calls/index-trait.ts` → `calls/index_trait.yo`
- ⬜ `calls/iso.ts` → `calls/iso.yo`
- ⬜ `calls/numeric-type.ts` → `calls/numeric_type.yo`
- ⬜ `calls/pointer-type.ts` → `calls/pointer_type.yo`
- ⬜ `calls/pointer.ts` → `calls/pointer.yo`
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
- ⚠️ `types/flowability.ts` → **PORTED to the WRONG path** as
  `yo-self/types/flowability.yo` (not `yo-self/evaluator/types/flowability.yo`).
  The function `is_flowable_expr` + `FlowOptions` exist (334 lines). My earlier
  "NOT PORTED" claim was wrong — it was a path-mapping miss (the file lives in
  the std-types dir, not the evaluator-types dir). The REAL gap: the **call
  sites are unwired** — TS calls `isFlowableExpr` from `assignment.ts`,
  `initialization-assignment.ts`, `begin.ts`, `function-type.ts`,
  `anonymous-function.ts`, but the yo-self counterparts don't, so the
  flowability rejection never fires (→ `ref_flowability`/`slice_flowability`
  `comptime_expect_error` tests fail). Wire the call sites + (optionally) move
  the file to the 1-to-1 path.
- ⬜ `types/fn-trait.ts` → `types/fn_trait.yo`
- ⬜ `types/function.ts` → `types/function.yo`
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

- ⏸️ `values/anonymous-function.ts` → `values/anonymous_function.yo` — safe-code-gate
  audit: the raw-ptr return-flowability gate (`anonymous-function.ts:954-975`) is
  UNPORTED but belongs to the slice/ref-flowability cluster (deferred
  def-eval-wall feature), not a standalone gate. (Otherwise unreviewed.)
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
- `calls/function_type.yo` — `check_deferred_generic_return_type` is a no-op stub; body never
  evaluated at definition time → ALL definition-time gates missing (the def-eval-wall root).
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

**REMAINING — LARGER/FEATURE TIER (each warrants its own focused effort; mostly def-eval-wall-blocked = 0 aggregate `check` delta):** 4. **`exprs/match.yo` + `types/enum.yo`** entire GADT subsystem missing — **explains the baseline
`gadts.test.yo` fail.** Large (port getGadtRefinedExpectedType/isGadtBranchReachable + 6 call
sites in match.yo; GADT enum construction in enum.yo). The one item that could flip a test. 6. **`builtins/comptime_numeric_fns.yo`** `checkOverflow` absent → silently clamps instead of
throwing on comptime integer overflow; no fn-name validation throw; i64 not bigint. Behavioral. 7. **`builtins/comptime_string_fns.yo`** result type derived from value TAG not value.type →
`length(x)`/`eq(...)` on unknown-valued operands get `comptime_string` instead of
`comptime_int`/`bool`. Behavioral (wrong static type). 8. **`builtins/macro_expand.yo`** error swallow-vs-rethrow inverted (benign non-expandable errors
abort the loop; assertion-error rethrow lost) — uses outer exn handler. 9. **`builtins/panic.yo`** ignores `expectedType` priority + `isRef`→ptr wrapping. 10. **`builtins/impl_constraint.yo`** `Concrete(T)` extraction + single-Concrete gate dropped
(relies on `is_concrete_trait_type` stub). **`builtins/type_fns.yo`** `can_form_rc_cycle`
stub returns false; `get_info` missing Function/Trait/Dyn/SomeType variants. 11. **`builtins/rc_fns.yo`** `iso_extract` returns `Option(T)` instead of Phase-H `T`. 12. **`types/enum.yo`** GADT enums hard-rejected ("not yet implemented") vs fully implemented in TS. 13. **`types/struct.yo`** atomic-object Send-enforcement gate missing (`type_implements_send` exists,
uncalled); **`exprs/open.yo`** has an extra non-TS implicit-var gate + extra ModuleVal branch. 14. **`effects/effect_analysis.yo`** ports a PRE-EXPLICIT*EFFECTS version (`has_effect_in_spread*`+
full`is*transitive_effect_call*` that current TS stubbed out) — detects transitive effects TS
no longer does. Should be re-synced to the gutted current TS.

Most are def-eval-wall-blocked (fn-body gates) so 0 aggregate `check` delta, but each is a real
faithfulness divergence. Fix order: #1 (mechanical) → #3/#5/#9/#11 (small surgical) → #2/#10/#13
(careful, hot paths) → #4/#6/#7/#12 (medium features) → #8/#14 (semantics re-sync).
