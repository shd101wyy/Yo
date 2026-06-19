# yo-self: parallelism spawn emitter gated on the closure-codegen subsystem

## Status

PARTIAL (2026-06-19). The spawn emitter IS ported + wired; the remaining blocker
is generic-method monomorphization, not the emitter.

### UPDATE 2026-06-19 — emitter ported; blocked on Thread.spawn monomorphization.

- The `Io`-type-collection crash is FIXED (commit pending): `collection.yo` now
  collects function SIGNATURE types (param + return) via `get_func_type(fid)`, not
  just bodies — a non-async `main(io : Io)` whose body never mentions `Io` now
  compiles (was rc=134 `get_type_string: no C type name found for Io`). Validated:
  `/tmp/th2.yo` → `value 42`; corpus 75/75.
- `generate_thread_spawn_call` / `generate_worker_spawn_call` / spawn-wrapper are
  ported to `yo-self/codegen/exprs/parallelism.yo` (resolving the closure fn +
  capture struct from the cb arg's ExprInfo, like async.yo; `consumedCaptures`
  NULLing omitted — non-`own(self)` only) and wired into `other_fn_call.yo`'s
  `is_extern == "yo"` dispatch for `__yo_thread_spawn` / `__yo_worker_spawn`. Type-
  checks clean; corpus stays 75/75 (the wiring is inert for the corpus).
- REMAINING BLOCKER: the spawn closure (`closure_yo_id_*`) IS emitted correctly
  (capture-param convention), but `Thread.spawn` itself (the std/thread.yo wrapper
  method `spawn : (fn(cb : Impl(Fn(io:Io)->unit, Send)) -> Self)`) is SKIPPED as
  generic — its `cb : Impl(Fn...)` param is a SomeType → `is_function_type_hard_generic`
  → `should_skip_function_codegen` drops it. So `Thread.spawn(cb)` lowers to a call
  to an undeclared `yo_id_<spawn>`, and the `__yo_thread_spawn(cb)` extern INSIDE
  its body (which would hit the new emitter with `cb : <concreteCaptureStruct>`) is
  never reached. The fix is GENERIC-METHOD MONOMORPHIZATION (Gap 2: yo-self FuncVal
  has no `specializedType`/`specializedFunctionCaches`) — specialize `Thread.spawn`
  per concrete closure type so it's emitted with `cb` typed as the concrete capture
  struct. Once that lands, the ported emitter resolves it end to end (TS reference:
  `/tmp/th.yo` → `thread sees 42` / `main done`).

### LAYER 1 LANDED (2026-06-19, commit 00247c89f) — hard-generic resolvedConcrete clause

The missing `guards.ts:490` clause is now ported: `is_function_type_hard_generic`
excludes a `.SomeT(id)` param that has a registered resolved-concrete (via the
`g_some_resolved_concrete` bridge, injected into guards.yo at codegen init by
`set_lookup_some_resolved_concrete` — the `set_collect_type_fn` indirection
pattern, to avoid the guards→expr_info cycle). corpus 75/75, 0 regressions.
This alone does NOT fix spawn: `Thread.spawn` is still never SPECIALIZED (the
function.yo:2509 trigger is `forall_names.len() > 0`), so the call references the
UNSPECIALIZED `Thread.spawn` whose `cb` SomeT has no registered concrete → still
hard-generic → skipped. Layer 2 below is the remaining piece.

### LAYER 2 (next) — specialization trigger + cb resolved-concrete

Broaden the function.yo:2509 specialization trigger from `forall_names.len() > 0`
to TS's guard (`is_function_type_generic(ft) && !is_control_fn`, helper.ts:1911-1929)
so a non-forall soft-generic call (`cb : SomeT`) specializes. KEY OPEN QUESTION to
investigate FIRST: when `create_specialized_function_inline` (helper.yo:914) builds
the specialized `Thread.spawn`, does its registered `spec_type` (register_func_type
@1310) carry `cb` as (a) the CONCRETE capture struct — then it's emittable with no
SomeT at all, layer 1 not even needed for spawn — or (b) still a SomeT — then
create_specialized must ALSO `register_some_resolved_concrete(cb_some_id,
capture_struct)` so layer 1's clause fires. TS does (b) (SomeType keeps identity +
gets resolvedConcreteType). Determine which yo-self does, then wire accordingly.
RISK: broadening the trigger routes many soft-generic std calls through
create_specialized (which lacks effects analysis, helper.yo:908) — validate corpus
+ check ./std + watch compile time.

