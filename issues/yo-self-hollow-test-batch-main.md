# yo-self drops the whole test-batch `main` body — "N passed" can be vacuous

**Status:** OPEN, pre-existing on HEAD (`a5457bad1`), measured 2026-07-26.
**Severity:** invalidates part of the #69 green count. 8 of the 19 gate-battery
files pass without executing a single assertion.

## Proof

Append one deliberately failing test to a copy of `tests/basic.test.yo`:

```rust
test("DELIBERATE FAILURE probe", {
  assert(false, "this assert MUST fail");
});
```

| compiler | result                     |
| -------- | -------------------------- |
| TS       | 33 passed, **1 failed** ✅ |
| yo-self  | **34 passed** ❌           |

yo-self does not run the assertion at all.

**Control — the probe is not measuring a broken harness.** The identical probe
appended to `tests/rc.test.yo`, whose batch `main` is NOT hollow, gives yo-self
**15 passed, 1 failed** — the harness detects the failure correctly there. So a
hollow `main` is exactly what separates a real pass from a vacuous one.

## Mechanism

The test harness generates one batch file per test file whose `main` is a
dispatch on `YO_TEST_INDEX`:

```rust
main :: (fn() -> unit)({
  io :: __yo_builtin_io;
  match(__yo_batch_env.env.get(`YO_TEST_INDEX`),
    .Some(__yo_test_idx) => cond(
      (__yo_test_idx == `0`) => { … test 0 … },
      …),
    .None => ());
});
```

For the affected files yo-self emits exactly this:

```c
void __yo_user_main() {
  // Failed to transpile match(((__yo_batch_env.env).get)(("YO_TEST_INDEX"…
}
```

`grep -c YO_TEST_INDEX` on the emitted batch C returns **1** — the comment. The
binary has 128 correctly-emitted functions and no caller for any of them, so
every index runs an empty `main`, exits 0, and the harness scores a pass.

The marker comes from `codegen/exprs/generation.yo:417`, the
`context.base.get_expr_info(expr)` → `.None` arm. Two things are ruled out:

- **Not a swallowed evaluator error.** An instrumented build printing `err` in
  `_evaluate_expression_wrapper`'s handler (`_expr.yo:1017`) reports ZERO
  throws for `imm_vec` once the `is_runtime_only` port is applied, and the main
  body is still hollow. (Before that port there were 5 throws — see
  `issues/yo-self-stub-inventory.md` — but removing them did not change the
  marker count.)
- **Not the expression being skipped by the wrapper.** Instrumenting the
  wrapper to fire on the exact id codegen looks up (`__DBG_NOINFO id=66070`)
  never triggers — neither as the input id nor as the result id. So the node
  codegen walks was never seen by that evaluation path at all, which points at
  an expr-id divergence: the evaluator recorded info against a different
  (cloned) AST node than the one codegen emits from.

## Scope — 19-file gate battery, HEAD binary (`/tmp/drop_s1`)

`main_hollow=1` means the `// Failed to transpile` marker appears inside
`__yo_user_main`. (Do NOT use a "lines in main" count as the signal — codegen
emits a `switch`'s closing brace unindented, so a naive brace-matched range
stops early and reports 11 lines for perfectly healthy mains.)

| file                        | reported | markers | main_hollow |
| --------------------------- | -------- | ------- | ----------- |
| `comptime`                  | 28       | 1       | **yes**     |
| `prelude`                   | 4        | 2       | **yes**     |
| `async_await`               | 116      | 1       | **yes**     |
| `basic`                     | 33       | 4       | **yes**     |
| `closure`                   | 9        | 1       | **yes**     |
| `imm_list`                  | 16       | 1       | **yes**     |
| `module_struct_unification` | 10       | 1       | **yes**     |
| `fn`                        | 24       | 1       | **yes**     |
| `arc`                       | 15       | 0       | no          |
| `sys/bufio`                 | 22       | 0       | no          |
| `fs/file`                   | 13       | 0       | no          |
| `fs/temp`                   | 7        | 0       | no          |
| `fs/walker`                 | 6        | 0       | no          |
| `sys/signal`                | 1        | 0       | no          |
| `cycle_collector`           | 16       | 0       | no          |
| `imm_string`                | 28       | 0       | no          |
| `ref_struct`                | 3        | 0       | no          |
| `iso`                       | 3        | 0       | no          |
| `rc`                        | 15       | 0       | no          |

**240 of the battery's 356 reported assertions never execute.** The other 11
files emit a real `main` that reads the index and dispatches, so this is
file-dependent, not a blanket harness failure — which is what makes it
diagnosable, and what the `rc` control above confirms.

Identical counts on three binaries — HEAD (`/tmp/drop_s1`), HEAD + the
`type_to_string` visited guard (`/tmp/tts_s1`), and HEAD + guard +
`is_runtime_only` (`/tmp/isro_s1`) — so it is pre-existing and none of today's
changes caused or fixed it.

## Why the existing gates missed it

- GATE 1 checks the battery's PASS COUNTS, and a vacuous pass counts.
- GATE 2 (corpus diff-test) compares emitted C against TS and is clean at
  PASS 140 / DIFF 0 — but its corpus is standalone `compile` inputs, never
  generated test batches, so it never exercises this path.
- The stage2/stage3 hollow-marker gate counts markers in the SELF-COMPILE, not
  in per-test batches.

**New gate needed:** count `Failed to transpile` in
`<dir>/.yo_selftest_batch_1.bin.c` (kept with `YO_KEEP_BATCH=1`) for every test
file, and treat a hollow `__yo_user_main` as a FAILURE regardless of rc.
Harness: `/tmp/hollow_sweep.sh` (this session).

## Consequence for the #69 count

The headline "165/183" counts hollow passes as green. The real number is
unknown until the same sweep is run over all 183 files; on the 19-file battery
the hollow rate is 8/19. Re-baseline before quoting progress.

## MECHANISM FOUND (2026-07-26) — full chain, with an 11-line reproducer

`issues/repros/closure-arg-abandons-enclosing-begin.yo`:

```rust
main :: (fn() -> unit)({
  xs := List(i32).new().prepend(i32(1)).prepend(i32(2));
  doubled := xs.map((x) => (x * i32(2)));      // <- emitted as a comment
  assert(doubled(usize(0)) == i32(4), "…");    // <- and so is everything after
  ()
});
```

1. `xs.map(<closure>)` is evaluated. The forall `U` of
   `map : fn(self, f : Impl(Fn(T) -> U)) -> List(U)` is never bound from the
   closure's actual return type.
2. `map`'s body is trial-evaluated at definition time. With `U` unbound,
   `List(U)` at `std/imm/list.yo:141` short-circuits through CTFE to a fresh
   named unknown, so `(result : List(U)) = List(U).new()` throws
   **`Incompatible types: Expected ctfe_result_yo_id_5179, Given unit`**.
3. That throw is swallowed by `_trial_eval_fn_body`'s `inner_exn`
   (`evaluator/calls/function_type.yo:222`). Its `unwind(())` exits the helper
   — and with it the ENCLOSING begin loop. The statement being evaluated and
   every statement after it never get an ExprInfo. (This is why the begin loop
   prints its statement id and then never prints a loop-end for it: measured.)
4. `codegen/exprs/generation.yo:417` finds no ExprInfo and emits
   `// Failed to transpile <stmt>`.

That also explains the earlier dead end: the wrapper probe never fired on the
missing ids because the node is not skipped and not re-cloned — the loop that
would have evaluated it was abandoned mid-flight.

The bisect that found it: splitting `tests/imm_list.test.yo` into single-test
files, the first one that goes hollow is test 6, `List map` — the first test
that passes a CLOSURE.

### Not the fix

Porting TS's `synthesizeTypes` on the closure return (closure-type.ts:186-196)
into `closure_type.yo` — a genuinely missing port, already flagged in the stub
inventory — was implemented and measured: **no effect on this repro**, because
instrumentation shows `try_to_implement_closure_by_fn_module_type` is never
called for a closure passed as a CALL ARGUMENT. That path is
`values/anonymous_function.yo` (the `=>` lambda path). The binding has to be
fixed there, which makes this the same root as the cluster-B `closure -> void*`
reds — and those have a history of hollow regressions, so gate any attempt on
marker counts, not test flips.

