# Bootstrapping the codegen — TS `src/codegen/` → yo-self `yo-self/codegen/`

The detailed plan for the codegen slice of self-hosting, the successor to
`BOOTSTRAPPING_EVALUATOR.md` (whose `check` surface went fully green
2026-06-10). Keep `BOOTSTRAPPING.md` as the umbrella record; update both
when status changes.

> **2026-06-11 — clean-slate update.** The untyped bootstrap codegen
> (`yo-self/codegen/` — driver.yo, exprs.yo, 49 files / ~30.6k LOC) was
> **DELETED** during the slice rework (user decision): it was built on the
> wrong foundation (AST pattern-matching without the evaluator) and would
> have been dragged through every language change. `run_compile`/`run_test`
> in `yo-self/main.yo` now throw a pointer to this plan. The port therefore
> starts from a CLEAN SLATE — which is the better starting point for the
> strict 1-to-1 rule: every `yo-self/codegen/X.yo` will be born as a
> faithful port of `src/codegen/X.ts`, never retrofitted.
> Also relevant: the slice rework (plans/SLICE_REWORK.md, complete)
> DELETED the builtin Slice(T) end-to-end, REDUCING the TS codegen surface
> to port (no slice struct registry, no range compound-literal emitters,
> no `__yo_slice_*` builtins; `str` is a builtin with one canonical
> `__yo_str` lowering). Current validation gates: std 152/152 ·
> tests 146-147/149 (2 unresolvable circular fixtures) · yo-self 245/245.

## Goal & end state

**The codegen port is a FAITHFUL port, same as the evaluator's:** strict
1-to-1 file mapping `src/codegen/X.ts` ↔ `yo-self/codegen/X.yo`, same
functions and control flow, TS-first for any bug found, divergences only where
the language forces them (documented in header comments). (The untyped
bootstrap walker `driver.yo` was already deleted on 2026-06-11 — the port
starts clean; nothing pre-existing violates the 1-to-1 rule.)

`yo-self-bin compile <file.yo>` produces a C11 program whose **runtime
behavior matches the TS compiler's output** on the same source, culminating in
the self-host fixpoint:

1. `yo-self-bin` (stage 1, built by TS) compiles `yo-self/main.yo` → stage 2.
2. Stage 2 compiles `yo-self/main.yo` → stage 3.
3. Stage 2 and stage 3 emit identical C (or at minimum behaviorally identical
   binaries that each pass the full test suite).

Equivalence is judged by **run behavior** (stdout + exit code + test results),
NOT by C-text equality against TS output — the two compilers may legitimately
emit different C for the same semantics.

## Where we start (inventory, 2026-06-10)

**TS codegen: 70 files, ~43k LOC.**

| Area | Files | LOC | Notes |
|---|---|---|---|
| `exprs/` | 50 | 18,268 | per-node emitters; largest: `other-fn-call.ts` 3,459 |
| `async/` | 8 | 15,409 | state machine (4.7k) + platform I/O C templates (~10.6k) |
| `functions/` | 5 | 2,869 | collection, declarations, generation (2,721), dyn |
| `types/` | 3 | 2,223 | type decls + RC headers + runtime preamble templates |
| root | 3 | 1,189 | `index.ts` driver (778), `codegen-c.ts` orchestrator (311) |
| `utils/` `shared/` `parallelism/` `c/` | 5 | 1,978 | helpers, fixup, suspension, worker runtime, includes |

**yo-self codegen today: DELETED (2026-06-11).** The previous 49-file
untyped bootstrap walker is gone (see the clean-slate note above). There is
no `yo-self/codegen/` directory; the port creates it file-by-file as
faithful 1-to-1 ports. The proto-evaluator `yo-self/evaluator/eval.yo`
remains only as the delegation target of `evaluator/index.yo` and retires
when the typed pipeline drives the proper evaluator end-to-end.