LAYER-2 MECHANISM (investigated 2026-06-19 — REFINED): `create_specialized_function_inline`
builds `runtime_param_tys` from the CONCRETE ARG types (`ae.arg_type`,
helper.yo:982), NOT the param SomeTs — and `spec_param_types` (helper.yo:1283-1287)
is built from those same `runtime_param_tys`. So a specialized `Thread.spawn`
ALREADY gets `cb` as the concrete capture struct (not a SomeT) — meaning it's
directly emittable once specialized, and layer 1's resolved-concrete clause isn't
even strictly required for this path. Therefore LAYER 2 REDUCES TO A SINGLE CHANGE:
broaden the specialization TRIGGER at function.yo:2509 from `forall_names.len() > 0`
to TS's guard — `is_function_type_generic(callee_func_type) && !is_control_fn(cv_fid)`
(helper.ts:1911-1929) — so a non-forall soft-generic call (cb : SomeT) specializes.
The existing arm body already handles the non-forall case (empty forall args, concrete
reg args). Edits: import `is_function_type_generic` (types/guards.yo) + `is_control_fn`
(evaluator/types/control_fn_registry.yo) into function.yo; OR the guard. ⚠️ HIGHEST-RISK
change in the whole effort: it routes EVERY soft-generic (SomeT-param) std call through
create_specialized (which lacks effects analysis, helper.yo:908) — memory
[[yo-self-phase3-generic-impl-funcid]] records a prior broad generic-specialization
attempt was REVERTED. MUST validate beyond the 75-fixture corpus: at minimum the full
`./yo-cli test` corpus PLUS yo-self-bin sweeps over std/tests, watching compile time,
in a FOCUSED (non-compacted) session. Do NOT land it validated only by the small corpus.

### FAITHFUL ROOT CAUSE (2026-06-19) — supersedes the FnTraitT/guard guesses below

Comparing yo-self against the TS reference 1-to-1 (per the faithful-porting
mandate) pins the divergence to a SINGLE missing clause:

- TS `isFunctionTypeHardGeneric` (src/types/guards.ts:466-494) excludes a SomeType
  param that has a **`resolvedConcreteType`** — guards.ts:490 with the explicit
  comment: "This matters for closure-typed parameters (e.g. `f : F` where
  F = Impl(Fn(...)) resolves to the closure's capture struct)." So a `Thread.spawn`
  whose `cb : Impl(Fn...)` SomeType is resolved to the concrete capture struct is
  NOT hard-generic → it specializes + emits.
- yo-self `is_function_type_hard_generic` (yo-self/types/guards.yo:466-504) checks
  `.SomeT` params but OMITS the `!resolvedConcreteType` clause — so a fully-resolved
  closure param is still counted hard-generic → `should_skip_function_codegen`
  drops `Thread.spawn` → undeclared call. (`cb` IS a SomeT in yo-self too, matching
  TS — the earlier "cb is FnTraitT" note was wrong; both predicates match `.SomeT`.)

FAITHFUL FIX: port the missing guards.ts:490 clause — in `is_function_type_hard_generic`
(and re-check `is_function_type_generic` likewise), a `.SomeT(id, …)` param with a
registered resolved-concrete (yo-self's `g_some_resolved_concrete` bridge via
`lookup_some_resolved_concrete(id)`) must NOT count toward hard-generic. PLUMBING:
guards.yo is low-level; importing the bridge from expr_info.yo would cycle — use an
indirection global set at init (the `set_collect_type_fn` pattern in collection.yo)
or relocate the bridge to a leaf module. VERIFY FIRST (instrument): that the spawn
call site actually registers `cb`'s SomeT → concrete capture struct in the bridge;
if not, that registration is the (additional) gap. VALIDATION: hot path
(should_skip uses this) — corpus 75/75 + `check ./std` + full `./yo-cli test --bail`
(~30 min) before committing.

