# Stage-2 fixpoint blocker: ~60GB RC leak in eval phase (NOT a hardware limit)

## Status: OPEN — root localized, fix pending

## TL;DR — the diagnosis was wrong

The plan (`plans/YO_SELF_STAGE2_HANDOFF.md`, item 3) records the fixpoint
(`stage-2.c ≡ stage-3.c`) as blocked by codegen memory, remedy = "run on a
32GB+ box" (task #21). **That premise is wrong.** The self-compiled binary (s2)
does not merely _use a lot of_ memory — it **leaks ~60GB** compiling
`yo-self/main.yo`. A 32GB box would not fix a 60GB leak. It is a **fixable RC
bug**, not a hardware ceiling.

## Evidence

Control (s1 = yo-self compiled by TS `--release`) compiling `main.yo`:

- **76 seconds, peak RSS 9.2GB, COMPLETES.** Emits a 30,596,242-byte C file.

Same input, s2 (= yo-self compiled by s1, i.e. `stage-2.c` built at `-O2`):

- Runs 3.8–5.7 min, then **SIGKILL (rc=137)**.
- RSS stays ~3.4GB (misleading — macOS _compresses_ the leaked heap).
- True footprint (`top -stats mem,cmprs`) balloons: **27G→36G→56G→73G**
  (52–70G compressed) → jetsam kills it.

The leak is in the **EVAL phase**, not codegen: `s2 check main.yo` (evaluator
only, no C emission) balloons to 56–73GB identically. (An earlier note claimed
`check main.yo` was "bounded 3.3GB" — that measured RSS, which compression
holds flat; the footprint was already ballooning.)

s1 completing in 76s/9.2GB while s2 leaks 60GB on the _same source_ ⇒ this is a
**yo-self codegen / RC-lifecycle divergence from TS**, exactly the faithful-port
bug class. (TS uses a tracing GC that reclaims dead eval state for free; yo-self
uses RC + Bacon-Rajan cycle-GC and must drop it explicitly.)

## What leaks (live-heap breakdown, `heap -s` at 15s / 3.5GB / 35M live nodes)

| live count | avg bytes | site                                          | what                                    |
| ---------: | --------: | --------------------------------------------- | --------------------------------------- |
|  2,729,549 |       320 | `yo_id_20437` = **`new_variable`**            | env Variable records                    |
|  5,885,763 |        68 | `yo_id_20024`                                 | Variable sub-alloc (name String / etc.) |
|  5,954,076 |        60 | `yo_id_11997`                                 | ”                                       |
|  5,861,472 |        56 | `yo_id_4830`                                  | ”                                       |
|  1,854,763 |       154 | `yo_id_260821`                                | call dispatch                           |
|  1,100,193 |       151 | `yo_id_264811` = **`evaluate_function_call`** |                                         |

Dominant leaker = **`new_variable`**: the per-call callee-environment Variables
bound during **def-time body evaluation** are never freed. Over the whole
compiler's millions of def-time calls they accumulate to ~60GB. (`heap` without
MSL showed 195M live 80-byte objects at 23G — same story, later in the run.)

`callee_env` in `stage-2.c` has **9 `incr_rc` : 2 `decr_rc`** — a large net
retention imbalance: the callee environment (and, transitively, its Variables)
is retained far more than released.

## Two confirmed contributing divergences

1. **`evaluate_function_call` early-return drop omission.** Between the
   `evaluated_callee` `___dup` incr (`stage-2.c:366996`) and its single
   scope-end decr (`374265`) there are **140 early `return`s**, and **none**
   decr `evaluated_callee`. Each "Drop local variables before early return"
   block omits it. (This one pins bounded existing AST nodes, not the 60GB, but
   it is a real leak on the special-case call paths.)

