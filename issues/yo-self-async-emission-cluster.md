# yo-self: async/worker emission cluster (post-IoExn-erasure tail)

The IoExn erasure fix (annotation-driven forall substitution + NULL
io-builtin fields) moved 4 of the 7 rc=-6 files past the abort into
ordinary C-compile failures. Probing those batches (`YO_KEEP_BATCH=1`,
binary /tmp/s1io 2026-07-19) isolated four distinct, small emission bugs
plus one unported feature. TS references verified against `a.out.c` for
the same batches.

## 1. Statement-level `io.spawn` temp collision (sys/timer, worker)

```c
io_async_block_yo_id_6116_sync_fut_t* __spawn_future = task1;   // first spawn
io_async_block_yo_id_6118_sync_fut_t* __spawn_future = task2;   // redefinition!
```

Two unbound spawn statements in one C scope. Both sides suffix the temps
with `ei.variable_name` / `expr.$.variableName` — but TS's evaluator
attaches a TEMP name to statement-level spawns
(`__spawn_future__yo5eba12b3_temp_44063` in TS-emitted C), while yo-self's
`ei.variable_name` is `.None` there. The eval-side name carry was tried
before and REVERTED (double-emit nondeterminism — see handoff). Fix shape
(consumer-side, deterministic): in `_generate_io_spawn`
(codegen/exprs/generation.yo:294), fall back to
`__spawn_future_expr_<ast_expr_id(expr)>` when `variable_name` is absent.

## 2. Await-closure re-registration drops source param labels (sys/timer)

```c
static inline void closure_yo_id_6060(void* closure_context, __yo_t24 e) {
  ... yo_id_5159((__yo_t24)(io));   // 'io' undeclared — proto says 'e'
```

`evaluate_anonymous_function_implementation` registers the closure with
SOURCE labels (the L3 fix, corrected_func_type), but the Phase-5 result
refinement at anonymous_function.yo:1314 RE-registers with
`t_func_simple(param_labels, …)` — the EXPECTED labels (`e` from
`Fn(e : E)`), clobbering L3 for every closure the refinement touches
(concrete body type + closure-marked; the timer task closures qualify).
Fix: use `actual_param_labels` there. (cfrc's yield closure dodged this
only because its body never references the param.)

## 3. Closure registered result stays unit while body returns a value (worker)

```c
static inline void closure_yo_id_6166(void* closure_context, __yo_t23 io) {
  ... return counter;   // -Wreturn-mismatch, prototype says void
```

The :1314 refinement (which would stamp the concrete i32 body type) did
not reach the emitted generation's fid. Needs a probe of which
registration the codegen-read generation carries (the sticky-marker
re-eval path).

## 4. Unit-typed await result declared as `void x = ;` (worker)

```c
void _file____User_temp_6592 = ;
```