### CORRECTION + deeper layers (2026-06-19, continued)

Direct inspection refines the fix below — it is MORE than a guard swap:
- `Thread.spawn`'s `cb : Impl(Fn(io:Io)->unit, Send)` is a **`FnTraitT`**
  (types/definitions.yo:305), NOT a `SomeT`. `is_function_type_generic`
  (guards.yo:428) only treats `forall`/`implicit`/`SomeT`-param functions as
  generic — it does NOT detect a `FnTraitT` param. So simply swapping the
  guard at function.yo:2509 to `is_function_type_generic` would NOT fire for
  `Thread.spawn`. Generic-detection must also count a `FnTraitT` (closure/Impl-Fn)
  param as "needs specialization."
- `is_function_type_hard_generic` does not yet check call-site resolved-concrete
  (its own doc says "Phase 2b: extend to check resolvedConcreteType") — so the
  `&& !isFunctionTypeHardGeneric` half of the TS guard also needs the call-site
  view, else it would wrongly treat the resolved call as still-hard-generic.
- The exact reason the unspecialized `Thread.spawn` is dropped at codegen
  (skip vs not-collected vs FnTraitT get_type_string) was NOT fully pinned —
  needs instrumentation before editing.
So the Gap-2 spawn fix spans at least: (1) FnTraitT-aware generic detection,
(2) call-site-resolved hard-generic check, (3) the specialization-guard branch
at function.yo:2509 handling the non-forall case, (4) ensuring the cb arg's
type is the concrete capture struct in the specialized callee. A focused session
should instrument the skip/collection path FIRST, then implement these layers
with full-suite validation. This is genuinely foundational, multi-layer work —
not a single safe edit.

### PRECISE FIX LOCATION for the Gap-2 spawn blocker (2026-06-19)

Root-caused to the specialization guard in `yo-self/evaluator/calls/function.yo:2509`:
```
if(forall_names.len() > usize(0), { … create_specialized_function_inline … });
```
yo-self only specializes functions with `forall` params. TS's guard
(`src/evaluator/calls/helper.ts:1917`) is
`isFunctionTypeGeneric(functionType) && !isFunctionTypeHardGeneric(functionType)`
(plus `!isControlFunction`, no-unknown-implicits, etc.) — so TS ALSO specializes
SOFT-generic functions whose generic-ness comes from an `Impl(...)` / SomeType
param, e.g. `Thread.spawn : (fn(cb : Impl(Fn(io:Io)->unit, Send)) -> Self)`. TS's
specialized output is `fn_…_spawn_rtparam0_struct(value:i32)…(struct(value:i32) cb)`
— cb monomorphized to the CONCRETE capture struct.

The fix: broaden the yo-self guard to the TS form. BUT the existing arm at 2509 is
built entirely around `forall` binding (`fa_bound_names`/`fa_bound_types`,
`_static_dot_receiver_self_type`, forall-result re-registration), so a non-forall
soft-generic call needs either a separate branch that calls
`create_specialized_function_inline` with EMPTY forall args + the concrete reg-arg
types, or careful generalization of this arm. `create_specialized_function_inline`
already derives `runtime_param_tys` from `ae.arg_type` (helper.yo:982) and
`compute_compile_time_signature` already keys on concrete closure capture types
(helper.yo:642) — so once invoked, it should specialize cb correctly, PROVIDED the
cb arg's `arg_type` is the concrete closure/capture type at the call site (verify;
may tie back to closure-arg typing). HIGH REGRESSION RISK: this guard is on the
hot call path the entire std depends on — validate with `check ./std` + the full
corpus + ideally the ~30-min suite. yo-self has `is_function_type_hard_generic`
(used in declarations.yo); confirm/port `is_function_type_generic`.

## (historical) Status

OPEN (2026-06-18). The parallelism **runtime** (`generate_parallelism_runtime`,
the `__yo_thread_*` / `__yo_worker_*` C boilerplate) is ported and wired
(`yo-self/codegen/parallelism/runtime.yo`, gated on `context.uses_parallelism` in
`functions/generation.yo`). The parallelism **expression emitter**
(`src/codegen/exprs/parallelism.ts`: `generateThreadSpawnCall`,
`generateWorkerSpawnCall`, `generateSpawnWrapper`,
`generateYoThreadSetMaximumThreads`) is NOT yet ported because it depends on the
deferred closure-codegen subsystem.