2. **`return.yo` `_keep_pending_drop` has a yo-self-only over-broad guard** that
   TS (`src/codegen/exprs/return.ts:306-354`) does **not** have
   (`yo-self/codegen/exprs/return.yo:206-209`):
   ```
   c_name := sanitize_for_c_identifier(var_name, false);
   if(!(context.base.declared_c_var_names.contains(c_name)), { return(false); });
   ```
   It was added because yo-self records the **end-of-scope env** (not TS's
   point-in-time env), so it approximates "is this var initialized here yet?"
   via C-emission order (`declared_c_var_names`). If a legitimately-declared
   local is **not registered** in `declared_c_var_names`, its early-return drop
   is wrongly suppressed → leak. This is the prime suspect for the systematic
   callee-env/Variable drop omission on the hot early-return paths.

## The mechanism (decisive): throw-path drop omission × swallowed trial-eval throws

The 140 "early returns" in `evaluate_function_call` are almost all
`if (__yo_effect_escaped) { <drops>; return (__yo_t26*){0}; }` — i.e.
**throw/exception propagation** paths, taken when a `throw` unwinds through the
`exn.throw(...)` call and sets `__yo_effect_escaped`.

Def-time body evaluation **trial-evaluates** every function body and
**swallows** the failures (see `yo-self-defeval-wall` /
`yo-self-test-trial-eval-swallow`). So during `check main.yo` these throw paths
fire **constantly** — on the order of once per failed body eval, i.e. millions
of times across the whole compiler.

Each throw-path drop block _does_ drop the local `Option` temps, but it
**omits** `callee_env` and the per-call bound Variables (`new_variable`
results). TS's tracing GC reclaims that now-unreachable state for free; yo-self
must drop it explicitly on the throw path and does not. Millions of
swallowed-throw unwinds × leaked callee-env Variables = the ~60GB.

This is why the leak is invisible on small inputs (`check parser.yo`, 6s, few
throws) but catastrophic on `main.yo` (whole compiler, millions of trial-eval
throws), and why it is eval-phase, not codegen.

## Why no GC config helped (and why the "32GB box" remedy is a red herring)

The leaked callee-env state is **reachable** (pinned by explicit over-retention
/ missing drops), not unreachable cyclic garbage. Neither RC nor the cycle-GC
(`can_type_form_rc_cycle`, which IS implemented, not stubbed) frees reachable
objects. So every `YO_GC_*` setting still OOM'd — consistent with a
drop-emission leak, not a collector gap.

## ROOT CAUSE (definitive, 2026-07-13): unported M3 — the conservative control-flow drop-skip

`yo-self/evaluator/exprs/begin.yo:240-274` (`_schedule_scope_end_drops`) has a
**big-hammer conservative skip** that TS does not have: if a begin block
DIRECTLY contains a `return`/`unwind`/`break`/`continue`, it sets
`skip_block = true` and returns `None` — i.e. **drops NONE of the block's
owning named locals**. Its own comment says why:

> `(b)` a control-flow EXIT: yo-self has no init-position-filtered early-return
> drops yet (**TS begin.ts:2068-2122 — M3**) … so scheduling drops on a
> control-flow block crashes codegen when it emits a drop for a
> not-yet-live / moved-out local.

TS (`begin.ts:2064-2140`) instead:

1. ALWAYS schedules the normal `variablesNeedingDrop` (owning locals not
   consumed at scope end) — even for control-flow blocks;
2. ADDITIONALLY computes `earlyReturnOnlyVariables` (consumed-at-scope-end but
   initialized before an early return) and attaches their drops to the specific
   return statements via `attachEarlyReturnOnlyDropExpressionToReturns`,
   excluding the value being returned (it is consumed at that return).

Because yo-self skips ALL of it, when **yo-self's codegen** compiles yo-self
every control-flow-bearing function (i.e. `evaluate_function_call` and most of
the compiler) emits its dup-on-store incrs (`callee_env` at stage-2.c:367101 =
`__yo_incr_rc(ci->env)`) with **NO matching scope-end drop** — `callee_env` has
0 decrs in `yo_id_264811`. So s2 leaks `callee_env` (and every other owning
local) on EVERY call, millions of times → ~60GB. TS's codegen (which built s1)
HAS M3, emits the drops → s1 does not leak. This is the exact s1-vs-s2
divergence.

## Fix (faithful port of M3)

