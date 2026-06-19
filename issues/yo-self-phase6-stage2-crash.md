# Phase 6 (self-host fixpoint): stage-2 self-compile crashes on the full self-source

## Status

OPEN (2026-06-19). Phase 5 is DONE (parallelism keystone + Thread.spawn work
end-to-end, corpus 76/76, commit 88d060546). Phase 6's first step — the stage-2
self-compile (`yo-self-bin compile yo-self/main.yo`) — crashes before producing C.

## Symptom

- `YO_MAIN_STACK_MB=4096 /tmp/yo-self-bin compile yo-self/main.yo` (the -O0 binary):
  rc=138 (SIGBUS), ZERO output.
- `YO_MAIN_STACK_MB=16384 ... check yo-self/main.yo` (-O0, eval-only, 16 GB stack):
  rc=138, zero output → the crash is in EVAL/module-load of the full self-source,
  not codegen-specific.
- `YO_MAIN_STACK_MB=8192 /tmp/yo-self-rel compile yo-self/main.yo` (the **--release**
  binary, -O2 small frames): STILL rc=138, zero output.

## Key conclusion: NOT (just) deep-recursion stack exhaustion

CLAUDE.md attributes the rc=139/138 deep-recursion crash to -O0 multi-MB frames and
prescribes `--release` (LLVM stack coloring, ~100× smaller frames → 1000s of levels).
Here the **--release binary crashes identically** (rc=138, 8 GB stack), so it is NOT
stack depth — it is a GENUINE crash (null/misaligned access, or a memory/resource
limit manifesting as SIGBUS) triggered by loading+evaluating the ENTIRE self-source
graph in one process. (The --release binary is otherwise healthy: it compiles +
runs the spawn repro → `thread sees 42` / `main done`.)

Note `check ./yo-self` (Phase-3 milestone, 227/227) checks each file in ISOLATION;
`check yo-self/main.yo` loads main + ALL transitive imports together — the harsher
unified load is what crashes.

## lldb backtrace (2026-06-19) — pinned to `get_specialized` frame

`lldb -b -o run -o bt -- /tmp/yo-self-rel compile yo-self/main.yo`:
```
thread #2, stop reason = EXC_BAD_ACCESS (code=2, address=0x300003ff0)
frame #0: fn_yo51ba7706_id_121_get_specialized_T_TypeValue_Self_ArrayList_(enum(Unit,BoolT,Void,Str,Int(...),Float(...),...,Pointer(Box(enum(...))),Array(Box(enum(...)),length,length_var))...)  +4
->  stp x24, x23, [sp, #0x10]   ; (function PROLOGUE — store to the stack)
```
The fault is a WRITE (code=2) at a stack-pointer-relative store in the function
PROLOGUE → a STACK OVERFLOW, in `get_specialized` specialized over the GIANT nested
`TypeValue` enum (the `Self` = `ArrayList(enum(... the whole TypeValue ...))`). It
runs on thread #2 (the `__yo_main_stack` worker that runs `main`; YO_MAIN_STACK_MB
applies to it), yet 8 GB overflowed at --release — so this is NOT ordinary
deep-recursion-with-small-frames. Likely cause: `get_specialized`'s frame holds the
giant `TypeValue`/`ArrayList(enum…)` BY VALUE (a multi-KB+ frame even at -O2), and it
recurses over the deeply self-referential `TypeValue` (`Box(enum(...Box(enum...)))`),
so a moderate depth × giant frame blows the stack — OR it is genuine unbounded
recursion in `get_specialized` for this self-referential type. NOTE: `get_specialized`
(types/...:id_121, the `Type.get_specialized` method) is unrelated to the closure work
— this is a pre-existing self-compile gap surfaced by the harshest input.

## Diagnosis directions (next session)

