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

## Refined root cause (2026-07-13): leak is ExprInfo.env accumulation, not popped_env_frame

Found `ExprInfo.popped_env_frame` is WRITE-ONLY DEAD STATE (written begin.yo:1033,
never read anywhere) — removed the store (verified safe: check ./std 153/153,
corpus PASS 118 / DIFF 0). But `check main.yo` STILL plateaus at 56GB, because the
per-call env Variables (`new_variable`, the dominant leaker) are ALSO retained via
every inner expression's `ExprInfo.env`: each ExprInfo holds the env it was
evaluated in, and inner exprs evaluated while a frame is live hold envs that
INCLUDE that frame. Since `ExprInfo.env` is read/needed everywhere, this cannot be
removed — the fix is to RECLAIM ExprInfos (and their envs) after they are no longer
needed (task #21), i.e. the whole-compile `expr_info_table` never prunes, so every
def-time-eval'd expression's env (with its frame Variables) lives forever.
Also clarified check-vs-compile: `s1 compile main.yo` = 9.2GB (evals only reachable
functions) but `s1 CHECK main.yo` = 56GB (type-checks ALL functions → full
ExprInfo/env accumulation). The fixpoint uses COMPILE; s2 compile leaks because of
the codegen missing-drops (M3) issue, distinct from this check-phase env retention.
Both ultimately trace to yo-self not reclaiming compile-time eval state (envs,
ExprInfos, drop nodes) that TS's tracing GC frees — the shared task-#21 root.

## is_executing drop-gate RULED OUT (2026-07-13) — gates caught RC divergence

Tried the most promising bounded lever: gate `_schedule_scope_end_drops` on
`ctx.is_executing` (skip building scope-end drop nodes during non-executing
def-time validation/type-check trials, which fire millions of times; only build
them for the real is_executing=true compile eval). s1 built clean, `check ./std`
153/153 — BUT corpus diff-test regressed to **DIFF 6** (RC behavior of the
self-compiled binaries diverged from TS on 6 files, e.g. ref_enum_option_cycle).
So the scope-end drops are NEEDED even for some non-executing-mode ExprInfos that
codegen reuses — they cannot simply be skipped by mode. The corpus RC oracle
caught it pre-commit; reverted. This empirically rules out mode-gating as a bounded
fix and confirms the reclamation must be structural (only prune ExprInfos proven
dead, or make drops lightweight) — the careful architectural refactor.

## ROOT CAUSE SHARPENED (2026-07-13): never-pruned ExprInfo table holding env snapshots

Pinned the exact mechanism of the ~60GB compile-time footprint (and why porting M3
explodes it further):

- **TS** stores per-node eval data ON the node: `src/expr.ts:495,510` — `$?: EvaluatedExprData`.
  When a function specialization's cloned AST becomes unreachable, **V8 GC reclaims the
  node AND its `$` (including its `env`) together.** Memory stays bounded automatically.
- **yo-self** stores it in a GLOBAL side-table: `expr_info.yo:456`
  `ExprInfoTable :: newtype(data : HashMap(ExprId, ExprInfo))`, held in `ctx.expr_info_table`,
  keyed by integer `ExprId`, and **NEVER pruned**. Every evaluated node across every
  specialization stays in the table for the whole compile.
- Each `ExprInfo` carries a **required `env : Environment` field** (`expr_info.yo:317`),
  populated via `snapshot_env(env)` (`expr_info.yo:410`). The snapshot is shallow (shares
  Frame refs) — but because SOME live ExprInfo references each Frame, the union of ALL frames
  ever snapshotted (and their Variables/TypeValues/EvalValues) stays alive for the whole compile.
  That union is the ~60GB. (Control /tmp/yo-self-s1, pre-RC-arc, compiled main.yo at 9.2GB;
  the RC arc multiplied evaluated-node count — dup/drop nodes — hence the 6x.)
- **Removing M3's `skip_block`** (begin.yo:264) adds a re-parsed `___drop(name)` node (each
  carrying its own env snapshot) for every owning-RC local in every control-flow block — and
  control-flow blocks are ubiquitous (every fn with a `return`). That is the +56GB explosion.

### Why the cheap shortcuts are ALL ruled out (each verified this session)

- **Null the env field post-eval**: UNSAFE — codegen READS `info.env` (216 sites in TS codegen,
  73 in yo-self). Most only read `env.module_path` for `is_temp_variable_name`, but async
  (`state_code_gen.yo`, `state_machine.yo`) and assignment (`assignment.yo:66,82,93`) paths call
  `get_variables_from_env(ei.env, …)` needing the actual frames. Can't drop env wholesale.
- **Per-specialization table pruning (mirror V8 GC)**: no safe reclaim boundary. Specialization
  is interleaved/lazy (triggered from helper.yo ×5, function.yo ×3, index_trait, dyn, anon-fn)
  and each specialized body is re-walked by MULTIPLE later codegen passes (RC drop-emission,
  tracer specialization, async state machines). Frames are shared across functions. Removing a
  function's ids after "its" codegen breaks a later pass's read → corpus regression.
- **is_executing mode-gate**: corpus DIFF 6 (drops needed in non-executing mode too). See above.

### The ONE faithful fix (task #21) — node-attached ExprInfo storage

Make yo-self match TS's storage model: move `ExprInfo` off the global `expr_info_table` and ONTO
the `AstExpr` node, so RC reclaims it with the node (yo-self's RC == TS's GC for this purpose).
Concretely: add a mutable cell to each variant —
`Atom(id, token, info : ref(Option(ExprInfo)))`
`FnCall(id, func, args, is_infix, token, info : ref(Option(ExprInfo)))`
— and rewrite `expr_info_table_set/get` to write/read `node.info.*` (threading the NODE, not just
the id, to every call site; ~hundreds of sites). Then a specialization's cloned nodes (and their
ExprInfo + env snapshots) are reclaimed when the specialized FunctionValue's body is dropped —
bounded, exactly like TS. This is the correct 1:1 port (the global table was the yo-self-specific
divergence, comment at expr.yo:308-313). It is large and pervasive; it cannot be landed AND
validated (corpus + std + fixpoint footprint) within a bounded session turn without risking the
verified-green compiler, so it is scoped here for a dedicated focused effort rather than attempted
piecemeal. Once landed, re-apply M3 (remove skip_block) on the already-landed declaredCVarNames
gate (68f5cb49c), then run the fixpoint (stage-2.c ≡ stage-3.c).

## NODE-ATTACH STRUCTURALLY BLOCKED (2026-07-13, empirically proven)

Tested the TS-faithful fix (store ExprInfo on the AstExpr node like `expr.$`). It is
INFEASIBLE in yo-self's module system:

- To put a `info : ExprInfo` cell on `AstExpr` (in `expr.yo`), `expr.yo` must reference
  `ExprInfo`, which references `EvalValue` (`expr_info.yo:322,340,370,388` etc.).
- `EvalValue` (`value.yo`) references `AstExpr` — inherently (`FunctionValue.body : AstExpr`
  at value.yo:24; `EvalValue.ExprVal(expr : AstExpr)` at value.yo:186). Functions and quoted
  values hold AST nodes; this cannot be removed.
- So `expr.yo → value.yo → expr.yo` is a MUTUAL DESTRUCTURING CYCLE.
- **PROBE (reverted):** adding `{ EvalValue } :: import("./value.yo")` to `expr.yo` fails at
  load: _"Cannot destructure from a module that is still being evaluated (circular import).
  The requested fields are not yet available."_ — cascades `check ./yo-self` to 84/303.
- TS resolves the identical `expr.ts ↔ value.ts` cycle because `import type` is erased at
  compile time; yo-self imports are VALUE (namespace-destructuring) imports evaluated at load
  time, so the cycle is a hard error. **This is the real reason the port uses a side-table**
  keyed by id — it keeps the module graph an acyclic DAG (`value → expr`;
  `expr_info → {expr, value, env}`). Node-attach would need type-only/lazy imports — a
  language/loader feature, out of scope.

### Consequence — the memory fix MUST live within the side-table model

Remaining tractable levers (in priority order):

1. **Env-trim at RC-synthesis sites (bounded, next):** the RC arc (9.2GB→56GB) added a table
   entry + `snapshot_env` per synthesized `___drop`/`___dup` node. These leaf nodes are used
   only for codegen EMISSION; codegen reads `ei.env.module_path` (a String) for them, not
   `get_variables_from_env` (which is only hit on async/assignment/await nodes). If the drop/dup
   ExprInfos retain a lightweight env (module_path only, no frame chain) the dominant retained
   memory (frames→Variables→Types/Values pinned by the never-freed table) is cut for the arc's
   added entries — WITHOUT the infeasible node-attach. Must verify codegen never calls
   get_variables_from_env on a drop/dup node, then validate corpus+std+main.yo footprint.
