# Bootstrapping codegen — resume plan (2026-06-19)

Single ordered checklist for finishing Phases 5–7. Each step has a precise entry
point + validation gate. Resume from the top. Tree is clean + green at
`codeberg feat/bootstrap-codegen` (codegen-bootstrap corpus 75/75).

## State at handoff

- Phase 5 ~95%: async + effects (resume **and** unwind) DONE; parallelism runtime
  + spawn emitter PORTED; spawn blocked only on Gap-2 (below).
- Phase 6 (self-host fixpoint) + Phase 7 (revive yo-self/tests) UNSTARTED, and
  **sequentially gated** on Phase 5 codegen being complete enough to compile all
  of yo-self's own source.

## Step 1 — Gap-2: monomorphize soft-generic (Impl(Fn)-param) functions

THE keystone — unblocks parallelism spawn AND is required for the Phase-6 fixpoint.

- Entry: `yo-self/evaluator/calls/function.yo:2509`, guard `forall_names.len() > 0`.
- Faithful target: TS `src/evaluator/calls/helper.ts:1917` guard =
  `isFunctionTypeGeneric(ft) && !isFunctionTypeHardGeneric(ft)` (+ `!isControlFunction`,
  no-unknown-implicits). Both helpers exist in yo-self
  (`types/guards.yo:428` `is_function_type_generic`, `is_function_type_hard_generic`).
- The existing arm at 2509 is forall-centric; add a NON-forall branch (empty
  forall args + concrete reg-arg types) calling `create_specialized_function_inline`
  (helper.yo:914), then record value+type on the callee node (mirror lines 2604-2607,
  skip the forall-return-fix).
- ALSO REQUIRED: the closure (cb) arg's `arg_type` must be the CONCRETE capture
  struct at the call site (else specialization can't refine `cb`). Verify; may need
  closure-arg typing work.
- RISK: `is_function_type_generic` is broad → routes many std calls through
  `create_specialized_function_inline`, which lacks effects analysis (helper.yo:908)
  and uses soft-fallbacks; prior broad attempts regressed std + were reverted.
  Consider NARROWING the new branch to Impl(Fn)-closure params first.
- GATE: `./yo-cli check ./std` (TS) clean, rebuild yo-self-bin, corpus 75/75, then
  the spawn repro (`/tmp/th.yo` shape) → `thread sees 42` / `main done`; add a
  parallelism corpus fixture. Run the full `./yo-cli test --bail` (~30 min) before
  committing — this touches the hot call path.

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