### Measured on the `=>` lambda path (2026-07-26) — two more dead ends, recorded

Instrumenting `helper.yo`'s Step-6 synthesize shows exactly what the caller
sees for `xs.map((x) => (x * i32(2)))`:

```
param=f  expected=Impl : (Fn(i32) -> U : (Send))
         given   =fn(a : i32) -> U : (Send)          <- should be -> i32
```

So the closure's OWN type keeps the expected return `U`; Step 6 then binds `U`
to itself and nothing is learned. Two fixes were implemented and measured, and
NEITHER clears the repro:

1. **Stamp the SomeType return from the body type** — the faithful port of
   TS anonymous-function.ts:963-988 (`functionType.return.type
.resolvedConcreteType = <body type>`), using yo-self's shared
   `resolved_concrete` cell plus the id-keyed registry. Instrumentation
   confirms it FIRES for our case (`ret=U : (Send) body=i32`), and the markers
   do not change — so the stamp lands on a SomeT that `map`'s body evaluation
   does not consult. Next probe: print the SomeT id at the stamp and at the
   `List(U)` CTFE short-circuit and compare; a mismatch means the resolved
   param type is a substituted COPY with a fresh id, which would make the
   id-keyed registry the wrong channel here.

2. **Stop coercing the body to the forall var** — `anonymous_function.yo:1243`
   clears `expected_type` when the return is an unresolved SomeT, but only for
   `mark_closure_for_codegen` (io.async) closures; widening that to every
   closure makes the body type concrete (`i32`) instead of `U`, which is what
   makes fix 1 fire at all. Still not sufficient on its own.

3. **Narrow the unknown-arg CTFE gate to non-type returns.** This one is a
   genuine faithfulness finding: `comptime_fn.yo:565-585` short-circuits a CTFE
   call whose arg values contain an `UnknownVal`, and **TS has no such gate at
   all** — `evaluateComptimeFunctionCall` short-circuits only for
   `isAnalyzingCtfeCapability` (comptime-fn.ts:58-70) and otherwise executes the
   body. Exempting type constructors (`is_type_hierarchy_type(return_type)`)
   makes `List(U)` fold to the real generic instantiation instead of a
   `ctfe_result_…` placeholder.

   **Repro: markers 2 → 0.** The statement is no longer dropped; the emitted C
   contains the real `map` call. But it does NOT hold up on the battery:

   | file       | HEAD         | narrowed gate                      |
   | ---------- | ------------ | ---------------------------------- |
   | `imm_list` | rc=0, hollow | **rc=139 (SIGSEGV)**, still hollow |
   | other 18   | unchanged    | unchanged (8 hollow both ways)     |

   So it converts one silent drop into a crash and clears none of the eight
   hollow batteries — the batch `main`'s hollow statement fails for a reason
   the repro does not capture. NOT landed. (It also leaves the emitted call
   mangled `yo_id_…__unknown__Type__…` and the C full of `void` fields/params,
   i.e. it lands squarely in the cluster-2 comptime-param-model territory.)

All three are kept OUT of the tree pending a fix that clears the repro AND the
battery — the area has a history of hollow regressions, so nothing lands there
on plausibility alone.

### Two independent hardening items this exposes

- `_trial_eval_fn_body` abandoning the caller's begin loop is a much bigger
  blast radius than "def-time trial eval failed". TS's def-time body eval
  (function-type.ts:499) does not take the caller's statement list with it.
- A per-test hollow gate is mandatory: see "New gate needed" above.

## RE-MEASURED 2026-07-27 (post-validation-batch, s1i + a bracketed diag)

Three probes bracketing the def-time path (`__TR P1..P5` in
`try_to_implement_function_by_function_type`) plus begin-loop enter/end
counters, on `issues/repros/closure-arg-abandons-enclosing-begin.yo`:

- The map def-time trial throws (`__DBGT Incompatible types: Expected
ctfe_result_… Given unit`) and `_trial_eval_fn_body` CONTAINS it — the
  emitted C is correct (`if (__yo_effect_escaped) { …; __yo_effect_escaped=0;
return; }`), and P1..P5 all print: **the def-time path completes
  normally** (flow_out empty, no re-raise).
- The abandonment happens ABOVE: after try_to_implement returns, the
  enclosing evaluation chain for `xs.map(closure)` dies silently — main's
  4-statement begin loop never re-enters (i=1 has no loop-end, i=2 never
  entered), NO error passes the statement wrapper (`__DBGW` = 0 prints for
  the whole compile), and the module driver simply moves on to the next
  module ("check: parsing ./std/prelude.yo").