Port TS `begin.ts:2064-2140` into `_schedule_scope_end_drops` /
`evaluate_begin_expression`:

- **Remove the control-flow `skip_block`.** Schedule the normal owning-local
  scope-end drops for control-flow blocks too (the per-variable `consumed` /
  `initialized` / result-var / tail-atom filters e1-e7 already exist and are
  the correct granularity).
- **Port `earlyReturnOnlyVariables` + `attachEarlyReturnOnlyDropExpressionToReturns`**
  so that at each early `return(x)`/`unwind(x)` the block's owning locals are
  dropped EXCEPT `x` (consumed at that return) and any not-yet-initialized
  local. Without this, a naive `skip_block` removal would UAF on
  `return(owning_local)` patterns — which is precisely why the big hammer was
  added.
- The codegen side (`return.yo` early-return emission + `declared_c_var_names`
  guard) already filters not-yet-declared locals per return point, so it will
  correctly skip a scheduled drop whose C var isn't live yet.

Reference: `plans/YO_SELF_NAMED_LOCAL_DROPS.md` (M1/M2/M3 milestones); M3 is the
missing one. This is a well-scoped but non-trivial evaluator port with UAF risk
if done partially — the corpus diff-test (RC double-free/leak oracle) is the gate.

## Attempt 1 (2026-07-13): fix is CORRECT but triggers a drop-scheduling cascade

Tried the minimal version: delete the control-flow `skip_block` from
`_schedule_scope_end_drops` (rely on the existing `e5` consumed-check + the
begin-tail ownership pass, since `_check_keyword_position` forces return/unwind
to the tail where the tail pass already marks the returned local consumed).

Result — the fix WORKS as intended: rebuilt s1's emitted C for
`evaluate_function_call` now drops `evaluated_callee` (and the
`callee_saved_expected` dup) on the `__yo_effect_escaped` early-return paths that
previously leaked. BUT it surfaced a **latent drop-scheduling completeness bug**:
the same early-return drop blocks now also emit
`fn_...___drop(_yo73831c64_temp_283624)` for a temp that is **declared later** in
the function — `use of undeclared identifier` (20 clang errors in s1.c). It also
tripped a `rhs.$!.env` null-deref in `initialization-assignment.ts:497` (a
separate TS fragility; guardable with `rhs.$?.env`).

So scheduling scope-end drops for control-flow blocks is correct, but the
emission side must FILTER locals/temps not yet live at each early-return point.

- yo-self codegen already has this: `return.yo:206-209` `declared_c_var_names`
  guard — so the yo-self→stage-2 path may already be safe.
- **TS codegen (which builds s1) does NOT fully filter it** — its M3
  `initializedAtToken`/`tokenIsAtOrBefore` check (begin.ts:2081) does not cover
  this temp (`_283624` has no `initializedAtToken` — it is a compiler-generated
  temp, not a named local). This is the TS-side gap to fix FIRST (faithful-port
  rule): TS's early-return drop emission must skip drops whose C identifier is
  not yet declared at the return point (mirror yo-self's `declared_c_var_names`
  ground truth, or exclude temps without `initializedAtToken`).

Full fix = (1) TS: filter not-yet-declared temps from early-return drops (+
`rhs.$?.env` guard); (2) yo-self: delete the `skip_block` (verify `return.yo`'s
`declared_c_var_names` guard covers the same temps); (3) validate via corpus
diff-test + `s2 check main.yo` footprint bounded. Reverted to green pending that
multi-layer fix; the leak diagnosis and the working-but-incomplete fix are
recorded here.

## Attempt 2 (2026-07-13): the fix is blocked by a CASCADE of latent ID-sensitive TS-codegen bugs

Removing `skip_block` from `begin.yo` shifts every global expression id (the
`alloc_global_expr_id` counter moves), which changes temp names and ExprInfo
keys across ALL files. That surfaces latent, id-position-sensitive bugs in TS's
OWN codegen (the compiler that builds s1) — NOT in the M3 logic itself. Fixing
them in dependency order (faithful-port rule = fix TS first):

