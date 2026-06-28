# yo-self RC-emission layer: faithful dup + drop port

**Status:** PLANNED — master plan for task #38. Supersedes the incremental framing in
`plans/YO_SELF_NAMED_LOCAL_DROPS.md` (keep that doc for its M1 attempt logs §10/§11 and
the validation harness §6). This plan adds the **decisive new finding**: the eval-side
`set_expr_as_needs_to_call_dup` is a **no-op stub** (`yo-self/evaluator/utils.yo:562`), so
yo-self has **zero dup-on-store** — the true root of why scope drops can't land alone.

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
- All validated: compile OK (~77s), corpus **86/86 PASS DIFF 0 SELF-FAIL 0**,
  `check ./yo-self` 0 regressions (baseline = identical 11 pre-existing test-file fails).

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

### REMAINING — eval side (must CALL `set_expr_as_needs_to_call_dup`; TS has, yo-self lacks)

| TS site                   | yo-self file                | note                                                                                                                                                                                                                                                                                                                 |
| ------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `calls/helper.ts:418-452` | `evaluator/calls/helper.yo` | **HIGH** — fn-call args (`sink(x)`). yo-self helper.yo lacks the WHOLE owned-vs-borrowed arg branch (no `set_expr_as_consumed` calls at all): owning arg → consume (move, no dup); borrowed/non-owning → `set_expr_as_needs_to_call_dup` + consume. Consume-tracking change → validate use-after-move across corpus. |
| `exprs/begin.ts:1776`     | `evaluator/exprs/begin.yo`  | return-value expr dup (pairs with Phase B return handling)                                                                                                                                                                                                                                                           |
| `values/dyn.ts:321`       | `evaluator/values/dyn.yo`   | dyn() inner value                                                                                                                                                                                                                                                                                                    |
| `values/tuple.ts:107`     | `evaluator/values/tuple.yo` | tuple element                                                                                                                                                                                                                                                                                                        |

(yo-self's `record_type.yo`/`trait_type.yo` calls have no separate TS file — TS folds them into `type.ts`. Those are already present.)

### REMAINING — codegen side (must EMIT `deferred_dup_expressions`; pattern §3, helper like `init_assignment.yo`'s `_emit_rhs_deferred_dup`)

| TS site                        | yo-self file                      | note                                                                                                                                                                                                                                                                             |
| ------------------------------ | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `other-fn-call.ts` (~7 blocks) | `codegen/exprs/other_fn_call.yo`  | **HIGH** — primary block maps to `_materialize_arg` (line ~420, after `final_name`); needs the `argTargets`-filtered `get_deferred_dup_target_atom_name` match (utils/index.yo:992) so a closure-capture dup isn't substituted as the arg. Plus method-call/variadic/dyn blocks. |
| `assignment.ts`                | `codegen/exprs/assignment.yo`     | **COUPLED w/ Phase C** — reassignment `a.f = __dup(b)`; will make cycle tests DIFF until the paired drop-of-old + scope drops land. Do LAST.                                                                                                                                     |
| `cond.ts`                      | `codegen/exprs/cond.yo`           |                                                                                                                                                                                                                                                                                  |
| `array-fns.ts`                 | `codegen/exprs/array_fns.yo`      | also the array-init RHS path left in `init_assignment.yo`                                                                                                                                                                                                                        |
| `closures.ts`                  | `codegen/exprs/closures.yo`       | capture dup                                                                                                                                                                                                                                                                      |
| `recur.ts`                     | `codegen/exprs/recur.yo`          |                                                                                                                                                                                                                                                                                  |
| `tuple-fn.ts`                  | `codegen/exprs/tuple_fn.yo`       |                                                                                                                                                                                                                                                                                  |
| `functions/generation.ts`      | `codegen/functions/generation.yo` | param/body dup + the `_copy_expr_list` divergence fix (saved `m1_full_attempt.patch`) belongs here for Phase B                                                                                                                                                                   |

### Safe landing order (recap §0)

All dup sites (eval calls + codegen emits) are crash-safe to add incrementally
(refcount++ only leaks; never UAFs). Add them ALL first, validating corpus
0-diff/SELF-FAIL-0 after each (cycle tests may DIFF only when `assignment.yo`
reassignment-dup lands — that one co-lands with Phase B/C drops). THEN Phase B
(drops + return materialization + early-return filter) rebalances. Never land a
drop before its paired dups exist.