## The dependency

`generateThreadSpawnCall` / `generateWorkerSpawnCall` resolve the spawned
closure's concrete capture struct + closure function via
`context.implClosureCallMap.get(concreteTypeId)`, which yields
`{ functionCName, callType, consumedCaptures }`. That map is populated by
`registerImplClosureCallMappings` in `src/codegen/exprs/closures.ts`.

In yo-self, `closures.yo`'s header documents that
`generateClosureConstruction`, `allocateClosureCapture`, and
`registerImplClosureCallMappings` are the **deferred Phase-3 closure-codegen
subsystem** (see `issues/yo-self-closure-codegen-gate.md`). yo-self has no
`impl_closure_call_map` on the codegen context.

`async.yo`'s sync-effect path side-steps the map by reading
`closure_function_value` + `capture_type` from the closure arg's **ExprInfo**, so
the closure function C name and capture struct C name ARE derivable that way. But
the spawn emitter additionally needs `consumedCaptures` (the `own(self)`-consumed
capture field names) to NULL them before the wrapper's drop, preventing a
double-free. `consumedCaptures` is tracked ONLY in `implClosureCallMap`; it is not
carried on yo-self ExprInfo. Porting the spawn emitter without it would silently
omit the RC-cleanup NULLing — an unfaithful correctness shortcut — so it is
blocked on either:

1. Porting `registerImplClosureCallMappings` + an `impl_closure_call_map` on the
   codegen context (the faithful path, unblocks `generateClosureConstruction`
   too), or
2. Threading `consumed_captures` onto ExprInfo at eval time and reading it here
   (a narrower bridge, mirrors how async.yo reads `closure_function_value`).

## Faithful-port note

Do NOT emit a partial spawn emitter that drops the capture struct without first
NULLing consumed fields — that reintroduces the double-free the TS
`generateSpawnWrapper` exists to prevent. Port the closure-call mapping first.

## Concrete repro + current failure (2026-06-19)

`/tmp/th.yo`:
```rust
{ println } :: import("std/fmt");
{ Thread } :: import("std/thread");
main :: (fn(io : Io) -> unit)({
  value := i32(42);
  thread := Thread.spawn((io) => { println(`thread sees ${value}`); });
  thread.join();
  println(`main done`);
});
export(main);
```
- TS reference → `thread sees 42` / `main done`.
- yo-self-bin → CRASHES at codegen, rc=134:
  `get_type_string: no C type name found for Io (type not collected before lowering)`.

So before/alongside the spawn emitter there is a **type-collection gap**: the
`Thread.spawn` closure's `io : Io` param type is never collected into
`context.types` (the spawn emitter doesn't exist, so the closure arg falls through
to a generic path that lowers `Io` without it being registered). The full fix is:
(1) port `generateThreadSpawnCall` / `generateWorkerSpawnCall` /
`generateSpawnWrapper` (`exprs/parallelism.ts`) into a new `yo-self/codegen/exprs/
parallelism.yo`, resolving the closure fn + capture struct the way `async.yo` does
(closure_function_value + capture_type from ExprInfo), and wiring the two
`__yo_thread_spawn` / `__yo_worker_spawn` extern names in `other_fn_call.yo`'s
`is_extern == "yo"` dispatch (mirrors other-fn-call.ts:906-916); (2) ensure the
spawn closure's param/capture types are collected (the `Io` crash); (3)
`consumedCaptures` for the own(self) NULLing remains the narrower deferred piece —
a fixture WITHOUT own(self) consumption (like the repro above) is faithful without
it and can land first. The parallelism RUNTIME (`runtime.yo`) is already in place,
so once the emitter lands a fixture is differential-testable end to end.

### UPDATE 2026-06-19 (2) — type-lowering groundwork LANDED (commit fd019e82b); codegen-emission half remains.

Gap-2 monomorphization now produces the correctly-typed specialized callee. Four
faithful, corpus-safe (75/75), non-regressing changes landed:

1. ref-spill monotonic counter (other_fn_call.yo) — fixes `__yo_ref_spill_0`
   redefinition when two calls in one fn both spill arg 0.
2. arg-eval passes the `Impl(Fn(...))` SomeT as the closure arg's expected type
   (function.yo, mirrors helper.ts:330) — closures now resolve `fn(io:Io)->unit`
   instead of garbage `fn(io:io)->_ret`.
3. closure arg's `ExprInfo.capture_type` used as the specialization arg_type
   (function.yo) — `cb` lowers to its concrete capture struct (mirrors TS
   resolvedConcreteType, helper.ts:2245).
4. specialization trigger fires for NON-forall soft-generic fns, NARROWED to
   closure-(Impl(Fn))-param fns (`_func_type_has_closure_param`). Broad (all
   soft-generic) crashed large-corpus processing; closure-only is corpus-safe.

Result: `Thread.spawn` (and any closure-param fn, e.g. `apply` in the minimal
repro below) is specialized with `cb` typed as `__yo_capture_<id>` (the capture
struct), matching TS. Confirmed via the specialized C name
`yo_id_<n>_rtparam0__struct_capture_<id>_`.

NON-REGRESSION PROOF: the clean HEAD binary breaks the same closure-param-value
cases IDENTICALLY (just a different error: `yo_id_<n>` undeclared). Closure-param
functions returning non-unit values are a PRE-EXISTING unported codegen feature.

MINIMAL NON-EXTERN REPRO (simpler than spawn — exercises the same gap WITHOUT the
thread wrapper, so fix/validate this first):
```rust
apply :: (fn(cb : Impl(Fn(x : i32) -> i32)) -> i32)(cb(i32(10)));
main :: (fn() -> unit)({ base := i32(5); r := apply((x) => (x + base)); println(`${r.to_string()}`); });
```
TS → prints 15. yo-self-bin → broken C (capture-struct cast where pointer needed).

REMAINING CODEGEN-EMISSION PIECES (the complete TS mechanism, from cls.yo emit):
- (A) CALLER: a closure arg passed to a fn whose param is the capture struct must
  emit the capture-struct CONSTRUCTION `(captureStruct){ .field = capturedVar }`
  (assigned to a temp, passed by value), NOT `(captureStruct)(closure_fn_name)`.
  TS: `__capture_..._4 = (struct..){ .base = base }; apply((struct..)(_tmp))`.
  This is the call-site arg emission in other_fn_call.yo.
- (B) COLLECTION: the specialized closure-param body must be emitted. It is
  currently SKIPPED by the `exprContainsUnknownValue(body)` guard
  (collection.yo:496) because the body's value is UnknownVal of a non-unit type
  (`cb(10)` → unknown i32; `Self(raw)` → unknown Thread). In TS the same guard
  exists but the body value is a StructValue/known and passes — investigate why
  yo-self records UnknownVal here (struct-construction / closure-call result value)
  and align, OR relax the guard for specialized (concrete-typed) functions.
- (C) SPECIALIZED BODY: `cb(x)` where `cb` is a capture-struct param must emit
  `closure_fn(&(cb), x)` (closure called with `&cb` as `closure_context`). TS:
  `closure_..._49(&(cb), 10)`. For spawn specifically this is instead the
  `__yo_thread_spawn(wrapper, &cb-heap-copy)` path already ported in parallelism.yo;
  the GENERAL case is a direct closure call and is the broader missing emitter.

A+B+C must land together (none alone compiles the repro). The async/io.async path
(async.yo, `sm->__capture.field`) is the state-machine analogue; the non-async
closure-param path is capture-struct-by-value + direct closure call.

### UPDATE 2026-06-19 (3) — full A/C blueprint: the implClosureCallMap subsystem.

Scoped the codegen-emission half precisely against TS. The general closure-call
mechanism centers on `context.implClosureCallMap` (TS utils/index.ts:139, on the
BASE CodeGenContext): `Map<captureStructTypeId, { functionCName, callTypeId,
callType?, consumedCaptures? }>`. yo-self's CodeGenContext (utils/index.yo:90) does
NOT have this field yet — ADD it + an `ImplClosureCallInfo` object.