0. Pin whether it's unbounded vs deep-but-finite. ATTEMPTED: `lldb bt 200` shows only
   frame #0 — lldb cannot unwind past the overflowing prologue (the frame isn't
   established), so depth is hidden. Next: set a breakpoint on `..._get_specialized`
   with a counter, or instrument the Yo `get_specialized` source with a depth guard
   that panics at N to confirm recursion. Inspect the `Type.get_specialized` source
   (types/...:id_121, a generic method specialized over the self-referential
   `TypeValue` enum): look for (a) a missing cycle/base case when recursing the
   self-referential type, and (b) the giant `TypeValue`/`ArrayList(enum…)` passed/
   returned BY VALUE (multi-KB frames) — box it / pass by ref to shrink frames.
   8 GB overflowing at --release points to deep-or-unbounded recursion over the
   self-referential type, OR giant frames × moderate depth.

1. The empty output is the main obstacle. Force-flush / run under a debugger:
   - `lldb -- /tmp/yo-self-rel compile yo-self/main.yo` → backtrace at the SIGBUS;
     `MallocStackLogging=1` / `MallocScribble=1` if it's a heap/UAF.
   - Check Console.app / `~/Library/Logs/DiagnosticReports` for the crash report
     (signal, faulting address, frame).
2. Bisect by input size: `check` progressively larger SUBSETS of the import graph
   (e.g. a driver that imports only lexer+token+parser, then + evaluator, then +
   codegen) to find the module/threshold that triggers it. Distinguishes
   memory-pressure-scales-with-size from a specific-module bug.
3. Rule out OOM/mmap: watch RSS during the run; if it balloons then SIGBUS, it is
   memory pressure (SIGBUS from a failed lazy page-in), not a logic bug.
4. If a specific construct: minimize to a standalone repro (the usual issues/
   workflow) and fix the evaluator/loader.

## UPDATE — 32 GB stack → OOM-kill (rc=137): NOT fixable by more stack

`YO_MAIN_STACK_MB=32768 /tmp/yo-self-rel compile yo-self/main.yo`: rc=137 (SIGKILL =
OS OOM-kill). So at 8 GB it stack-overflows (rc=138) and at 32 GB it exhausts RAM
before finishing → the recursion is pathologically deep (or unbounded). More stack is
NOT the fix.

