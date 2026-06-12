# Bootstrapping the codegen — TS `src/codegen/` → yo-self `yo-self/codegen/`

The detailed plan for the codegen slice of self-hosting, the successor to
`BOOTSTRAPPING_EVALUATOR.md` (whose `check` surface went fully green
2026-06-10). Keep `BOOTSTRAPPING.md` as the umbrella record; update both
when status changes.

**This document is a HANDOFF SPEC** — it assumes the executing agent has no
prior session context. Everything needed to start (environment, commands,
conventions, porting order, done-criteria) is in this file plus the
referenced instruction files.

> **2026-06-11 — clean-slate update.** The untyped bootstrap codegen
> (`yo-self/codegen/` — driver.yo, exprs.yo, 49 files / ~30.6k LOC) was
> **DELETED** during the slice rework (user decision): it was built on the
> wrong foundation (AST pattern-matching without the evaluator) and would
> have been dragged through every language change. `run_compile`/`run_test`
> in `yo-self/main.yo` now throw a pointer to this plan. The port therefore
> starts from a CLEAN SLATE — which is the better starting point for the
> strict 1-to-1 rule: every `yo-self/codegen/X.yo` will be born as a
> faithful port of `src/codegen/X.ts`, never retrofitted.
>
> Also landed since: the slice rework (plans/SLICE_REWORK.md, complete)
> DELETED the builtin Slice(T) end-to-end (`str` is a builtin with one
> canonical `__yo_str` lowering); yo-self's TYPE MODEL is fully aligned
> with TS (TypeValue.Str variant, Slice/SliceVal removed, copying-range
> slice_copy rewrite ported — commit 49f51b35); `yo-self/tests/` was
> revived and is green (commit ca1f776a); the same-scope borrow-invalidation
> flowability gate exists in BOTH compilers (490c5d60 + 7f06fca7).

## Current validation gates (must stay green throughout)