- (A) `generate_closure_construction` (closures.ts:250) — UNPORTED (yo-self
  closures.yo has only the 3 helpers, not this). For Impl(Fn) with captures:
  `allocate_closure_capture` (closures.ts:99) builds `(captureCName){ .field = arg }`
  (stack alloc, value semantics; each field via generateExpr of its dup-expr or a
  synthesized Atom), emits `captureCName tmp = {...};`, registers
  `implClosureCallMap[resolveSomeTypeToConcrete(captureType).id] = {functionCName,
  callType,...}`, returns the temp var. Route closure-construction FnCall exprs
  (is_closure_construction already exists, closures.yo:62) to this in the expr
  dispatcher. Without-captures + Dyn branches also exist (closures.ts:314-356).
- (C) call-site (other-fn-call.ts:2103) — when calling a value whose type is the
  capture struct (or a SomeT resolving to it), look up `implClosureCallMap[id]`;
  HIT → `mapped.functionCName(&(cb), args...)` (+ evidence/borrow branches); MISS →
  fn-pointer cast fallback `((ret(*)(params))(closureCode))(args)`.
- DATA-MODEL GAP: TS's `register_impl_closure_call_mappings` pre-pass
  (closures.ts:223) iterates context.functions reading `value.closureInfo`
  (closureType+captureType+consumedCaptures). yo-self FuncVal has NO closureInfo
  field; it uses ExprInfo.closure_function_value + .capture_type + the
  register_closure_capture_info(funcId, ClosureCaptureInfo) registry
  (anonymous_function.yo:1039). So the pre-pass must be rebuilt from those side
  registries, OR rely on per-site registration in generate_closure_construction
  (works when the closure-constructing fn is codegen'd before the consumer; add the
  pre-pass only if ordering breaks). mark_as_closure_fn marks closures.

IMPLEMENTATION ORDER (each ~1 build): (1) add impl_closure_call_map +
ImplClosureCallInfo to utils/index.yo; (2) port allocate_closure_capture +
generate_closure_construction into closures.yo + wire is_closure_construction in the
expr dispatcher; (3) port the call-site closure-call (piece C) in other_fn_call.yo;
(4) fix collection (piece B); validate the apply repro → 15, corpus 75/75, then spawn.

### UPDATE 2026-06-19 (4) — 2nd structural divergence: Struct carries no per-field source exprs.

`allocate_closure_capture` (closures.ts:132) generates each capture field value
from `field.exprs.expr` (the captured-var source expr) + handles `field.isEffectParam`
+ Rc dup-exprs. yo-self's `Struct` TypeValue (definitions.yo:179) has ONLY
`field_labels` + `field_types` — NO per-field source exprs, no isEffectParam flag.
So the capture-struct construction must be ADAPTED: emit `.<label> = <c_var_name>`
where the value is the captured variable accessed in the CONSTRUCTING scope (the
field label IS the captured var name). Use the constructing scope's variable→C-name
mapping (get_variable_name_for_codegen / atom emission); Rc captures need the closure
expr's `deferred_dup_expressions` (ExprInfo) for the dup'd value. Effect-param fields
(io.async bundles) → NULL; detect via the field being an effect-record/fn type since
there's no isEffectParam flag. This is an ADAPTATION, not a transcription — the two
data-model gaps (no FunctionValue.closureInfo; no Struct field source exprs) mean the
A/C port designs from yo-self's ExprInfo + side registries, not TS's field/closureInfo
shapes. The context field (impl_closure_call_map + ImplClosureCallInfo) is step 1 and
must land WITH its consumers (steps 2-4), not as standalone scaffolding.

### UPDATE 2026-06-19 (5) — general closure-param codegen DONE; spawn blocked on method/extern-Type Self-resolution.

MILESTONE (commits cf11393c1, 574c654e8): the general closure-param specialization
codegen WORKS end-to-end. `apply :: (fn(cb : Impl(Fn(x:i32)->i32)) -> i32)(cb(i32(10)))`
called `apply((x) => (x + base))` compiles + runs → prints 15 (matches TS). Corpus
75/75, no regression. Pieces A (capture-struct construction emission), B (collection
past the unknown-value guard), C (closure call via impl_closure_call_map) all landed,
plus the closure-param eval binding (callable SomeT + g_some_resolved_concrete capture
struct), callee-type normalization (SomeT(Impl(Fn))→Func in eval + codegen), and the
spec static-method `-> Self` return resolution.