A unit-returning future's await result gets a C declaration; TS omits
the declaration for unit results. Locate the await-result declaration
emitter and skip unit types. (The same batch also emits `(() == ())` for
a unit comparison — check TS's lowering for unit equality while there.)

## 5. Iso lowering unported (iso, rc — the remaining rc=134 pair)

`get_type_string: Iso lowering is Phase 3 — not yet ported`
(codegen/utils/index.yo `.IsoT({}) => __yo_panic`). Both files' batches
abort in the type-string of an Iso type. This is a PORT work item
(getTypeString's Iso branch + iso type collection/runtime), not a bug.

## Scoreboard effect (updated after the same-cycle fixes)

Items 1 and 2 are FIXED in the same commit as the IoExn erasure pair
(spawn expr-id suffix fallback; :1314 actual_param_labels), plus a third
emitter fix the corpus exposed: `_materialize_arg` re-declared a
capture-read under the same source name for every effectful call
(`yield(io)` twice → C redefinition) — now guarded by
scope_stack_contains (the io_async_fsm_multi corpus file's old "PASS"
had never emitted its awaits at all: `// Error: await argument must be a
Future type` placeholders returning 42 by luck; with the annotation fix
the awaits emit for real).

- tests/control_fn_as_regular_call.test.yo: FLIPPED green (3 passed).
- tests/codegen-bootstrap/io_async_fsm_multi.yo: emits real awaits,
  compiles, runs (42) — strictly more faithful than the pre-fix state.
- sys_timer: COMPILES now; 1 behavioral failure — the interleaving
  asserts fire because yo-self lowers awaits inside the closure as
  BLOCKING sync-await poll loops while TS transforms the closure into a
  resumable FSM (`_yobbb56756_temp_40816_resume` switch); `yield` never
  actually yields. NEXT LAYER: the io.async closure FSM transform
  (codegen/async/ port) for multi-await closures.
- worker: rc=139 (items 3-4 remain: void-closure result registration,
  unit await-result declaration).
- thread / iso_api_surface: rc=1 (untriaged tail of the same batch).
- iso / rc: rc=134 — blocked on the UNPORTED Iso lowering (item 5).

## 6. io.async result-T cell cross-poisoning (the remaining void-closure root)

20-line repro (scratchpad/void_closure_batch.yo): TWO io.async tasks in one
batch main — t0's action returns `i32(42)`, task1's action returns unit
(trailing assignment). Under the unit-tail-guard build:

- task1's closure emits CORRECTLY (tail as statement, `void` signature) —
  the generation.ts:1687 unit-tail port works.
- t0's closure emits an EMPTY body (`{ return; }`) under a `void`
  signature, and the await result read collapses (`int32_t r0 = ;`).

Mechanism (the ResumeType/IoExn-E class again, now for T): io.async's
declared `Fn(E) -> T` T is ONE declaration SomeT; per-call clones SHARE
the slice-1 resolution cell. Whichever call resolves first stamps the
cell; the other call's closure registration/prototype then renders the
WRONG resolution (unit-poisoned i32 task → empty body + void signature;
in the full async_await batch the mixed population yields the 8×
"void function should not return a value").

FIX SHAPE (established discipline, helper.yo ctl sites): the per-call
resolution must REBUILD a fresh SomeT + seeded cell (`t_resolved_cell`)
for the registered/ExprInfo type instead of mutating the shared cell —
i.e. the yo-self mirror of TS anonymous-function.ts:963-988
(`functionType.return.type.resolvedConcreteType = runtimeType` on TS's
per-call CLONED type object) must not write through the shared handle.
Locate where the closure's result SomeT gets its resolution stamped after
body eval (or add the missing stamp) and apply the fresh-cell rebuild.

Note: `_materialize_arg`'s empty-await-result sibling (`int32_t r0 = ;`)
is the same poisoning seen from the CONSUMER side (the future's T renders
against the poisoned cell) — expect one fix to close both.

**SHARPENED (REFINE-instrumented probe of the repro):** t0's action
evaluates TWICE — gen A (`closure_yo_id_5001`) refines with body_ty=UNIT
(mis-typed eval) and gen B (`closure_yo_id_5007`) with body_ty=i32
(correct) — and CODEGEN consumes gen A: collected fid = 5001, emitted
body = EMPTY (its stored body tree carries no evaluated ExprInfos — the
"codegen-read closure is a CLONE with fresh expr-ids" identity split),
signature void. So the T-poisoning presents as a GENERATION-IDENTITY
problem: the io.async call's ExprInfo.closure_function_value points at
the stale generation. Fix direction: extend the SOURCE-key
cross-generation merge (already done for capture info via
g_closure_fid_source / keep-larger) to the FUNC-TYPE registration — the
refinement registers under the source key too, and the codegen-side
get_func_type consumer prefers a source-merged CONCRETE-result
registration over a fid-keyed unresolved/unit one; alternatively fix the
collection to reference the LAST evaluated generation.

## 7. THE EVAL-SIDE ROOT (supersedes item 6's codegen-side view)

Swallow-instrumentation with last-expr diagnostics (s1dbg5) proved the
async_await class is EVAL-side: every failing closure's def-eval throws
begin.yo:1041 "Return type mismatch. Expected unit, got i32" (or vice
versa) because the RE-EVAL generation's expected `Fn(E) -> T` carries a
T CONCRETIZED FROM A SIBLING CALL. Mechanism: TS clones the callee's
function type PER CALL (specializeFunctionType deep-copy), so
`resolvedConcreteType` stamps are per-call-isolated for free; yo-self
deliberately PRESERVES the io.async OUTPUT SomeT id across calls
(function.yo ~3678: "the io.await resolution keys on the output id") and
resolves eval-side awaits via `lookup_some_resolved_concrete(tid)` — a
GLOBAL keyed by that shared id (function.yo:3683/:3989). First call
resolves T:=unit → global + shared lineage cell poisoned → an
i32-bodied sibling's re-eval sees expected unit → throws → trial
swallowed → no result refinement → stale registration → the 8×
"void function should not return a value" + downstream `void x = ;`.

FAITHFUL REWORK (restores TS's per-call identity at the call boundary):

1. function.yo io.async return-type minting: rebuild the FutureTraitT
   OUTPUT SomeT per call — fresh id, same name, FRESH empty cell (the
   t_resolved_cell discipline) — so the synthesizer's slice-1 cell
   mutation lands on THIS call's lineage only.
2. Eval-side await result resolution (:3683/:3989): read the FUTURE
   ARG's type → FutureTraitT output → per-call CELL first; the tid
   global becomes the last-resort fallback (mirrors the v6 codegen-side
   await fix, 78000440a).
3. Codegen await/spawn/state consumers already prefer per-call data
   after 78000440a.

### Item 7 probe results (per-call freshening, s1dbg6)

The uniform "expected unit/got i32" swallow class is GONE (the per-call
fresh output id + cell isolates sibling io.async calls as designed). The
batch surfaces the NEXT two layers:

- 8× `returning 'int32_t' from a function with result type '__yo_t36 *'`
  — some closures' PROTOTYPES now render the FUTURE STRUCT POINTER as
  their result: an unrefined registered result SomeT resolving (cell or
  fresh-id global) to a WRAPPER future type. Suspect: the
  `register_some_resolved_concrete(oid, rr)` bridge writing a
  future-typed rr (a DELEGATE closure's registered result) under an oid
  that a non-delegate closure's result render reads. Needs the oid/rr
  trace (next probe).
- Residual swallows (13, varied): `Expected type "Output", got unit` on
  bare-`return` bodies (test 8's early-return closure) — the expected
  renders "Output" yet passed the `!is_some_type` gate; ekey diagnostic
  added (s1dbg7) to reveal the actual variant.

### Item 7, layer 2 (s1dbg8 probe): the ACTION-PARAM T shares the declaration id

`__yo_t36` = std/process's `Output` STRUCT (not a future). The remaining
8× wrong prototypes render `Output*` because the CLOSURE's registered
type carries the ACTION PARAM's `T` (from `action : Impl(Fn(E) -> T)`),
whose id is the DECLARATION's — shared by every io.async call. During
std eval, command.yo's `io.async(...) -> declared Impl(Future(Output,
IoExn))` unification registers that shared id → process::Output
(synthesizer stamp), poisoning every later closure's result render.
The return-side-only freshening (item 7 layer 1) split T's identity:
param-side T old/shared, return-side T fresh — the closure-body
unification (T := body) no longer reaches the future's output either.

CORRECT SHAPE (= TS specializeFunctionType): freshen the WHOLE callee
Func per io.async call at CALL ENTRY — one name→fresh-SomeT mapping
applied consistently to the action param's `Fn(E) -> T` AND the return's
`Future(T, E)` — so the per-call lineage is closed end-to-end (closure
registers fresh-T; body unification seeds fresh cell; await reads it).
The residual "Expected Output" def-eval swallows in the batch are
command.yo's OWN closures' std-eval noise (pre-existing swallow
philosophy), NOT the async_await failure.

### Residual-class probe (s1dbg10, [CONCEXP])

~150 closure evals per async_await batch arrive with a CONCRETE
(non-SomeT) expected RESULT — all under `fb=fnbody`, `ioasync=n`: these
are the ENCLOSING fn's def-time body evals re-evaluating each io.async
call after its unification resolved the per-call T (TS does the same;
they mostly succeed). Distribution: 126× unit, 16× i32, plus
Output/ExitStatus/struct singles. The 9 swallowing closures are the
mis-paired minority: an i32-bodied closure receiving expected UNIT.
NEXT correlation (2-line patch, one build): re-add the [SWALLOW] print
alongside [CONCEXP] and match positions/fids — then trace WHICH call's
resolved-T the mis-paired expected came from (suspects: the
`register_some_resolved_concrete(oid, rr)` bridge pairing rr from the
WRONG action fid when a test has multiple io.async calls in one
statement list, or gen-1 body_ty mis-derivation for `return(v)`-tailed
bodies).

### RESIDUAL CLASS ROOT IDENTIFIED (s1dbg11 correlation + s1dbg5 DBG chain)

Paired [CONCEXP]/[SWALLOW] proves each swallowing closure receives the
CORRECT expected (arm 0's task is genuinely unit) — the BODY mis-types
i32. The s1dbg5 last-expr diagnostic showed WHY: gen-2 of the closure at
batch 15:88 (arm 0, body = printf/Box/assign/await/assert/()) evaluated
a begin whose LAST expr was `return((bb.(*)))` — an expression from a
DIFFERENT test's closure (source line 46, the i32-returning task). The
re-eval generation is reading CROSS-WIRED expression state: the
ast-expr-id collision class (clone_expr_fresh_ids ids vs parser ids in
one id space; the id-keyed ExprInfo table lets one tree's stamps alias
another's — the same mechanism attempt #6 recorded as "calls overwrite
each other's annotations"). The 2× swallow per closure = two id-aliased
re-eval generations.

ID-COLLISION HYPOTHESIS REFUTED (static check): parser and
clone_expr_fresh_ids share ONE global counter (expr.yo:314
`alloc_global_expr_id`; parser.yo:150 calls the same fn) — "parser nodes
and synthesized nodes share the sequence". No aliasing is possible.

The cross-wiring is therefore at the BODY/FUNCVAL FETCH level: gen-2's
trial eval receives a body TREE belonging to a different closure
(arm-0's eval saw `return((bb.(*)))` — the i32 task's expr). NEXT (fresh
session, one probe build): at evaluate_anonymous_function_implementation
entry, print `ast_expr_id(body_expr)` + the body's FIRST-token position
alongside [SWALLOW]/[CONCEXP]; then trace where the re-eval driver got
that body (the io.async arg's ExprInfo.value FuncVal? the deferred-eval
queue? closure_type.yo's arg extraction?) — whichever registry handed
gen-2 the wrong FuncVal is the fix site.

**DISAMBIGUATED (s1dbg12 [BODY] probe): the NESTED-eval reading is
correct.** Every swallowing closure's trial receives its OWN body
(`closure@15:88 body@15:91` — adjacent positions, correct arg
extraction). The "Return type mismatch (unit vs i32)" is thrown by a
NESTED evaluation somewhere INSIDE the trial (the capture-free swallow
wall catches every nested throw, mis-attributing it to the outer
closure), and the s1dbg5 `last=return((bb.(*)))` names the nested
begin's last expr — an expr tree that does not belong to arm 0's source.
NEXT SESSION: instrument begin.yo's :1041 throw with the ACTIVE
fctx.func_type render + the begin expr's OWN id/position, run the batch,
and identify which nested eval (yield's def-eval? a deferred completion
queue? an effect-dispatch re-eval?) executes foreign expression trees
under the ambient FunctionBody context — the fix is making that driver
carry its own recorded context (or scope the check to the IMMEDIATE
body). The 2x-per-closure swallow repetition and the exact C-error
count (8) vs swallow count (9) are consistency checks for the fix.

### Arg-census ground truth (s1dbg14) — the frontier, precisely

The mismatching begin IS the i32-returning closure's own coherent body
(census: printf/assert/Box/increment/await/printf/assert/`return((bb.(*)))`,
9 args, all tokens consecutive — earlier cross-line archaeology was
misled by REGENERATED batch files shifting arm→line mappings; only
same-run probes are trustworthy). The defect: this closure's def-eval
runs under expected `fn(e : Io) -> unit` — E:=Io AND T:=unit BOTH
resolved in the FnTrait the expected wrapper carries, though THIS call's
fresh T should be unresolved (or i32). The `e` label proves the type
came through `_func_from_fn_trait(extract_fn_trait_from_type(wrapper))`.

TWO additional facts from [CONCEXP]:

1. EVERY closure eval in the batch reports `ioasync=n` — the UnknownVal-
   callee arms (where builtin io.async calls actually land) NEVER set
   `ctx.is_inside_io_async_call`; only the FuncVal arm does. TS sets
   `isInsideIoAsyncCall` keyed on `functionType.ioBuiltin` REGARDLESS of
   the callee-value shape (helper.ts:1314). This is an independent
   faithful-port defect: the flag drives await-analysis attachment and
   the sticky closure-codegen marking — fix by setting/restoring the
   flag around try*to_call_function_with_arguments in BOTH `*` arms
   (mirror of the :2770 FuncVal-arm block). It may or may not be the
   T:=unit vector — fix it first, re-probe.
2. The swallowing evals are all `fb=fnbody` — the enclosing fn's
   def-time body eval — i.e. gen-1 IS the swallowing generation (there
   are no successful earlier generations for these fids; the refinement
   never runs for them).

NEXT SESSION SEQUENCE: (a) port the missing is_inside_io_async_call
flag in both UnknownVal arms; (b) re-probe [CONCEXP]/[MISMATCH] — if
T:=unit persists, instrument extract_fn_trait_from_type to print where
the wrapper's FnTraitT result got its resolution (the remaining
candidates: the trait-checking extraction resolving through a cell, or
resolve_param_types_from_expected in an arm without freshening).

### Step-(b) trace state (static, post flag-parity)

- `extract_fn_trait_from_type` does NO resolution — it returns the
  FnTraitT AS STORED in the wrapper (trait_checking.yo:1149). The
  expected wrapper reaching the swallowing eval is ALREADY concretized
  (`Fn(e : Io) -> unit`).
- `resolve_param_types_from_expected` (helper.ts:1283 mirror) is
  EXONERATED: called only from the FuncVal-callee arm and gated on
  `ctx.expected_type.is_some()` — the binding-RHS io.async calls have
  no expected and take the UnknownVal arm.
- REMAINING CANDIDATE (one): gen-2's expected derives from the
  closure's gen-1-STAMPED ExprInfo type (corrected_func_type), whose
  result is the per-call fresh T — the SAME SomeT instance (shared
  slice-1 cell) as the call's T. Between generations the call machinery
  resolves that T (synthesizer cell-stamp) — to UNIT for these i32
  closures, i.e. the call-side resolution itself is wrong (suspect: a
  unification of the closure/future type against a unit context, e.g.
  the enclosing statement/arm merge, or are_types_compatible resolving
  T := unit during the gen-1 SWALLOWED eval's partial body run).
  DECISIVE PROBE (one build): at the [CONCEXP] site print the expected
  wrapper's FutureTraitT-output/FnTrait-result SomeT ID + cell content;
  at the synthesizer cell-stamp sites (synthesizer.yo:1262/:1351) print
  registrations whose given/expected is unit with the SomeT id — match
  the ids to name the exact stamping unification.

### Stamp probe result: ZERO `T := unit` cell registrations

The synthesizer stamp sites (synthesizer.yo:1262/:1351) NEVER register
T:=unit in the whole async_await batch — the cells/global are NOT the
unit vector. types/substitution.yo recurses FnTraitT.call_result and
FutureTraitT.output correctly, so the freshened wrapper carries fresh-T
inside its FnTraitT. Therefore the swallowing eval's expected — a
CONCRETE `fn(e : Io) -> unit` (FnTrait labels!) — was CONSTRUCTED
concrete somewhere between the freshened callee and the closure eval.
NEXT PROBE (the narrowest yet): in helper.yo's
check_if_function_parameter_matches_argument (the arg-eval that sets
expectedType = the declared param, helper.ts:330 mirror), print the
EXPECTED it passes for io.async action args (render + whether the
FnTrait result is SomeT/concrete). If concrete there → the param type
was re-built/re-evaluated between freshening and arg-eval (suspect:
`evaluate_function_return_type_again`-style re-evaluation of
`Impl(Fn(e : E) -> T)` in the callee env, where the AST re-eval
constructs a NEW FnTraitT whose result defaults/resolves to unit when
`T` binds a placeholder). If SomeT there → the [CONCEXP]-firing evals
are NOT the param-matching arg evals at all, and the driver is a
statement-position replay reading a stored concrete type.

### Flag-parity port (helper.ts:1314) REVERTED — S1E_NONDETERMINISTIC

Setting `is_inside_io_async_call` in the UnknownVal arms (v9 candidate)
failed the same-binary double-emit determinism gate: the flag routes
every builtin action closure through the await-analysis/capture-info
machinery, whose registration bookkeeping is emission-order-sensitive
(the same nondeterminism class as the reverted eval-side variable_name
carry). The parity port is still CORRECT per TS — it needs a
determinism-safe landing: first find which flag-gated registration
diverges between two emits of one binary (suspects: closure capture-info
keep-larger merges keyed by hash order; sticky codegen marking consuming
random_id differently per pass), fix THAT ordering, then re-land the
flag.

### THE COMPLETE RESIDUAL MECHANISM (settled by elimination + Step-2 read)

check_if_function_parameter_matches_argument Step 2
(`evaluate_function_parameter_type_again(param_type, callee_env)`,
helper.yo:457) re-evaluates the param type BY NAME in the callee env.
Every task body awaits `yield(io)`, whose NESTED io.async call rebinds
the ambient `T` in the shared mutable env chain to UNIT (yield's action
returns unit) — the outer call's Step-2 re-evaluation then reads `T` →
unit and constructs a CONCRETE `Fn(e : Io) -> unit` expected for the
outer action closure. Uniform unit across the batch (every body yields),
i32 closures swallow, unit closures pass by luck — every probe datum
fits. TS is immune because its env chains are persistent/immutable and
its per-call parameter clones resolve without name lookups.

FIX (designed): io.async's param types SKIP the Step-2 name-based
re-evaluation — they are already per-call instantiated by
\_freshen_io_builtin_callee. Plumb an explicit
`use_param_type_directly : bool` through
check_if_function_parameter_matches_argument (the caller loop already
computes is_io_async_call(expr)); do NOT key on
ctx.is_inside_io_async_call (it stays set through nested arg evals whose
own params DO need re-evaluation... and it is reverted anyway).

### v11 gate failure bisect (capture-read rewrite)

The v11 pair (Step-2 skip + capture-context read) SELF-FAILED
closure_capture_rc_dup + io_async_bundle_field and broke the stage2 C
compile (`__yo_t113 __yo_eff_bundle = e` — initializing a bundle struct
from `e`, the closure's void* C PARAM). Root: the capture-literal
rewrite keyed ONLY on `current_closure_captures.contains(name)` — but
the captures side-table can contain names that are REAL C parameters of
the current fn (the SM bundle param `e`), and rewriting those to
`((cap*)closure_context)->e`references a nonexistent capture field.
REFINED FIX: in-scope names win — check`scope_stack_contains(context.base.declared_scopes, lbl)` FIRST (bare
read), only then the captures rewrite (same precedence as the atom
emitter). Bisect build s1v12 (Step-2 skip alone) in flight to confirm
the skip is gate-clean solo.

### v12 bisect verdict: the Step-2 skip is TOO BROAD — revert both; the refined design

Step-2-skip-only (s1v12) still SELF-FAILS closure_capture_rc_dup (rc=1)
and io_async_bundle_field (rc=139): the name-based re-evaluation is
LOAD-BEARING for effect-bundle param shapes (it resolves `E` to the
enclosing row). Both v11 changes are reverted; the tree returns to
25f5f9e89-committed state.

THE PRECISE ROOT (ordering fact): within ONE call, Step 2 runs BEFORE
the arg eval (so the nested-yield rebind cannot poison the SAME call's
expected). The poisoned generation is the SECOND def-eval pass — the
nested call's `T` rebind PERSISTED in the shared env chain across
generations (the rebind wrote through to an outer/module frame instead
of the call's own placeholder frame). THE ROOT FIX (next session): the
forall REBIND during synthesis/param-matching must be scoped to the
call's OWN placeholder frame (frame-level check at the rebind site in
try_to_call_function_with_arguments/synthesize) so nothing persists
after the call pops — TS equivalence via persistent env chains.

WITH that scoping, the v11 pair becomes safe to re-land:

- the Step-2 re-evaluation reads clean bindings (no skip needed at all —
  drop `use_param_type_directly` entirely), and
- the capture-literal rewrite needs the scope-stack precedence refinement
  (in-scope C params win over the captures side-table) since the `e`
  bundle param regression is independent of the env story.
  PROOF OF VALUE: with the (buggy) v11 pair, tests/async_await.test.yo
  went WHOLE-FILE GREEN — 116 passed, zero C errors — so the endgame for
  this file is fully de-risked; only the two refinements above separate it
  from a gate-clean landing.

### v14: identity-gated rebinds — regression-clean, async_await surface persists

The identity gate (found slot's stored SomeT id must match the lineage
being resolved; mismatch → shadow) holds the repro + both bundle corpus
files, but the async_await swallows persist: the poisoning update's slot
holds a RESOLVED (non-SomeT) value at update time — no id to compare —
and lands in an AMBIENT top frame the frame-check treats as legitimate.
Remaining routes, in order of preference:

1. Frame MARKER (`is_call_placeholder : bool` on Frame, set by
   try_to_call's placeholder push): in-place updates allowed ONLY inside
   marked frames; ambient tops always shadow. Invasive (env.yo + push
   sites) but principled — models TS's per-call scope exactly.
2. Narrowed Step-2 skip: understand first WHY bundle-field actions need
   the param re-evaluation even though their `(e : IoExn)` annotation
   should resolve E via the annotation pass (probe: compare the
   annotation-pass result for bundle actions with and without the
   re-eval; the v11 rc=139 says something else in the re-eval matters).
   The v14 identity gate itself is sound hardening (prevents cross-lineage
   in-place updates whenever ids ARE visible) — gated for standalone commit.

### Scoping-mechanism elimination complete — the write is NOT in \_bind_some_type

Four scoping mechanisms tried at the synthesis slot-update site:

1. frame check (67acb7390, LANDED — real write-through class fixed),
2. lineage-identity gate (92b27f68b, LANDED — placeholder repaints fixed),
3. call-placeholder frame markers (probed OUT: ~475 ambient-top `T`
   updates per file are LEGITIMATE — no frame-level separation exists),
4. resolution provenance (var-id → source-SomeT-id; regression-clean but
   async_await-neutral).
   Conclusion: the unit-expected poison does not flow through
   \_bind_some_type's update arm. NEXT DECISIVE PROBE: at the swallowing
   closure eval, print whether a PRIOR ExprInfo exists for the closure expr
   and render its STAMPED ei.ty — if the stamp already carries `-> unit`,
   the poison was baked in at gen-1 completion by the call machinery's
   post-match write-back of the substituted param type onto the arg's
   ExprInfo (check_if_function_parameter_matches_argument's post-match
   section — UNEXAMINED so far), and the fix is scoping THAT write-back
   (per-call type, not the memo/interned shared instance). Also check
   `_freshen_io_builtin_callee`'s intern_type interaction: post-resolution
   `Fn(Io) -> unit` instances are structurally equal across calls and
   intern-shared — verify no consumer mutates through the shared instance.

### Write-back probe: prior=NO universally — the driver passes the poison

Every concrete-unit-expected closure eval (130/batch) has NO prior
ExprInfo stamp: these are FIRST evaluations of fresh-id CLONE trees, and
the concretized `fn(e : Io) -> unit` expected arrives through
`ctx.expected_type` from the DRIVER that initiates the clone eval — not
through stamps, cells, globals, or \_bind_some_type (all eliminated).
PRIME SUSPECT (matches the file's own "codegen-read closure is a CLONE
with fresh expr-ids, evaluated WITHOUT is_inside_io_async_call" note):
create_specialized_function_inline's body re-eval — it clones the
enclosing fn body and sets ctx.expected_type around statement evaluation
(helper.yo:1432 region). NEXT PROBE (one build): print at the [WBACK]
site the ctx.is_evaluating_function_body fn NAME/type + whether a spec
re-eval is active (ctx flag), and at helper.yo:1432 print what expected
is being set when the enclosing fn contains io.async calls. The fix will
be making the driver evaluate the cloned io.async ARG with the DECLARED
(freshened) param expected — i.e. routing the clone's arg eval through
the same per-call machinery as gen-1 — rather than a leaked
sibling-resolved Fn type.

## 8. Generic-impl dispose family (std/sync + ordered_map/imm_map) — GAP-6-BLOCKED

`collectDisposeMethodsFromGenericImpls` (TS collection.ts:650) was never
ported — but the port is NOT the direct-registration TS shape: yo-self's
find_methods_from_generic_impls returns a GENERIC (hard-generic,
emission-skipped) FuncVal, so the constructor's
`header.dispose_fn = <fid>` renders an undeclared identifier
(yo_id_6143 = Mutex's Dispose impl, the whole sync family + 2
collections files). Three-stage fix attempted (trace-sibling-shaped
monomorphizer via create_specialized_function_inline + emittable-entry
resolver preference in get_dispose_function_for_type): regression-clean
(async_await 116 + bundles hold) but the spec never lands — the Mutex
dispose body trips create_specialized_function_inline's documented
weaknesses (the Gap-6 class; it also dragged an uncollected constructor
**yo*new***yo_t22 into the batch). REVERTED (uncommitted); the family
rides with the Gap-6 dedicated arc (wip/resolution-time-spec, attempt #6
salvage plan). All three edit shapes are in this ledger's history for
re-application once create_specialized_function_inline handles
static/nested generic-impl bodies.

## 9. `\u` escape decode gap (tests/str.test.yo, likely encoding_json too)

`String.from("café").raw_bytes().len == 5` fails self-compiled: TS
decodes escapes at parse (JSON.parse — the stored VALUE holds the real
2-byte é), while yo-self's StrLit keeps RAW token text and decodes at
consumption — its decoder handles the basics (\n/\t/\"/\\ work
throughout the suite) but NOT `\uXXXX`, and \_c_string_literal's
backslash escaping then turns the un-decoded `é` into a LITERAL
9-byte C string. FIX: add `\uXXXX` (and `\u{...}` if the TS lexer
supports it) → UTF-8 encoding to yo-self's escape decoder (find it by
grepping the byte-92 handling shared by the \n path); check
encoding_json's failure for the same root. Quick win — one decoder, two
candidate file flips.

---

## 2026-07-20 — async-future WRAPPER resolved-concrete is the gap (NEW, un-attempted)

Fresh-binary re-triage confirmed the 7 async-future files (fs/{dir,file,temp,metadata,
walker,fs_convenience}, sys/bufio) all fail the SAME way and it is genuinely Gap-6, but
the mechanism is now PRECISE and points at a specific un-ported TS block:

- Symptom (sync-await path, await.yo:434-443): the `__sync_future` var is declared
  `__yo_io_future_t*` (generic) and then `->__yo_resume_fn` / `->__yo_set_effect_fn` are
  accessed (which that generic struct lacks), AND `__sync_future->result` is `int32_t`
  where the awaited result type is specific. A specialized `_..._sync_fut_t*` struct DOES
  get emitted elsewhere — the await site just isn't using it.
- Reason: `get_type_string(future_type)` falls back to `__yo_io_future_t*` because the
  FUTURE (wrapper `Impl(Future(T,E))` SomeT) has no `resolved_concrete`. A symptom-level
  patch (`is_io_future || future_type_name == "__yo_io_future_t*"` at await.yo:437) peels
  the resume_fn layer but then the result-type mismatch surfaces — proving the fix must be
  the RENDERING (specialized struct), not the classification. Reverted.
- **The precise gap:** yo-self registers the **OUTPUT** SomeT's resolved-concrete
  (`function.yo:3768`, `register_some_resolved_concrete(oid, rr)` where `oid` =
  `_future_output_some_id` and `rr` = the async closure's result type) — i.e. the `T` in
  `Future(T,E)` — but NEVER the **future WRAPPER** SomeT's resolved-concrete. TS sets the
  function RETURN type's `resolvedConcreteType = functionBodyReturnType`
  (**function-type.ts:613-631**), and for an io.async fn the return type IS the wrapper
  `Impl(Future(T,E))`. That whole block (the body-return-type check at 595-611 AND the
  613-631 resolved-concrete population) is **ABSENT from yo-self's `function_type.yo`**
  (713 lines, no `is_some_type` return handling, no body-return check). await.ts:82-95
  reads the wrapper's `resolvedConcreteType`; yo-self's await.yo:60-73 reads it too — but
  it is never populated for the wrapper, so the read always misses → generic fallback.
- **Next experiment (async cluster, ~7 files):** port function-type.ts:613-631 into the
  point where yo-self computes an io.async fn's body return type (NOT necessarily
  function_type.yo — yo-self does def-time body eval elsewhere; find where the async
  closure's concrete result/SM type is known and register it as the WRAPPER SomeT's
  resolved-concrete, alongside the existing OUTPUT registration at function.yo:3768).
  CAUTION: yo-self itself uses io.async — full battery incl. STRICT_FIXPOINT + the async
  canaries (io_async_bundle_field, closure_capture_rc_dup, io-async-result-t-cell-poisoning)
  are mandatory; the wrapper resolved-concrete must be PER-CALL-fresh (the
  `_freshen_io_async_result` lineage) or sibling awaits cross-poison (item 7 above).