1. **`initialization-assignment.ts:497` `rhs.$!.env` null-deref** — RHS with no
   ExprInfo. Guarded with `rhs.$?.env` (temp vars always carry env → false).
   FIXED (revertible one-liner).
2. **`return.ts` early-return drop filter missing the initialized-after-cleanup
   check** — TS only checked `initializedAtToken` EXISTS, not its position, so it
   emitted a drop for a variable initialized later in the body. Ported yo-self's
   `_variable_initialized_after_cleanup_point` into TS as
   `variableInitializedAfterCleanupPoint`, applied at both filter sites. FIXED.
3. **`return.ts` drops a variable that has `initializedAtToken` but was NEVER
   declared in C** (`evaluate_function_call`'s `_yo…_temp_283624`: appears only
   in `___drop(...)` calls, no declaration anywhere) → `use of undeclared
identifier` (20 clang errors). Fix #2 does NOT catch it (its token is not
   comparable to the cleanup expr, so the position check returns "not-after").
   **This is the real blocker.** yo-self's codegen survives the identical case
   via `context.base.declared_c_var_names` — a C-emission-order ground-truth set
   (reset per function, seeded with params, grown as each declaration is
   emitted). **TS has no equivalent** (it relies on point-in-time
   `initializedAtToken`, which is inaccurate for a var whose declaration codegen
   skipped — e.g. an init-assignment that returned `""`). Completing the fix
   requires giving TS a `declaredCVarNames` mechanism (or teaching the drop
   filter to skip variables whose declaration was elided) — a substantial,
   high-blast-radius TS-codegen change (affects every compiled program) needing
   the full integration-test suite to validate.