**The coupling that defines the work.** TS codegen is driven almost entirely
by evaluator annotations on `expr.$` (yo-self: the `ExprInfo` table):
`type`, `value`, `variableName`, `env`, `controlFlow`, `pathCollection`,
`runtimeArgExprsInOrder`, `runtimeDestructurings`, `dynCallTraitValues`,
`deferredDupExpressions`/`deferredDropExpressions`, `macroExpansion`,
`awaitAnalysis`, capture structs. yo-self's `ExprInfo` already carries the
core (type/value/env/control_flow/path_collection/variable_name/origin_type);
the runtime-oriented fields (deferred dup/drop, runtime destructurings, await
analysis, dyn vtable bindings, capture types) are produced partially or not at
all — **most of the porting effort is making the evaluator produce them and
the emitters consume them**, not the C string-building itself.

**Critical consequence for the evaluator:** codegen requires evaluating
function bodies in **executing mode** (`is_executing = true`) with REAL,
propagating errors — the def-eval-wall *swallow* that protects `check` cannot
apply. This will surface the remaining evaluator tail
(`EVALUATOR_PORT_REVIEW.md` status summary: GADT match-refinement, HKT partial
application, ModuleT/Call dispatch, effect-analysis re-sync, …). That is a
feature of the plan, not a risk to dodge: each phase below names the evaluator
work it is expected to unlock.

## Method (carried over from the evaluator port — it worked)

- **Strict 1-to-1**: `src/codegen/X.ts` ↔ `yo-self/codegen/X.yo`, same
  functions, same order; language-forced divergences get header comments.
  Bootstrap-only files (driver.yo) get deleted as their replacements land.
- **TS-first for bugs**: if TS codegen has a bug, fix TS, then port.
- **Iteration loop**: `./yo-cli compile yo-self/main.yo -o /tmp/yo-self-bin`
  (no `--release` — too slow for the loop; use `YO_MAIN_STACK_MB=4096` for
  deep-recursion validation runs).
- **Never regress the evaluator**: `check ./std` (152), `check ./tests`
  (146-147/149 baseline), `check ./yo-self` (245) stay green after every
  step.
- **Differential testing is the gold standard**: same `.yo` source → TS-built
  binary and yo-self-built binary → same stdout/exit code. Build the harness
  in Phase 0 and run it constantly.
- Findings → `issues/`; surprises about Yo itself → skills/instructions files.

## Phases

### Phase 0 — Baseline + differential harness

1. Rebuild `yo-self-bin`; `yo-self-bin compile` currently THROWS by design
   (the codegen was deleted) — the baseline scorecard is all-COMPILE-FAIL,
   and the differential harness measures progress from zero.
2. Build the **differential harness**: a script that takes a `.yo` file (or a
   directory), compiles it with BOTH compilers, runs both binaries, diffs
   stdout/exit code, and reports PASS/FAIL/COMPILE-FAIL per file. This is the
   `check`-equivalent for the whole codegen phase.
3. Close the stale codegen issues
   (`issues/yo-self-codegen-typeid-needs-typed-ast.md`,
   `issues/yo-self-codegen-parallelism-needs-closure-metadata.md`) — their
   subject (the untyped walker) was deleted; keep the segfault issue only if
   it reproduces against the rebuilt pipeline.

**Gate:** harness exists; baseline scorecard committed.

### Phase 1 — The typed pipeline (from the clean slate)

Port the orchestration spine faithfully, driven by the evaluator's `ExprInfo`:

- `codegen-c.ts` → `codegen_c.yo` (full `compileModule`: collection → type
  decls → dyn fixup → fn decls → fn bodies → module-level vars → main
  wrapper/library init → specialized fns → dispose dispatch).
- `functions/collection.ts`, `types/collection.ts`, `c/collection.ts` — the
  reachability passes (currently stubbed).
- `functions/context.ts` (generation context), `utils/{index,fixup}.ts`
  completion (4 missing exports: `findReturnedAsyncBlock`,
  `getRuntimeStructFields`, `isComptimeOnlyStructField`, `isComptimeFunction`).
- Evaluator side: run module evaluation in the mode codegen needs
  (executing-mode body evaluation for reachable runtime functions), populating
  the `ExprInfo` fields the emitters read. Start with the core set
  (type/value/control_flow/variable_name); add fields as emitters demand them.

