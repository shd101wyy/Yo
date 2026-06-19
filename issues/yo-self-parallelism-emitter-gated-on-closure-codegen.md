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

LAYER-2 MECHANISM (investigated 2026-06-19): create_specialized builds the
specialized param types at helper.yo:1285-1287 via
`convert_comptime_type_to_runtime_type_with_expected(rpt, Option(TypeValue).None,
callee_env)` — `expected = None`. So to resolve `cb`'s SomeT to the concrete
capture struct, layer 2 must thread the call's CONCRETE arg type in as that
`expected` (currently None) — i.e. pass the per-param resolved arg type so the
SomeT param lowers to the capture struct in `spec_param_types`. Then spec_type's
`cb` is concrete (option (a)) and it's emittable directly (layer 1's
resolved-concrete clause then mainly helps cases where the SomeT identity is
retained). Net layer-2 edits: (1) function.yo:2509 trigger broadened to
non-forall soft-generic (is_function_type_generic, !is_control_fn); (2) thread the
concrete arg type as `expected` into the spec-param-type conversion so `cb`
resolves. Validate heavily (hot path).

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
