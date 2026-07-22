# yo-self: OPTIMIZE_DUP_AND_DROP_PAIRS ported + captured-map pollution fix (cycle_collector)

**Status: FIXED** (this commit). Flips `tests/cycle_collector.test.yo` (15/16 → 16/16).

## Symptom

"Garbage cycle collected while live objects survive": a mid-scope `Gc.collect()`
saw `tracked=3` where TS sees `tracked=1` — the garbage `a ↔ b` cycle was NOT
collected. Repro `/tmp/gcr.yo` (needs `open(import("std/fmt"))` for println):
TS `3 → 1 → 0`, s1 `3 → 3 → 0`.

## Roots (two, stacked)

1. **`OPTIMIZE_DUP_AND_DROP_PAIRS` was a Phase-2aa stub.** yo-self emitted
   `incr_rc(local)` for every `.Some(<owned local>)` ctor arg AND the local's
   scope-end drop — RC-balanced, but the locals stay OWNING until scope end,
   so a mid-scope collect sees external refs into the garbage cycle. TS
   cancels that dup against the scope-end drop and marks the local CONSUMED
   at the dup's use site — a true move (begin.ts:1787-2062 + the collector at
   348-636). Ported to begin.yo:

   - `collect_dup_calls_conservatively` — recursive dup-call collection with
     cross-branch conservatism (cond/match: early-return-branch dups are
     independent pairs; fallthrough dups only cancel when ALL fallthrough
     branches dup; partial ⇒ never optimize), while/io.async skips, recursion
     into `deferred_dup_expressions` and recorded `macro_expansion`s. Detects
     BOTH dup shapes (`(x.___dup)()` and bare `___dup(x)`).
   - `_optimize_dup_drop_pairs` — runs right before `_schedule_scope_end_drops`;
     candidates mirror the scheduler's e1-e7 gates + the captured filter; TS
     gates ported: value-type-with-RC-fields, partial-branch dups,
     return-before-dup (child-index vs earliest return child),
     consumed-derived-count / base-consumed (ownership-alias chains),
     runtime-dup-count ≤ 1. Winners: dups stripped from the tree
     (`_remove_dup_calls_from_tree`) + `consumed_at_token` set to the dup's
     USE-SITE token (side-table `g_dup_use_site_tokens` stamped in
     `set_expr_as_needs_to_call_dup`, mirroring TS `__useSiteToken`) so the
     M3 driver attaches early-return-only drops for the [init, consume)
     window. `__isEarlyReturnDup` → `g_early_return_dup_ids` side-table.
     TS's `__branchGroup` is never SET anywhere in src/ (vestigial) — skipped;
     `branchIsEmpty` computed but unread — skipped.

2. **`captured_variables` pollution defeated the optimizer's captured gate**
   (and TS-parity of `trackVariableUsage` generally). `FuncOrAsyncBlockCtx.
eval_env` stored the LIVE mutable env; when `evaluate_begin` later pushed
   the body's begin frame, `eval_env.frame_count()` grew, so body LOCALS
   (frame_level == entry count) passed the "outer scope" gate
   (`frame_level >= frame_count`) and were tracked as captures — every
   candidate then failed `_variable_is_captured_by_current_function`.
   TS probe on the same repro: `cap=false mapsize=0` for all three locals
   (TS envs are persistent; `evaluationEnv.frames.length` is frozen at body
   entry). FIX: `eval_env : snapshot_env(...)` at ALL 8 FuncOrAsyncBlockCtx
   creation sites (helper spec+handler, function_type, calls/function,
   calls/comptime_fn, builtins/comptime_fn, recur, test) — frames-list copy
   with shared Frame refs, freezing the entry frame count exactly like TS.

## Round 2 — stage-2 self-compile regressions (fixed before landing)

The first port broke stage-2 clang (`undeclared result` / `temp_var_name`)
through THREE stacked issues, each a faithfulness lesson:

1. **Collector was BROADER than TS**: it recursed into recorded
   `macro_expansion`s. TS's `searchRecursively` never looks inside
   `$.macroExpansion`, so dups inside an `if(...)` macro arm (CONDITIONAL
   execution) stay invisible and keep their dup+drop pair. Recursing found
   them as plain unconditional dups and wrongly cancelled them. Removed
   (collector and removal walk are raw-tree-only, TS-exact).
2. **Return detection was NARROWER than TS**: `expr_tree_contains_return`
   (expr_traversal.yo) is documented "AST-only" — it cannot see a return
   hidden in an `if()` macro's recorded expansion, while TS's
   `exprTreeContainsReturn` checks `$.macroExpansion`. `earliest_ret` stayed
   unset and the return-before-dup guard never fired. Added the macro-aware
   `_contains_return_for_opt` (ctx-threaded) for the optimizer.
3. **Early-return-only drop emission had no C-scope gate**: with far more
   consumed locals, the M3 driver's source-token gates hit the known C
   decl-emission-order divergence — `x := match(...)` emits x's C decl AFTER
   the switch, so a return inside an arm precedes it in C while FOLLOWING x's
   init token in source (TS is protected by per-return point-in-time env
   lookups, begin.ts:140; yo-self's retroactive shared-frame envs find the
   name anyway). Fix: `generate_early_return_only_deferred_drop_expressions`
   now requires `scope_stack_contains(declared_scopes, c_name)` — the same
   authoritative block-scope signal `_keep_pending_drop` uses (params are
   seeded at function entry; a target absent from the stack holds no C value,
   so skipping cannot double-free or leak). Subsumes the old minted-TEMP
   check.

## Debug recipe

`eprintln` probes gated on `token.module_path.contains("/tmp/")`: OPTDBG in
the optimizer (candidate gates, base lookup, runtime count) + CAPDBG in
`track_variable_usage` (`flvl=2 cnt=3` was the smoking gun: local's
frame_level 2 vs LIVE count 3). TS side probed via a temporary console.error
in `variableIsCapturedByCurrentFunction` (bun build is fast; revert after).

## Verification

- /tmp/gcr.yo: `3 → 1 → 0` with TS-identical dispose ordering.
- cycle_collector.test.yo 16/16; full battery + STRICT_FIXPOINT — see commit.