| Gate | Command | Expected |
|---|---|---|
| TS unit tests | `bun test --timeout 30000` | 457/457 |
| TS evaluator on std | `node ./out/cjs/yo-cli.cjs check ./std` | 152/152 |
| Full integration suite | `node --expose-gc --max-old-space-size=4096 ./out/cjs/yo-cli.cjs test ./tests --parallel 2 --bail --c-compiler clang` | ~2601/2601, ~12 min |
| Self-hosted binary sweep | `YO_MAIN_STACK_MB=4096 /tmp/yo-self-bin check ./std` | 152/152 |
| 〃 | `… check ./tests` | all pass except the 2 baseline fixtures `tests/circular_deps/circular_error_{a,b}.yo`, which error identically under TS (count drifts as tests are added; 143/145 as of 2026-06-12) |
| 〃 | `… check ./yo-self` | all pass (235/235 as of 2026-06-12; count drifts with the file inventory) |
| yo-self component tests | per-file `node ./out/cjs/yo-cli.cjs test yo-self/tests/<f> --parallel 1\|2` | green; see `yo-self/README.md` "Test suite layout" for tiers, runtimes, and the known-heavy trio (eval_basics/eval_tail_1/eval_tail_2 exceed the runner's 1800 s isolated-process limit; they `check` clean) |

## Handoff onboarding (read first)

**Environment quirks (macOS dev box):**
- `bun` drops out of PATH in fresh shells:
  `export PATH="/nix/store/9zgnq216jb56ai0xpm6c6j2fblnp8vxy-devenv-profile/bin:$PATH"`.
- Always `bun run build` before invoking `node ./out/cjs/yo-cli.cjs …` after
  TS edits. Never use npm.
- The self-hosted binary's evaluator is deeply recursive: run it with
  `YO_MAIN_STACK_MB=4096` (a `-O0` binary SIGSEGVing (rc=139) on deep
  recursion is stack exhaustion, NOT heap corruption — AGENTS.md pitfall).
- Build loop: `node ./out/cjs/yo-cli.cjs compile yo-self/main.yo -o
  /tmp/yo-self-bin` — ~10 min, NO `--release` (too slow for iteration).
- Run `./yo-cli fmt <file.yo>` on every created/modified .yo file before
  committing (`fmt --check` to verify).
- Classify yo-self-bin failures by EXIT CODE, not by grepping "evaluator
  OK": rc=0 pass, rc=1 evaluator error, rc>1 (133/139) crash.
- ASan via `--sanitize address` is broken on this machine (Nix clang vs
  Xcode runtime). For memory bugs use guard pages:
  `DYLD_INSERT_LIBRARIES=/usr/lib/libgmalloc.dylib <bin> …` — it turns
  intermittent corruption into deterministic faults with usable crash
  reports (`~/Library/Logs/DiagnosticReports/*.ips`).

**Conventions (non-negotiable, inherited from the evaluator port):**
- **Strict 1-to-1**: `src/codegen/X.ts` ↔ `yo-self/codegen/X.yo`, same
  functions, same order; language-forced divergences get header comments.
  No yo-only helper files.
- **TS-first for bugs**: if TS codegen has a bug, fix TS (with a `tests/`
  case that fails first), then port.
- **Never regress the gates table above** after any step.
- Findings → `issues/`; Yo-language surprises → `.github/skills/*` and
  `.github/instructions/*` files.
- Commits: `git commit --no-verify` (husky needs bunx), message body ends
  with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Push
  incrementally; validate every batch before committing.

**Yo-syntax landmines that bit during the evaluator port** (full list in
`.github/skills/yo-syntax/syntax-cheatsheet.md` — read it):
- Single-expression fn body must NOT have braces (`{ expr }` = struct lit).
- No forward references; self-recursion via `recur`, not the fn's name.
- No variable shadowing (match-arm bindings can't reuse an outer name).
- `match` arms over multi-field variants: use curly destructuring
  `.Variant({ field, other : alias })`.
- Objects are Rc'd and cannot be mutually recursive — break cycles with id
  strings (see `RefBorrowMark` in `yo-self/env.yo` for the pattern).
- `continue` in Rc-allocating while bodies is SAFE (re-verified 0/52 on the
  historical corruption protocol, 2026-06-11).

## Goal & end state — DEFINITION OF DONE

**The codegen port is a FAITHFUL port:** strict 1-to-1 file mapping, same
functions and control flow.

`yo-self-bin compile <file.yo>` produces a C11 program whose **runtime
behavior matches the TS compiler's output** on the same source, culminating
in the self-host fixpoint:

1. `yo-self-bin` (stage 1, built by TS) compiles `yo-self/main.yo` → stage 2.
2. Stage 2 compiles `yo-self/main.yo` → stage 3.
3. Stage 2 ≡ stage 3 (identical C text, or — if `random_id` makes text
   unstable — behaviorally identical: both pass the full suite; consider
   seeding ids for the comparison build).

Equivalence is judged by **run behavior** (stdout + exit code + test
results), NOT C-text equality against TS output.

**The port is DONE when ALL of the following hold:**
- [ ] Differential harness: 100% of `tests/*.test.yo` PASS (same stdout,
      same exit code, same per-test results) for the harness's POSIX
      targets (macOS arm64 + Linux x86_64). Windows + WASM runtimes are an
      explicitly out-of-scope follow-up (tracked by its own issue).
- [ ] `yo-self-bin test ./tests` runs the suite end-to-end with results
      matching `./yo-cli test ./tests`.
- [ ] All differential runs are clean under guard pages (libgmalloc).
      The proven memory-debug workflow on this machine (Developer Mode is
      enabled): lldb batch + `DYLD_INSERT_LIBRARIES=/usr/lib/libgmalloc.dylib
      MallocStackLogging=full`, post-crash `-k` commands, `malloc_history
      <pid> <addr>` for alloc/free/use stacks — see
      issues/fixed/yo-self-macro-dispatch-corruption.md. (Single-TU ASan
      still OOMs at 16 GB; gmalloc + malloc_history covers the need.)
- [ ] Self-host fixpoint (stages 2≡3 above).
- [ ] Every gate in the table above still green; `yo-self/tests/` green
      under BOTH compilers (`./yo-cli test` and `yo-self-bin test`).
- [ ] `BOOTSTRAPPING.md` umbrella table updated; this file's Status
      checklist all ticked.

## Where we start (inventory, 2026-06-11)

**TS codegen: ~70 files, ~42.8k LOC.** Per-file LOC (descending; this is
also a difficulty map):

| File | LOC | Phase |
|---|---|---|
| async/runtime-io-windows.ts | 4228 | out of scope (follow-up) |
| exprs/other-fn-call.ts | 3502 | 2 |
| functions/generation.ts | 2721 | 3 |
| async/state-machine.ts | 2605 | 5 |
| async/state-code-gen.ts | 2136 | 5 |
| exprs/async.ts | 2085 | 5 |
| async/runtime-io-macos.ts | 1779 | 5 |
| async/runtime-io-common.ts | 1717 | 5 |
| async/runtime-io-linux.ts | 1696 | 5 |
| types/generation.ts | 1516 | 3 |
| exprs/match.ts | 1196 | 2 |
| utils/index.ts | 1067 | 1 |
| exprs/generation.ts | 1007 | 2 |
| exprs/await.ts | 835 | 5 |
| functions/declarations.ts | 808 | 3 |
| async/runtime-io-wasm.ts | 797 | out of scope (follow-up) |
| index.ts (driver) | 778 | 1 |
| exprs/asm.ts | 761 | 2 |
| exprs/return.ts | 719 | 2 |
| functions/collection.ts | 697 | 1 |
| types/collection.ts | 598 | 1 |
| exprs/atom.ts | 588 | 2 |
| exprs/initialization-assignment.ts | 557 | 2 |
| exprs/rc-fns.ts | 556 | 4 |
| functions/dyn.ts | 547 | 3 |
| exprs/cond.ts | 520 | 2 |
| parallelism/runtime.ts | 474 | 5 (last) |
| exprs/property-access.ts | 446 | 2 |
| async/runtime-core.ts | 382 | 5 |
| exprs/drop-dup.ts | 370 | 4 |
| exprs/closures.ts | 358 | 3 |
| exprs/comptime-value.ts | 346 | 2 |
| exprs/assignment.ts | 344 | 2 |
| exprs/parallelism.ts | 318 | 5 (last) |
| exprs/and-or.ts | 310 | 2 |
| codegen-c.ts (orchestrator) | 309 | 1 |
| exprs/begin.ts | 263 | 2 |
| types/dyn.ts | 238 | 3 |
| exprs/while.ts | 237 | 2 |
| exprs/inline-fns.ts | 231 | 2 |
| functions/context.ts | 223 | 1 |
| shared/suspension-codegen.ts | 199 | 5 |
| exprs/{dyn,downcast}.ts | 176 ×2 | 3 |
| exprs/ptr-fns.ts | 171 | 2 |
| c/collection.ts | 153 | 1 |
| exprs/{async-completion,iso,recur,array-fns,tuple-fn}.ts | 101–124 | 2/5 |
| constants.ts, async/runtime.ts, exprs/{panic,open,typeid,binding,consume}.ts, utils/fixup.ts | ≤96 | 1/2 |

**yo-self codegen today: none** (clean slate; the port creates
`yo-self/codegen/` file-by-file). The proto-evaluator
`yo-self/evaluator/eval.yo` remains only as the delegation target of
`evaluator/index.yo` and retires when the typed pipeline drives the proper
evaluator end-to-end.

**The coupling that defines the work.** TS codegen is driven almost entirely
by evaluator annotations on `expr.$` (yo-self: the `ExprInfo` table):
`type`, `value`, `variableName`, `env`, `controlFlow`, `pathCollection`,
`runtimeArgExprsInOrder`, `runtimeDestructurings`, `dynCallTraitValues`,
`deferredDupExpressions`/`deferredDropExpressions`, `macroExpansion`,
`awaitAnalysis`, capture structs. yo-self's `ExprInfo` already carries the
core (type/value/env/control_flow/path_collection/variable_name/origin_type);
the runtime-oriented fields are produced partially or not at all — **most of
the porting effort is making the evaluator produce them and the emitters
consume them**, not the C string-building itself.

**Critical consequence for the evaluator:** codegen requires evaluating
function bodies in **executing mode** (`is_executing = true`) with REAL,
propagating errors — the def-eval-wall *swallow* that protects `check`
cannot apply. This will surface the remaining evaluator tail
(`EVALUATOR_PORT_REVIEW.md` status summary: GADT match-refinement, HKT
partial application, Module/Call dispatch, effect-analysis re-sync, …).
That is a feature of the plan: each phase names the evaluator work it is
expected to unlock.

## Known pre-existing landmines (read the issue docs before Phase 0)

1. ~~The ExprInfo-table use-after-free~~ — **✅ RESOLVED 2026-06-11**
   (`issues/fixed/yo-self-macro-dispatch-corruption.md` +
   `issues/fixed/codegen-shadowed-binding-early-return-double-drop.md`).
   Two general early-return over-release bugs in the TS RC layer
   (name-vs-identity pending-drop matching; consume-at-end-of-scope vs
   transfer site), both fixed with regression tests
   (`tests/shadowed_binding_early_return_drop.test.yo`). Dispatch-ON
   sweeps are clean (std ×5, yo-self 240/240, gmalloc-clean). Phase 0's
   first deliverable is hereby done; the lldb+gmalloc+malloc_history
   workflow in the dossier is the template for any future corruption.
2. `MACRO_DISPATCH_ENABLED` in `yo-self/evaluator/calls/function.yo` —
   now safe to enable (see 1); the three phase6 macro tests un-gate
   themselves via the exported flag.
3. yo-self consume-tracking is unwired (`set_expr_as_consumed` in
   `evaluator/utils.yo` has no callers) — the move half of the
   borrow-invalidation gate is dormant; wiring it is part of the Phase 4
   ownership work (TS callers to mirror: iso.ts, calls/helper.ts dup
   insertion).
4. `tests/circular_deps/circular_error_{a,b}.yo` fail identically under
   both compilers — baseline, don't chase.

## Phases

### Phase 0 — Baseline + differential harness + the UAF

1. **Fix the ExprInfo-table use-after-free** (landmine 1). Do not start
   emitter work on a foundation that corrupts intermittently.
2. Rebuild `yo-self-bin`; `compile` currently THROWS by design — baseline
   scorecard is all-COMPILE-FAIL.
3. Build the **differential harness** (suggested: `scripts/diff-test.sh` or
   a `yo-cli` subcommand): input = a `.yo` file or directory; compile with
   BOTH compilers; run both binaries; diff stdout + exit code; report
   PASS / FAIL / COMPILE-FAIL(stage) per file; `--parallel N`; summary
   counts. This is the `check`-equivalent for the whole codegen phase —
   it runs after every batch.
4. Close stale codegen issues whose subject (the untyped walker) is gone.

**Gate:** UAF fixed (gmalloc-clean sweeps); harness exists; baseline
scorecard committed.

### Phase 1 — The typed pipeline (port order, top to bottom)

| Order | File | Why |
|---|---|---|
| 1 | `constants.ts` | leaf, everything imports it |
| 2 | `utils/index.ts` + `utils/fixup.ts` | helpers all emitters use (incl. the 4 exports the old port lacked: `findReturnedAsyncBlock`, `getRuntimeStructFields`, `isComptimeOnlyStructField`, `isComptimeFunction`) |
| 3 | `functions/context.ts` | the generation-context record |
| 4 | `c/collection.ts` | include collection (note the platform filter added in commit 5945937e — port it faithfully) |
| 5 | `types/collection.ts` | reachable-type collection |
| 6 | `functions/collection.ts` | reachable-function collection |
| 7 | `codegen-c.ts` | the orchestrator: collection → type decls → dyn fixup → fn decls → fn bodies → module-level vars → main wrapper/library init → specialized fns → dispose dispatch |
| 8 | `index.ts` | CLI driver glue (target resolution, allocator, C-compiler invocation) — wire `run_compile` in `yo-self/main.yo` to it |

Evaluator side, in parallel: run module evaluation in the mode codegen
needs (executing-mode body evaluation for reachable runtime functions),
populating the ExprInfo fields the emitters read. Start with the core set
(type/value/control_flow/variable_name); add fields as emitters demand them.

**Gate:** tiny corpus (≥10 programs: print/arith/struct/enum/match/while/
closure-call/string/ArrayList/HashMap) passes the differential harness.

### Phase 2 — Expression-emitter sweep (the long middle)

Port order (dependency- and frequency-driven):

1. `exprs/expr.ts` (dispatch) + `exprs/generation.ts` + `exprs/atom.ts` +
   `exprs/begin.ts` — the skeleton every program hits.
2. `exprs/other-fn-call.ts` (3.5k — calls, method dispatch, trait calls,
   specialization invocation; the single largest emitter; split the work
   by its internal sections).
3. `exprs/initialization-assignment.ts`, `exprs/assignment.ts`,
   `exprs/binding.ts`, `exprs/property-access.ts` (consume
   `pathCollection` + deferred dup/drop — coordinate with Phase 4).
4. `exprs/cond.ts`, `exprs/match.ts` (caseExecuted, primitive-match, GADT
   refinement becomes testable here), `exprs/while.ts`, `exprs/return.ts`,
   `exprs/and-or.ts`, `exprs/recur.ts`.
5. The rest by harness-failure frequency: `comptime-value`, `inline-fns`,
   `ptr-fns`, `array-fns`, `tuple-fn`, `asm`, `panic`, `open`, `typeid`,
   `consume`, `downcast`, `iso`.

Validate by walking `tests/*.test.yo` through the harness, non-async
subset first; `./yo-cli test` stays the reference for expected behavior.

**Gate:** ≥50% of non-async `tests/*.test.yo` pass differentially.

### Phase 3 — Functions, types, dyn, specialization

1. `types/generation.ts` (1.5k — type lowering incl. iso/dyn/SomeT
   monomorphized forms + runtime preamble templates: GC marks, atomics,
   thread-sync macros, `__yo_ref_header_t` — mostly mechanical template
   transcription).
2. `functions/declarations.ts`, `functions/generation.ts` (2.7k — bodies,
   wrappers, main wrapper incl. the `__yo_main_stack` worker-thread setup,
   library init).
3. `functions/dyn.ts` + `types/dyn.ts` + `exprs/dyn.ts` — box types,
   vtables, wrapper fns, dup/drop (`fixupDynImplKeys`,
   `generateDynBoxTypes/Functions/Vtables/DupDrop`).
4. Generic specialization emission — pairs with the evaluator's existing
   machinery (calls/helper.yo).
5. `exprs/closures.ts` — capture structs
   (`create_capture_type_and_value` already exists in
   `evaluator/utils/closure.yo`; wire it to emission).

**Gate:** ≥80% of non-async tests pass differentially; dyn + generics +
closure test files green.

### Phase 4 — Memory management correctness

`exprs/drop-dup.ts`, `exprs/rc-fns.ts`, RC dup/drop placement
(`pathCollection`-driven), drop-on-scope-exit + drop-on-unwind, cycle GC
(`canTypeFormRcCycle` → tracked headers + collector),
`__yo_dispose_dispatch`. Wire yo-self consume-tracking (landmine 3).
Validate every differential run additionally under guard pages
(libgmalloc; both compilers' outputs must be clean) and under ASan once
available. Explicit regression corpus: `tests/continue_rc_cleanup.test.yo`,
`tests/ref_borrow_invalidation.test.yo`, deep-recursion stack sizing.

v4 borrow-soundness machinery the port must carry
(`plans/BORROW_EXCLUSIVITY.md`; landed in TS 2026-06-12):

- **Ref-binding codegen** (`exprs/initialization-assignment.ts`): a
  `ref(r) := obj.field` binding emits `(&(lvalue))`; a bare-local
  source emits `(&(x))` (a ref source copies the pointer instead); and
  an RC-object base ALSO emits the **owner pin** — a hidden owning
  handle (`__yo_pin_<r>`) + dup at the binding line, whose drop rides
  the normal scope-end lists via the `refOwnerPin` ExprInfo field the
  evaluator sets (the hidden owning variable is already registered in
  the env by the evaluator, so drop synthesis is automatic).
- **Call-site ref/own exclusivity** (`requireRefOwnArgumentExclusivity`
  in `evaluator/types/flowability.ts`, called from
  `tryToCallFunctionWithArguments`): its yo-self mirror is BLOCKED on
  landmine 3 (own/consume tracking) — wire it together with
  consume-tracking in this phase.
- Note `-> ref(T)` is banned (both evaluators already enforce it), so
  the TS codegen's ref-RETURN plumbing is dead code — do NOT port it.

**Gate:** full non-async `tests/` differential pass, guard-page-clean.

### Phase 5 — Async/effects state machines + I/O runtimes

The largest single block (~13k LOC in scope):

1. `shared/suspension-codegen.ts`, `exprs/await.ts`, `exprs/async.ts`,
   `exprs/async-completion.ts`.
2. `async/state-machine.ts` (2.6k) + `async/state-code-gen.ts` (2.1k) —
   the FSM transformation (the evaluator's await/suspension analyses are
   ported as types; the passes must now run and land in ExprInfo).
3. Effect-handler state machines (`return` resumes, `unwind` discards;
   Aborted future state).
4. Platform I/O runtimes — C template transcription: `async/runtime.ts` +
   `runtime-core` + `runtime-io-common` + **macOS and Linux only**
   (Windows 4.2k and WASM 0.8k are the documented follow-up).
5. `parallelism/runtime.ts` + `exprs/parallelism.ts` last.

**Gate:** async_await, algebraic_effects, sync/, parallelism test files
pass differentially on macOS + Linux.

### Phase 6 — Self-host fixpoint

1. `yo-self-bin test ./tests` — the self-hosted compiler RUNS the suite
   with results matching `./yo-cli test`.
2. Stage 2: `yo-self-bin compile yo-self/main.yo` → stage-2 binary passes
   (1). Expect a wave of executing-mode evaluator findings — yo-self's own
   source is the harshest corpus.
3. Stage 3 + the fixpoint comparison (see Definition of Done).
4. Re-validate `yo-self/tests/` under `yo-self-bin test` (it is already
   green under the TS compiler).

**Gate:** fixpoint reached = self-hosting done. Tick every box in the
Definition of Done; update `BOOTSTRAPPING.md`.

## Risks & mitigations

- **The ExprInfo-table UAF** (landmine 1) — fix in Phase 0, before
  anything else amplifies allocation churn.
- **Executing-mode evaluator tail**: every phase budgets evaluator fixes;
  the drain methodology from the def-eval era is proven (location-tagged
  diagnostics → pin → root-cause → fix → re-measure; sequential prints
  beat lingering breadcrumbs).
- **C-text instability** (random_id in emitted names): differential
  testing compares BEHAVIOR; the fixpoint comparison may need seeded ids.
- **Compile-loop speed**: yo-self-bin -O0 builds are ~10 min; batch
  validation, prefer the harness's directory mode, keep `--release` out of
  the loop.
- **Platform surface**: POSIX first; Windows/WASM runtimes are isolated
  follow-ups. Note the c_include platform filter (commit 5945937e):
  includes registered from comptime-eliminated platform branches must not
  leak into the other platform's emission — port that behavior.

## Status

- [x] "Phase 7" of the original plan (revive `yo-self/tests/`) — **DONE
      EARLY** (2026-06-11, commit ca1f776a): suite revived and green under
      the TS compiler; see `yo-self/README.md`. Re-check under
      `yo-self-bin test` in Phase 6.
- [ ] Phase 0 — UAF fix + baseline + differential harness
- [ ] Phase 1 — typed pipeline
- [ ] Phase 2 — expression-emitter sweep
- [ ] Phase 3 — functions/types/dyn/specialization
- [ ] Phase 4 — memory management, guard-page/ASan-clean
- [ ] Phase 5 — async/effects/parallelism runtimes (POSIX)
- [ ] Phase 6 — self-host fixpoint → Definition of Done

## References

- `BOOTSTRAPPING.md` — umbrella status; update its codegen rows as phases
  land.
- `BOOTSTRAPPING_EVALUATOR.md` + `EVALUATOR_PORT_REVIEW.md` — the evaluator
  slice (complete) + the divergence inventory executing-mode work will
  exercise.
- `issues/fixed/yo-self-macro-dispatch-corruption.md` — the UAF dossier
  (RESOLVED; reproducers, crash stacks, and the lldb+gmalloc+malloc_history
  workflow — the methodology template for memory corruption).
- `issues/fixed/codegen-shadowed-binding-early-return-double-drop.md` — the
  two root-cause fixes behind that UAF.
- `issues/fixed/codegen-continue-in-while-heap-corruption.md` — how the
  continue-corruption was re-tested and closed; the methodology template.
- `.github/instructions/c-codegen.instructions.md`,
  `debugging.instructions.md`, `testing.instructions.md`,
  `.github/skills/yo-syntax/syntax-cheatsheet.md`,
  `.github/skills/yo-core-patterns/core-patterns-cheatsheet.md`.