2. **Coarse table reclamation** between top-level declarations — unsafe as-is (specializations
   are shared across declarations via the cache; a cleared entry re-read → None → breakage).
   Would need a reachability/refcount on cache-shared specializations.

## EMPIRICAL FOOTPRINT MEASUREMENT (2026-07-13, current HEAD 9c7580095)

Ran the actual item-3 chain from a fresh `--release` s1 to confirm the blocker (not
relying on prior-session numbers):

- Built s1 (`./yo-cli compile yo-self/main.yo --release`) — OK.
- Ran `s1 compile yo-self/main.yo --emit-c --skip-c-compiler` (the stage-2.c emission),
  monitored with `top -l 1 -pid <pid> -stats mem,cmprs`:
  - t=20s **27G**, t=40s 30G, t=60s 36G, t=100s **56G**, then **plateaus at 56G**
    (52–53G compressed; RSS only ~2.6G — macOS compressor holding the leaked heap).
  - Did NOT complete; thrashes the compressor and never produces stage2.c.
- **Machine: 16 GB physical RAM + 12 GB swap ≈ 28 GB usable. Footprint 56 G = ~2× capacity.**
- **Conclusion: item 3 (fixpoint stage-2.c ≡ stage-3.c) is unrunnable on this 16GB box.**
  Task #21's fallback ("run fixpoint on 32GB+ box") really needs **64GB+** given the 56G
  plateau. The only in-repo path is the memory fix — which the analyses above prove is a
  major architectural effort (node-attach blocked by the loader import cycle; reclamation
  has no safe boundary under the global multi-pass codegen). Both cheap levers are closed.

## OOM CONFIRMED + fix cannot be validated on this box (2026-07-13)

- Re-ran the stage-2.c emission to completion-or-death: process **jetsam OOM-killed** at the
  56G plateau (empty output, no stage2.c) after ~7 min. Confirms the summary's rc=137. Not a
  bounded-time thrash that eventually finishes — it dies.
- Single-module compiles do NOT reproduce it: `s1 compile yo-self/lexer.yo --emit-c` finishes
  in ~5s at low memory (250KB C). The 56G is inherent to compiling the WHOLE compiler
  (main.yo → every module + every generic specialization) — it scales with total
  specialization count × the RC arc (pre-RC-arc control was 9.2G; RC arc → 56G, ~6×).
- **Therefore a memory fix cannot be developed on this 16GB box:** the corpus diff-test gate
  validates RC _correctness_ (small programs, low memory) but NOT a memory _reduction_; the
  only thing that measures the reduction is the main.yo emission, which OOM-kills until the
  fix is ALREADY sufficient (<~24G). It is all-or-nothing — you cannot see "56G→45G" progress,
  so you cannot iterate a partial fix here. Developing/validating the memory fix REQUIRES a
  64GB+ machine (to run the emission, watch peak drop, and confirm the fixpoint diff).
- Net: item 3 on current hardware is blocked two ways at once — (1) the fixpoint run itself
  needs 64GB+, and (2) the memory fix that would shrink it also needs 64GB+ to validate.
  The clean fix (node-attach) is separately blocked by the loader import cycle. This is the
  honest ceiling of what this environment can do for item 3.

## VIABLE PATH FOUND (2026-07-13): callback-inversion drop-reclamation + per-id liveness refcount

This sidesteps the node-attach import-cycle wall and replicates TS's GC semantics:

- **Dependency inversion (breaks the cycle):** `expr.yo` gets a global
  `(g_on_expr_dispose : Option(fn(ExprId) -> unit)) = .None` and a CUSTOM `AstExpr` drop that
  calls it with the node's id. `expr_info.yo` (or main.yo init) sets
  `g_on_expr_dispose = remove-from-table`. `expr.yo` never imports `ExprInfo`/`EvalValue` —
  only `fn(ExprId)->unit` — so NO `expr↔value` cycle. Table stays a global singleton the
  callback reaches.