The crash frame (`get_specialized` = the SPECIALIZED `ArrayList.get`; C comment:
`(ArrayList(u8)) fn(self, index) -> Option(u8)`) is `ArrayList(TypeValue).get →
Option(TypeValue)` — `Option(TypeValue)` is returned BY VALUE, and `TypeValue` is the
huge self-referential enum, so each such frame is large. `get` itself isn't recursive;
it's just where the already-near-exhausted stack tips over during a deep evaluator
recursion (lldb couldn't unwind the caller chain past the overflow).

Important contrast: `check ./yo-self` (Phase-3, 227/227) checks each file in ISOLATION
and is fine; `check`/`compile yo-self/main.yo` loads main + ALL transitive imports in
ONE evaluation, and THAT unified eval recurses deeply enough to exhaust 32 GB. This
smells like either (a) a missing memoization/cycle-guard so a shared self-referential
type (TypeValue) is re-descended combinatorially in the unified load, or (b) a genuine
unbounded recursion triggered only by the full graph, or (c) just-too-deep × the giant
`TypeValue`-by-value frame cost.

### Refined fix directions
1. Determine bounded-vs-unbounded: instrument the hot evaluator recursion (or
   `ArrayList(TypeValue).get`'s caller) with a depth counter that panics at e.g. 5000
   — a panic with a clean Yo stack trace shows the recursive cycle; no panic before
   OOM = genuinely deep, not a single tight loop.
2. Shrink the per-frame cost: `TypeValue` is large + returned/passed by value in
   hot recursive paths (e.g. `Option(TypeValue)` returns, `clone`, `match` temps).
   Boxing more of TypeValue (or returning `*(TypeValue)` in the hottest helpers)
   cuts frame size ~Nx and may bring depth back under a sane stack.
3. Add memoization/cycle-guards to whatever traverses the self-referential TypeValue
   in the unified load (mirrors the substitute() / type_contains cycle guards already
   added elsewhere this port).

### UPDATE — scales with unified-load size (not main.yo-specific)

`YO_MAIN_STACK_MB=4096 /tmp/yo-self-rel check yo-self/codegen/codegen_c.yo` (a large
SUBGRAPH — the whole codegen + evaluator, less main's full graph) ALSO crashes rc=138,
0 "evaluator OK". So the deep recursion is NOT a single main.yo-only construct — it
triggers on any sufficiently large unified load and scales with graph/type count. Small
isolated files (`check ./yo-self` per-file, 227/227) are fine. → strongly favors a
combinatorial re-descent of shared self-referential types (missing memoization in a
type-traversal run per-module during the unified load) and/or genuinely-deep def-time
body-eval recursion across the full call graph, amplified by the giant
`TypeValue`-by-value frame cost. The fix is frame-size reduction (box TypeValue in hot
paths) + memoization/visited-guards on the type traversal, not more stack.

### UPDATE — rebuild-free diagnostics exhausted (both lldb directions blocked)

- `lldb bt` cannot unwind past frame #0 (the overflow faults at the prologue before
  the frame/FP chain is established).
- `lldb memory read -f A -c 8000 $sp` returns only ~21 entries — reading UP the stack
  from `$sp` immediately hits the guard page / unmapped region (the deep frames are in
  the exhausted area), so the repeating-return-address scan can't see the recursion.

So pinning the EXACT recursive function needs depth instrumentation, and a naive
global counter is unreliable here: the def-eval-wall unwinds frequently (trial-eval
swallow), and `unwind` skips a decrement-on-exit → the count leaks upward across many
shallow evals and gives false depth. A correct probe must save/restore depth across
BOTH normal return AND the unwind handler (e.g. in `_evaluate_expression_wrapper`
_expr.yo:898, the per-call exn handler restores `g_eval_depth = saved` before
`unwind`). With that, panic-at-N (on the descent) prints the recursive expr/construct.
Alternatively, address the SYMPTOM: shrink the per-frame cost by boxing/`*(TypeValue)`
in the hottest type helpers (e.g. `Option(TypeValue)` returns) so the same depth fits
— but TypeValue is pervasive, so that is a large, carefully-validated change.

### UPDATE — ruled out the obvious type-traversal recursers

The deep recurser is NOT a naive cyclic type traversal — the usual suspects are
already bounded/guarded: `type_to_string`/`_tts` (types/string.yo) caps at depth 40
(`_d > 40 → "…"`) and doesn't recurse Struct/Enum field types (prints the name);
`are_types_compatible` (compatibility.yo) has a `visited` cycle guard on
Struct/Union/Enum; `substitute` has the `visited_trait_ids` cycle guard. So the deep
recursion is in the EVAL / comptime-execution path (e.g. `_evaluate_expression`
mutual recursion or a comptime fn executing over the unified graph), not a tight
type-structure loop — consistent with the crash being where a deep eval chain happens
to call `ArrayList(TypeValue).get`. Next-session probe should target the eval
recursion (unwind-aware depth guard in `_evaluate_expression_wrapper`) rather than the
type helpers.

## BREAKTHROUGH (2026-06-19) — sampling profiler pins the REAL recursion

The lldb dead-ends were sidestepped with macOS `sample`, which snapshots the live
call tree *while the recursion is still descending* (run with a big stack so it
doesn't crash mid-sample):

```
YO_MAIN_STACK_MB=16384 /tmp/yo-self-bin check yo-self/main.yo & PID=$!
sleep 3; sample $PID 4 -file /tmp/s.txt; kill $PID
```

**The `get_specialized` frame in the old lldb backtrace was a RED HERRING.** The
profiled hot recursion is the EVALUATOR's def-time body-eval path, not a type
traversal. Two facts from the sample:

1. The recursive cycle is:
   `_evaluate_expression → evaluate_function_call → try_to_call_function_with_arguments
   → … → _build_def_time_body_env → _trial_eval_fn_body (body eval) → _evaluate_expression`,
   with `synthesize_types`/`_synthesize_types_impl`, `try_to_implement_function_by_function_type`,
   `find_methods_from_generic_impls`, `get_variables_from_env`, `merge_and_check_envs`
   interleaved. So **def-time body eval is being RE-ENTERED** — evaluating one
   function's body triggers def-time body eval of further functions, descending the
   (cyclic) compiler call graph that only the UNIFIED load makes fully resolvable.
2. **~half the samples are `clone` / `clone_specialized_T_TypeValue_Self_ArrayList` /
   `…_Box`** — every `_build_def_time_body_env` copies the ENTIRE caller env's
   variables (function_type.yo:247-274 loops all frames × all variables, cloning each
   `cv.ty`), and in the unified load that env holds all modules' symbols. So each
   re-entry is a giant frame (huge env clone + TypeValue-by-value) AND the depth is
   the call-graph depth → GBs.

Why per-file `check ./yo-self` (227/227) is fine but `check main.yo` overflows: in
per-file isolation a cross-module callee is a shell/signature, so a call to it
type-checks via its return type; in the unified load the callee's full body is
present, so def-time body eval descends into it (and into ITS callees…).

## Fix lead — TS's `skipSpecialization` + `skipCtfeExecution` + checking-phase flag

TS breaks exactly this recursion (see `docs/SPECIALIZATION_CACHE_PITFALL.md`,
function.ts:885/945): when CHECKING a call it passes
`tryToCallFunctionWithArguments({ …, skipSpecialization: true, skipCtfeExecution: true,
context: { …, isInFunctionCallCheckingPhase: true } })` so the call's result type is
computed WITHOUT executing/specializing the callee body, and the
`isInFunctionCallCheckingPhase` flag PROPAGATES so nested calls also skip CTFE.

yo-self ports the pieces but does NOT honor one:
- `is_in_function_call_checking_phase` exists (context.yo:235), is set during trials
  (function.yo:534) and read in comptime_fn.yo:429. ✓
- `skip_specialization` is honored (helper.yo:2523 `if(!(skip_specialization) && …`). ✓
- **`skip_ctfe_execution` is DISCARDED — helper.yo:1816 `_ := skip_ctfe_execution;`.**
  The parameter is accepted and thrown away, so CTFE/body execution is NOT skipped
  during the checking phase. ✗  ← prime suspect.

NEXT: trace where `try_to_call_function_with_arguments` actually executes the callee
body (post-`synthesize_types`) and gate it on `skip_ctfe_execution ||
ctx.is_in_function_call_checking_phase` (mirroring TS). Also confirm every def-time
body-eval call site enters the checking phase with both flags true. Validate the
corpus stays 76/76 (the flag must not suppress execution that real CTFE needs) AND
that `check main.yo` no longer overflows. CAUTION: this gates comptime execution —
an over-broad gate will regress CTFE-dependent fixtures, so scope to the
checking-phase path only.

Secondary lever if depth persists: `_build_def_time_body_env` copies the whole env by
value every re-entry — share/alias it instead of deep-cloning (cuts frame size + the
clone half of the samples).

## UPDATE (2026-06-19, cont.) — two experiments, root narrowed to specialization-during-validation

Profiled `create_specialized_function_inline` IS in the hot recursion (21 frames in a
3 s sample), so the deep chain is GENERIC SPECIALIZATION. Two fixes attempted, BOTH
reverted (kept 76/76 clean):

1. **Skip def-time body validation during the checking phase** (gate
   `try_to_implement_function_by_function_type`'s body eval on
   `!ctx.is_in_function_call_checking_phase`). REVERTED: no effect — the flag is not
   set on the hot recursion path (the recursion is not reached via the
   checking-phase trial calls).

2. **Port the missing mutual-recursion stack guard.** yo-self's `is_recursive_spec`
   guard (helper.yo:2524) only checked the SINGLE slot `currently_specializing_function`,
   so MUTUAL recursion (f specializes g specializes f — the slot is overwritten by g)
   was not caught — only direct self-recursion. TS tracks the full
   `currentlySpecializingFunctionStack` and checks it with `.some(...)`
   (helper.ts:1852-1857, push/restore 2419-2469). I ported it (helper
   `_func_id_being_specialized` scanning the stack + push/pop the stack at the
   set/restore sites; stack entries need only `original_func_id` since yo-self has no
   stack-based forward-ref — `EvalValue` has no `.clone()`, so the entry's
   `original_func_value` was a `UnitVal` placeholder). RESULT: partial — the eval
   recursion shrank (`_evaluate_expression` 1659→966 samples) but the crash REMAINED,
   AND it regressed `runtime_numeric_cast.yo` to SELF-FAIL (75/76). So the
   mutual-recursion stack is NECESSARY (it is a real TS mechanism yo-self lacks) but
   INSUFFICIENT alone, and its naive form perturbs an existing specialization the
   numeric-cast fixture depends on.

**Refined root cause:** generic specialization (`create_specialized_function_inline`,
which deep-clones the callee env + TypeValues — the clone half of the samples) RUNS
during def-time body validation and recurses a deep chain of DISTINCT specializations
down the compiler's generic call graph. TS avoids this: while CHECKING a call it
passes `skipSpecialization: true` (+`skipCtfeExecution: true`, +
`isInFunctionCallCheckingPhase: true`) so the call's result type is resolved WITHOUT
specializing/executing the callee body. **yo-self DISCARDS `skip_ctfe_execution`
(helper.yo:1816 `_ := skip_ctfe_execution;`) and does not propagate
`skip_specialization` into the calls inside a body being validated**, so each call
fully specializes, cascading.

**Fix plan (do together, validate as one):**
(a) Honor the checking-phase intent: during def-time body validation, calls resolve
    their return type via `synthesize_types` WITHOUT `create_specialized_function_inline`
    — i.e. propagate `skip_specialization`/`skip_ctfe_execution` (or gate
    specialization on `!ctx.is_in_function_call_checking_phase` AND not-validating)
    exactly where TS sets them. Compare TS function.ts:885/945 + the
    `isInFunctionCallCheckingPhase` propagation precisely.
(b) Add the mutual-recursion stack guard (experiment 2) for the genuine recursive
    specializations that remain — but reconcile it with `runtime_numeric_cast.yo`
    (understand why that fixture needs the specialization the stack guard suppressed;
    likely the guard must still allow the FIRST specialization and only short-circuit
    a re-entrant one with identical args).
(c) Secondary: shrink `_build_def_time_body_env`'s whole-env deep clone.
Validate: corpus 76/76 AND `check main.yo` no longer overflows (2 GB stack).

## UPDATE (2026-06-19, round 3) — two constraints that rule out the easy fixes

Investigated fix (a) and the env-share lever; both hit a wall that must be respected:

- **Cannot skip specialization during the def-time body trial.** The trial context
  (`create_function_body_evaluation_context`) SHARES `ctx.expr_info_table`
  (function_type.yo: `expr_info_table : ctx.expr_info_table`). So the def-time body
  eval is NOT throwaway — it is the single pass that populates the ExprInfo (incl.
  specialized callee FuncVals) that CODEGEN consumes. yo-self does validate +
  codegen-metadata population in ONE recursive pass over the call graph. Gating
  `create_specialized_function_inline` on `!is_validating_function_definition` (or the
  checking-phase flag) therefore breaks codegen for every generic call inside a body.
  This is the core reason the recursion can't simply be cut: the specialization chain
  IS the work codegen needs.

- **The env flat-copy is NOT a behavior-preserving target for `snapshot_env`.**
  `_build_def_time_body_env`'s copy (function_type.yo:247-274) does two things: the
  expensive O(unified-env) copy AND a re-bind that forces `is_compile_time_only =
  (variable has a value)` (so valued module globals become comptime in the body env).
  `snapshot_env` (shallow frame share) would keep each variable's ORIGINAL
  `is_compile_time_only`, changing comptime/runtime classification in the body —
  load-bearing (see the std/log.yo `is_reassignable` note in-code). So the env-share
  win requires replicating the is_compile_time_only re-bind on the shared frames (or
  proving TS's variables already carry the right flag at definition and the re-bind is
  itself the divergence to remove).

**Net:** the genuine fix is a COORDINATED change — most likely (1) box/`*(TypeValue)`
the hottest by-value TypeValue paths to shrink the C stack frame so the deep-but-
necessary specialization chain fits (attacks rc=138 directly, the only lever that does
not fight codegen's need for the chain), plus (2) the env-share + is_compile_time_only
re-bind to cut the heap/OOM half, plus (3) the mutual-recursion stack + forward-ref
port for the cyclic specializations. Each needs its own validated rebuild cycle
(~13 min) and must keep the corpus at 76/76; this is a dedicated multi-iteration effort,
not a single rapid edit. Three fixes were attempted this session and ALL reverted to
preserve 76/76 — the working compiler must not be regressed for a partial fix.

## UPDATE (2026-06-19, round 4) — mutual-recursion fix landed; depth is huge/unbounded → suspect the spec cache

- **Mutual-recursion specialization guard + forward-reference PORTED & committed**
  (b2f62e781): yo-self lacked TS's `currentlySpecializingFunctionStack` + forward-ref
  (helper.ts:1985-2010) — it handled only DIRECT recursion (single slot + `recur`).
  Now the stack is pushed/popped around specialization and mutual recursion forward-
  refs the in-progress specialized funcId. Corpus 76/76 (runtime_numeric_cast.yo
  exercises it). **But this does NOT fix the stage-2 crash** — profiling the fixed
  binary shows `_build_forward_ref_funcval` is hit ZERO times on the crash path, so
  cyclic specialization is NOT the crash driver.

- **`--release` ALSO crashes (rc=138, 4 GB) — confirmed with a fresh -O2 build.** This
  rules out the "-O0 giant-frame" explanation: at ~100× smaller -O2 frames, a bounded
  ~514-deep chain (what a 3 s `sample` showed) would fit in well under 1 GB. Crashing
  at 4 GB (and 32 GB OOM, per above) means the recursion is genuinely **thousands deep
  or unbounded**, not deep-but-finite × big frames. The `sample` max-depth (~514) was
  an undercount (tree-merge / mid-descent snapshot).

- **Prime remaining suspect: specialization-cache MISS → re-descent.** Only GENERIC
  calls recurse during validation (non-generic calls resolve their return type from the
  signature without evaluating the callee body; `is_func_generic` gates
  create_specialized_function_inline). So the deep chain is generic specialization
  descending the call graph. With a working cache, each `(func, concrete-args)`
  specializes ONCE and repeats hit the cache — bounding the chain. If
  `_find_specialization_cache` / `compute_compile_time_signature` produces an UNSTABLE
  key for functions over the self-referential `TypeValue` (e.g. freshened type ids per
  specialization, or a key that varies for the same logical type), every repeat call
  re-specializes → unbounded re-descent. This is the OPPOSITE failure of the cache
  COLLISION fixed earlier (see memory yo-self-phase3-hashmap-new-blocker, where a
  name-only struct compare gave false HITS) — here we'd have false MISSES.

  NEXT: instrument `create_specialized_function_inline` to log `(func_id, signature)`
  on cache miss; if the SAME logical specialization recurs with differing signatures
  (or the same signature misses), the cache key is unstable — fix
  `compute_compile_time_signature` to render the self-referential `TypeValue`
  canonically/structurally (id-independent), mirroring how TS keys it. Verify: the
  miss log stops repeating + `check main.yo` completes. Secondary: confirm via a
  depth-counter panic in create_specialized whether depth is bounded (frame-size) or
  unbounded (cache) — a panic at N=2000 with a clean trace settles it.

  REFINEMENT (inspected the key): `compute_compile_time_signature` keys forall type
  args via `value_to_signature_string` → `type_to_string(t)`, which is DETERMINISTIC
  (name-based, depth-capped at 40). So it is NOT a simple key-instability miss; if
  anything the depth-40 cap + name-only struct/enum rendering risks false HITS
  (collisions), which would REDUCE recursion, not cause it. Sample composition:
  `_evaluate_expression` ~971 vs `create_specialized` ~28 ⇒ depth ≈ (specialization
  nesting ~28) × (per-body expression-eval nesting ~18) ≈ the observed ~514. So the
  next step is NOT a cache-key tweak by inspection — it is an INSTRUMENTED run (depth
  counter in create_specialized + cache hit/miss log) to settle bounded-but-huge
  (→ frame-size / box TypeValue) vs unbounded (→ a specific re-descent bug). That is a
  dedicated rebuild-driven investigation; do not blind-edit the cache key (the
  name-only loosening already regressed std 151→17 once — see
  memory yo-self-phase3-hashmap-new-blocker).

## UPDATE (2026-06-19, round 5) — INSTRUMENTED: specialization is bounded; the driver is unbounded EVAL recursion

Added a diagnostic probe in `create_specialized_function_inline` (reverted after): two
STATIC panics — one if the callee's `func_id` already appears on the specializing
stack (a cycle that slipped the mutual-recursion guard), one if specialization nesting
exceeds 300. Ran `check yo-self/main.yo` (4 GB): **NEITHER fired**, yet it still
crashed rc=138. So:

- **Specialization nesting is BOUNDED (< 300)** and **no cycle slips the guard** — the
  mutual-recursion forward-ref (committed b2f62e781) is working; specialization is NOT
  the depth driver. (Consistent with the sample: ~28 `create_specialized` frames vs
  ~971 `_evaluate_expression`.)
- **The driver is the EVAL recursion** (`_evaluate_expression → evaluate_function_call
  → … → _evaluate_expression`), and it is **unbounded/enormous**: a fresh `--release`
  (-O2, ~100× smaller frames) build crashes rc=138 at **16 GB** — at ~90 KB/frame that
  is >100k levels, so the ~514 a `sample` showed was a gross undercount; the recursion
  does not converge.

So the bug is an unbounded EVAL descent that does NOT go through deep specialization.
The most likely mechanism: the function-call **checking phase** (function.yo:525-547
sets `is_in_function_call_checking_phase`; calls `try_to_call_function_with_arguments`
with `skip_specialization: true`) descends into the callee to resolve its return type,
and for the compiler's MUTUALLY-RECURSIVE call graph (evaluate_expression ↔
evaluate_function_call ↔ …) this re-enters without a guard. TS passes
`skipCtfeExecution: true` in the checking phase precisely to stop that descent;
**yo-self DISCARDS it (helper.yo:1816 `_ := skip_ctfe_execution;`)**. So the eval, not
specialization, recurses the cyclic graph forever.

Precise locus (read function.yo:520-547): the recursion is the OVERLOAD-RESOLUTION
trial machinery. `evaluate_other_function_call` sets
`ctx.is_in_function_call_checking_phase = true` and, for EACH candidate, runs
`_trial_call_overload_candidate(cv, ct, call_expr, func_expr, args, env, ctx, …)`. That
trial re-evaluates the call (cloned arg exprs etc.). The in-code comment already notes
this was once "exponential in nested operator-call chains (std/glob.yo never
finished)", fixed by setting the checking-phase flag so nested comptime/macro calls
short-circuit to UnknownVal. The stage-2 self-source evidently hits a case the flag
does NOT cover: the trial re-evaluates argument calls, which re-enter
`evaluate_function_call` → trials → … unboundedly for the mutually-recursive call
graph (and `skip_ctfe_execution` is discarded at helper.yo:1816, so nothing stops the
callee descent).

NEXT (clear, scoped): (1) confirm with an UNWIND-AWARE depth probe in
`evaluate_function_call`/`_evaluate_expression` (save/restore the counter across normal
return AND the trial-eval unwind handler, _expr.yo:898) that panics at N with the
callee chain. (2) Fix in the overload-trial path: a "currently-checking (funcId,arg-
shape)" memo so a candidate trial is not re-run inside its own nested trials, AND/OR
honor `skip_ctfe_execution` to stop the callee body descent — mirror TS
function.ts:822-831 (`isInFunctionCallCheckingPhase` + `skipCtfeExecution` on each
dry-run). Validate: corpus 76/76 (must not break overload resolution — the glob.yo
case) AND `check main.yo` completes.

## UPDATE (2026-06-19, round 6) — DEFINITIVE: bounded-but-deep CTFE × giant frames (NOT unbounded)

Traced the body-eval to the CTFE gate (function.yo:2324): type-hierarchy-return /
comptime-only-return / all-args-are-types / macro functions EXECUTE their body at call
time; runtime-return functions correctly yield `UnknownVal` without it (the 2466
comment, faithful to helper.ts:1731). So the deep recursion is CTFE of the self-
source's mutually-recursive TYPE-returning functions over the self-referential
`TypeValue`.

**KEY PROOF it is BOUNDED, not unbounded:** the TS compiler SUCCESSFULLY compiles
`yo-self/main.yo` — that is exactly how `/tmp/yo-self-bin` is built (eval + CTFE +
codegen, ~5 min, exit 0). So the very CTFE recursion that overflows yo-self-bin
TERMINATES under TS. The recursion is bounded; the earlier "unbounded" reading
(round 5) was wrong.

**Therefore the crash is FRAME SIZE, not recursion count.** TS runs on a huge JS call
stack with tiny frames; yo-self-bin's enormous `evaluate_*` functions
(`evaluate_match` ~9 MB, `evaluate_function_call` ~8 MB at -O0; still multi-MB at -O2
because they are giant inlined matches holding `TypeValue`/`EvalValue` BY VALUE) blow
the C stack at a depth TS's stack absorbs. That is why `--release` (smaller, but still
multi-MB frames) also overflows 16 GB: a few-thousand-deep CTFE × multi-MB/frame > 16 GB.