Net: the M3 fix is correct and demonstrably works (s1.c dropped
`evaluated_callee` on early returns once fixes #1+#2 let codegen proceed), but
landing it end-to-end is gated on a TS-codegen robustness project (#3), because
any yo-self edit that shifts ids trips this latent TS landmine. All attempts
reverted to green. NEXT: implement `declaredCVarNames` in TS codegen (mirror
yo-self), then re-apply fixes #1/#2 + the `skip_block` removal, then validate
(corpus diff-test + `check ./std` + integration suite + `s2 check main.yo`
footprint bounded) before the fixpoint.

## Attempt 3 (2026-07-13): declaredCVarNames LANDED + validated; M3 blocked by a NEW affordability wall

Implemented the full `declaredCVarNames` mechanism in TS codegen (COMMITTED,
dormant-but-validated groundwork):

- `CodeGenContext.declaredCVarNames: Set<string>` (utils/index.ts), reset +
  seeded with params per function in `generateFunction`, grown as each
  declaration string is built in `getVariableTypeString`.
- `isCodegenTempName` (src/utils.ts) — module-independent temp-name test
  (`/^_.+_temp_[0-9]+$/`), used because a synthetic drop target may have no env
  to recover its minting module from.
- Drop-emission gate (skip a codegen TEMP whose C name is not yet in
  `declaredCVarNames`) at the universal choke point `generateDeferredDropExpressions`
  (drop-dup.ts) + `generateDropCodeForValue`, plus the early-return/unwind filters
  in `return.ts` and the scope-end loops in `begin.ts`.
- `variableInitializedAfterCleanupPoint` (return.ts) + `rhs.$?.env` guard
  (initialization-assignment.ts).

RESULT: with these + the `skip_block` removal, **s1 built CLEAN (0 clang errors)**
— the 20-error undeclared-temp cascade was fully resolved (found the true choke
point after tracing: the drops are resolved `fn_TYPE___drop(x)` method calls
emitted via `generateDeferredDropExpressions`, not the `___drop` builtin). Gates
with the infra alone (no M3): **s1 clean, check ./std 153/153, corpus PASS 118 /
DIFF 0 / SELF-FAIL 0.** The infra is correct and regression-free.

**BUT M3 hit a NEW, deeper wall — compile-time memory, not codegen:** with the
`skip_block` removal, **s1fix (stage-1) itself balloons to 67GB compiling
main.yo** (rc=137) — it can't even emit stage-2.c. Root: yo-self's
`_schedule_scope_end_drops` builds each `___drop(name)` via
`generate_expr_from_code("___drop(${name})")` — it **PARSES a string into fresh
AST nodes** per owning local per block, on every (repeated, trial-eval) block
evaluation. Un-skipping control-flow blocks (the majority) multiplies that
per-eval string-parsing across the whole compiler's millions of def-time evals →
tens of GB of transient/retained drop-node garbage. (It also regressed one corpus
file, `dyn_error_throw_ioerror`, to SELF-FAIL — same class in yo-self's own
codegen emitting an undeclared temp; gone once M3 is reverted.)

So M3-as-designed trades the s2 _runtime_ RC leak for an s1 _compile-time_
allocation explosion. Reverted the `skip_block` removal (kept the validated TS
infra). **The real remaining work is to make M3's scope-end-drop scheduling
affordable** — do not re-parse `___drop(name)` per eval:

1. build the `___drop` AST node directly (no `generate_expr_from_code`), and/or
2. CACHE the scheduled drop nodes per AST-node id (create once, reuse across
   the repeated def-time/trial-eval passes), and/or
3. only materialize drops at codegen time rather than eagerly during eval.
   Then re-apply `skip_block` removal + the TS `declaredCVarNames` gates (already
   landed) and validate `s1 emit main.yo` footprint stays ~≤10GB before the fixpoint.
   This also likely helps the pre-existing eval-phase cost.

## Fix direction (next dedicated effort)

Make yo-self's codegen drop the per-call callee environment (and recursively its
Variables) on **all** exit paths of the call-evaluation functions, matching what
TS's GC reclaims. Concretely:

1. Audit the `callee_env` lifecycle in `evaluate_function_call` /
   `yo_id_260821` / the body-execution helper (`yo_id_260010`) — find where the
   9:2 incr/decr imbalance originates.
2. Fix the `declared_c_var_names` completeness gap (or narrow the guard) so
   legitimately-declared locals are dropped on early returns — port TS's
   point-in-time `initializedAtToken` semantics faithfully rather than the
   end-of-scope-env approximation.
3. Verify: `s2 check yo-self/main.yo` footprint stays bounded (~≤10GB, like s1),
   then run the fixpoint `s2 compile … --emit-c` and diff `stage-2.c` vs
   `stage-3.c`.

## Repro / tooling

```bash
# s1 control (completes 76s/9.2GB):
YO_MAIN_STACK_MB=4096 /tmp/yo-self-s1 compile yo-self/main.yo --release \
  --emit-c --skip-c-compiler -o /tmp/s2ctl

# s2 leak (footprint balloons — WATCH cmprs, RSS lies):
YO_MAIN_STACK_MB=4096 /tmp/yo-self-s2o2 check yo-self/main.yo &
top -l 1 -pid <pid> -stats mem,cmprs   # 27G→73G

# live-heap leaker breakdown:
MallocStackLogging=1 /tmp/yo-self-s2o2 check yo-self/main.yo &
sleep 15; heap <pid> -s | head -20     # yo_id_20437 (new_variable) #1
```

Note: `malloc_history -allBySize` is too slow (times out) at this allocation
volume; use `heap -s` (fast, MSL-derived site names).

## Attempt 4 (2026-07-13): affordability is ARCHITECTURAL, not GC-tunable

The `declaredCVarNames` codegen gate LANDED and is validated (committed
`68f5cb49c`): with it, removing yo-self's `skip_block` (M3) makes s1 build with
**0 clang errors** (the 20-error undeclared-temp cascade is fully resolved) —
and the gate alone (no M3) is regression-free (s1 clean, `check ./std` 153/153,
corpus PASS 118 / DIFF 0 / SELF-FAIL 0).

But M3 itself is blocked by a compile-time memory explosion, and the two cheap
levers are RULED OUT:

- **Aggressive GC does NOT help.** With M3 applied (s1 builds clean), emitting
  main.yo under `YO_GC_THRESHOLD=64` still climbs 27G→36G→53G→56G and SIGKILLs
  (~7 min). The transient `___drop` nodes are **reachable/pinned** (retained on
  each block's `ExprInfo.deferred_drop_expressions`), not unreachable cyclic
  garbage — same reachable-not-cyclic property as the runtime leak, so no
  `YO_GC_*` setting reclaims them.
- **Direct AST-building (skip `generate_expr_from_code`'s lexer+parser) is
  insufficient** — the cost is dominated by the COUNT of drop nodes, not per-node
  build cost. M3 materializes one `___drop` node per owning-RC local per block,
  and the compiler's giant control-flow functions (`evaluate_function_call` et
  al., 10-20+ owning locals) × their many specialized instantiations produce
  tens of millions of pinned drop nodes (baseline non-control-flow blocks already
  ~9GB; adding control-flow blocks → 56GB+).

**Conclusion:** M3-as-a-faithful-port (eagerly schedule + retain scope-end drops
on every block's ExprInfo during eval) is architecturally too expensive in
yo-self. TS gets away with it because its tracing GC reclaims the transient
per-specialization drop Exprs; yo-self pins them on whole-compile ExprInfo
tables. The real fix: materialize scope-end drop nodes **lazily at codegen time**
(only for blocks actually emitted — bounded by final AST size), or represent a
scheduled drop as a lightweight `(var_name, type)` record the drop emitter
expands on demand rather than a retained AST node. Both are deeper
evaluator/codegen architecture changes than a localized fix — the well-scoped
next effort. After it, M3 + the landed `declaredCVarNames` gate complete item 3.

## Attempt 5 (2026-07-13): direct-build EMPIRICALLY ruled out — retention, not parse cost

Implemented direct AST construction of `___drop(name)` (AstExpr.FnCall + Atom via
alloc_global_expr_id/synthetic_token) in `_schedule_scope_end_drops`, replacing
`generate_expr_from_code`, + re-applied M3. s1 built clean; emitting main.yo
**still plateaus at 56GB** (unchanged from the string-parse version). So the
transient parser garbage was NOT the cost — it is the RETAINED drop nodes (and
the env/Variable state they pin) on per-block-per-specialization ExprInfo entries
that accumulate in the whole-compile expr_info_table. Confirms: no per-creation
optimization helps; only NOT retaining them (lazy codegen-time materialization)
or reclaiming per-specialization ExprInfo state (task #21) will. Reverted to green.

## Scope of the lazy-materialization refactor (measured 2026-07-13)

`ExprInfo.deferred_drop_expressions : Option(ArrayList(AstExpr))` is consumed at
**40+ sites** across yo-self codegen (grep): begin.yo, return.yo, cond.yo,
match.yo, while_loop.yo, other_fn_call.yo, functions/{generation,collection}.yo,
and the async state-machine machinery (state_machine.yo ~20 sites,
state_code_gen.yo, plus the `context.yo` FunctionGenerationContext fields and
`pending_deferred_drops`/`_concat_drops` plumbing). Changing the representation
to lightweight `(var_name, type)` records (so drops are expanded to C on demand
via `generate_drop_code_for_value` instead of retained AST nodes) means
rewriting all of them — including the async drop-chaining
(`_chain_additional_remaining`, `_append_exprs`, branch `deferred_drop_expressions`
fields) — and mirroring in TS. This is a pervasive multi-session refactor, not a
localized change; that measured scope is why the affordability fix cannot be
landed safely in a bounded step. The alternative (env RC-balance so the callee
env disposes its Variables at call end, avoiding per-block drop scheduling
entirely) is the smaller-surface path to investigate first next session.

## Env RC-balance alternative RULED OUT (2026-07-13) — M3 is genuinely required

Checked the "make callee_env a borrow (no dup-on-store incr)" alternative:
`callee_env := match(callee_info_opt, .Some(ci) => ci.env, .None => env)`
(function.yo:1716) — both arms ARE borrows (ci.env field / env param), so
callee_env should indeed be a borrow (TS: `calleeEnv = functionType.env`, no
incr), and fixing that removes callee_env's own +1. BUT the DOMINANT leaker is
the `new_variable` Variables (2.7M live) pushed onto the call frame — they leak
because the frame's owning-RC locals are never dropped at scope exit, which is
exactly what M3 (scope-end drops) provides. s1 (no leak) drops them via TS's M3;
yo-self's `skip_block` omits them. So the env-borrow tweak does NOT fix the
dominant Variable leak — M3 is genuinely required, and its only blocker is the
affordable-drop-representation refactor (40+ sites). No bounded shortcut exists;
the lazy-materialization (or ExprInfo-reclamation / task #21) refactor is the
sole path to item 3.

## Interning shortcut RULED UNSAFE (2026-07-13) — sharing AST nodes reintroduces double-free

Considered making M3 affordable by INTERNING `___drop(name)` nodes globally
(one shared node per name, reused across all specializations' blocks; compute
the drop's type from each block's own env at emission for per-specialization
correctness). This would bound the retained node count cheaply. BUT it requires
SHARING AstExpr nodes across blocks, and yo-self's RC assumes tree-ownership of
AST nodes: a shared node is dropped when one owning block is dropped, dangling
for the others — the exact shared-node / id-collision double-free class that bit
this project before (the `.clone()`-keeps-id regressions; see
yo-self-macro-dispatch-corruption / the `___dup` vs `.clone()` lesson). So
interning is NOT a safe shortcut. That leaves only the pervasive
compute-drops-from-`popped_env_frame`-at-codegen (or lightweight-record) refactor
across the ~40 `deferred_drop_expressions` sites, or per-specialization ExprInfo
reclamation (task #21). Confirmed by attempting the design, not just reasoning:
there is no safe bounded fix; item 3's remainder is a dedicated architectural
refactor.

## Better lead (2026-07-13): scratch expr_info_table for def-time trial eval

yo-self trial-evaluates function bodies at definition time with FRESH-ID clones
and swallowing exceptions (function.yo:389-435 `_trial_call_overload_candidate`,
`trial_exn := Exception(throw : ((_err) -> unwind(())))`; the general
def-time-body-eval per `yo-self-defeval-wall`). Each trial's fresh-id ExprInfos
are DISCARDED but still accumulate forever in the whole-compile `expr_info_table`
— this is very likely the bulk of the 56GB (and it makes M3 worse because M3 adds
drop nodes to each). PROMISING FIX (more localized than the 40-site drop refactor):
run the def-time trial eval against a SCRATCH `expr_info_table` (swap
`ctx.expr_info_table` for a fresh one before the trial, restore + discard after),
so throwaway trial ExprInfos never enter the persistent table. PREREQUISITE to
verify first: codegen must RE-evaluate bodies for real (not reuse the def-time
trial's ExprInfos) — check whether the real/codegen eval overwrites or depends on
def-time ExprInfos before implementing; if codegen reuses them, this breaks and
the 40-site drop-representation refactor is required instead. This scratch-table
approach also directly attacks task #21 (compile memory) independent of M3.

### Scratch-table caveat (verified in code): \_trial_eval_fn_body evals the ORIGINAL body

`_trial_eval_fn_body` (function_type.yo:208) evaluates `wrap_body_in_begin(body)`
— the ORIGINAL body node, NOT a fresh-id clone. So the ExprInfos it creates share
ids with what codegen later reads. For NON-generic functions (no specialization
clone), codegen reuses exactly those def-time ExprInfos → scratch-tabling this
eval would drop them and break codegen ("Failed to transpile" / get_expr_info
None) unless codegen re-evaluates the body in executing mode. So the scratch-table
must be applied ONLY to the genuinely-throwaway fresh-id-clone trials (overload
resolution `_trial_call_overload_candidate` function.yo:389, and any
specialization TRIALS that are discarded) — NOT the def-time validation eval of
original bodies, and NOT the real specialization eval (helper.yo:1465, whose
ExprInfos codegen needs). Distinguishing these precisely (and confirming which
dominate the 56GB) is the correctness-sensitive prerequisite. This is why item 3's
remainder is a careful, validated effort, not a bounded edit — verified at code
level, every candidate fix is either ineffective (measured) or correctness-risky.