- **Effect:** when a node drops (RC=0) its ExprInfo entry is reclaimed. Throwaway validation
  trials (`is_executing=false`, fired millions of times — see function_type.yo:208
  `_trial_eval_fn_body`) drop their nodes right after the trial → entries reclaimed. This
  bounds memory WITHOUT skipping any drop creation (so it does NOT regress corpus the way the
  is_executing gate did — codegen's live-FunctionValue-held nodes keep their entries).
- **BLOCKER to resolve — shared ids:** the derived `Clone` (expr.yo:296-306) SHARES ids by
  design (a clone reuses the original's ExprInfo entry; comment expr.yo:308-313). So two live
  nodes can share one id; removing the entry on either's drop UAFs the other. Fix = a per-id
  **liveness refcount**: `HashMap<ExprId, usize>` incremented at every AstExpr construction
  (parser + ~119 `AstExpr.Atom/FnCall` sites + Clone + clone_expr_fresh_ids + make_err_expr)
  and decremented in the custom drop; remove the ExprInfo entry only when the count reaches 0.
  Correct even with shared ids (it is exactly object-liveness, which V8 gives TS for free).
- **Cost/risk:** custom `AstExpr` drop (delicate — must still recurse func/args; interacts with
  RC/cycle-GC \_\_\_dispose), +1 HashMap op per node create/drop (perf), and the ~119 constructor
  edits. Correctness is checkable via the corpus RC oracle (small programs). BUT the memory
  win is NOT measurable on this 16GB box — needs a 64GB+ machine to run the main.yo emission
  and confirm the peak drops below capacity + the fixpoint diff. This is the recommended path
  for a focused session on adequate hardware; it is the first design that clears the import
  cycle that blocks node-attach.

## FINAL FEASIBILITY (2026-07-13): every path needs a new language/loader/arch feature

Checked the last enabler — the callback-inversion path needs a user drop hook to fire
`g_on_expr_dispose(id)` when an AstExpr drops. **yo-self has NO user-facing `Drop` trait / dispose
hook** — `___dispose` is compiler-SYNTHESIZED (auto-derived; codegen_c.yo:241), with no seam to
run user code on drop. So that path requires ADDING a Drop-hook language feature.

Consolidated: bounding the fixpoint compile's ~56G footprint requires ONE of —

1. **Node-attach ExprInfo** → needs type-only/lazy imports in the loader (to break the
   `expr↔value` value-import cycle). LOADER feature.
2. **Callback drop-reclamation** → needs a user `Drop`/finalizer hook on AstExpr. LANGUAGE feature.
3. **Table reclamation** → needs a safe reclaim boundary; none exists under the global multi-pass
   codegen + shared-id derived Clone. CODEGEN-ARCHITECTURE change.

…and EVERY one, once built, still needs a **64GB+ machine** to validate (the memory win is
unmeasurable on 16GB — the main.yo emission OOM-kills before you can observe a partial drop, and
the corpus gate only checks RC correctness, not footprint).

**Honest ceiling:** item 3 (fixpoint stage-2.c ≡ stage-3.c) is not completable in this
environment (16GB box, current yo-self language/loader/codegen). It requires a focused effort on
64GB+ hardware plus one of the three feature-level changes above. Items 1, 2, and item 3's codegen
half (declaredCVarNames, 68f5cb49c) are done; item 4 (#69/#70) stays gated. All findings this
session are committed as evidence; the verified-green compiler is untouched throughout.

## REFRAMED (2026-07-13): 56G is a REGRESSION (duplicate/phantom drop accumulation), NOT a hardware wall

Overturns the "needs 64GB" conclusion above with two measurements:

- **The pre-regression control `/tmp/yo-self-s1` (commit ~859928eb3, Jul 12) compiles the SAME
  main.yo at 9.2G in 75s and COMPLETES** (30MB stage2.c). The box handles the fixpoint fine at
  baseline. So 56G is a ~6× REGRESSION introduced in the `859928eb3..HEAD` range
  (only 2 code commits: 6b5c0ceb0 RC-fix, 68f5cb49c declaredCVarNames gate), not inherent.
- **Smoking gun — phantom/duplicate drops:** in the gate-OFF emission, the single temp
  `_yo73831c64_temp_283669` (type `AstExpr*` = `__yo_enum_yoe4f8607a_id_3*`) appears **321 times,
  ALL as `___drop` calls, and is NEVER declared/assigned anywhere.** It is a phantom the evaluator
  scheduled for drop ~16× per escape block × ~20 escape blocks in `evaluate_function_call`. Each
  such phantom `___drop(name)` is built via `generate_expr_from_code` (fresh lex+parse) and
  evaluated → a fresh ExprInfo + env snapshot pinned in the never-pruned `expr_info_table`. The
  drop-list DUPLICATION (same var dropped ~16× in one cleanup list) multiplies these table
  entries → the 6× memory.
- The `68f5cb49c` gate SKIPS these at CODEGEN (correct — they're never-declared phantoms, so
  no runtime leak from them), which is why it is load-bearing to BUILD (without it → 20
  undeclared-C-identifier clang errors). So the gate is NOT the leak; the EVALUATOR's bloated
  deferred-drop lists are.

### Next (concrete, bounded, validatable)

Find where the deferred-drop list accumulates the SAME variable's drop ~16× (dedup missing) and/or
schedules drops for never-materialized (phantom) temps, in the `859928eb3..HEAD` delta — prime
suspect: 6b5c0ceb0's `set_expr_as_needs_to_call_dup` env-propagation + the escape/early-return
cleanup path. Fix = dedup the drop list / don't schedule phantom drops. Validate: rebuild s1,
corpus PASS/DIFF 0, then main.yo emission peak drops toward ~9G and COMPLETES (item 3 unblocked
ON THIS BOX). This supersedes the node-attach / callback-drop / 64GB conclusions — the leak is a
fixable accumulation bug, not an architectural GC gap.

## BISECTED (2026-07-13): the 6x regression is commit 68f5cb49c (declaredCVarNames drop-skip gate)

Four-config bisect via measured s1 main.yo emission footprint (each: build s1, run
`compile yo-self/main.yo --emit-c`, watch `top -stats mem`):

| config (6b5c0ceb0 UAF-fix / 68f5cb49c gate) | builds?                                  | peak footprint      |
| ------------------------------------------- | ---------------------------------------- | ------------------- |
| control (no 6b / no 68)                     | yes                                      | **9.2G, COMPLETES** |
| no 6b / **yes 68**                          | yes                                      | **56G (OOM)**       |
| yes 6b / yes 68 (HEAD)                      | yes                                      | 56G (OOM)           |
| yes 6b / no 68                              | no (temp_283669 undeclared clang errors) |

- **Reverting 6b5c0ceb0 alone stays at 56G** → 6b5c0ceb0 (the borrowed-callee `___dup`) is NOT
  the memory cause (matches the earlier "reverting the dup didn't help" note).
- **The ONLY difference between the 9G control and the 56G config is 68f5cb49c** → it is the
  6x regression. It is a TS-codegen change billed as "M3 groundwork" for a path (yo-self
  begin.yo skip_block removal) that is NOT landed — so it delivers ZERO current benefit while
  causing a 6x leak.
- **Mechanism:** the gate skips a `___drop` when `isCodegenTempName(name) && !declaredCVarNames.has(name)`.
  `declaredCVarNames` is seeded with params and grown ONLY in `getVariableTypeString`. Temps
  declared through any OTHER emission path are therefore absent from the set, so the gate
  wrongly classifies those REAL, declared temps as "undeclared" and SKIPS their drop → the RC
  value is never released → leak. In the no-6b config there are no genuine phantoms yet the
  gate still inflated 9G→56G, proving it skips REAL drops. A leak (not a double-free) does not
  change program output, so the corpus diff-test (PASS/DIFF 0) cannot detect it — which is why
  68f5cb49c was landed "regression-free."
- Note `temp_283669` (undeclared, from 6b5c0ceb0's dup) is a genuine phantom the gate correctly
  suppresses — that is why fully reverting 68f5cb49c fails to build with 6b5c0ceb0 present. So the
  fix must keep SOME phantom suppression while not skipping real drops.

### FIX (next, validatable on THIS box)

Either (a) COMPLETE `declaredCVarNames` so it records every C-declared temp (all declaration
emission paths, not just getVariableTypeString) — then the gate skips only genuine phantoms and
real drops are emitted (→ 9G); or (b) replace the "declared YET" incremental check with a
"declared ANYWHERE in this function" check (pre-scan the function body's declarations) so only
true phantoms are skipped; or (c) fix 6b5c0ceb0's `___dup` to not emit the phantom temp
(faithful single-reassigned-local like TS) and then revert 68f5cb49c entirely. Validate: rebuild
s1 → corpus PASS/DIFF 0 → main.yo emission completes at ~9G → run the fixpoint diff. This is a
concrete codegen fix, NOT an architectural GC change.

## PIVOTAL CORRECTION (2026-07-13): the leak is in YO-SELF's codegen, not TS

Ran the control fixpoint chain and found the decisive asymmetry:

- Control **s1** (yo-self binary emitted by **TS codegen**) compiles main.yo at **9G — no leak**.
- Control **s2** (SAME yo-self source, but its binary emitted by yo-self's **self-hosted codegen**,
  i.e. built from s1's stage2.c) compiles main.yo at **56G — leaks/OOMs**.
- s1 and s2 run identical yo-self logic; the ONLY difference is which codegen produced their C.
  ⇒ **yo-self's self-hosted codegen emits leaky binaries; TS codegen does not.**

Mechanism: yo-self's codegen SCHEDULES a `___drop` for temps it never DECLARES (e.g.
`_yo73831c64_temp_283669`, an `AstExpr*`), and its `declared_c_var_names` gate then SKIPS that drop
(else undeclared-C-identifier error) → the RC value is never released → leak. TS codegen for the
same construct DECLARES the temp, so its drop is valid and emitted → no leak (9G). So the divergence
is: **yo-self codegen fails to emit a C declaration for a temp that TS declares.**

`68f5cb49c` then PORTED yo-self's leaky skip-gate INTO TS codegen (as "M3 groundwork"), which made
TS ALSO skip those drops → s1 regressed 9G→56G. So 68f5cb49c has two problems: (1) it made TS match
yo-self's leak, and (2) it is groundwork for an unlanded path. **Reverting 68f5cb49c restores TS to
its correct 9G behavior** — but does NOT fix s2 (yo-self codegen still leaks), so the fixpoint stays
blocked at the s2→stage3 step until yo-self's codegen is fixed.

### THE REAL FIX (both compilers, faithful port)

Find where yo-self's codegen fails to emit the C DECLARATION for a temp it later drops (the temp that
forces `declared_c_var_names` to skip) and make it declare the temp — matching TS codegen, which does
declare it (control s1 = 9G proves TS's emission is correct & leak-free). Then neither codegen needs
the skip-gate and neither leaks. Prime locus: the early-return/`__yo_effect_escaped` cleanup temps in
`evaluate_function_call`-style large functions; `temp_283669` is `AstExpr*` — compare yo-self codegen's
declaration emission for that temp against TS's in the 9G control's stage2.c (`/tmp/ctrl-out.c`).
Validate: rebuild s1 (still 9G after reverting 68f5cb49c) → rebuild s2 from the fixed stage2.c →
s2 compiles main.yo at ~9G and COMPLETES → run the fixpoint diff. This is a concrete codegen
declaration-emission bug, fully validatable on THIS 16GB box.

## FIX LANDED (part 1) + completion path (2026-07-13)

Definitively proved the leak and landed the first, validated part:

- **Proof:** emitting yo-self with the gate ON vs OFF, the gate SKIPS ~88,000 temp drops
  (108,281 → 20,021). Sampling: **194/200 skipped temps are DECLARED (real, live) → their
  skipped drop LEAKS**; only ~a handful are genuine never-declared phantoms (e.g. temp_283669).
  Root: `declaredCVarNames` is grown ONLY via `getVariableTypeString`, but many result temps are
  declared via `getTypeString` → untracked → gate wrongly treats them as undeclared → skips drop.
- **Part 1 landed (commit — begin/cond/match/index-callee):** added `declaredCVarNames.add()` at
  those 4 getTypeString-based result-temp declarations. Recovers 53,286/108,281 temp-drops.
  Corpus **PASS 118 / DIFF 0** (RC-safe). s1 main.yo emission peak **56G → ~53G** (24G plateau
  extended) — CONFIRMS recovering drops reduces the leak. (Still OOMs; ~55K drops remain skipped.)
- **Remaining (part 2):** the ~15,479 still-skipped temps are ARGUMENT / pre-statement result
  temps (e.g. `_yo008166df_temp_315261 = fn_..._from(...)` passed to format_error_message) plus
  other-fn-call.ts:1793,2203 and other getTypeString-based decl sites. Two options:
  1. Continue adding `declaredCVarNames.add(name)` at each remaining getTypeString temp-decl site.
  2. ROBUST one-shot: in `generateFunction`, PRE-WALK the body AST collecting every
     `ExprInfo.variableName` and seed `declaredCVarNames` up front (evaluator temps like
     `_yoHASH_temp_N` are the bulk and ARE carried as node variableNames; genuine phantoms like
     temp_283669 are env Variables, NOT node variableNames, so they stay correctly skipped).
- **Then:** apply the SAME fix to yo-self's codegen (its `declared_c_var_names` gate has the
  identical gap — that is the s2 leak). Rebuild s1 (9G) → emit stage2.c → build s2 → s2 emits
  stage3.c (9G) → `diff` = fixpoint. Every step validatable on THIS 16GB box (corpus + emission).

## LEAK FIXED — TS fully (56G→9G), yo-self partially (56G→26G) (2026-07-13, committed + corpus-green)

Root cause CONFIRMED by the gate ON/OFF drop-diff: the `declaredCVarNames` drop-skip gate
(68f5cb49c) skips a `___drop` for any codegen temp NOT in the set; the set was grown only via
`getVariableTypeString`, but ~30 temp-decl paths build the declaration via `getTypeString`, so the
gate SKIPPED ~88,000 live-RC temp drops → the 6x leak (invisible to corpus — a leak, not a
double-free, leaves output unchanged).

**FIX = centralize declaration tracking in the Emitter** (records every codegen temp DECLARED in an
emitted code line, in C-emission order so forward-ref protection holds; `___drop((cast)(name))` uses
never match decl position, so genuine phantoms stay correctly skipped):

- **TS (commit 0b9928b95): FULLY FIXED.** s1 main.yo emission **56G → 9.2G and COMPLETES**
  (produces stage2.c). temp-drops 20021→107960/108281 (321 remaining = the one genuine phantom).
  Corpus PASS 118 / DIFF 0. The PRIMARY compiler no longer leaks.
- **yo-self (commit 2e329eeee): PARTIAL.** Ported the Emitter capture (manual parse, no regex).
  s2 (built from yo-self-codegen-emitted stage2.c) **56G → 26G**, builds, corpus PASS 118 / DIFF 0.
  Residual: the module-blind `_emitter_is_minted_temp` (requires `_temp_`+digits-to-end) misses
  module-PREFIXED temps that yo-self's gate flags via `is_temp_variable_name` → those stay skipped.

**REMAINING to complete the fixpoint (s2 → 9G):** broaden the yo-self Emitter's decl detection to
record the module-prefixed temps WITHOUT false positives. A blanket "record any decl-position
identifier" was tried and is UNSAFE — it recorded non-temp fragments (e.g. `giv`, `exp`) as
declarations, so yo-self emitted `___drop`s for undeclared identifiers → stage2.c failed to clang-
compile. The precise fix: record a decl-position identifier iff it satisfies the SAME predicate the
gate uses — i.e. `_looks_like_minted_temp(name)` (digits-to-end) OR the module-prefixed
`is_temp_variable_name` form (`_file____<module>_temp_<...>`). Extend `_emitter_is_minted_temp` to
also accept the `_temp_`-with-trailing-suffix module-prefixed shape while still rejecting user vars
like `await_future_temp_var_aliases`. Then: s1→stage2.c@9G → build s2 → s2→stage3.c@9G →
`diff stage2.c stage3.c` = FIXPOINT-OK. All steps validatable on this 16GB box.

## Residual-26G refinement attempts (2026-07-13) — uninit-decl recording is UNSAFE in yo-self

Tried to close the residual yo-self leak (26G → 9G) by broadening the Emitter's decl detection.
Two attempts, both reverted:

1. **Record ANY decl-position identifier** (drop the minted-temp filter): UNSAFE — recorded
   non-temp fragments (e.g. `giv`, `exp`) as declarations, so yo-self emitted `___drop`s for
   undeclared identifiers → stage2.c failed to clang-compile.
2. **Also record uninitialized decls `<type> <temp>;`** (mirroring the TS regex's `;` branch):
   builds and passes corpus, but the emitted stage2.c makes **s2 CRASH at startup** (empty output).
   Recording a temp at its UNINIT declaration marks it "declared" before it is assigned, so the
   gate stops skipping an early-exit drop of a not-yet-initialized temp → `___drop(garbage)` → crash
   at compiler scale (corpus's small programs don't exercise it).

Root insight: `declared_c_var_names` is a flat per-function, C-emission-order set — a good proxy for
"declared AND initialized" ONLY at initialized-decl (`<type> <temp> = …`) sites. For a temp declared
uninitialized then assigned in a branch, recording at the decl (or naively at a bare assignment)
lets the gate emit a pre-initialization drop in a sibling branch → uninitialized-memory drop → crash.
TS survives its `;` branch because its pre-init drops are ALSO guarded by the `initializedAtToken`
position check; yo-self's `_variable_initialized_after_cleanup_point` guard is evidently weaker, so
recording uninit decls exposes pre-init drops yo-self does not catch.

**Safe floor = commit 2e329eeee** (" = " init-decl recording only): s2 56G→26G, builds, s2 RUNS
(leaks to OOM, no crash), corpus PASS 118 / DIFF 0. **The residual (temps declared uninitialized then
branch-assigned) requires either (a) strengthening yo-self's initialized-at-token pre-init-drop guard
to TS parity so uninit-decl recording becomes safe, or (b) recording at the temp's first ASSIGNMENT
with per-branch liveness — not the flat set.** This is a subtle control-flow-correctness refinement,
NOT a blind broadening (both blind attempts failed as above).

### Net state of item 3

- TS codegen leak: **FULLY FIXED** (s1 emits stage2.c at 9G, 0b9928b95) — primary compiler done.
- yo-self codegen leak: **56G→26G** (2e329eeee), safe; s2 still OOMs on 16GB → stage3.c/diff not yet
  produced. Fixpoint blocked only on the residual uninit-temp refinement above (or a ≥32GB box:
  26G fits comfortably in 32GB, so the fixpoint IS runnable there right now with the current commits).

## Residual CONCLUSIVELY needs the pre-init-drop guard, not recording-broadening (2026-07-13)

Third attempt: record at the temp's INITIALIZATION point (bare first-assignment `<temp> = val`,
name at line-start) in addition to init-decls — reasoning it marks the temp initialized (safer than
the uninit `<type> temp;` decl). Result: builds, **corpus PASS 118 / DIFF 0**, but s2 STILL CRASHES
at startup (same as the `;` case). So ANY recording beyond strict `<type> temp = …` init-decls
introduces a pre-initialization drop on some cross-branch path → `___drop(garbage)` → crash.

**Conclusion:** the 26G→9G residual is NOT closable by broadening the Emitter's decl detection
(3 variants tried: blind→clang errors; uninit-`;`→crash; init-assignment→crash). It requires
strengthening yo-self's pre-init-drop GUARD (`_variable_initialized_after_cleanup_point` /
`initialized_at_token`, return.yo:211) to TS parity — TS's `;`-branch recording is safe precisely
because its `initializedAtToken` position check independently suppresses pre-init drops, and
yo-self's equivalent is weaker. That is a control-flow-correctness fix in the drop emitters, a
separate focused effort (each iteration risks the s2 startup crash, so it needs the full
s1→s2→stage3 chain to validate, not just corpus).

**FINAL net state of item 3:**

- TS codegen leak: FULLY FIXED (0b9928b95) — s1 emits stage2.c at 9G; primary compiler done.
- yo-self codegen leak: 56G → 26G (2e329eeee), safe (builds, s2 runs, corpus green).
- Fixpoint (stage2.c ≡ stage3.c): NOT produced on this 16GB box (s2 OOMs at 26G). RUNNABLE NOW on
  a 32GB box with the current commits (26G < 32GB) — task #21's documented fallback. On 16GB it
  needs the pre-init-drop guard strengthening above to reach 9G.

## CORRECTION (2026-07-13, measured): s2 peak is ~55G, NOT 26G — my earlier claim was a plateau misread

Re-ran the committed-state (2e329eeee) s2 emitting stage3.c, CLEAN (84% mem free) and to OOM:
memory climbed 26G(t=24s) → 36G(t=60s) → **55G(t=108s), held to OOM** (swap grew to 10G). The "26G"
I reported earlier was an INTERMEDIATE PLATEAU sampled before the final climb — NOT the peak.

**Consequence — corrected diagnosis of the two leaks:**

- **s1's 56G→9G** (TS fix, 0b9928b95) is REAL and confirmed: the declaredCVarNames drop-skip GATE
  bug (skipping ~88K temp drops) was s1's leak; fixed; stage2.c now producible (was OOM before).
  This genuinely ADVANCED the fixpoint one stage (blocker moved from "s1 OOMs" to "s2 OOMs").
- **s2's ~55G is DOMINATED by the ORIGINAL M3 leak, NOT the temp-drop gate.** The yo-self
  declaredCVarNames Emitter port (2e329eeee) is a correct faithful fix (mirrors TS, corpus PASS 118
  / DIFF 0, fixes the same gate bug in yo-self codegen) but it BARELY moves s2 (~56G→55G): s2's
  binary is emitted by yo-self's codegen, whose `_schedule_scope_end_drops` `skip_block` SKIPS
  scope-end drops for every control-flow block → callee-env Variables never dropped (the handoff's
  "2.7M+ live new_variable" leak). That is the M3 milestone, still UNPORTED.
- TS codegen has M3 (begin.ts:2064-2140), which is why s1 (TS-emitted binary) does NOT have this
  leak and runs at 9G once the gate bug is fixed.

**So the fixpoint's remaining blocker is M3 (remove yo-self begin.yo `skip_block`), and M3 is blocked
by the never-pruned `expr_info_table` compile-time explosion** (removing skip_block builds a `___drop`
AST node per owning-RC local per control-flow block via generate_expr_from_code, each pinned with an
env snapshot in the never-pruned table → s1's RUNTIME emitting stage2.c re-explodes to ~56G). That is
the architectural table-affordability issue (node-attached ExprInfo — infeasible on yo-self's module
system due to the expr↔value import cycle, proven earlier). NET: the declaredCVarNames work fixed a
real, separate gate-bug leak (s1 unblocked, 9G) but the fixpoint's DOMINANT blocker (s2 M3 leak → the
table-affordability wall) is unchanged. The 32GB-box path also does NOT apply to s2 at 55G — that
needs 64GB+, same as before for s2.

## FIXPOINT VERIFICATION EXECUTED (2026-07-13, per-file — main.yo OOMs, but s2 handles smaller modules)

Since s2 OOMs on main.yo, ran the fixpoint check `stage2 ≡ stage3` PER-FILE on yo-self modules s2
compiles within memory: s1 = committed TS-built yo-self (yo-self-yf); s2 = committed self-built
yo-self (fp-s2, from stage2.c). Both run yo-self's codegen, so `s1-emit(F)` must equal `s2-emit(F)`.

Results (normalizing the global temp-counter `_temp_[0-9]+ → _temp_N`, a spurious per-run offset):

- **lexer.yo: FIXPOINT-OK** (251277 bytes, normalized stage2 ≡ stage3).
- **token.yo: FIXPOINT-OK** (134068 bytes).
- **expr.yo: 16-line real divergence** — ArrayList-growth alloc size emitted as `(24ULL) * cap`
  by s1 vs `(sizeof(__yo_t26)) * cap` by s2 (and `16ULL` vs `sizeof(__yo_t3)`). FUNCTIONALLY
  EQUIVALENT (both valid C, identical runtime size) — a comptime-`sizeof`-folding divergence: s1's
  yo-self folds `sizeof(T)` to the numeric constant, s2's emits it symbolically. Byte-different,
  behavior-identical. This is a determinism divergence in the sizeof-emission path, NOT a
  miscompile (s2 is a correct compiler — corpus PASS 118/DIFF 0).

**Meaning:** the self-hosting fixpoint HOLDS structurally on real yo-self modules (lexer/token
byte-identical modulo temp counters; expr differs only in equivalent sizeof-vs-constant form). The
FULL main.yo byte-exact fixpoint is blocked by three separable things, in priority order:

1. s2 memory (the M3 skip_block callee-env leak) — s2 OOMs at 55G on main.yo (16GB box). DOMINANT.
2. temp-counter offset — s1/s2 diverge by a small constant in `g_temp_counter` (needs deterministic
   counter seeding or normalization in the fixpoint check).
3. `sizeof`-fold determinism — make yo-self's alloc-size codegen emit the SAME form in s1 and s2.
   Items 2–3 are small/cosmetic (functionally-equivalent output); item 1 is the architectural blocker.
   So on a 64GB box, `diff <(norm stage2.c) <(norm stage3.c)` would be near-empty (only the sizeof-fold
   class), and the remaining work to a byte-exact main.yo fixpoint is items 2+3 plus the M3 memory fix.

## PIVOTAL (2026-07-13): M3 is AFFORDABLE now (9G, no explosion) — the "56GB architectural wall" was STALE

Empirically re-tested removing yo-self begin.yo `skip_block` (scheduling scope-end drops for
control-flow blocks = the M3 milestone), now that the declaredCVarNames Emitter fix is in place:

- s1 (TS-built, M3-enabled) **BUILDS clean** (no def-time explosion) and **emits stage2.c at 9.3G,
  COMPLETES** (31.6MB). The prior "M3 explodes s1 to 56GB" (task #21 / handoff BLOCKER) is STALE —
  it does NOT reproduce. M3 is affordable.
- corpus: **DIFF 0** (no double-free from the added drops) — but **SELF-FAIL 1**
  (dyn_error_throw_ioerror.yo) and the M3 stage2.c **fails to clang-compile** with undeclared-temp
  drops (e.g. `_file____User_temp_584456` at m3-stage2.c:147719) → s2 not buildable from it.

**So the fixpoint is NOT blocked by the architectural table/import-cycle wall.** M3 (which fixes s2's
dominant callee-env leak) is cheap. The REMAINING blocker is CORRECTNESS of the M3 scope-end drops:
a few reference temps not declared at the escape/early-return point (the declaredCVarNames gate +
Emitter capture catch MOST but not all — the same uninit/cross-branch-temp class). The faithful fix
is TS's early-return-only drop attachment (begin.ts:2064-2140: `attachEarlyReturnOnlyDropExpressionToReturns`)

- ensuring EVERY M3 drop path consults declaredCVarNames. This is BOUNDED codegen work, not an
  architectural refactor.

**Corrected completion path for item 3 (fixpoint):**

1. Port M3 faithfully (remove skip_block + attach early-return-only drops like begin.ts) so the
   scope-end drops emit WITHOUT undeclared-temp references. M3 emission is affordable (9G, proven).
2. Validate: corpus PASS 118/DIFF 0/SELF-FAIL 0; s1 emits stage2.c @9G; build s2; s2 emits
   stage3.c @9G (M3 drops fix the callee-env leak → no OOM); `diff` (normalize temp counters).
3. Address the residual sizeof-fold + temp-counter-offset for byte-exactness (cosmetic).
   This supersedes the "needs 64GB / node-attach architectural fix" conclusion — the leak fix is M3,
   and M3 is affordable; only the drop-emission correctness (undeclared-temp gating) remains.

## M3 port precisely scoped (2026-07-13) — the bounded remaining work for the fixpoint

M3 emission is affordable (9G, proven). The naive skip_block removal leaves undeclared-temp drops
because the flat `declared_c_var_names` set cannot model cross-branch C scope: a temp declared in
branch A is "in the set" for branch B's escape-cleanup drop, but is out of C scope there → undeclared
identifier. TS solves this NOT with the flat set but with per-return token-position attachment:

- **`attachEarlyReturnOnlyDropExpressionToReturns` (begin.ts:130-238):** recursively walks the block;
  for each `return`/`unwind` whose cleanup point satisfies `tokenIsAtOrBefore(initializedAtToken,
cleanupPoint) && tokenIsBefore(cleanupPoint, consumedAtToken)`, attaches the drop to that return's
  `earlyReturnOnlyDeferredDropExpressions`. Recurses through cond/match/macroExpansion.
- **`scheduleScopeEndDrops` (begin.ts:~2064-2140):** the driver that computes the scope-end drop set
  and calls the above for early-return-bearing blocks.
- **ExprInfo field `earlyReturnOnlyDeferredDropExpressions`** + its codegen emission at the return.

Porting these to yo-self (replacing the `skip_block` big-hammer in `_schedule_scope_end_drops`) is the
faithful M3 milestone. It is BOUNDED (clear 1:1 TS reference) but LARGE (recursive token-position
walker + new ExprInfo field + codegen), and must be validated with the full s1→s2→stage3 chain
(corpus PASS/DIFF/SELF-FAIL 0 + s2 emits stage3.c at ~9G + normalized `diff` = FIXPOINT-OK). It is the
same subtle uninit/cross-branch-temp class that crashed s2 in the flat-set shortcuts, so it needs the
token-position logic done faithfully, not a flat-set approximation.

**Item-3 completion checklist (all bounded, non-architectural):**

1. Port M3 (attachEarlyReturnOnly + earlyReturnOnlyDeferredDropExpressions + codegen) → yo-self.
2. Rebuild s1 (9G), corpus PASS 118/DIFF 0/SELF-FAIL 0, emit stage2.c @9G.
3. Build s2, emit stage3.c @9G (M3 drops fix the callee-env leak → no OOM).
4. `diff <(norm stage2.c) <(norm stage3.c)` = FIXPOINT-OK; then drive the temp-counter + sizeof-fold
   residuals to byte-exact.

## M3 PORT STARTED (2026-07-13): scaffolding committed green; walker/driver/helpers remain (all TS refs captured)

**Committed green (behaviorally no-op until the walker sets the field):**

- ExprInfo `early_return_only_deferred_drop_expressions` field (expr_info.yo) + init.
- Codegen `generate_early_return_only_deferred_drop_expressions` (return.yo) un-no-op'd to emit it.
- check ./yo-self 303/303.

**Remaining (turnkey — exact TS references read this session):**

1. Port 3 missing helpers into begin.yo (evaluator):
   - `is_function_boundary_for_early_drop` (begin.ts): `exprIsFunctionCallOf(->/=>)` &&
     (isAnonymousFunctionDefinition || isFunctionValue(value) || func is fn/ctl/unsafe_fn/Fn ||
     `!expr.$`).
   - `variable_can_need_drop_ignoring_consumed` (begin.ts): is_owning_the_rc_value &&
     type_contains_rc_type && !is_module_level && !(unresolved-SomeT-no-traits). (Same as the
     e1..e4 predicate already inline in `_schedule_scope_end_drops`.)
   - `variable_is_captured_by_current_function` (begin.ts): `ctx.captured_variables?.has(name)`
     (verify yo-self ctx has captured_variables).
2. Port `attach_early_return_only_drop_expression_to_returns` (begin.ts:130-238): recursive walker;
   at each return/unwind atom or call, if `tokenIsAtOrBefore(initializedAtToken, cleanupPoint) &&
tokenIsBefore(cleanupPoint, consumedAtToken)`, append dropExpr to the node's
   early_return_only_deferred_drop_expressions. Recurses through macroExpansion, cond/match (and
   `=>` branch parts), stops at function boundaries / TypeValue-fn callees.
3. Port the driver (begin.ts:2068-2122) into evaluate_begin: compute earlyReturnOnlyVariables from
   the current frame (has consumed+initialized tokens, block-token at-or-before init, not captured,
   not auto-generated, NOT already in the regular scope-end drop set, can-need-drop-ignoring-consumed);
   build a drop per var (consumed cleared) and attach to each return via the walker. REMOVE the
   `skip_block` big-hammer (control-flow blocks now schedule regular scope-end drops normally — M3
   emission proven affordable at 9G).
4. Validate: rebuild s1 (9G), corpus PASS 118/DIFF 0/SELF-FAIL 0, emit stage2.c @9G, build s2, emit
   stage3.c @9G (M3 early-return drops fix the callee-env leak → no OOM), `diff <(norm stage2.c)
<(norm stage3.c)` = FIXPOINT-OK. Iterate on any undeclared-temp/crash (the token-position logic
   is what makes cross-branch early-return drops scope-correct — do it faithfully).

## M3 ACTIVATION TESTED (2026-07-13): RC-correct (DIFF 0), 117/118 self-compile — 1 cross-branch edge case

Fully ported + activated M3 (walker + driver + skip_block removal + codegen emission with a
declared_c_var_names gate) and tested end-to-end:

- s1 builds clean at ~9G (NO undeclared-temp errors in stage2.c — the walker's per-return token
  gate scopes the consumed-var early drops correctly, unlike the naive skip_block removal).
- **corpus: PASS 117 / DIFF 0 / SELF-FAIL 1.** DIFF 0 = M3 is RC-CORRECT (no double-free). The lone
  SELF-FAIL is `dyn_error_throw_ioerror.yo`: its emitted C references an undeclared temp
  (`_file____User_temp_4682`) inside an inline enum `___drop` (`switch((temp).tag){ ... __yo_decr_rc((temp).data.Some.value) }`)
  at a return where the temp lives in a SIBLING match-arm's C block scope. A REGULAR scope-end drop
  (now scheduled because skip_block is gone) is emitted at that early-return via the pending-drop
  path; the flat `declared_c_var_names` set recorded the temp (declared in the sibling arm, emitted
  earlier) so the C-emission-order gate does not skip it, but in C-BLOCK scope it is out of scope
  there → undeclared identifier.

**This is the fundamental flat-set-vs-C-block-scope limitation** (the same class that has surfaced
all session). M3 itself is RC-correct and works for 117/118; the residual is that a per-function flat
`declared_c_var_names` cannot express C `{}`-block scope, so a sibling-arm temp appears "declared" at
an early-return in another arm. Per the non-negotiable no-regression gate (118→117 is a regression),
the activation was REVERTED; the M3 scaffolding + walker remain committed green (inactive).

**Remaining to finish the fixpoint (precisely pinned):** make the pending/scope-end drop emission at
an early-return respect C-BLOCK scope, not just per-function C-emission order — e.g. reset/snapshot
`declared_c_var_names` per emitted `{}` block (so a sibling arm's temps are not considered declared at
another arm's return), OR scope the pending-drop list to enclosing blocks only (exclude sibling-arm
scope-end drops). This is the one edge case between the RC-correct M3 activation (117/118, DIFF 0) and
the full fixpoint. Everything else (walker, driver, token gate, codegen) is ported and validated.

## Pinpointed the 1/118 M3 self-fail cause (2026-07-13): omitted TS driver/walker filters

The `dyn_error_throw_ioerror` cross-arm over-attach is NOT a C-block-scope limitation (TS uses a
flat, non-block-scoped declaredCVarNames and works). It is that my M3 port OMITTED two TS filters:

1. **Driver (begin.ts:2083):** `if (variable.token.modulePath.startsWith("auto-generated://")) continue;`
   — skip auto-generated temps as early-return candidates. (yo-self HAS the `auto-generated://`
   convention, parser.yo:1419; Variable.token.module_path is accessible.) [temp_4682 is `_file____User`,
   NOT auto-generated, so this alone won't fix it — but it's a required faithful filter.]
2. **Walker (begin.ts:218-233):** stop recursion when the callee is a TypeValue that is a function
   type / implements Fn:
   `if (exprIsFunctionCall(expr.func) && isTypeValue(expr.func.$.value) && isFunctionType(...)) return;`
   `if (... && typeImplementsFn(...)) return;`
   I OMITTED these ("rare edge case"), so the walker recurses PAST a function-type-callee boundary in
   the dyn/error construct and attaches temp_4682's drop to an unwind in a sibling scope → undeclared.
   These need is_type_value (value.yo), is_function_type (types/guards), type_implements_fn
   (trait_checking — verify no import cycle into begin.yo).

**Precise remaining step to finish item 3:** re-apply the M3 activation (driver + skip_block removal +
return.yo early-return gate — all authored+tested this session, RC-correct DIFF 0 at 117/118) WITH the
two omitted filters added (auto-generated skip in the driver; TypeValue-fn-callee boundary stops in the
walker). Then corpus must reach PASS 118/DIFF 0/SELF-FAIL 0, after which s1 emits stage2.c @9G → build
s2 → s2 emits stage3.c @9G (M3 fixes the callee-env leak) → `diff <(norm stage2.c) <(norm stage3.c)` =
FIXPOINT-OK. M3 is otherwise complete and RC-validated; this is the last faithful-filter gap.

## 1/118 cause REFINED (2026-07-13): M3 walker crosses an effect-handler function boundary

Added the two omitted filters (auto-generated skip + TypeValue-fn-callee is_function_type boundary)
and re-tested: still PASS 117 / DIFF 0 / SELF-FAIL 1 (dyn_error_throw_ioerror). Diagnosed the exact
mechanism: the undeclared `temp_4682` is emitted INSIDE a nested handler C function
(`fn_yo_id_5164(__yo_t5 err)` — the caught-error handler) in its early-return cleanup, but temp_4682
belongs to the ENCLOSING function. So the M3 walker (`_attach_early_return_only_drop_to_returns`)
recursed INTO the effect/error handler's body (a `=>` closure / `ctl` handler passed to the catching
construct) and attached the enclosing var's drop to a return there — crossing a C FUNCTION boundary.

`_is_function_boundary_for_early_drop` should stop the walker at that handler, but does NOT recognize
this handler form: the handler `=>`/closure's ExprInfo in yo-self evidently lacks the
`is_anonymous_function_definition` flag AND a `.FuncVal` value at walk time (they are set later, during
closure specialization), so the arrow-boundary check falls through and the walker recurses in.

**Precise fix for the last 1/118:** strengthen `_is_function_boundary_for_early_drop` to recognize the
effect/error-handler closure boundary even when its ExprInfo isn't yet a FuncVal — e.g. treat ANY `=>`
/`->` arrow node as a boundary (TS's `!expr.$` fallthrough already returns true for un-evaluated
arrows; yo-self should match: if the arrow node's ExprInfo lacks a resolved FuncVal/anon flag, still
treat it as a boundary), OR stop the walker at the specific catch/handler construct. This is the ONE
remaining gap; M3 is otherwise RC-correct (DIFF 0) and self-compiles 117/118. Activation reverted per
the no-regression gate; scaffolding + walker remain committed green (inactive).

## RESOLVED — M3 activated & committed green (2026-07-13, commit 7e7ebced1)

The last 1/118 (dyn_error_throw_ioerror) is FIXED and the full M3 subsystem is now ACTIVE and
committed. Three coordinated changes (all faithful-port-justified):

1. **begin.yo** — removed the `skip_block` big-hammer from `_schedule_scope_end_drops` (TS has no such
   hammer); re-added the M3 driver in `evaluate_begin_expression` (attaches early-return-only `___drop`s
   for CONSUMED locals to each return/unwind — port of begin.ts:2068-2122).
2. **begin.yo** — simplified `_is_function_boundary_for_early_drop` to treat ANY `->`/`=>` arrow as a
   boundary. Match-arm `=>` never reach this predicate (the walker recurses into cond/match branch
   PARTS, not arm nodes), so any arrow here is a closure/handler = a new C function scope. This stops
   the walker cross-attaching an enclosing var's drop to a return inside the nested handler function
   (the dyn_error_throw_ioerror SELF-FAIL). The prior is_anonymous/FuncVal check missed the handler
   because yo-self sets those markers only after closure specialization, later than this def-time walk.
3. **return.yo** — applied the `declared_c_var_names` C-emission-order guard on ALL paths in
   `_keep_pending_drop` (previously the escape path, `skip_env_check=true`, bypassed it). yo-self
   over-materializes intermediate temps that codegen folds inline (never declaring them in C) yet still
   schedules their scope-end drop; the guard skips their drop (no C variable exists → cannot leak).

Gates: corpus PASS 118 / DIFF 0 / SELF-FAIL 0; check ./std 153/153; check ./yo-self 303/303.

## Item-3 fixpoint STATUS + the REMAINING PERF divergence (2026-07-13)

Fixpoint chain executed:

- s1 (yo-self by TS, --release) emits stage2.c: **78s, 10.1 GB peak** (31.7 MB C).
- clang -O2 stage2.c → s2: **0 errors** (item 1 confirmed).
- s2 emits stage3.c: with GC on, s2 runs at **~26 GB stable / ~48 min** (still going at report time);
  with `YO_GC_THRESHOLD=0` it runs FAST (~226s) but **OOMs** (peak footprint 98 GB) — abnormal
  termination, no output.

**Root of the s2 slowness (the user's perf-parity concern):** `sample` shows **100% of leaf time in
`__yo_gc_collect`** — the Bacon-Rajan FULL collector (`__yo_gc_register` triggers it when tracked_count
crosses the adaptive 2x-live `__yo_gc_full_threshold`). s2's tracked-object graph is far larger than
s1's, so each O(tracked) full scan is enormous and they repeat as the graph grows.

Differential emit counts (yo-self stage2.c vs TS ts-main.c, SAME main.yo source):

- `// Drop local variables before early return` blocks: **2388 (yo-self) vs 15611 (TS)** — 6.5x fewer.
- (Raw `___drop` count 17 vs 240331 is NOT comparable — yo-self INLINES enum drops as
  `switch(tag){case SOME: __yo_decr_rc(payload)}` while TS calls typed `fn_..___drop()`.)

**The `YO_GC_THRESHOLD=0` OOM proves the extra memory is CYCLIC garbage** (GC-on bounds it at 26 GB by
reclaiming ~72 GB of cycles; a pure acyclic missing-drop leak keeps RC>0 forever and GC could NOT
reclaim it). So yo-self's emitted C leaves reference CYCLES as garbage that TS breaks promptly: TS emits
a scope-end/early-return drop that decrements a cycle member to RC 0 (freed immediately, cycle never
becomes GC garbage); yo-self MISSES that drop (6.5x fewer blocks), so the cycle survives to be reclaimed
by the expensive full collector. Missing-drops and cyclic-garbage are therefore the SAME root.

**Where the missing drops come from (two candidate causes, not yet split):**

- (a) `declared_c_var_names` guard suppression: the guard skips a drop whose temp the emitter never
  recorded. yo-self's `_emitter_record_declared_temp` (emitter.yo) matches only `<type> <name> = `
  (initialized) — it does NOT record `<type> <name>;` (uninitialized) declarations, unlike TS's
  `DECL_RE = /[\w>*\]]\s+([A-Za-z_]\w*)\s*(?:=(?!=)|;)/`. stage2.c has ~9k uninit temp decls. A `;`-decl
  temp later assigned & needing a scope-end drop is thus unrecorded → its drop is guard-filtered → the
  object (possibly a cycle member) leaks to the GC. NOTE: naively adding `;` recording previously
  CRASHED s2 — an uninit temp then passes the (declared-only) escape-path guard and gets dropped before
  assignment. A safe fix must ALSO gate the escape path on initialization (yo-self's escape path passes
  skip_env_check=true, matching TS, so the init check is bypassed there — but TS's pending list does not
  contain those uninit temps, so TS never hits it; yo-self's scheduling DOES include them).
- (b) scheduling gaps: the 6.5x block deficit may also reflect fewer scope-end/early-return drops
  SCHEDULED by the evaluator (getVariablesNeedingDrop-equivalent + M3 driver coverage), independent of
  the emitter guard.

**Next step for perf parity (tasks #34/#65 territory):** split (a) vs (b) by counting guard-suppressed
drops vs scheduled drops on a small self-compiled input; then either (a) make the emitter record `;`
decls AND add an initialization gate to the escape path so uninit temps are never dropped, or (b) close
the scheduling deficit. Validate each change against the full corpus (PASS 118 / DIFF 0 / SELF-FAIL 0)
and REVERT on any regression. Target: s2 tracked graph ≈ s1's 10 GB so the full GC stays cheap and s2
matches s1's ~78s.

## DEFINITIVE (2026-07-13, end of session): GC tuning is futile — s2 OOMs on main.yo, #65 leak fix REQUIRED

Exhaustively confirmed that item 3's full-main.yo diff cannot be produced without fixing the leak:

- **Default GC:** s2's memory footprint climbs unbounded on main.yo (measured 26G → 36G → 56G over ~100s
  via `top -stats mem,cmprs`) → jetsam (abnormal exit, empty log). It does NOT reliably complete. (One
  earlier run showed a constant "1058M" reading that was a `top` artifact — every other run climbs.)
- **`YO_GC_THRESHOLD=0`** (disable incremental): fast (~226s) but OOMs at 98GB peak.
- **`YO_GC_FULL_PCT=1000`** (raise full-collector threshold): 32G in 45s → OOM at 90s.
- **`YO_GC_FULL_PCT=130`** (lower it): bounded but even slower (>58min, no completion).

So the full collector at the DEFAULT 2x-live threshold is the ONLY setting that bounds memory, and it
does so by running O(all-tracked) constantly (`sample` = 100% `__yo_gc_collect`), which is why the emit
either OOMs (when garbage outpaces it) or takes >80min (when it keeps up). There is NO GC-tuning or
patience path. **The garbage MUST be reduced at the source** — the #65 drop-scheduling gap (yo-self
emits ~7x fewer owned-local drops than TS; `callee_env` captured into CallResult structs `__yo_t401`/
`__yo_t413` shows 9 incr : 2 decr → net +7 leaked refs/call, accumulating as reference cycles the full
collector must repeatedly reclaim).

**Bottom line for item 3 / item 4:** blocked on the #65 leak fix (reduce cyclic garbage so s2's tracked
set ≈ s1's, then the emit completes in ~78s and the byte-exact diff runs) — and, for the emitter half of
that fix, blocked-first on the #30 type-identity collision (issues/yo-self-gc-traverse-value-struct-field.md).
The fixpoint PROPERTY is proven (mini-fixpoint byte-identical on real files); only the full-main.yo SCALE
is blocked. This is genuine multi-session work on tasks #65 + #30.

## Ruled out (2026-07-13): trial-clone ExprInfo eviction is NOT the leak fix

Implemented + tested a targeted fix: `expr_info_table_remove_subtree` evicting the fresh-id clone's
ExprInfo after the discarded overload trial (`_trial_call_overload_candidate`), the faithful analog of
TS freeing a cloned expr's `$` via GC. Result: **corpus 118/0/0 (correctness-safe) but s2 memory still
climbs 26→36→40G→OOM** — no material reduction. Reverted (adds hot-path cost for no benefit).

Why it doesn't help: two structural limits + wrong target.

1. An `Exception.throw` handler is a `->` function that CANNOT capture outer variables (`ctx`, the
   clones), so eviction can only run on the trial's SUCCESS path — but the leak is on the THROW paths.
2. The dominant leak is NOT trial-clone ExprInfo. Per the allocator evidence (`new_variable` 2.7M live)
   it is the per-call `callee_env` Variables not dropped on the `__yo_effect_escaped` throw-propagation
   paths inside the COMPILED `try_to_call_function_with_arguments` (`callee_env` shows 9 incr : 2 decr in
   stage-2.c). That is a codegen RC-balance / drop-scheduling gap (#65), not a side-table eviction issue
   — fixing it means emitting the missing `callee_env` decr on the `if(__yo_effect_escaped){…}` return
   paths (and/or dropping the returned CallResult struct `__yo_t401`/`__yo_t413` that captures it).

So item 3 is blocked squarely on #65 codegen drop-scheduling for `callee_env` on throw paths. The whole
solution space explored this session (GC tuning, waiting, emitter DECL_RE parity, GC-traverse guard,
ExprInfo eviction) is exhausted and documented; none is the fix.

## Trace narrowed to the exact fix site (2026-07-13, end of session)

Followed the leak from symptom to source:

- OOM → `sample` 100% `__yo_gc_collect` → cyclic garbage (THRESHOLD=0 OOMs at 98G) →
- `callee_env` 9 incr : 2 decr → `callee_env` is captured into per-parameter `CheckParamResult` ref
  structs (helper.yo:409 `CheckParamResult :: ref(struct(callee_env, caller_env, arg_value, ...))`,
  built once per param by `check_if_function_parameter_matches_argument`, helper.yo:425) inside the
  arg-matching WHILE loop of `try_to_call_function_with_arguments`.
- yo-self's loop codegen `generate_loop_body` (codegen/exprs/while_loop.yo:153-195) DOES emit
  per-iteration scope-end drops from the body begin block's `deferred_drop_expressions`. So the drop
  MECHANISM is present and correct.
- Therefore the gap is upstream, in the EVALUATOR: `_schedule_scope_end_drops`
  (evaluator/exprs/begin.yo:439) does not SCHEDULE a drop for the `CheckParamResult` (and the
  callee_env-carrying locals) in that loop body — so `deferred_drop_expressions` omits them and each
  iteration leaks one `CheckParamResult` (→ callee_env → parameter Variables). Over millions of
  def-time arg-matching iterations this is the dominant leak.

**Exact next step:** determine why `_schedule_scope_end_drops`'s filter (begin.yo:486-500, the e1–e7
chain mirroring TS `getVariablesNeedingDrop`) rejects the `CheckParamResult` local — check its
`is_owning_the_rc_value` / `type_contains_rc_type` / `consumed_at_token` on the loop-body frame at
scope-end, compared against what TS schedules for the same variable. Fix the filter divergence so the
loop body schedules the drop. Validate with the s2 memory-trajectory signal (climbs → bounded) since
full main.yo completion is the very thing being fixed. This is the concrete #65 entry point.

## BREAKTHROUGH (2026-07-13): leak REPRODUCED in a small no-OOM file + exact fix + why shortcuts fail

Reproduced the eval-phase leak in a standalone repro (no OOM, ~instant emit) — the fast iteration
loop this whole investigation lacked:

```rust
Env2 :: ref(struct(x : i32));
maybe_throw :: (fn(v : i32, exn : Exception) -> i32)({ if(v > 3, { exn.throw(dyn(String.from("boom"))); }); v });
run :: (fn(n : i32, exn : Exception) -> i32)({
  (sum : i32) = 0; (i : i32) = 0;
  while(i < n, {
    h := Env2(x : i);              // ref local, live across the call below
    r := maybe_throw(i, exn);      // may set __yo_effect_escaped
    sum = ((sum + h.x) + r); i = (i + 1);
  });
  sum
});
```

yo-self emits (LEAK): `if (__yo_effect_escaped) { return (int32_t){0}; }` — `h` NOT dropped.
TS emits (CORRECT): `if (__yo_effect_escaped) { // Drop local variables before early return\n
fn_..._id_21___drop(h); return (int32_t){0}; }` — `h` IS dropped.

So the mid-body effect-unwind check (`emit_effect_unwind_check` → `generate_pending_deferred_drops`,
return.yo) fails to drop still-live locals on the escape path. In the real evaluator this is exactly the
per-call `callee_env` (and its parameter Variables) leaking on the millions of def-time trial-eval throw
paths → the 26→56G OOM.

**Why it leaks in yo-self but not TS:** `emit_effect_unwind_check` calls
`generate_pending_deferred_drops(..., skip_env_check=false)`. With use_env=true, `_keep_pending_drop`
resolves each pending drop against the CALL expr's recorded env. TS's env is POINT-IN-TIME (has `h`,
lacks not-yet-bound locals). yo-self records the END-of-scope env, and its resolution returns empty for
`h` → `h` filtered → leaked.

**Fixes tried this session (all reverted; each teaches the constraint):**

- `skip_env_check=true` in emit_effect_unwind_check + `_keep_pending_drop`'s !use_env branch resolving
  via the drop's OWN atom env + init-token/consumed checks → DROPS `h` correctly (verified) BUT
  regressed `effect_handler_struct_result`: it also drops `p := if(… raise() …)` whose C decl is emitted
  AFTER the escape (inside its own initializer) — source-token order ≠ C-emission order, so the
  init-token check wrongly keeps `p` → `use of undeclared identifier 'p'`.
- Gate the escape drop on `declared_c_var_names.contains` (C-emission-order truth): corpus 118/0/0 but
  only +14 drops on main.yo — because it records ONLY minted temps, so it SKIPS the leaking NAMED
  locals (callee_env_m et al.). Marginal, no OOM relief.
- Record NAMED locals in declared_c_var_names too (flat set): **block-scope-UNSOUND** — a name declared
  in one match arm (`field_labels`) appears "declared" at an escape in a sibling arm where it's out of C
  scope → 20 clang errors (`use of undeclared identifier 'field_labels'/'svn'/…`). Flat set cannot model
  C block scoping; only uniquely-numbered temps are safe in it.

**THE fix (next session, now precisely scoped):** make yo-self resolve the escape-path pending drops
against a POINT-IN-TIME env like TS (so `h` is present, `p`/sibling-arm bindings are absent), rather
than the end-of-scope env + flat declared set. Either (a) record per-expr point-in-time env snapshots
for call/escape exprs (the faithful TS model), or (b) make the drop-scheduler attach the escape drop
only to escapes that are LEXICALLY AFTER the local's full binding statement AND within the same C block
scope (scope-aware, not flat). Validate on the repro above (h dropped, no undeclared p) + corpus 118 +
the s2 memory trajectory (bounded, not 26→56G). This is the concrete entry point for #65.

## PROBE-CONFIRMED root + correct fix design (2026-07-13)

Instrumented `_keep_pending_drop` (eprintln, reverted) on the small repro and on the one file the naive
fix regressed (`effect_handler_struct_result.yo`, local `p := if(… raise() …)`):

[PROBE keep h] use_env=true has_ei=true env_vars=1 in_declared=false (run() loop-body local; SHOULD drop)
[PROBE keep p] use_env=true has_ei=true env_vars=1 in_declared=false (binding contains the escape; must NOT drop)

Both named locals are PRESENT in the escape expr's recorded env (env_vars=1) and ABSENT from
declared_c_var_names (in_declared=false, which records only minted temps + params). So:

- The env-branch `declared_c_var_names` guard (return.yo ~228) requires EVERY drop target to be in the
  set, so it filters BOTH `h` (→ leak) and `p` (→ correctly avoids the undeclared crash). It's a blunt
  gate that suppresses the leak fix as a side effect of preventing the crash.
- yo-self's recorded env is END-OF-SCOPE (confirmed: `p` is in the raise-call's env even though the
  escape is inside `p`'s own initializer). So it CANNOT be used as a point-in-time liveness signal, and
  restricting the guard to temps (TS's isCodegenTempName gate) regresses `p` (env still has it; its
  init-token is the LHS, before the escape → init-check keeps it → `use of undeclared identifier 'p'`).
- Recording named locals in the flat set is block-scope-UNSOUND (sibling match-arm bindings).

**Correct fix (scope-aware, point-in-time, repro-validatable): M3-driver-extended-to-calls.** At EVAL
time in `evaluate_begin_expression`, for each statement that is / contains a may-unwind call, attach
`___drop(local)` escape-drops for the owning-RC locals bound by PRECEDING statements of the same begin
block (a new ExprInfo field, e.g. `escape_deferred_drop_expressions`, mirroring the M3
`early_return_only_deferred_drop_expressions` machinery already ported). Codegen's
`emit_effect_unwind_check` then emits THAT list on the `if(__yo_effect_escaped)` path instead of
filtering the whole end-of-scope pending list. This is correct for all three cases WITHOUT env/declared
heuristics:

- `h` (bound by a preceding statement) → attached → dropped ✓
- `p` (bound BY the statement that contains the escape, not a preceding one) → not attached → skipped ✓
- sibling match-arm bindings (not top-level begin statements) → not attached → skipped ✓
  Validate on the repro in the section above (h dropped, no undeclared p) + corpus 118 + s2 memory
  trajectory (bounded, not 26→56G). This is the concrete, correct #65 implementation task; it reuses the
  existing M3 attach/walk helpers and is validatable on the small repro (no OOM).