**Expected evaluator unlocks:** executing-mode body eval will surface
unification/dispatch gaps the swallow hid — budget for evaluator fixes here
(same drain methodology as the def-eval era: location-tagged diagnostics, pin,
root-cause, fix, measure).

**Gate:** tiny corpus (≥10 programs: print/arith/struct/enum/match/while/
closure-call/string/ArrayList/HashMap) passes the differential harness.

### Phase 2 — Expression-emitter sweep (the long middle)

Port the `exprs/*.ts` emitters 1-to-1 (all fresh — nothing pre-exists).
Priority order = differential-harness failure frequency, but the known big
rocks first:

- `exprs/other-fn-call.ts` (3,459 LOC — calls, method dispatch, trait calls,
  specialization invocation; the single largest emitter).
- `exprs/generation.ts`, `exprs/expr.ts` dispatch parity.
- RC-bearing emitters: `drop-dup`, `assignment`, `initialization-assignment`,
  `binding`, `property-access` (consume `pathCollection` +
  `deferredDup/DropExpressions` — these need the evaluator to produce them;
  see Phase 4 for the deep end).
- `match`/`cond` (caseExecuted, primitive-match, GADT refinement lands here —
  the deferred evaluator item becomes testable).

Validate by walking `tests/*.test.yo` through the differential harness,
non-async subset first; `./yo-cli test` (TS runner) stays the reference for
expected behavior.

**Gate:** ≥50% of non-async `tests/*.test.yo` pass differentially.

### Phase 3 — Functions, types, dyn, specialization

- `functions/generation.ts` (2,721) — bodies, wrappers, main wrapper, library
  init; `functions/declarations.ts`, `functions/dyn.ts`.
- `types/generation.ts` (1,515) — full type lowering incl. iso/dyn/SomeT
  monomorphized forms + the runtime preamble templates (GC marks, atomics,
  thread-sync macros, `__yo_ref_header_t`) — mostly mechanical template
  transcription.
- Dyn: box types, vtables, wrapper functions, dup/drop (`fixupDynImplKeys`,
  `generateDynBoxTypes/Functions/Vtables/DupDrop`).
- Generic specialization emission (specialized decls + bodies) — pairs with
  the evaluator's existing specialization machinery (helper.yo).
- Closure capture structs (`create_capture_type_and_value` is already in
  `evaluator/utils/closure.yo`; wire it through to emission — dissolves the
  parallelism-closure-metadata issue).

**Gate:** ≥80% of non-async tests pass differentially; dyn + generics +
closure test files green.

### Phase 4 — Memory management correctness

RC dup/drop placement (`pathCollection`-driven), drop-on-scope-exit +
drop-on-unwind, cycle GC (`canTypeFormRcCycle` → tracked headers + collector),
`__yo_dispose_dispatch`. Validate every differential run additionally under
`--sanitize address --allocator libc` (both compilers' outputs must be
ASan-clean). Known landmines from the TS era to test explicitly:
continue-in-while RC corruption (`issues/codegen-continue-in-while-heap-corruption.md`),
deep-recursion stack sizing (`YO_MAIN_STACK_MB`, AGENTS.md pitfall note).

**Gate:** full non-async `tests/` differential pass, ASan-clean.

### Phase 5 — Async/effects state machines + I/O runtimes

The largest single block (~15.4k LOC TS):

1. `async/state-machine.ts` (2,605) + `state-code-gen.ts` (2,136) +
   `shared/suspension` codegen — the FSM transformation (the evaluator's
   await/suspension analyses are already ported as types; the analysis
   passes must now actually run and land in ExprInfo).
2. Effect-handler state machines (resume/unwind lowering — `return` resumes,
   `unwind` discards; Aborted future state).
3. Platform I/O runtimes — C template transcription: `runtime-core` (382) +
   `runtime-io-common` (1,717) + **macOS (1,779) and Linux (1,696) first**;
   Windows (4,228) and WASM (797) deferred to a follow-up — the dev loop and
   CI are POSIX.