- So the killer is a SILENT `__yo_effect_escaped` set (no printing handler
  is ever invoked) somewhere between try_to_implement's return and the call
  evaluation completing, cascading up every `if (__yo_effect_escaped)
return` site until the top-level driver's local containment. This matches
  the flag-leak class already documented at `_expr.yo` ("HashMap ops
  (ExprInfo table get/set) can leak the escaped flag through GC").
- **Earlier step-3 wording is corrected**: the trial swallow's unwind does
  NOT itself abandon the caller's begin loop; the abandonment is a separate
  stale-flag cascade fired later in the same statement's evaluation.

Next probe: an lldb watchpoint on `__yo_effect_escaped` (or a temporary
`__yo_set_escaped()` wrapper function in the emitted C to get a stack) run
on the repro, filtered to hits after the last `__TR P5` — that names the
silent setter directly. The 4 dead ends above still stand.

Also note for diag builders: there is a FOURTH silent swallow the 3-site
recipe misses — `_comptime_expect_error_arg_threw`'s `local_exn`
(`evaluator/builtins/comptime_expect_error.yo`), which eats REAL errors
during a `comptime_expect_error` argument eval with no diagnostic.

### REFINED 2026-07-27 — the abandonment is NOT an escape-flag cascade either

Full-coverage C instrumentation on the diag binary (all 18 `__yo_effect_escaped
= 1;` setter sites printing `__ESC <func>`, all 16,993 of 16,996
`if (__yo_effect_escaped)` checks printing `__PROP <func>` when taken):

- The four setter handlers in play: the two diag print-handlers (`__DBGT`
  trial, `__DBGA` anon-trial), `try_match_generic_impl`'s synthesis-failure
  swallow in impl.yo (~1150 benign firings/compile), and a silent
  function.yo handler (6 firings).
- In the fatal window (main's body begin, stmt i=1 `doubled := xs.map(...)`),
  the last events are: map's def-time trial throw (contained, P1..P5
  complete), a SECOND successful def-time trial (out=1, P1..P5 complete) —
  then the log jumps STRAIGHT to the codegen phase's prelude re-parse.
  **Zero `__PROP`, zero `__ESC`, zero begin-loop end prints** between the last
  P5 and the phase change.
- `evaluate_begin_expression`'s statement loop has NO `continue`/`break`/
  direct `return(...)` that could skip the loop-end probe.

So the statement evaluation chain (map-call machinery → main's body begin
loop → main's def-time trial → module eval end) exits by some path that is
neither the escape flag nor a source-level early return. Candidate vectors to
probe next, in order:

1. Instrument `evaluate_begin_expression`'s C exits directly (every `return`
   in its compiled body) — is the loop fn even exiting, or is its FRAME
   corrupted (stack smash) so the `while` condition ends?
2. Probes are eprintln calls — verify the emitted call sites for the loop
   probes have no conditional gating (pre-clear + check pattern) that could
   suppress output under a stale flag.
3. lldb: `watchpoint set variable loop_i` equivalents / breakpoint on the
   codegen-phase entry with `bt` to see what the stack looked like when the
   check phase ended.

The 2026-07-26 step-3 attribution ("the trial swallow's unwind abandons the
begin loop") is definitively WRONG — measured twice over: the trial contains
correctly and the loop dies later, silently.

### THIRD ROUND 2026-07-27 — the begin frame never exits at all

All 185 compiled `return` statements of `evaluate_begin_expression`'s C body
were instrumented (`__BEXIT L<line>`), same emitted-C sed technique:

- The map def-time trial's TWO begins (the synthetic `wrap_body_in_begin`
  wrapper + the body's own) both exit via the SAME escape-check return
  (L186153) when the trial throw unwinds — correct containment, again.
- A later successful trial's begin exits via the normal tail (L188906).
- **Main's body begin (the one that loses statements i>=2) exits through NO
  return at all** — no `__BEXIT`, no loop-end print, no postloop print, and
  no escape-flag activity — yet the process continues into the codegen-phase
  prelude pass and completes rc=0.

A C frame that never returns while execution continues afterwards means the
frame was terminated non-locally or its loop state was corrupted. Combined
with the intermittent rc=139s in the same neighborhood, MEMORY CORRUPTION
(stack smash / UAF during the map-call chain) is now the leading hypothesis —
NOT a semantic swallow. Next recipe: run
`/tmp/diag_s1c compile issues/repros/closure-arg-abandons-enclosing-begin.yo`
under Guard Malloc (`DYLD_INSERT_LIBRARIES=/usr/lib/libgmalloc.dylib`, see
scratchpad/guardmalloc_corpus.sh and the ExprInfo-table-UAF lldb recipe in
agent memory `yo-self-macro-dispatch-corruption-fixed`), which converts the
corrupting write into a deterministic crash with a stack.

Caveat recorded: `__BEXIT` uses raw fprintf while the other probes are yo
eprintln — if eprintln buffers, CROSS-channel ordering is unreliable; only
the absence/presence of events is load-bearing in this round.

Guard Malloc over the FULL repro compile is infeasible: rc=137 (killed)
mid-way through std/string evaluation — page-per-allocation over the
evaluator's millions of allocations exhausts memory. Narrow it next time:
lldb with a hardware watchpoint on the dying begin's `loop_i`/`done` stack
slots (break on entry to `evaluate_begin_expression` when
`env->module_path` matches the repro, finish-to the fatal iteration, then
watch), or a gmalloc run that starts the protection late.

### FOURTH ROUND 2026-07-27 — MECHANISM FULLY CAPTURED (single ordered fprintf stream)

A combined instrumentation build (all 18 setters `__ESC`, all 23 containments
`__CONT`, all 16,993 checks-taken `__PROP`, all 185 begin returns `__BEXIT` —
one unbuffered stderr stream, no eprintln-vs-fprintf ordering hazard) shows
the complete fatal chain for `xs.map(closure)`:

```
(throw: Incompatible types, inside map's body eval — U unbound)
__PROP evaluate_begin_expression        <- map's BODY begin propagates
__BEXIT L186153                         <- ... and exits via the escape path
__PROP create_specialized_function_inline    <- THE KEY FRAME
__PROP try_to_call_function_with_arguments
__PROP evaluate_function_call
__PROP _evaluate_expression / wrapper / raw
__PROP evaluate_initialization_assignment    <- main's `doubled := ...`
__PROP _evaluate_expression / wrapper / raw
__PROP evaluate_begin_expression        <- MAIN'S begin loop propagates
__BEXIT L186153                         <- ... and exits — statements i>=2 lost
__PROP raw / wrapper / _evaluate_expression
__PROP _trial_eval_fn_body              <- MAIN'S OWN def-time trial
__CONT _trial_eval_fn_body              <- contained HERE (this is whose
                                           handler printed the __DBGT!)
```

So, correcting every earlier attribution:

1. map's body is evaluated during the call via the SPECIALIZATION path
   (`create_specialized_function_inline` → `try_to_call_function_with_arguments`)
   — NOT under map's own def-time trial swallow.
2. That path installs NO swallowing handler, so the `Incompatible types`
   throw (root: the callee's generic `U` never bound from the closure
   argument) unwinds the ENTIRE call chain, including main's begin loop —
   exactly the hollow-batch blast radius.
3. It is finally contained by the ENCLOSING function's (here: main's)
   def-time trial — whose handler is what prints the error in a diag build,
   which is why every earlier round misattributed the swallow.
4. Earlier stdout/stderr and eprintln-buffering artifacts created the
   phantom "frame never exits / process continues" readings — both retracted.

Implication for the fix: containment-at-specialization (mirroring TS's
checking-phase try/catch) would only trade hollow for the cluster-2
`__unknown__Type__` mangling (dead end 4 already measured that shape). The
real fix remains binding `U` from the closure's actual return type on the
argument path — and the next probe from the 2026-07-26 session ("compare the
SomeT id at the stamp vs at the `List(U)` CTFE short-circuit") should now be
run INSIDE `create_specialized_function_inline`'s substitution, which is the
path that actually evaluates the body.

### NEXT ATTEMPT DESIGN (2026-07-27, from the spec-path capture — untried)

The spec body eval resolves `U` from the CALLEE ENV (`get_variables_from_env`)
— bound by `try_to_call`'s Step-6 synthesis, where the measured given type
for the closure is still `fn(a : i32) -> U` (U binds to itself). There are
potentially THREE same-named-but-distinct `U` SomeT lineages: the wrapper's
`Fn(i32)->U` return, the fn's `-> List(U)` occurrence, and the env-bound
generic param. The dead-end registry stamps (2026-07-26 #2/#3) keyed ONE of
them and the body eval consulted another.

Untried, concrete: at Step 6 (`check_and_add_argument`'s synthesize), when
the GIVEN closure-arg type's return is a SomeT (i.e. the closure's own
declared return never resolved), look up the closure's DEFINITION-SITE
return type by its FuncVal id (`register_definition_site_return` /
function_value.yo — the anonymous-fn path already registers it) and use THAT
as the given return for synthesis — so `U` binds to `i32` directly in
callee_env, the same channel the spec body eval actually reads. This routes
around all three lineage identities instead of trying to stamp one.

Gate any attempt on: the repro's 2 markers, the 8 hollow batteries' hollow
flags, corpus 141, std 153, and stage2 markers=6 — this area has a history
of hollow regressions (the closure registry stamp added 13 markers while
passing every other gate).

### ATTEMPT 5 (2026-07-27) — Step-6 closure-body-type binding: BEST RESULT YET, parked as WIP

Implemented the design above (`issues/patches/closure-body-type-step6-binding.patch`,
3 files): a `register_closure_body_type` side table (function_value.yo) fed by
the `=>` path's existing concrete-body refine block (anonymous_function.yo,
inside the `has_some == 0` branch that already computes `body_ty`), consumed
in `check_and_add_argument` immediately before Step-6 synthesize: when the
arg value is a FuncVal whose GIVEN fn-type return is a SomeT and a concrete
body type is registered, substitute it as the given return
(`arg_type_for_synth`).

**Measured:**

- Canonical repro: markers **2 → 0** — the map call and the assert are
  emitted for REAL for the first time (every prior attempt either changed
  nothing or crashed imm_list). The begin-loop blast radius is GONE.
- Residual on the repro: the emitted spec call
  `yo_id_5059_..._ret_gs_yo_id_4998_1975_cl1_closure_...` is **called but
  never defined** (rc=139 via clang implicit-int) — i.e. the file moves from
  the closure-forall family INTO the cluster-7 "undeclared spec" bucket; the
  spec's name still renders the return as `List(U-1975)` rather than
  `List(i32)`, so the spec-emission/identity half still needs the same
  binding at SPEC-NAMING time.
- TIER 1: battery UNCHANGED (all hollow flags at baseline — no regressions,
  no flips yet), std 153/153, corpus PASS 140 / **SELF-FAIL 1**:
  `io_async_str.yo` — the io.async STATEMENT itself goes FTT (the
  substitution perturbs io.async's own `_ret`/E-bundle Step-6 synthesis).
- Narrowing the REGISTRATION with `!(ctx.is_inside_io_async_call)` did NOT
  fix io_async_str — the flag is not set (or not preserved) at the
  registration moment inside the def-time body-eval context. The right scope
  is probably at the CONSUMER: skip the substitution when the CALLEE is the
  io builtin (`_freshen_io_builtin_callee` knows it) or when resolved_pt is
  the io.async bundle-carrying wrapper.

**Next session:** (1) scope the consumer by callee (io builtins excluded),
(2) fix the spec-identity half — the spec name/prototype must render the
bound return (`List(i32)`), which is where the cluster-7 undeclared-spec
work and this fix meet. Reverted from the tree pending both; the patch
re-applies cleanly.

### SECOND HALF LOCALIZED (2026-07-27, post-landing) — three checkpoints, one gap left

With the Step-6 binding landed, the residual "spec called but never defined"
was traced end-to-end on the canonical repro (probes in /tmp/yb):

1. The spec IS created and cached: `__SPECSTORE base=yo_id_5059
spec=yo_id_5059_..._cl1_closure_...` — the exact name the call site emits.
2. Codegen COLLECTION does find and register it — via the method-callee VALUE
   side-table path in `codegen/functions/collection.yo`
   (`lookup_method_callee_value`), NOT via any of the module-field /
   registry / callee-ExprInfo paths (all measured misses; the callee's
   ExprInfo carries no 5059 FuncVal at all). A general
   `_collect_specializations_of` helper (walks
   `EvalContext.specialized_fn_caches` by base fid, injected into collection
   via a `set_spec_caches_for_collection` live view — same indirection as
   register_find_function_calls_in_expr) was prototyped and is ALSO useful
   (TS collection.ts:565), but is NOT what's missing for this repro.
3. EMISSION drops it: `should_skip_function_codegen`
   (codegen/functions/declarations.yo) skip2's `has_generic_return` fires
   because the spec's REGISTERED fn type still returns `List(U)` — the fid's
   own render says so (`ret_gs_yo_id_4998_1975`, 1975 = U's SomeT id).

So the one remaining gap: `create_specialized_function_inline`'s
`spec_ret_ty` stays unresolved even though the spec BODY eval resolves `U`
fine (markers 0 — `List(U).new()` no longer throws). The forall-extraction
that feeds spec_ret_ty (helper.yo, the "extract the inferred type parameter
values from calleeEnv" block after Step 6, TS helper.ts:1499-1513) does not
see the binding the substituted synthesis produced. Next probe: print what
callee_env's `U` variable holds right after Step-6 synthesis (TypeVal of
what? resolved_concrete set?) vs what the extraction requires; the fix is
whichever representation bridge is missing. After that, the fid render
(`rtparam1_fn_a___i32_____U____Send_` — runtime_param_tys still carries the
closure's `-> U` type) may also want the substituted arg type for identity
hygiene, but emission only needs spec_ret_ty.

CORRECTION to the "next probe" above, measured 2026-07-27 late: helper.yo's
Step-8 forall extraction NEVER FIRES for the repro compile (a `__EXTRACT`
probe on its SomeT arm prints nothing) — and a ported TS-helper.ts:1464-1494
resolution-propagation there changes nothing. The map call runs on the OTHER
call path (`_evaluate_funcval_runtime_call`, the FuncVal arm — the same
two-path split the arg-type-check fix documented), so the spec's return
inputs are the FuncVal arm's OWN `fa_bound_names`/`fa_bound_types` (built by
function.yo's Step-6-analog synthesis, threaded into
`create_specialized_function_inline`). The Step-6 closure-body-type
substitution (landed) only covers check_and_add_argument — the FuncVal arm's
arg loop needs the SAME given-return substitution before ITS synthesis, and
then `fa_bound_types` will carry `i32` and spec_ret_ty resolves. That is the
one remaining edit for the emission half; the prototyped
`_collect_specializations_of` collection helper (in the same WIP) is the
belt-and-braces companion (TS collection.ts:565).

FURTHER NEGATIVES on the emission half (2026-07-27, all in
`issues/patches/spec-emission-second-half-wip.patch` — collection helper +
codegen_c wiring + the FuncVal-arm structural-fallback substitution twin,
probe-free, diff vs the landed tree):

- The FuncVal arm's STRUCTURAL fallback substitution (the twin of the landed
  Step-6 one, applied before `_funcval_try_synthesize_param`) does NOT
  resolve the spec's return either — the fid still renders
  `ret_gs_yo_id_4998_1975`. Either an earlier inference arm already
  "bound" U (to something non-concrete, setting fa_bound), or the scratch
  synthesis still yields a SomeT (skipped by its `!(is_some_type)` gate).
  Next probe: print which arm binds U and to what, for the map call
  specifically (filter by the callee fid `yo_id_5059`, never by the name
  `U`).
- Meanwhile the C shows `ret_gs_yo_id_4998_i32` for a DIFFERENT call — the
  resolved-return render works when the binding lands, so everything
  downstream (fid, prototype, emission gate) is expected to fall into place
  once the right arm binds U concretely.
- Also confirmed: collection's method-callee side-table DOES register the
  spec FuncVal (`__MCV ... has=false` then registration), so once the spec's
  registered TYPE resolves, `should_skip_function_codegen`'s
  has_generic_return gate stops dropping it and no further codegen work
  should be needed.

TWO MORE DATA POINTS (2026-07-27, final probes of the session):

- `__STEP8 fid=yo_id_5059 n_forall=1 fv_forall=1` — try_to_call DOES process
  the map call with U in its forall list, and the Step-8 extraction's SomeT
  arm does NOT fire for it — i.e. U's callee_env value at extraction is
  already NON-SomeT (concrete) or absent. If concrete, THAT invocation's
  arg_values.forall_args carries i32.
- The FuncVal arm's four inference arms NEVER attempt `U` at all (unfiltered
  `__FABIND` census: T/\_Self only) — so if the single `__SPECSTORE
base=yo_id_5059` mint happened on the FuncVal-arm path, its bindings had
  no U and the U-flavored fid follows.

LEADING HYPOTHESIS for the next session: the spec is minted ONCE on a pass
whose forall bindings lack/miss U (checking-pass or the FuncVal-arm path),
cached under the base fid, and the later better-bound pass gets a CACHE HIT
on the unresolved spec (the cache key doesn't include the resolved return).
Probe: print `arg_values.forall_args` contents + which caller invoked
`create_specialized_function_inline` at the 5059 mint, and whether a second
mint attempt cache-hits. Fix candidates: include resolved forall values in
the cache key, or re-mint/patch the cached spec when bindings improve.

FINAL NEGATIVE of the session (probe cycle 8): `U` IS bound to `i32` in
`arg_values.forall_args` at the 5059 mint entry (`__MINTENTRY n_fa=1` /
`__MINTFA ty=i32`), and a zip-bind of forall_names→forall_args values into
the mint's callee_env immediately before
`spec_ret_ty := evaluate_function_return_type_again(<List(U)>, callee_env, ctx)`
STILL leaves the return unresolved — so `evaluate_function_return_type_again`
does not resolve a SomeT inside a generic instantiation (`List(U)`) from an
env NAME binding alone; it needs the SomeT-identity channel (substitution by
SomeT id/level, or the resolved_concrete cell on THAT `U` occurrence — the
`U` inside `List(U)` is a different SomeT copy than the env-bound one, the
classic Gap-6 lineage split). NEXT: substitute the declared return through
`substitute()` keyed by the forall SomeT occurrences (get_all_some_types of
the declared return, matched to forall_names by name+level) with the
forall_args values — the same mechanism `_evaluate_funcval_runtime_call`'s
header already implements for ITS return resolution (function.yo:1348-1370,
`s_ret := subst_new(); ...`) — that code is the proven in-tree template; the
mint should reuse it. All attempts probe-free in
`issues/patches/spec-emission-second-half-wip.patch`.

CYCLE 9 (final): subst-by-occurrence applied to BOTH mint return re-evals
(`spec_ret_ty` ~helper.yo:1490 AND `spec_result` ~helper.yo:2064, the one
feeding `register_func_type(specialized_func_id, spec_type)`) STILL leaves
the spec unemitted — because `should_skip_function_codegen`'s
`_func_has_generic_params` gate also fires: the spec's PARAM list still
carries the closure param typed `fn(a : i32) -> U`. Completing the emission
therefore needs the SAME substitution over `spec_param_types` (and ideally
the closure param swapped for its registered body-typed Func — which also
fixes the fid's `rtparam1_fn_..._U_...` identity segment). All layers are in
`issues/patches/spec-emission-second-half-wip.patch` (updated). The chain is
now: [landed Step-6 binding] → [WIP: collection helper + mint return substs]
→ [remaining: param-type subst + gates re-check + full TIER 1/2].

### CYCLE 10 — THE SPEC EMITS; three clusters converge on ONE remaining project

Extending the mint substitution to the PARAM types (collect SomeT occurrences
from return + every param, substitute both; ArrayList has no indexed set —
rebuild the list) gets the spec FULLY EMITTED for the first time: prototype +
definition, with a correct body (the map loop, RC handling, and the closure
invocation). The canonical repro is now down to ONE line of C error:

    passing '__yo_t21' (capture struct) to parameter of incompatible type
    'int32_t (*)(int32_t)'

i.e. the CLOSURE-PARAM CALLING CONVENTION — exactly red-cluster 3
(`issues/yo-self-69-red-list-map.md`: impl*fn_field_rejection /
ref_closure_capture / sync/once, "capture struct passed to a parameter
declared void (*)()"). The plain-Func substitution for a closure param is
WRONG for the convention: TS types the param as the CAPTURE STRUCT (the
wrapper SomeType's resolvedConcreteType — the closure*type.yo:296-299
registry is yo-self's equivalent) and lowers body calls `f(x)` through the
closure convention (`closure_fn(ctx, x)`). So the param substitution must
special-case closure params: substitute the registered capture-struct type
(get_closure_capture_info) instead of the plain Func, and the body's
call-through must use the closure convention (the body currently emits
`((int32_t (*)(int32_t))f)(v)` because the param re-bind chose the plain
Func).

STRATEGIC: completing this ONE convention finishes (a) the closure-forall
hollow family (8 files), (b) red cluster 3 (3 files), (c) red cluster 7's
undeclared-spec shape (2 files, same emission path), and plausibly parts of
cluster 2 — up to ~13 files. The full WIP chain (collection helper + mint
return/param substitutions) is `issues/patches/spec-emission-second-half-wip.patch`
(re-apply on top of the landed Step-6 binding; gate on TIER 1 + battery
hollow flags + stage2 markers=6).

CYCLE 11 (session end): typing the spec's closure param as the CAPTURE
STRUCT (get_closure_capture_info in the mint's param loop — in the WIP) makes
the CALL SITE line up (`__yo_t21` passed to `__yo_t21 f`); the repro's last
error moves INSIDE the spec body: `f(x)` emits the fn-pointer-cast fallback
(`((int32_t (*)(int32_t))f)(v)`) instead of the closure convention. The
correct lowering ALREADY EXISTS — other_fn_call.yo "Piece C" emits
`impl_fn(&(f), args)` when `resolve_some_type_to_concrete(<callee ExprInfo
type>)` reaches a capture-struct id present in `impl_closure_call_map` — so
the miss is the SomeT-resolution at codegen time, i.e. EXACTLY red cluster
3's documented "registry hit at eval time, miss at codegen time / SomeT id
re-minted between the two" identity gap. Everything else is peeled off; the
next session starts at that identity question with the full WIP applied
(`issues/patches/spec-emission-second-half-wip.patch`, now including the
capture-struct param typing).

FINAL CONNECTION: the codegen-time resolution the body call needs is the
`register_some_resolved_concrete(<wrapper SomeT id>, capture_type)` stamp on
the `=>` lambda path — WHICH IS THE EXACT CHANGE ALREADY MEASURED as adding
13 hollow markers to the stage2 self-compile when made UNCONDITIONAL
(issues/yo-self-69-red-list-map.md, "GATE RESULT: the closure registry stamp
causes a HOLLOW regression — do not re-apply blind"; the affected function
was build_runner's C-compiler invocation). The red-list already prescribes
the fix shape: TS gates the stamp on
`wrapperType.requiredTraits.some(t => t.traitType.id === expectedFnTraitType.id)`
and otherwise builds a synthetic `__impl_fn` wrapper
(anonymous-function.ts:1200-1226) — port the CONDITION, not the unconditional
stamp. Gate any attempt on stage2 markers (baseline 6) FIRST, before test
flips. This closes the investigation loop: closure-forall (8 hollow) +
cluster 3 (3 red) + cluster 7 (2 red) all end at this one guarded stamp plus
the WIP already staged.

### RESOLVED (first repro) + NEXT LAYER MAPPED (2026-07-28)

The canonical repro COMPILES AND RUNS with the landed chain (see the
`feat(yo-self): specialization mint` commit): Step-6 closure-body-type
binding + mint subst-by-occurrence (returns AND params) + capture-struct
closure params + capture-info cap_ty fallback in the rebind. Two pieces
measured HARMFUL and dropped: the register-all-specializations collection
helper (cycle_collector RC regression — it emitted extra spec copies) and
the wrapper-resolution stamp even in TS-conditioned form (fs/file + fs/temp
went hollow). The battery, corpus (141), and std are all at baseline with
the landed chain; TIER 2 in flight.

imm_list's batch main is STILL hollow — the next failure layer under the
same specialization-path swallow, measured with a fresh diag:

- `(result : Self) = Self.new()` types UNIT (list.yo:117 filter, :152) —
  the `Self`-slot sibling of the fixed `U` problem;
- `Failed to evaluate right-hand side of assignment: (reversed._head)`
  (list.yo:131) — downstream of a reverse() return typing;
- `Cannot unify incompatible types: "usize" and "Type"` — the third
  handoff-cause-table construct.

These are the handoff cause-table's `reversed._head` (2 files) and
`usize/Type` (2 files) rows plus a new Self-slot class — same
probe-cycle method, next session.

### usize/Type UNIFY ROOT CAPTURED — value-generic misbind in the batch-5 zb-loop route (2026-07-27)

Per-arm isolation of the imm_list batch (8 standalone repros): after batch 5,
EVERY closure/generic arm is clean (map, filter, fold, concat, eq, for_each,
reverse all emit OK) — the single batch-killer is `from_array`, minimally
`ArrayList(i32).from_array(array(...))` (r_fromarray, HOLLOW markers=2).

Probe chain (fresh instrumented s1 from /tmp/yb):

1. `__ALEN lvar=N giv_len=3 nvars=0` — at Step-6 synthesize, the Array-length
   synthesis finds NO env binding for `N` and adds `N := IntLit(3) : usize`
   itself (the add-branch, TS synthesizer.ts:915-930 mirror).
2. `__ZB name=N bind=i32` — the batch-5 zb-loop in
   `create_specialized_function_inline` (helper.yo ~1490) binds
   `N := TypeVal(i32)` with type `TypeUni(0)` — the ELEMENT type under the
   VALUE binder's name.
3. `__MINTENV label=N nvars=2 ty=Type val=TypeVal(i32)` — at body eval the
   last binding of N is the TypeVal; `Self.with_capacity(N)` synthesizes
   expected `usize` against given `Type` → `Cannot unify incompatible types:
"usize" and "Type"` on the UNSWALLOWED spec path → begin-loop abandoned →
   hollow batch main.

MECHANISM: on the method-dispatch route, function.yo:1659 packs
`spec_forall_args` from `fa_bound_names`/`fa_bound_types` — the IMPL-level
registry bindings (`T := i32`) — while the FuncVal's `forall_names` are the
FN-level binders (`["N"]` for `from_array : fn(generic(N : usize), arr :
Array(T, N)) -> Self`). The zb-loop pairs them POSITIONALLY. The values are
load-bearing for the spec cache key (shared-FuncVal instantiations are
differentiated by compile-time args — helper.yo:1355), so they cannot be
dropped at the source.

FIX (surgical): guard the zb-loop bind on the binder's DECLARED kind —
`is_type_0(func_type.forall_types[i])` — so value-generic binders are never
rebound to a TypeVal. TS never rebinds at all (its calleeEnv carries
kind-correct bindings), so Type-kinded-only rebinding is strictly closer to
TS. KNOWN RESIDUAL (documented, not triggered by std): a FN-level Type binder
positionally paired with an IMPL-level binding on the function.yo route would
still misbind; detecting it needs labeled forall_args (ArgEntry has no name).

BLAST RADIUS: imm_list + imm_vec are both HOLLOW markers=1 (this throw);
imm_set / imm_sorted_set REDs also call from_array.

CORRECTION (same day, after guarding zb): with the zb-loop guarded the
misbind PERSISTED (`__MINTENV label=N nvars=1 ty=Type val=TypeVal(i32)`) —
on this route the mint env is function.yo's `fresh_env`, and the actual
writer is `_funcval_bind_foralls`' RECEIVER-POSITIONAL fallback
(function.yo ~1258, a yo-self-only mechanism; TS resolves impl generics via
specializedType, never positionally): `N` fails the name-match, the
STRUCTURAL fallback synthesizes `N := IntLit(3) : usize` into the scratch
env but its extraction only accepted `.TypeVal` (dropping the value
inference), so the positional fallback paired fn-level binder #0 (`N`) with
receiver type-arg #0 (`i32`).

FAITHFUL-PORT FIX (TS ground truth: helper.ts:1038-1067 pre-declares
binders as `createUnknownValue(declaredType)`; synthesizer.ts:900-937 then
updates that calleeEnv variable to the concrete length VALUE; the TS mint
never rebinds foralls and its cache keys on compileTimeArgValues — the
VALUES):

1. structural fallback: accept `.IntLit` — propagate `N := IntLit(len)`
   with its declared type (usize) into fresh_env — reaching exactly the env
   state TS reaches, and making `fa_bound=true` so the positional fallback
   is skipped;
2. spec_forall_args packing (function.yo ~1663): use the binding's ACTUAL
   env value in the ArgEntry (IntLit for value binders) instead of minting
   `TypeVal(bound_type)` — distinct lengths mint distinct specs, kind-wrong
   TypeVals never reach the mint;
3. receiver-positional fallback: kind-guarded to Type-kinded binders
   (declared forall type `is_type_0`), plumbed via a new `forall_kinds`
   param from callee_info_opt's Func forall_types;
4. helper.yo zb-loop: same kind guard (TS never rebinds foralls at all, so
   Type-kinded-only is strictly closer).

### fn batch decomposed — labeled-arg validation LANDED-pending + partial-application port (2026-07-27)

Compile-only proxy technique (no `test` runner needed, safe alongside a
running TIER 2): split `tests/fn.test.yo` into per-`test()` standalone mains
(balanced-brace scan skipping comments/strings) and compile each with the
candidate s1; `Failed to transpile` markers per file = that block's killers.

Result: 15/24 blocks individually hollow. Killers mapped:

1. **Labeled arguments on the inline FuncVal arm** (b00's s2 and the shared
   root of several others): `test3(x : 5)` — the arm evaluated the raw
   colon-pair, which routed through evaluate_binding → "Expected type for
   rhs, got 5" → unswallowed throw. TS peels AND VALIDATES the label in
   checkIfFunctionParameterMatchesArgument (helper.ts:271-302). Ported to
   BOTH routes: function.yo FuncVal-arm arg loop (peel + validate) and
   helper.yo Step 1 (validation added to the existing bare strip — the bare
   strip silently accepted wrong/reordered labels TS rejects, itself a cee
   class). Verified: fn_s2b/min/c markers → 0; block b00's s2 → 0.
2. **`Variable "_" not found` × 7 blocks (b15-b21)**: HKT partial type
   application — `Result(_, i32)`. yo-self evaluated `_` as an identifier.
   Ported TS function.ts:580-766 into the FuncVal arm (before the
   comptime-fn delegation): mint a comptime FuncVal capturing non-`_` args
   (yo-self adaptation: captures in cap*names/cap_tys/cap_vals instead of
   TS env-frame binding), `*`positions become`\__pa_<i>\_<id>` comptime
   params, body = synthetic call to the captured original. Also feeds the
   higher_kinded_types hollow file.
3. Remaining fn killers (diag-mapped, unfixed): b01 `Variable "Lhs" not
found` (comptime param default `?= Lhs` referencing a sibling generic);
   b05 (TBD — diag tail was prelude noise); b09/b12/b13 cee
   missing-validations; b11 `recur: missing function type in context`;
   b14 Incompatible types (TBD); b00's s3 outer-scope-read cee
   (`comptime_expect_error(x + a)` inside a plain fn).

ADDENDUM (same session): three more pieces joined the batch after the
labeled-arg + partial-application fixes exposed fn's next layers:

4. **Sequential default-param env** (function.yo splice + arg loop):
   `(comptime(Rhs) : Type) ?= Lhs` — defaults were evaluated in the CALLER
   env where sibling params aren't bound ("Variable Lhs not found"). TS
   evaluates defaults in calleeEnv with earlier params sequentially bound
   (helper.ts:329-331). Ported by layering a frame binding the
   already-evaluated args by param name around both default-eval sites; an
   `undefined` argument now also substitutes the declared default
   (helper.ts:323-344, previously unhandled). Flips fn's b01 (MyAdd).
5. **Three degraded-emission guards** (all in the established
   FTT-comment/degrade convention — TS never reaches these states because
   the eval throw discards the definition; yo-self's mutable registries
   can't roll back):
   - tail/return of a failed value expr → whole-statement FTT comment
     (functions/generation.yo + exprs/return.yo; was `return <comment>;` —
     "expected expression");
   - Dyn fat-pointer wrapper gated on a RESOLVED inner
     (functions/dyn.yo; was `.call` on a void\* payload field);
   - registered-call to a should_skip_function_codegen-dropped callee →
     FTT comment (exprs/other_fn_call.yo, io.async SM closures exempt; was
     an undeclared-function call), and \_binop with empty/FTT operands →
     FTT comment (exprs/inline_fns.yo; was `(() + ())`).
     With these, tests/fn.test.yo returns to rc=0 (still hollow — the
     remaining killers are the b09/b12/b13 cee validations, b00-s3
     outer-scope-read validation, b11 `recur` context, b14, and the
     cluster-B Dyn/box-closure eval root now clearly the file's frontier).

### closure batch decomposed (2026-07-27, compile-only proxy)

9 blocks; 4 individually hollow. Killers:

- c01 + c06: `(closure : Impl(Fn(y : i32) -> i32)) = ((y) => ...)` — a
  closure assigned to an Impl(Fn)-ANNOTATED BINDING types as plain
  `fn(y : i32) -> i32` ("Incompatible types: Expected Impl(Fn...)"). The
  call-ARG coercion path (values/anonymous_function.yo + the batch-5
  chain) works; the BINDING position never routes the declared type
  through the closure coercion. Note closure_type.yo's
  try_to_implement_closure_by_fn_module_type — measured never-called for
  call args — may be exactly the binding-position path to wire.
- c03 + c07: diag tail is prelude noise ("Cannot assign runtime argument
  to compile-time parameter self") — real killer needs the probe cycle.

UPDATE: c03 + c07 are `(closure : Dyn(Fn(...))) = dyn(box((y) => ...))` —
the SAME red-cluster-B construct as fn's Dyn-manual-boxing test
(`box(<closure>)` infers `V := <Impl-Fn SomeT>` from the expected type —
the deliberate exp_pt arm in \_funcval_bind_foralls — and everything keyed
on that SomeT id resolves at eval, misses at codegen). Cluster B is now
THE unified frontier for BOTH the fn and closure battery files (plus c01/
c06's sibling: Impl(Fn)-annotated BINDINGS never route the declared type
through the closure coercion at all).

### GATE-METRIC FALSE ALARM + FIX (2026-07-27, pat2 TIER-2)

pat2's GATE 4 read "stage2 hollow=12" vs baseline 6 — NOT a regression.
The metric was a plain `grep -c 'Failed to transpile\|Unknown type:'` over
the stage2 C, which counts the compiler's OWN string literals: the FTT
emitters and the 59c5fe1fa degrade guards contain "// Failed to transpile"
strings, and the self-compile embeds them as C string constants (+6).
Line-anchored recount: **exactly 1 real marker in BOTH pat2 and vgt2** (the
known `// Failed to transpile unwind();`), CLANG_RC=0.
`scratchpad/gates_perf1.sh` now uses the anchored grep; **new stage2
baseline: hollow=1 (real markers)**. Historic "baseline 6" == 1 real + 5
literals.

### Degrade-cascade boundary reached on c03 (2026-07-27 late)

Two more FTT degrades landed (assignment RHS splice + dyn inner-value
splice — both emitted `<type> <name> = // comment;` invalid C). With them,
c03's failure moves one statement further each time: the degraded BINDING
(`(closure : Dyn(...)) = dyn(box(...))`) never declares `closure`, so every
downstream USE (`closure2 := closure`, `closure(1)`) emits references to an
undeclared identifier. Degrading those too would re-implement
eval-abandonment statement-by-statement. VERDICT: the degrade convention is
for STANDALONE failed expressions; a failed BINDING requires the real fix —
emit `box(<closure>)`'s spec correctly (the cluster-B root: box's `V` binds
to the Impl-Fn wrapper SomeT; the spec keyed on it is dropped by
has_generic_return at emission even though the wrapper now carries the
capture struct in its resolved cell post-340c05b9e). Next probe: why
`should_skip_function_codegen` still sees the unresolved SomeT in box's
registered spec type — the spec registration path (create_specialized's
register_func_type) likely needs the same resolved-cell-aware substitution
the mint's return got in batch 5.

### c03 box-spec mint — two negative results + measured shapes (2026-07-27 night)

Probe (`__MINTPROBE`, /tmp/yb build): at box's mint for c03,
`forall V = SomeT(1602 cell=0)` (EMPTY cell — the take-on's capture-struct
cell rides the ARG TYPE copy, not the forall binding's TypeVal) while
`runtime_param_tys[0] = <struct:capture_yo_id_5000>` (already concrete).
fid = `..._rtparam0_capture_..._ret_R_gs_yo_id_2797_1602_...` (return still
keyed on unresolved 1602).

Negative 1: cell-aware subst (check the forall binding TypeVal's own
resolved cell at the zs_ret/ys_ret sites) — cell is empty, never fires.
Negative 2: declared-param bridge (pair the return occurrence's name+level
with the DECLARED param SomeT and substitute the runtime param type) —
c03 unchanged (markers=2). UNVERIFIED why: either the `y_somes` collection
does not include the return's V occurrence (does get_all_some_types walk a
Struct instance's type_arguments — `Box(V)`'s V lives there, not in
fields?), or the name/level pairing misses. NEXT PROBE: print y_somes
contents + whether ys_any/spec_result changed, and check
get_all_some_types' Struct arm for type_arguments coverage. Both
experiments live in /tmp/yb helper.yo (with \_\_MINTPROBE); workspace
helper.yo reverted to keep landed code proven-only. TIER 1 was green with
both (harmless).

FOLLOW-UP: `_collect_some_types_into`'s Struct arm (types/utils.yo:911+)
walks `field_types` only and its cycle guard keys on the STRUCT ID — if
`Box(V)` shares its shell id with an earlier-visited instantiation (e.g.
`Box(i32)` in the same signature walk), the whole `Box(V)` subtree is
SKIPPED and V is never collected into y_somes — which would explain the
bridge never firing. Probe: print y_somes for box's mint; if empty, the
fix is the visited-guard granularity (key on id + rendered type args, or
walk type_arguments before the guard).

### CLUSTER-B SOLVED — dyn(box(closure)) five-fix chain (2026-07-28, `b3a0b8804`)

Both prior hypotheses DEAD by probe: `get_all_some_types(Box(V))` DOES
collect V (`y_somes=1, id=1602 lvl=2` — no shell issue, no visited-guard
issue; a fresh call's visited set is empty so the id-guard cannot fire on
the return alone). The bridge in negative-2 was firing AND substituting
correctly (post-subst `somes=0`, type_key
`R#gs_yo_id_2797_capture_yo_id_5002_i32`) — the "Box(V)" render was a red
herring (the struct's stored NAME is literally "Box(V)").

The real chain, each link probed:

1. **function.yo:1799 CLOBBER** (`__YSKIPWHY` probe): after the mint
   registers the concrete spec type, the FuncVal arm re-registers with its
   own `resolved_ret` = `Box(wrapper)` (fa_bound subst binds V := the
   wrapper SomeT) — last-wins registry → `should_skip_function_codegen`
   sees a generic return → call-site FTT degrade. FIX: regression guard —
   never replace a somes-free registered return with a somes-bearing one.
2. **Closure placeholder type** (`__YREG` probe): the closure registered
   `fn(y : y) -> _ret` (the `_synthesize_default_func_type` no-expected
   fallback) → C signature `void* y`. The forall binding was the BARE `V`
   (rts=0), not a Fn-carrying wrapper — nothing at the mint could recover
   the trait. ROOT: yo-self's dyn port lacked **TS dyn.ts:210-224**, the
   `dyn(box(<closure>))` special case that passes `Box(Impl-SomeT)` as the
   box call's expected type. Porting it makes V bind to the wrapper (rts=1)
   and the closure contextually typed `fn(y : i32) -> i32` at creation.
   THIS IS THE ENABLER — pieces 1/3/4 then complete the flow.
3. **helper.yo ys_ret declared-param bridge**: declared param that IS a
   forall's bare SomeT pairs positionally with the spec's concrete param
   type (box's `value : V` ↔ capture struct). **MUST be guarded to true
   forall binders by NAME**: unguarded, io.async's `""`-named
   `action : Impl(Fn...)` param paired and substituted the equally-`""`-named
   `Impl(Future(T,E))` RETURN wrapper with the capture struct → walker
   crashed in the async emitter (`_emit_while_continuation`, pointer =
   ASCII "esac " — a String read as a pointer). Deterministic rc=139
   with ZERO-byte log (block-buffered stdout lost on SIGSEGV) — a
   REAL crash wearing the phantom-kill signature; the lldb run perturbed
   it into passing. Diagnose this class via
   `~/Library/Logs/DiagnosticReports/*.ips`, not retries alone.
4. **helper.yo zb mint-env bridge**: bind V := capture in callee_env
   BEFORE the spec body eval — the body's `Box(V)(value)` ctor otherwise
   types the pattern-era instantiation (body called never-emitted
   `__yo_new___yo_t3` while the signature returned `__yo_t16*`).
5. **Two knock-on identity fixes**: (a) codegen/functions/dyn.yo wrapper
   payload lookup falls back to the payload-RESOLVED key (`Box(W)` →
   `Box(capture)`) — the raw recorded key is no longer collected
   (dyn*fn_field / dyn_fn_same_sig_closures SELF-FAILs); (b)
   types/compatibility.yo capture-struct NOMINAL identity under exact
   match (`capture*<id>` ids compare by id — TS compatibility.ts:292
rejects on id inequality for SomeT-free structs; TS's per-closure
StructType object identity). Without (b), two same-shaped captures
(`{a : i32}`from two closures) collided the comptime-fn CTFE cache and
the second`box(<closure>)`'s ctor reused the first's Box instantiation
   ("passing **yo_t32 to parameter of incompatible type **yo_t26" — the fn
   dyn-manual-boxing batch, needs BOTH the auto-box and manual-box blocks
   to reproduce).

A speculative 6th piece (re-register the closure's func type from the
wrapper's Fn trait at the mint) measured DEAD post-dyn-fix and was removed
(t_func_simple also drops meta flags — hazard).

Corpus regression tests: `tests/codegen-bootstrap/dyn_box_closure_binding.yo`
(the c03 block runs end-to-end), `dyn_box_same_shape_captures.yo`
(corpus baseline now 143). TIER 1 green; TIER 2 in flight.

## Batch-dispatch hollow — isolation matrix (2026-07-28 night)

The remaining 1-marker hollow (array/imm files) is the batch main's
dispatch match FTT'ing — isolated hard:

| path                                 | binary                       | markers                                                |
| ------------------------------------ | ---------------------------- | ------------------------------------------------------ |
| `compile` (standalone, batch source) | release                      | **0 (6/6 runs, robust to MallocScribble/PreScribble)** |
| `compile`                            | ASan build                   | 1 (5/5) — no ASan violations                           |
| `test` (in-process synth+compile)    | release                      | 1 (4/4 matrix; ONE anomalous 0 observed earlier)       |
| `test`                               | diag build (eprintln probes) | 1                                                      |
| `compile`                            | diag build                   | 0                                                      |

Facts: (a) the FTT text is emitted by generation.yo site-1 — the MATCH
NODE HAS NO ExprInfo at codegen time in the test path; (b) ALL FOUR
swallow sites instrumented (wrapper YSW, \_trial_eval_fn_body YSW-FT,
\_trial_eval_anon_body YSW-ANON, try_populate_expr_info_table YSW-TOP) —
the test-path YSW set is IDENTICAL to the compile-path set (comm -23
empty) and YSW-TOP never fires: NO eval error distinguishes the paths;
(c) eval outcome therefore stamps the match in one path and not the
other WITHOUT any throw, OR the codegen reads a DIFFERENT table than the
eval wrote.

NEXT (fresh session): trace table identity — in main.yo compare what
`run_test`'s inner compile passes to codegen vs `run_compile` standalone:
which ExprInfoTable/EvalContext instance evaluates the batch main's body
(def-time trial eval stamps fn-body infos) and which table
`context.base.get_expr_info` reads at emission. Suspect: run_test's
pipeline builds a second context/table (or re-parses the batch) so the
def-eval-era stamps land in a table the emitter never sees — id-keyed
lookup misses. A cheap probe: eprintln the TABLE SIZE + the match expr id
at (1) end of batch main's def-eval, (2) emission entry, in both paths.

ALSO: the ASan-build compile-path divergence (1 vs release 0) is
UNEXPLAINED — different binary, same source; consistent with residual
layout-sensitivity (the corruption class), but the test-path mechanism
above is the reproducible, attackable half.

## Narrowed further (2026-07-28 ~23:20)

Probe run (id-gated on the match node, id 60506): **ZERO YSTAMP, 7× YGET
found=false** (across table states tlen=51587/51649), no swallowed error
at ANY of the four instrumented sites, YSW-TOP silent. Conclusion: in the
TEST path the batch `main`'s BODY DEF-EVAL NEVER RUNS AT ALL (nothing
ever stamps the match; nothing throws). In the COMPILE path it runs and
stamps (markers=0). The divergence is therefore in whether
`try_to_implement_function_by_function_type` → `_trial_eval_fn_body`
fires for the batch main — suspects: (a) should_defer_body decided
differently under test-path ctx/env state (e.g. `g_cached_prelude_env`
pre-populated by the test-file processing — the compile path builds it
fresh); (b) the module's top-level begin eval takes a different route
(per-expr continue?) in-process. NEXT PROBE (one build): eprintln at
`_trial_eval_fn_body` ENTRY with env.module_path, gated on
"selftest_batch" — fires in compile path but not test path ⇒ deferral
decision; fires in both ⇒ table mystery reopens.

## CORRECTION (2026-07-28 ~23:35) — the "nondeterminism" was a measurement bug

Every "0 markers" result in the isolation matrix above came from detached
`nohup bash -c '...'` scripts using `grep -c \"Failed to transpile\"` —
inside single-quoted bash -c, the ESCAPED quotes become literal: the
pattern is `"Failed` (with a quote), the remaining words become bogus
file args, and the printed `filename:0` was the count of a
never-matching pattern. Direct (properly quoted) reruns show the batch
dispatch marker is a STABLE, DETERMINISTIC 1 across binaries, paths,
allocators, and runs. The sweep script (single-quoted pattern) was
correct the whole time; ad-hoc checks were not. The e1096c1b4 commit
message's "array 12/12 with ZERO FTT markers" is WRONG on the marker
half (the 12/12 pass-count remains vacuous); the value-generic fix
itself is still real (per-arm bisect used VALID greps: arms 1/2/3/5
genuinely flipped ftt 1→0 individually).

STATE: one deterministic bug — the batch main's body def-eval NEVER runs
(id 60506 never stamped, nothing thrown, YSW-TOP silent, 3 YTRIAL-ENTER
fire for batch-module fns but apparently not for main). NEXT: extend
YTRIAL-ENTER to print the body expr id and compare against main's body
id; then find the gate that skips main's def-eval (should_defer_body /
the top-level `main ::` binding route).

LESSON (measurement): never escape double-quotes inside single-quoted
bash -c grep patterns — use `grep -c 'Failed to transpile'` (single
quotes) or a single unquoted word.

## Return-site trace result (2026-07-28 late): ZERO of 63 `return(expr);`

sites fire for the match id — evaluate_match exits via a NON-`return(expr)`
path (the tail expression, `return(<other node>)`, or an err-expr return).
Next probe (batch into ONE build): tag fn ENTRY (id-gated), every
`return(` regardless of argument, and the tail — plus stamp-check at exit.
PAUSED here — user re-prioritized to s2 PERFORMANCE (2026-07-28 ~23:45).

## State 2026-07-29 ~05:00 (post array fixes)

Landed: annotation-position Array(T,\_) rejection + length-var
codegen-generic classification (array.test 12/12 clean under the
BATTERY's default-parallel batch split). BUT under `--parallel 1` (ONE
batch, all 13 arms — what the sweep runs) the dispatch STILL FTTs
deterministically (3x matrix): another arm (or arm interaction) kills
the single-batch shape. Score unchanged 139/28/16. NEXT: YSW-FT
message probe on the current tree, `test tests/array.test.yo
--parallel 1`, read the message following the batch main's def-eval —
same recipe that found the cee killer. NOTE: batch SPLITTING differs by
--parallel (worker count), so sweep-vs-battery marker counts can
legitimately differ — always reproduce with --parallel 1.

## Array single-batch residual — MINIMAL REPRO (2026-07-29 ~06:00)

`scratchpad/ra_repro.yo` (1-min cycle, standalone):
`return_array :: (fn(comptime(n) : usize) -> Array(i32, n))(begin(return(Array(i32, n).fill(10)), ()))`
then `arr2 := return_array(5); assert(arr2.len() == 5)`. TS: evaluator
OK. Self-hosted (dfr_s1 era): 3 FTT markers, hollow run. The call's
RETURN comes back `unit` → `arr2 : unit` → `len()` fails → the batch's
one remaining swallow ("Cannot unify: Expected bool, Given unit" at the
assert). Chase: does the comptime-param spec trigger fire for the
VALUE-arg call (IntLit 5 passes the known-gate); does the mint's
return re-eval resolve `Array(i32, n)` with n:=IntLit(5) (the
\_type_has_array_len_var gate + early binding should); does the
call-site adoption stamp it. Probe recipe as before (YIMM tags on the
trigger/mint + YSW-FT), now ~1-min repro cycles with the fast binary.

Landed this arc: cee annotation rejection (binding.yo), length-var
codegen-generic classification (helper/guards/declarations), comptime-
param body DEFERRAL (function_type.yo) — each TIER-1-green; array
single-batch peeled from "whole dispatch dead" to this ONE residual.

## Arm-4 residual isolated (2026-07-29 ~06:15): comptime-RETURN comptime-param fns

The remaining single marker of the array single-batch is
`comptime_return_array :: (fn(comptime(n) : usize) -> comptime(Array(i32, n)))(...)`
— standalone 1-min repro `scratchpad/ra6_comptime_return_repro.yo`
(2 FTT markers; the runtime + begin/bare variants are all FIXED and
covered by scratchpad/ra_repro.yo). This routes through the CTFE gate
(comptime-only return) — evaluate_comptime_fn_call executes
`Array(i32,10).fill(30)` and the call site gets a COMPTIME ArrayVal;
the FTT is in materializing that comptime array result (or the .fill
CTFE) at codegen. NEXT: run the repro under a YSW-probe binary
(/tmp/yh recipe) for the exact message, then chase the comptime-array
materialization path (codegen/exprs/array vs the CTFE result stamping).

Fixed so far in this peel (each TIER-1-green, pushed): cee annotation
rejection; length-var codegen-generic classification; comptime-param
body deferral; rte fallback gate on the CORRECT if (the length-var
condition had landed on the zs-subst gate — replace-first hazard;
scripted edits must anchor on UNIQUE context).

## Peel consolidated (2026-07-29 ~06:25)

Per-arm matrix with the current binary: arms 0-5 and 8-11 ALL CLEAN
(ftt=0). Remaining: **arms 6 + 7 only** — the `for(arr, x => ...)`
array-iteration closures, i.e. the KNOWN associatedTypeConstraints-
blocked closure-method front (issues/yo-self-closure-void-param-
where-clause.md). Fixed this arc (all TIER-1-green, pushed): cee
annotation rejection; length-var codegen-generic classification;
comptime-param body deferral; rte fallback gate correction; CTFE-gate
length-var-from-args stamping. array.test goes genuinely GREEN once the
for/into_iter closure route lands.
