> **CLOSED (2026-08-06).** The bootstrap campaign this document belongs to is
> complete: the self-hosted compiler passes the full suite, the stage-2/stage-3
> fixpoint holds, and every CI job gates PRs (run 31069479984, commit
> `ac85f6cfc`). Kept as a historical record — do not resume work from this
> file. Umbrella status: `plans/BOOTSTRAPPING.md`. What comes next:
> `plans/SELF_HOSTING_COMPLETION.md`.

# Bootstrapping codegen — resume plan (2026-06-19)

Single ordered checklist for finishing Phases 5–7. Each step has a precise entry
point + validation gate. Resume from the top. Tree is clean + green at
`codeberg feat/bootstrap-codegen` (codegen-bootstrap corpus 76/76).

## State at handoff

- Phase 5 ✅ DONE: async + effects (resume **and** unwind) + parallelism. Gap-2
  closure-param specialization + Thread.spawn now work END-TO-END (commit 88d060546;
  spawn → "thread sees 42"/"main done", corpus 76/76 incl. thread_spawn.yo).
- **NEXT = Step 3 (Phase 6, self-host fixpoint).** Phase 7 (revive yo-self/tests)
  follows. Both were gated on Phase 5 codegen, now unblocked. EXPECT the stage-2
  compile (yo-self-bin compiling yo-self's own source) to surface a wave of new
  executing-mode codegen/eval gaps — each a Phase-5-style fix done THERE.

## Step 1 — Gap-2: closure-param specialization codegen-emission ✅ DONE (88d060546)

CLOSED. Closure-param functions specialize per closure, the closure lowers to its
capture struct, and the closure is called via the impl-closure-call map; Thread.spawn
works end-to-end. Fixes: general closure-param codegen (A/B/C, e9cc6806a), extern-
opaque-Type exclusion + lowering, deterministic capture-struct id, closure-call-map
pre-pass. (Historical entry-point notes below retained for reference.)

TYPE-LOWERING HALF: DONE (commit fd019e82b, 2026-06-19). `Thread.spawn` / any
closure-param fn now specializes with `cb` typed as its concrete capture struct.
Four faithful, corpus-safe (75/75), non-regressing changes landed (expected-type
coercion of `Impl(Fn)` args, capture_type→spec arg_type, narrowed soft-generic
trigger via `_func_type_has_closure_param`, ref-spill monotonic counter). See
`issues/yo-self-parallelism-emitter-gated-on-closure-codegen.md` UPDATE (2).

CODEGEN-EMISSION HALF: REMAINING. None of A/B/C alone compiles the repro — land
together. MINIMAL non-extern repro (fix this before spawn — same gap, no wrapper):
`apply :: (fn(cb : Impl(Fn(x:i32)->i32)) -> i32)(cb(i32(10)));` called
`apply((x) => (x + base))` — TS prints 15; yo-self-bin emits broken C. NOTE: the
clean HEAD binary breaks it identically → PRE-EXISTING unported feature, not a
regression. Pieces (full TS mechanism in the issue doc):

- (B) COLLECTION — root cause LOCATED: `function.yo:2536` records the runtime
  call-site result as `_call_result_unknown(...)` (an `UnknownVal`); TS leaves
  `expr.$.value` undefined for runtime calls. So `cb(10)` in a specialized body
  trips the `expr_contains_unknown_value` guard (collection.yo:496) and the body is
  skipped (undeclared symbol). `a+b` does NOT trip it (operator path records
  differently — `add2` compiles fine), so the divergence is specifically the
  function-call result-value recording. FIX (validate corpus 75/75 — hot path):
  align the runtime-call result to a non-UnknownVal (value=None + return type) like
  the operator path, OR refine the collection guard to not skip concrete-typed
  (specialized) functions. The TS guard chain is collection.ts:401-492.
- (A) CALLER arg emission — a closure arg passed where the param is the capture
  struct must emit `(captureStruct){ .field = capturedVar }` (temp + by-value),
  NOT `(captureStruct)(closure_fn_name)`. Call-site arg path in other_fn_call.yo.
- (C) SPECIALIZED-BODY closure call — `cb(x)` (cb = capture-struct param) → emit
  `closure_fn(&(cb), x)`. For spawn this is instead the `__yo_thread_spawn(wrapper,
&cb_heapcopy)` path already in parallelism.yo; the general case is a direct
  closure call and is the broader missing emitter. The async path (async.yo,
  `sm->__capture.field`) is the SM analogue.
- GATE: rebuild yo-self-bin, corpus 75/75, the apply repro prints 15, then the
  spawn repro (`/tmp/th.yo`) → `thread sees 42` / `main done`; add a parallelism
  corpus fixture. Run the full `./yo-cli test --bail` before committing (hot path).

## Step 2 — implicit-effect evidence machinery (optional for fixpoint)

Explicit-handler effects are done. Implicit (unthreaded) handlers need the
evidence-passing machinery (`resolveEvidenceArgsForCallSite` + call-through). Only
needed if yo-self's own source uses implicit effects; check before doing.
See `issues/yo-self-sync-effect-codegen-unported.md`.

## Step 3 — Phase 6: self-host fixpoint

1. Port the test runner (`src/test-runner.ts`, ~1632 LOC) → yo-self; wire `run_test`
   in `yo-self/main.yo`. ADDITIVE (low regression risk) but large + unvalidatable
   until stage-2 compiles.
2. `yo-self-bin test ./tests` matches `./yo-cli test`.
3. Stage 2: `yo-self-bin compile yo-self/main.yo` → stage-2 binary. EXPECT a wave of
   executing-mode evaluator findings (yo-self's own source is the harshest corpus) —
   each is a Phase-5-style codegen/eval gap to fix here.
4. Stage 3 ≡ stage 2 (fixpoint): stage-2 binary compiles yo-self → stage-3 binary
   identical/equivalent.

## Step 4 — Phase 7: revive yo-self/tests under yo-self-bin

Run `yo-self/tests/` via the stage-2 yo-self-bin; fix divergences from `./yo-cli`.
See `yo-self/README.md` for tiers + known-heavy files (eval trio exceeds the 1800s
isolated-process limit — validate via yo-self-bin sweeps, not the runner).

## Validation cadence (all steps)

`bun run build` first; `./yo-cli fmt` every .yo; rebuild `/tmp/yo-self-bin` via
`./yo-cli compile yo-self/main.yo -o /tmp/yo-self-bin` (~5 min); gate on the
codegen-bootstrap corpus (`./scripts/diff-test.sh tests/codegen-bootstrap
--parallel 1`) staying green; for call-path changes also run the full suite. Commit
small, push to `codeberg feat/bootstrap-codegen`.