4. `parallelism/runtime.ts` (474) + parallelism emitters last.

**Gate:** async_await, algebraic_effects, sync/, parallelism test files pass
differentially on macOS + Linux.

### Phase 6 — Self-host fixpoint

1. `yo-self-bin test ./tests` — the self-hosted compiler RUNS the suite
   (compiling and executing each test) with results matching `./yo-cli test`.
2. Stage 2: `yo-self-bin compile yo-self/main.yo` → stage-2 binary passes
   (1). Expect a wave of executing-mode evaluator findings here — yo-self's
   own source is the harshest corpus.
3. Stage 3: stage-2 compiles yo-self again; stage-2 ≡ stage-3 (C-output diff,
   modulo embedded nondeterminism — if random_id makes C text unstable, diff
   behavior + suite results instead, and consider seeding ids for the
   comparison build).

**Gate:** fixpoint reached = self-hosting done.

### Phase 7 — Revive `yo-self/tests/` (required follow-up)

`yo-self/tests/` (the 69 lexer/parser/component tests) is **very out of
date** — pre-broken against current APIs (memory `yo-self-tests-broken`:
they've been invalid as a validation target for months; e.g. the
`TypeValue.Func` constructions still pass 9 args against the now-16-field
variant). After the codegen port:

1. Sweep every `yo-self/tests/*.test.yo` against the CURRENT yo-self APIs
   (Func variant arity, renamed helpers, `unwind` not `escape`, ExprInfo
   table, etc.) — mechanical-fix catalogue in memory
   `yo-test-migration-patterns` applies.
2. Make `./yo-cli test ./yo-self/tests/ --parallel 1` fully green under the
   TS compiler, then under `yo-self-bin test` (differential).
3. Wire them into the standard validation loop (AGENTS.md already documents
   the commands) so component-level regressions are caught without full-corpus
   sweeps.

**Gate:** `./yo-cli test ./yo-self/tests/` and `yo-self-bin test
./yo-self/tests/` both green; counts recorded in `BOOTSTRAPPING.md`.

## Risks & mitigations

- **Executing-mode evaluator tail** (the big one): every phase budgets
  evaluator fixes; the drain methodology from the def-eval era is proven.
  Track surfaced gaps in `EVALUATOR_PORT_REVIEW.md`'s status summary.
- **C-text instability** (random_id in emitted names): differential testing
  compares BEHAVIOR, not text; the fixpoint comparison may need seeded ids.
- **Untyped-walker leftovers**: eliminated — the walker was deleted; every
  emitter is written fresh against ExprInfo.
- **Compile-loop speed**: yo-self-bin -O0 builds are minutes; batch
  validation, prefer the differential harness's directory mode, keep
  `--release` out of the loop.
- **Platform surface**: POSIX first; Windows I/O runtime (4.2k) is an isolated
  follow-up with its own issue.

## Status

- [ ] Phase 0 — baseline + differential harness
- [ ] Phase 1 — typed pipeline, driver.yo retired
- [ ] Phase 2 — expression-emitter sweep
- [ ] Phase 3 — functions/types/dyn/specialization
- [ ] Phase 4 — memory management, ASan-clean
- [ ] Phase 5 — async/effects/parallelism runtimes (POSIX)
- [ ] Phase 6 — self-host fixpoint
- [ ] Phase 7 — `yo-self/tests/` revived and green under both compilers

## References

- `BOOTSTRAPPING.md` — umbrella status incl. the component table this plan
  details; update its codegen rows as phases land.
- `BOOTSTRAPPING_EVALUATOR.md` + `EVALUATOR_PORT_REVIEW.md` — the evaluator
  slice (complete) + the remaining divergence inventory this work will
  exercise.
- `.github/instructions/c-codegen.instructions.md`,
  `debugging.instructions.md`, `testing.instructions.md`.
- Memory: `bootstrap-strict-1to1`, `no-release-during-porting`,
  `yo-self-tests-broken`, `yo-test-migration-patterns`,
  `yo-codegen-continue-while-corruption`.