SPAWN (Thread.spawn, the extern-wrapper IMPL-METHOD variant) remains blocked — but on
a DISTINCT gap from the closure work: codegen's should_skip_function_codegen
(declarations.yo) drops the specialized `Thread.spawn` and `Thread.join`. Confirmed by
instrumentation (DIAG-SKIP):
- `Thread.spawn` spec: `ret=Thread` (Self resolved ✓) but `has_generic_return=T` →
  skip2. Cause: `type_contains_some_type_for_codegen_param(Thread)` recurses into the
  field `handle : __yo_thread_t`, and `__yo_thread_t` (an `extern("Yo", X : Type)`
  declaration) is a SomeT PLACEHOLDER (trait_checking.yo:269). TS excludes extern
  SomeTypes: `if (type.isExtern) return false` (src/types/utils.ts:10). yo-self's SomeT
  has NO is_extern field (the port made that a no-op), so the extern opaque type is
  wrongly counted as a codegen SomeType. FIX OPTIONS: (a) add `is_extern : bool` to
  SomeT + stamp it in the extern-Type declaration path (faithful but touches every
  SomeT constructor/match — broad); (b) register extern Types' resolved-concrete and
  have type_contains_some_type follow it (TS utils.ts:11 does; yo-self's port skips
  it); (c) a narrower extern-type side-table queried here.
- `Thread.join`: `ret=unit` but `has_generic_params=T` → skip2. Cause: its `self : Self`
  param stays an unresolved SomeT in get_func_type(join) — non-generic-struct method
  Self is not resolved to the concrete receiver (Thread) for codegen. Generic-impl
  methods (ArrayList(T)) avoid this via specialization; non-generic-struct methods need
  Self→receiver resolution at method collection/codegen.

These two are method/extern-Type Self-resolution — the next focused unit, separate
from (and unblocked by) the now-complete closure-param codegen.

### UPDATE 2026-06-19 (6) — spawn root narrowed to ONE cause; lowered-type-id attempt + next direction.

Verified both spawn blockers reduce to ONE root: `Thread` contains `handle : __yo_thread_t`
(an `extern("Yo", X : Type)` opaque type = a SomeT placeholder), and
`type_contains_some_type_for_codegen_param(Thread)` flags it → should_skip drops BOTH the
specialized `Thread.spawn` (has_generic_return) and `Thread.join` (has_generic_params via
the same field). Confirmed `Point.get` (a plain non-generic struct, `self:Self` method,
i32 field) compiles + runs fine — so the `self:Self` machinery works; the ONLY difference
is the extern-opaque field.

