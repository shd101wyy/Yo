# yo-self RC-emission layer: faithful dup + drop port

**Status:** Phase A (dup-on-store) + Phase B (scope-end drops + return-materialization +
store-dup) DONE + COMMITTED — **corpus 86/86 DIFF 0 SELF-FAIL 0, TS-ASan clean**, named
locals now drop (Probe A p1/p2/p3 0→0). ONE residual: Probe A **p4 leaks 0→1** (vs TS 0→0)
— needs the faithful **`___dispose` synthesis** (§9 below), the deferred RC-function
synthesis. Supersedes `plans/YO_SELF_NAMED_LOCAL_DROPS.md`. Original decisive finding: the
eval-side `set_expr_as_needs_to_call_dup` was a **no-op stub** — the true root of why scope
drops couldn't land alone.

Phase commits: A1 `4eccdb5dd`, A2 `b61f2252c`/`cd113b73d`/`5778bb093`, Phase B `f2de4f781`.

**One-line:** Port yo-self's entire reference-counting emission layer to match TS 1-to-1:
(A) dup-on-store (the stub + ~9 codegen emission sites), then (B) scope-end drops +
return-value materialization + early-return filtering. (A) is safe to land alone (more
leaks, no crash); (B) rebalances. ⚠️ Memory-corruption risk — validate every build with the
corpus differential + TS-ASan.

---

## 0. Why this is one coupled port (not incremental M1/M2/M3)

Proven empirically (NAMED_LOCAL_DROPS §11): yo-self omits **both** dup-on-store and
scope-end drops. They currently **cancel** (every owning value leaks, but nothing crashes).

- **drops without dups → UAF**: `a` shared into `b` without dup (rc stays 1); dropping `a`
  at scope end frees it while `b` still points to it.
- **dups without drops → bigger leak, no crash** (rc only goes up).

So the **safe landing order** is: **dup-on-store FIRST** (Phase A — leaks more, behavior
unchanged, corpus stays green), **then drops + materialization + early-return filter**
(Phase B — rebalances to TS parity). Never land drops before dups.

## 1. The RC model (how TS does it — the target)

dup/drop is **evaluator-driven**, not a codegen flag:

- **`setExprAsNeedsToCallDup(expr, ctx)`** (`src/expr.ts:2446-2584`): when an owning RC
  value is _shared_ (stored into a binding/field, passed to an owned param), it either
  - marks the source **consumed** and emits **no dup** (when the source is a _temp_ that
    already owns the value — ownership simply transfers), OR
  - builds `___dup(variableName)`, evaluates it, stores it in
    `expr.$.deferredDupExpressions = [dupCall]`, and consumes the **dup-result temp** (NOT
    the original — the original is still dropped at scope end). This is the
    named-local / atom-mismatch / non-owning-temp case.
- **Codegen** at each emit site checks `expr.$.deferredDupExpressions`; if present, emits the
  dup statement (`generateDeferredDupExpressions`) and rewrites the emitted code to the dup
  **result temp's** variable name (so the dup'd copy is what gets stored/passed).
- **`begin.ts` scope-exit** schedules `___drop(name)` for every owning, non-consumed,
  non-borrowed, non-module-level RC local, stored in `expr.$.deferredDropExpressions`;
  codegen emits these at block end (and concatenates onto the enclosing pending set for
  early returns). The block's **result/returned** var is marked consumed → not dropped.

