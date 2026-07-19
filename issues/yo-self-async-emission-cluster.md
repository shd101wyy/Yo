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
