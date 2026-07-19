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