ATTEMPTED + REVERTED (inert): a `g_codegen_lowered_type_ids` set populated by register_type
(utils/index.yo) and queried in type_contains (exclude SomeTs whose id is a registered
codegen type). DIAG-TC showed every SomeT reaching the branch was `lowered=F` — the
`__yo_thread_t` SomeT id is NOT in the set. Cause: `__yo_thread_t` is a HARDCODED runtime
typedef (codegen/types/generation.yo:409 `typedef struct __yo_thread_t {...}`), not
register_type'd; and/or the field-type SomeT id differs from any codegen-registered id.
Reverted (unvalidated + didn't catch the target).

NEXT DIRECTION (faithful to TS `SomeType.isExtern`): mark extern-Type SomeTs at the
DECLARATION. `extern("Yo", X : Type)` (evaluator/exprs/extern.yo) should record X's name
(and/or the SomeT id once the placeholder is created) in a global extern-type registry;
type_contains_some_type_for_codegen_param then excludes a SomeT whose name/id is a
registered extern type. Verify the extern SomeT's `name` field == "__yo_thread_t" first
(extend the DIAG-TC to print the name). This is the single fix that unblocks spawn end to
end (both spawn + join). Then: spawn repro → `thread sees 42` / `main done`, corpus 75/75,
add a parallelism corpus fixture.

### UPDATE 2026-06-19 (7) — extern-Type exclusion landed (spawn compiles through to the wrapper); LAST blocker = capture-struct identity.

Commit 292d8af81: the extern-opaque-Type exclusion (g_extern_type_names, populated
by extern.yo, queried in type_contains_some_type_for_codegen_param) WORKS — verified
`__yo_thread_t` is now `extern=T`. `Thread.spawn` + `Thread.join` now COMPILE and
EMIT (were undeclared). The spawn-wrapper emitter (parallelism.yo) was adapted to
handle `cb` being the lowered capture-struct PARAM (capture type from cei.ty, closure
fn + funcId from impl_closure_call_map's new closure_fid field). Corpus 75/75, apply
still prints 15.

LAST BLOCKER (capture-struct IDENTITY): inside the specialized `Thread.spawn` body,
`__yo_thread_spawn(cb)` looks up impl_closure_call_map by cb's capture-struct id, but
that id (`__yo_capture_..._5654`, the spec param type from the eval-time arg_ty_spec)
DIFFERS from the id the closure construction in `main` registered under
(`__yo_capture_..._5638`, the codegen ei.capture_type). → "spawn cb has no closure
function". The closure's `ExprInfo.capture_type` is created with a fresh id on the
eval pass (sets the spec param) vs the codegen pass (does the construction); for the
free-function `apply` repro they coincided (one capture struct, works), but the
Thread.spawn METHOD path re-evaluates the closure → a second capture struct id.

FIX DIRECTION: unify the closure's capture-struct identity across eval/codegen (create
it ONCE per closure and reuse, or canonicalize the id), OR register impl_closure_call_map
under a stable key both sides compute (e.g. the closure funcId, which is stable — key
the map by the closure's funcId instead of the capture-struct id, and have both the
construction and the spawn site look up by funcId). The funcId-keyed approach is likely
the cleanest: generate_closure_construction has the closure FuncVal (fid); the spawn
site has cb's closure (via the spec param's source) — thread the closure funcId to the
spawn site. TS sidesteps this by sharing the same StructType object (reference identity)
for the closure's capture across eval+codegen.

### UPDATE 2026-06-19 (8) — spawn final fix = pre-pass + capture-struct-id alias + ordering (not a one-liner).

Tried a call-site alias (in main's Thread.spawn-call codegen, register
impl_closure_call_map[specParamCaptureId] = [closureConstructionCaptureId]).
DIDN'T unblock spawn → confirms a GENERATION-ORDERING issue: the specialized
`Thread.spawn` BODY (which does `__yo_thread_spawn(cb)` and reads the map by cb's
capture-struct id) is codegen'd BEFORE `main`'s closure construction + alias run,
so the map is still empty there. Reverted (unvalidated + ineffective alone).

TS avoids both problems via `registerImplClosureCallMappings` — a PRE-PASS
(closures.ts:223) that walks all collected closure functions and populates
impl_closure_call_map BEFORE any function body is generated. yo-self deferred this
pre-pass (relied on per-site construction registration, which works for the
free-function `apply` case where the consumer body happens to be generated after
the producer, but NOT for the Thread.spawn method case).

COMPLETE FIX (do together, validate corpus 75/75 + spawn + apply):
1. Port register_impl_closure_call_mappings as a PRE-PASS in compile_module/
   generate_all_functions, BEFORE bodies. yo-self has no FunctionValue.closureInfo,
   so iterate the closure registry (mark_as_closure_fn / register_closure_capture_info
   ClosureCaptureInfo) — each closure's capture struct + impl fn C name + funcId.
2. Capture-struct IDENTITY: eval and codegen mint different ids for the same
   closure's capture struct (create_capture_type_and_value uses random_id,
   closure.yo:218). EITHER make that id stable per closure (derive from a stable
   closure identity — hard, fresh func_ids per eval), OR have the pre-pass + call
   site register the map under BOTH ids (construction id AND the spec-param id the
   cast targets). The call-site alias (computed here) feeds the pre-pass'd map.
3. Then the spawn-wrapper lookup (parallelism.yo, capture-struct-param path) hits.

This is the single remaining piece for spawn end-to-end; it's a bounded but
multi-part change (pre-pass + identity reconciliation + ordering), not a one-liner.