Balance for `a := N(4); b := N(5, Some(a)); ()`:
`a` rc=1 → `___dup(a)` into `b` (rc=2), `a` NOT consumed → at scope end drop `b`
(frees b → drops its dup'd `a`: rc 2→1) **and** drop `a` (rc 1→0). Net zero. ✓
(If we'd skipped the dup, dropping both `a` and `b`-via-transitive would double-free.)

## 2. Current yo-self gaps (measured)

### A. Eval: `set_expr_as_needs_to_call_dup` is a STUB

`yo-self/evaluator/utils.yo:562` → `-> unit)(());`. Callers already exist and fire
(`assignment.yo:388`, `init_assignment`, `type.yo:263`, `array_type.yo:124`,
`comptime_list_type.yo:82`, `anonymous_struct`, `tuple`, `dyn`, `helper.yo`), but the stub
does nothing → `deferred_dup_expressions` is never populated → **no dups anywhere**.

### B. Codegen: ~9 emit sites missing vs TS (18 vs 9)

TS emits `deferredDupExpressions` from 18 files; yo-self from 9. **Missing in yo-self**
(map TS→yo-self filename):

| TS site                        | yo-self file                       | criticality                   |
| ------------------------------ | ---------------------------------- | ----------------------------- |
| `initialization-assignment.ts` | `codegen/exprs/init_assignment.yo` | **HIGH** (`x := New(...)`)    |
| `other-fn-call.ts`             | `codegen/exprs/other_fn_call.yo`   | **HIGH** (`sink(x)`, args)    |
| `assignment.ts`                | `codegen/exprs/assignment.yo`      | **HIGH** (`a.f = b` reassign) |
| `functions/generation.ts`      | `codegen/functions/generation.yo`  | med (param/body dup)          |
| `cond.ts`                      | `codegen/exprs/cond.yo`            | med                           |
| `array-fns.ts`                 | `codegen/exprs/array_fns.yo`       | med                           |
| `closures.ts`                  | `codegen/exprs/closures.yo`        | med (capture dup)             |
| `recur.ts`                     | `codegen/exprs/recur.yo`           | low                           |
| `tuple-fn.ts`                  | `codegen/exprs/tuple_fn.yo`        | low                           |

Already present (verify they match TS): `async/state_machine.yo`, `dyn.yo`, `match.yo`,
`return.yo`, `drop_dup.yo` (the shared emitter `generate_deferred_dup_expressions`),
`async.yo`, `functions/collection.yo`, `codegen/exprs/generation.yo`, `begin.yo` (drops
only — its header documents the deferred-dup of the return value as NOT done).

### C. Codegen: begin-block return-value NOT materialized before drops

`codegen/functions/generation.yo` emits scope-end drops then `return <expr>`; if `<expr>`
uses a just-dropped local → UAF (proven: `rc_early_return_drop` printed 0 vs TS 2). TS
materializes the return value into a temp first.

### D. Eval: no early-return init-position-filtered drops

TS `begin.ts:2068-2122` drops only locals **already initialized** at an early `return`.
yo-self has none → feeding scope drops into the early-return path drops not-yet-live
locals → crash (NAMED_LOCAL_DROPS §11 fix #2 worked around this by skipping such blocks).

## 3. The uniform codegen emit pattern (port mechanically)

Every TS dup-emit site is the same shape (from `initialization-assignment.ts:324`):

```ts
if (rhs.$?.deferredDupExpressions && rhs.$.deferredDupExpressions.length > 0) {
  generateDeferredDupExpressions(rhs, indent, functionContext); // emits "T tmp = ___dup(x);"
  const dupExpr = rhs.$.deferredDupExpressions[0]!;
  if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
    rhsCode = getVariableNameForCodegen(dupExpr.$.variableName, dupExpr.$.env); // use tmp
  }
}
```

yo-self equivalents already exist: `generate_deferred_dup_expressions` (`drop_dup.yo:434`),
`get_variable_name_for_codegen`, `expr_is_function_call`. So each site is a ~6-line
mechanical insert right before the place that currently uses the raw `rhs`/`arg` code.

## 4. Plan of record (phased, each phase corpus-green before the next)

### Phase A — dup-on-store (safe: leaks more, no crash)

1. **A1. Port `set_expr_as_needs_to_call_dup` fully** (`utils.yo:562`) from `src/expr.ts:2446-2584`:
   no-variableName / comptime-value-with-non-owning-temp guards; temp-owning → consume+return;
   else build `___dup(name)` via `generate_expr_from_code`, evaluate, consume dup-result temp,
   set `deferred_dup_expressions`, thread env. Reuse yo-self `update_existing_variable`,
   `get_variables_from_env`, `is_temp_variable_name`, `expr_is_atom`, `type_contains_rc_type`
   (`types/utils.yo:412`).
   - **Validate**: corpus 0-DIFF, SELF-FAIL 0 (dups now set + emitted at the 9 _existing_
     sites; everything still leaks → behavior identical). `check ./std` 152.
2. **A2. Add the 9 missing codegen emit sites** (table §2B), HIGH first
   (`init_assignment`, `other_fn_call`, `assignment`), building + corpus-validating after
   each. Pattern §3. After each: corpus 0-DIFF, SELF-FAIL 0.

### Phase B — drops + materialization + early-return filter (rebalances)

3. **B1. Return-value materialization** (`codegen/functions/generation.yo`, gap §2C): emit the
   block result into a temp _before_ the scope-end drops, then `return <temp>`. Mirror TS
   `functions/generation.ts` (~line 1515 region; this is where `_copy_expr_list` from the
   saved `m1_full_attempt.patch` also belongs — TS COPIES the drop list, yo-self aliased).
4. **B2. Early-return init-filtered drops** (eval, gap §2D): port TS `begin.ts:2068-2122`
   (`attachEarlyReturnOnlyDropExpressionToReturns`) — only drop locals initialized at the
   return point.
5. **B3. Scope-end drops for owning named locals** (eval `begin.yo`): the
   NAMED_LOCAL_DROPS §2-§4 work (predicate + collection + consume/result exclusion). Now
   SAFE because dups (Phase A) balance them.
   - **Validate**: NAMED_LOCAL_DROPS §6 gates — Probe A all `→` equal, Probe B `disposed 7`,
     **TS-ASan no leak/no-UAF**, corpus 0-DIFF + SELF-FAIL 0, `check ./std` 152, cycle tests
     return to baseline (flip `after < mid` → `after == before`).

### Phase C — finish

6. **C1. Reassignment dup+drop-old** (`assignment.yo`, NAMED_LOCAL_DROPS §5): `a.f = dup(b)`
   - drop old `a.f`. Closes `CYCLE_GC_TRACE_HOOKS.md §4`. ASan on `form_cycle`/`ref_enum_cycle`.
7. **C2. Regression tests**: Probe A + Probe B as `tests/codegen-bootstrap/` differentials;
   cycle survivors-return-to-baseline assertion.

## 5. Validation harness & build loop

See `plans/YO_SELF_NAMED_LOCAL_DROPS.md §6` (Probe A/B source, the 6 gates). Summary:

- Build: `./yo-cli compile yo-self/main.yo -o /tmp/yo-self-bin` (~6 min, NO `--release`).
  ENV: `export BUN=/nix/store/*-bun-1.3.*/bin/bun`; run binary with `YO_MAIN_STACK_MB=4096`.
- Corpus: `YO_SELF_BIN=/tmp/yo-self-bin scripts/diff-test.sh tests/codegen-bootstrap/ --parallel 4`
  → **DIFF 0, SELF-FAIL 0** is the primary safety net (a double-free shows as SELF-FAIL).
- TS-ASan: `./yo-cli compile <probe>.yo --release --sanitize address --allocator libc -o t && ./t`
  (yo-self's own ASan binary hangs; TS-ASan on the same source is representative since the
  emitted runtime is a verbatim port — but ALSO run the yo-self-compiled binary normally).
- `tracked_count` probes (Probe A) catch leaks the behavior corpus can't see.

## 6. Risks / invariants

- **Failure mode is corruption, not leaks.** When unsure if a var is consumed/borrowed/moved,
  DON'T drop it (leak > UAF). Phase A first guarantees no crash while we build confidence.
- **Closure captures** are dup'd into the capture struct; codegen already skips
  closure-capture drops (`is_deferred_drop_for_closure_capture`) — don't double-schedule.
- **`ref`/`inout` params + borrows**: never dup/drop a borrowed binding (it doesn't own).
- **Def-time body eval** (the def-eval wall): `set_expr_as_needs_to_call_dup` runs at
  def-time; the dup eval uses `evaluate_expression_raw`. Watch interaction with the
  trial-eval/swallow machinery and `is_evaluating_function_body_or_async_block`.
- **1-to-1 faithfulness** is the directive: mirror `src/expr.ts` + `src/codegen/exprs/*`
  exactly; validate via corpus 0-diff (behavior) + ASan (memory). No yo-self-only mechanisms.

## 7. Docs/records to update when done

- `plans/CYCLE_GC_TRACE_HOOKS.md §4` → resolved (Phase C1).
- `plans/YO_SELF_NAMED_LOCAL_DROPS.md` → mark folded into Phase B3.
- `issues/yo-self-cycle-gc-runtime-port.md` → `issues/fixed/` if fully closed.
- `plans/BOOTSTRAPPING_CODEGEN.md` phase 4 → consume-tracking/RC + self-compile-memory (P2 #21).
- `cycle-gc-trace-hooks-progress` memory + task #38.

## 8. Progress + PRECISE two-sided gap inventory (2026-06-28)

The dup-on-store gap is **two-sided** — the eval side must CALL
`set_expr_as_needs_to_call_dup` (mark) AND codegen must EMIT the resulting
`deferred_dup_expressions` (rewrite to the dup temp). yo-self is missing calls
on BOTH sides. Verified by diffing `setExprAsNeedsToCallDup` call sites
(`src/evaluator/` 12 files) and `deferredDupExpressions` emit sites
(`src/codegen/` 18 files) against yo-self.

### DONE this session

- **A1 — eval-side `set_expr_as_needs_to_call_dup` ported** (was a no-op stub;
  THE root cause). Commit `4eccdb5dd`. All existing callers thread `exn`.
- **A2 (1/N) — codegen dup emission in `init_assignment.yo`**. Commit `b61f2252c`.
- **A2 (2/N) — shared `emit_deferred_dup_or_code` helper (drop_dup.yo) + ref-struct
  ctor-arg dup** (other*fn_call.yo `\_\_yo_new*<cName>(args)`loop). Commit`cd113b73d`.
- **A2 (3/N) — fn-call-arg move-ownership pair**: eval owned-param arg branch in
  `helper.yo` (`check_if_function_parameter_matches_argument`, threading new
  `param_is_owning` from `__fm8.param_is_owning`) = owning arg → `set_expr_as_consumed`
  (move), borrowed → `set_expr_as_needs_to_call_dup` + consume; codegen half = the
  `_materialize_arg` value-pass return routes through `emit_deferred_dup_or_code`.
  Commit `5778bb093`. Matches TS exactly (inout-deref arg → set_expr early-returns,
  0 dups in BOTH). The owning→consume effect is marking-only, dormant until Phase B.
  Deferred sub-parts: `ctx.own_consumed_captures` tracking (helper.ts:419-428) +
  `require_expr_not_consumed` enforcement.
- All validated: compile OK (~77s), corpus **86/86 PASS DIFF 0 SELF-FAIL 0**,
  `check ./yo-self` 0 regressions, `check ./std` 152/152.

### ✅ Dup machinery PROVEN firing (the key de-risk this session)

Verified end-to-end with `Pair(y, y)` (y kept) vs TS: eval builds 2 dups; codegen
emits 2 inline `__yo_incr_rc(y)` before the ctor; program runs correctly; matches
TS's 2 `___dup` calls. **DIAGNOSTIC LESSON: a ref-struct/ref-enum `___dup` lowers to
`__yo_incr_rc((void*)x)`, NOT a `_dup(`-named call — grep `__yo_incr_rc` (not `_dup`)
when checking whether a dup fired.** `incr_rc` returns the same pointer, so yo-self's
`incr_rc(x); Ctor(x,x)` (emit-then-use-raw) is equivalent to TS's `t=dup(x); Ctor(t,t)`
for rc-types (the dup-result-temp rewrite returns the raw fallback because a ref dup
has no result temp — correct).

### ⚠️ COUPLING boundary discovered: which dup sites are SAFE-alone vs cycle-COUPLED

Adding a dup is crash-safe (refcount++), but a dup on a **cycle-formation path** changes
the refcounts a cycle test observes (`tracked_count`) → corpus DIFF (no crash) until the
paired Phase-B drops land. Measured:

- **SAFE alone (0-diff, landed):** init-assignment RHS, **ref-struct ctor args**
  (`Pair(y,y)`) — the corpus struct cycle forms via ArrayList push/reassign, not ctor args.
- **CYCLE-COUPLED (DIFF without drops — must co-land with Phase B/C):**
  **enum-construction args** (`Some(y)`/`Cons(..)` — `ref_enum_option_cycle` DIFFs:
  enum ctors ARE the cycle nodes) and **assignment reassignment** (`a.next=b`). ATTEMPTED
  the enum-ctor dup (other_fn_call `_emit_enum_construction`, both the nullable-ptr
  single-arg + multi-field loop) → `ref_enum_option_cycle` DIFF 1, reverted. Re-apply it
  together with the enum-cycle drops in Phase B/C.
  So the refined order: SAFE dup sites land in Phase A; the two cycle-coupled dup sites move
  to the coupled Phase-B/C landing (with their drops).

### Phase-B re-attempt on the dup groundwork (2026-06-28) — de-risked, NOT yet 0-diff

Re-applied the saved M1 scope-drop patch (`scratchpad/m1_full_attempt.patch`:
begin.yo `_schedule_scope_end_drops` + the conservative skip + generation.yo
`_copy_expr_list` + empty early-return pending) ON TOP of the landed Phase-A dups,
then reverted. Result: **PASS 80, DIFF 6, SELF-FAIL 0**. The big news: **the dups
eliminated the §11 UAF-CRASHES** — zero SELF-FAIL now (was crashing pre-dup). The
fn-call consume (5778bb093) correctly excludes moved-into-owned-param args from the
scope drop, so the pass-to-function case balances. The 6 remaining DIFFs (no crashes,
all `ts_rc=0 self_rc=0` behavioral) split into TWO root causes:

1. **Return-value NOT materialized before scope-end drops (5 diffs):** the block's
   result expr reads a local that the scope-end drop already freed → reads garbage/0.
   `rc_early_return_drop` prints `0` not `2` (`i32(xs.len())` after `xs` freed);
   `fn_pointer_struct_result` `0` not `42`; also `effect_handler_struct_result`,
   `io_async_struct_field`, `io_async_two_await_struct` (struct/async results). The M1
   conservative skip only catches a DIRECT `return` statement, not a result expr that
   uses a to-be-dropped local, nor a `return` nested in an `if`. **FIX = port the
   normal-exit return-value materialization (TS generation.ts ~1515 region): emit the
   block result into a temp BEFORE the scope-end drops, then return the temp.**
2. **Cycle/reassignment-dup coupling (1 diff):** `arraylist_self_cycle` "leaked" not
   "collected" — dropping the list nodes without the dup-on-reassign unbalances the
   cycle. **FIX = land the reassignment/method-call-arg dup-or-consume WITH these drops.**

### ✅ B1 IMPLEMENTED + CONFIRMED (2026-06-28) — M1+B1 = 85/86, last diff pinpointed

Implemented B1 (return-value materialization) in `generation.yo` `generate_function_body`'s
no-early-return last-expr path: when the body has scope-end drops + a non-unit return, emit
`<ret_type> __yo_scope_ret = <expr_code>;` BEFORE `generate_deferred_drop_expressions`, then
`return __yo_scope_ret;` (mirrors generation.ts:1587-1611, return type from the `Func` result).
With M1 scope-drops + B1 applied (on the Phase-A dup groundwork): **PASS 85, DIFF 1,
SELF-FAIL 0** — **all 5 return-UAF diffs CLEARED** (rc_early_return_drop, fn_pointer_struct_result,
effect_handler_struct_result, io_async_struct_field, io_async_two_await_struct). The full
M1+B1 work is saved at `scratchpad/phaseB_m1_b1.patch` (begin.yo + generation.yo). Reverted to
clean Phase A (can't commit a 1-diff state).

**The ONE remaining diff — `arraylist_self_cycle` — root-caused precisely (NOT a consume
issue):** BOTH compilers drop `a`/`b` at `form_cycle` scope end — TS emits
`fn_..._id_21___drop(b); ___drop(a)`, yo-self emits `__yo_decr_rc((void*)(a/b))`. The
difference is the **dup-on-store INSIDE `push`**: TS's `a.children.push(b)` stores a **dup'd**
`b` into the buffer (b rc 1→2), so the scope-end `___drop(b)` leaves rc=1 (b survives, held by
the buffer = the cycle edge) → `Gc.collect` reclaims the unreachable cycle (`collected`).
yo-self's `push` stores `b` into the buffer **without duping** (rc stays 1), so the scope-end
drop frees `b` immediately (rc→0) → the cycle never forms → `leaked`. The call site passes `b`
RAW in both (no caller-side dup; verified in the emitted C). **So the fix is the store-dup
inside `push`'s body — the §C assignment / index-store dup-on-store (`a.f = dup(v)` /
`buf(i) = dup(v)`), which yo-self has not ported.** This is exactly the "cycle-COUPLED"
reassignment/store-dup flagged above — it MUST co-land with the M1+B1 drops.
**NEXT (B3): port the assignment/index-store dup (TS `assignment.ts`; yo-self `assignment.yo`
already calls `set_expr_as_needs_to_call_dup(prop_rhs)` at line 388 — wire its codegen emit +
the index-store path used by `ArrayList.push`).** Then re-apply `phaseB_m1_b1.patch`, expect
**86/86**, validate TS-ASan, flip the cycle assertions to baseline. That closes Phase B for the
corpus.

### REMAINING — eval side (must CALL `set_expr_as_needs_to_call_dup`; TS has, yo-self lacks)

| TS site                       | yo-self file                    | note                                                                                                                                                                     |
| ----------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ~~`calls/helper.ts:418-452`~~ | ~~`evaluator/calls/helper.yo`~~ | ✅ DONE (`5778bb093`) — owned-param arg branch + `param_is_owning` threading + `_materialize_arg` emit. Deferred: `own_consumed_captures` + `require_expr_not_consumed`. |
| `exprs/begin.ts:1776`         | `evaluator/exprs/begin.yo`      | return-value expr dup (pairs with Phase B return handling)                                                                                                               |
| `values/dyn.ts:321`           | `evaluator/values/dyn.yo`       | dyn() inner value                                                                                                                                                        |
| `values/tuple.ts:107`         | `evaluator/values/tuple.yo`     | tuple element                                                                                                                                                            |

(yo-self's `record_type.yo`/`trait_type.yo` calls have no separate TS file — TS folds them into `type.ts`. Those are already present.)

### REMAINING — codegen side (must EMIT `deferred_dup_expressions`; pattern §3, helper like `init_assignment.yo`'s `_emit_rhs_deferred_dup`)

| TS site                        | yo-self file                      | note                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------ | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `other-fn-call.ts` (~7 blocks) | `codegen/exprs/other_fn_call.yo`  | PARTIAL — ✅ ref-struct ctor-arg loop (`cd113b73d`) + `_materialize_arg` value-pass return (`5778bb093`) via `emit_deferred_dup_or_code`. DEFERRED (cycle-COUPLED, co-land w/ Phase B/C): enum-construction args (`_emit_enum_construction`). The `argTargets` filter (get_deferred_dup_target_atom_name) was NOT needed for the simple value-pass cases — add only if a closure-capture-dup mis-substitution appears. |
| `assignment.ts`                | `codegen/exprs/assignment.yo`     | **COUPLED w/ Phase C** — reassignment `a.f = __dup(b)`; will make cycle tests DIFF until the paired drop-of-old + scope drops land. Do LAST.                                                                                                                                                                                                                                                                           |
| `cond.ts`                      | `codegen/exprs/cond.yo`           |                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `array-fns.ts`                 | `codegen/exprs/array_fns.yo`      | also the array-init RHS path left in `init_assignment.yo`                                                                                                                                                                                                                                                                                                                                                              |
| `closures.ts`                  | `codegen/exprs/closures.yo`       | capture dup                                                                                                                                                                                                                                                                                                                                                                                                            |
| `recur.ts`                     | `codegen/exprs/recur.yo`          |                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `tuple-fn.ts`                  | `codegen/exprs/tuple_fn.yo`       |                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `functions/generation.ts`      | `codegen/functions/generation.yo` | param/body dup + the `_copy_expr_list` divergence fix (saved `m1_full_attempt.patch`) belongs here for Phase B                                                                                                                                                                                                                                                                                                         |

### Safe landing order (recap §0)

All dup sites (eval calls + codegen emits) are crash-safe to add incrementally
(refcount++ only leaks; never UAFs). Add them ALL first, validating corpus
0-diff/SELF-FAIL-0 after each (cycle tests may DIFF only when `assignment.yo`
reassignment-dup lands — that one co-lands with Phase B/C drops). THEN Phase B
(drops + return materialization + early-return filter) rebalances. Never land a
drop before its paired dups exist.

## 9. NEXT (the p4 residual): faithful `___dispose` synthesis — auto-derived recursive RC-field drop

**Root cause of the p4 leak (verified):** yo-self ref-structs with RC fields have NO
auto-derived `___dispose`, so `get_dispose_function_for_type(N)` (= `_method_c_name(N,"___dispose")`,
drop_dup.yo:34) returns None → the constructor sets `dispose_fn = NULL` (constructors.yo:113) →
when an N is freed (rc→0), `__yo_decr_rc` does NOT recursively drop its RC fields (the runtime
calls `dispose_fn` for that — gc_runtime.yo:341 normal free, :658 collector). So `b := N(5,Some(a))`:
freeing `b` never decrements `a` → `a` leaks. TS auto-derives `___dispose` (recursive field-drop);
yo-self **deferred the whole RC-function synthesis** (evaluator/types/utils.yo:19).

**TS source to port (faithful):** `src/evaluator/types/utils.ts` —
`generateDisposeFunctionCodeForStructType` (389), `generateDestructuringAndCalls` (355),
`generateDisposeFunctionCodeForEnumType` (~691), `addRcFunctionsToStructType` (573) /
`addFunctionCodeToSelfTypeModule`. The `___dispose` body is just:
`(fn(self : Self) -> unit)({ { f1 : a1, f2 : a2, … } := self; (___drop)(a1); (___drop)(a2); … () })`
over the RC-containing runtime fields (TS `generateDestructuringAndCalls`).

**Where to do it in yo-self (a ctx-bearing pass — `auto_derive_traits_for_struct_type` lacks
ctx/exn/field-labels):** add a codegen-time `collect_dispose_methods` pass mirroring task #37's
`collect_trace_methods_from_generic_impls` (collection.yo:852) + `_specialize_and_register_trace`
(it already threads `base/ctx/module_env/info/exn` from `compile_module`):

1. Snapshot RC struct/enum types from `base.types` (like the trace pass).
2. For each with RC fields and no existing `___dispose`: build the dispose code string from the
   type's field labels (get_runtime_struct_fields / variant fields), `generate_expr_from_code`,
   evaluate it in a `clone_env(module_env)` frame with `Self`/`self` bound to the concrete type
   (mirror `_specialize_and_register_trace`'s env-build), extract the `FuncVal`,
   `register_type_trait_method(type_id, ___dispose_entry)`, and collect it for codegen (add to
   `base.functions` + collect its sig/body, exactly as the trace pass does).
3. Then the EXISTING machinery works unchanged: `get_dispose_function_for_type` finds it →
   constructor sets `dispose_fn` → `decr_rc` recurses on free.

**Scope/risk:** task-#37-scale (intricate synth+register+collect, broad blast radius — every RC
type). Validate: corpus 86/86 0-diff + SELF-FAIL 0, **Probe A p4 0→0** (the fix target) + p1-3
still 0→0, Probe B (`disposed 7` fires), TS-ASan clean, check ./std 152, cycle tests still
collect. Enum version (`generateDisposeFunctionCodeForEnumType`) + the `containsSomeType`/
comptime-only skips must be ported too. This is the last piece for a leak-free faithful Phase B.

### §9 ATTEMPT 1 (2026-06-28) — collect_dispose_methods, reverted (saved dispose_synth_attempt.patch)

Implemented a codegen-time `collect_dispose_methods` pass (collection.yo) + `_synthesize_and_
register_dispose` + wired into compile_module before type-decls (codegen_c.yo), mirroring the
trace pass: synthesize `(fn(self : Self) -> unit)({ { f : a, … } := self; (___drop)(a); … () })`
from RC field labels → generate_expr_from_code → evaluate_expression_raw (Self-bound via
ctx.self_type) → register_function + find_function_calls_in_expr + register_type_trait_method.
Build OK, but corpus = PASS 85 DIFF 0 **SELF-FAIL 1** (regression) and p4 STILL 0→1. Two
concrete bugs to fix next time:

1. **Synthesized destructuring parse error** (`recursive_enum_nested_match` → `error: unexpected
token: }`): the generated `{ label : alias }` destructuring doesn't parse for some struct
   shapes. Port TS `generateDestructuringAndCalls` faithfully — it aliases NON-identifier labels
   as `{ (label) : alias }` (parenthesized) and uses `isValidIdentifier`; the bare `{ label : alias }`
   form breaks on such labels (or on the `{`-ambiguity). Also guard: only emit for structs whose
   fields are all concrete (no SomeType — TS `containsSomeType` skip) + runtime (not comptime-only).
2. **Dispose didn't connect for N** (p4 unchanged): the synthesized FuncVal either didn't register
   under the right id or the constructor's `get_dispose_function_for_type` didn't find it. Verify
   `type_id_or_empty(ct)` matches the constructor's lookup id, that `evaluate_expression_raw`
   actually yields a FuncVal (the ExprInfo.value), and that collect_dispose_methods runs before
   constructor emission (it's placed before generate_type_declarations — confirm constructors emit
   later). Add a temporary stderr probe in \_synthesize_and_register_dispose (did it register? fid?).
   The approach is sound (faithful TS synthesis); it needs this iterative debugging. Phase B
   (f2de4f781) stands as the committed milestone meanwhile.

### §9 ATTEMPT 1 — FULL DIAGNOSIS (probes): synthesis WORKS; real blocker is deeper

Re-ran with probes (`[DISP]` eprintln). Findings (definitive):

- **The dispose synthesis WORKS end-to-end for the happy case.** For `N = ref(struct(v, next:Option(Self)))`:
  the pass synthesized `(fn(self:Self)->unit)({ {next:a} := self; (___drop)(a); () })`, evaluated it →
  FuncVal `yo_id_3742`, registered it, and the CONSTRUCTOR picked it up:
  emitted `obj->header.dispose_fn = (void(*)(void*))yo_id_3742;` + the function is defined. So the
  synthesis + registration + constructor-wiring (bug 2) all WORK. (Add `type_contains_some_type` skip.)
- **Bug 1 (parse crash, SELF-FAIL):** a struct `id_3510` has a field labeled `*` (Box/newtype inner) →
  synthesized `{ * : __yo_disp_* } := self` is invalid → "unexpected token }". FIX: skip structs whose
  RC field labels aren't simple identifiers (TS parenthesizes via `generateDestructuringAndCalls`, but `*`
  is special — skip is safest), or special-case the newtype/box `.*` field.
- **Bug 3 (the REAL p4 blocker — deeper):** `yo_id_3742`'s emitted body is ONLY
  `__yo_disp_next = self->next; // Destructuring next` — **the `(___drop)(__yo_disp_next)` emitted NOTHING**,
  AND there's no scope-end drop of `a`. Root: `a : Option(N)` is a VALUE-enum (nullable-ptr); (i) the
  explicit `___drop(Option(N))` codegen elides, and (ii) the Phase-B scope-drop predicate (begin.yo
  `_schedule_scope_end_drops`) is deliberately NARROW — ref-struct/enum only (M1 excluded
  value-enums/newtypes-holding-RC to avoid the then-untested recursive-drop codegen crash). TS drops `a`
  via the scope-end drop of the destructured local with a BROADER predicate + working value-enum
  recursive-drop. **So p4's fix = (a) broaden the scope-drop predicate from ref-struct/enum to
  `type_contains_rc_type` (covering Option(N)/newtypes), AND (b) make the recursive \_\_\_drop codegen for
  value-enums/newtypes-holding-RC actually emit (the dormant path M1 flagged).** This is a deeper Phase-B
  layer, NOT just the dispose synthesis. The synthesis scaffold (scratchpad/dispose_synth_attempt.patch)
  is correct + reusable; it needs bug-1 skip + the bug-3 drop-predicate/codegen work to make p4 0→0.

### §10 p4 FIXED — recursive \_\_\_dispose synthesis + INLINE value-enum drop (committed)

The p4 leak (0→1) is FIXED — Probe A p4 now **0→0**, matching TS. Two coordinated pieces, both
landed faithfully to yo-self's established RC-lowering architecture (inline, side-registry-free):

1. **Struct `___dispose` synthesis** (`collect_dispose_methods` in codegen/functions/collection.yo).
   A codegen-collection-time pass (mirroring task #37's trace synthesis) that, for every RC struct
   lacking a **_dispose, synthesizes `(fn(self : Self) -> unit)({ { f : a, … } := self; (_**drop)(a); … })`
over its RC fields, evaluates it Self-bound (`\_eval_and_register_rc_method`), and registers it as the
type's ___dispose method. The constructor then wires `dispose_fn` via get_dispose_function_for_type,
   so freeing the struct (gc_runtime header.dispose_fn) recursively drops its RC fields. Mirrors TS
   addRcFunctionsToStructType / generateDisposeFunctionCodeForStructType.

   - **Bug-1 (non-identifier field labels, e.g. the newtype/box `*` field):** the destructuring LABEL is
     paren-aliased (`{ (*) : alias }`, via `_destructuring_label_fragment` + `_is_valid_yo_identifier`,
     porting TS isValidIdentifier) AND the alias is index-based (`__yo_disp_f0`) so the raw `*` never
     leaks into a binding name.

2. **Value-enum per-variant drop — INLINE (NOT a synthesized method).** `generate_drop_code_for_value`
   (codegen/exprs/drop_dup.yo) now lowers a value enum's drop inline: nullable-pointer enums →
   `if ((v) != NULL) { <drop inner> }`; tagged enums → `switch ((v).tag) { case TAG: <drop each RC
field of the arm>; … }`. This is the SAME inline treatment yo-self already uses for reference-enum
   drops (drop_dup.yo:193-209) — yo-self stores trait methods in a side-registry, not on the type.
   - **Why inline, not the TS method approach:** registering a value-enum `___drop` _trait method_
     (the literal TS port) made `(___drop)(x : ValueEnum)` resolve via method dispatch, which mis-lowered
     to a double-application `f(x)(x)` for a _duplicate_ generic instantiation (task #30) whose dispose
     was synthesized AFTER the method was registered (surfaced by recursive_enum_nested_match: two
     Box(Tree) struct ids). Inline lowering sidesteps the method dispatch entirely and is consistent
     with the ref-enum divergence already documented in the codebase.
   - codegen/exprs/generation.yo: BF_DROP / BF_DUP are now routed to generate_drop / generate_dup
     BEFORE the macro_expansion check — these RC builtins are authoritative via their generators and must
     never be diverted through a (possibly stale, id-collided) side-table macro_expansion.

**Validation:** corpus **86/86 DIFF 0 SELF-FAIL 0**; Probe A p4 **0→0** (was 0→1), p1/p2/p3 still 0→0;
TS-ASan clean on p4 + recursive_enum_nested_match (no leak / UAF / double-free); recursive_enum_nested_match
(the lone regression from the method-approach attempt) compiles + runs correctly under the inline approach.