**THE FIX (frame-size reduction, faithful):** box the large by-value locals in the
hottest recursive evaluator functions so each C frame shrinks ~Nx:
`_evaluate_expression`, `evaluate_function_call`, `evaluate_match`,
`evaluate_begin_expression`, `evaluate_cond` — pass/return `TypeValue`/`EvalValue` via
`Box`/`*(…)` in the hot paths and split the giant match arms into helpers (each helper
frame is independent, so LLVM stack-colors them separately). This is pervasive but
targeted at ~5 functions; it does not change semantics (so corpus stays 76/76) and
mirrors why TS never hits this (JS boxes everything). Secondary: the
def-time-body-env share (round 3) trims the heap half. Validate: corpus 76/76 + check
main.yo completes at a sane stack (e.g. 2-4 GB). NOTE the evaluator deadline (TS
_expr.ts:236) is a TIME limit, not a depth limit — it does not prevent the overflow
because the stack blows before the deadline fires.

## Why this matters

This is the gate for the whole Phase-6 fixpoint (stage-2 → stage-3 ≡ stage-2) and
Phase 7 (revive yo-self/tests under the stage-2 binary). Per the plan, the stage-2
compile is EXPECTED to surface a wave of executing-mode gaps; this startup crash is
the first one and must be cleared before the wave is even visible.
