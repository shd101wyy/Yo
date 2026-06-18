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
| Differential harness | `scripts/diff-test.sh tests --parallel N` (env `YO_SELF_BIN`, default `/tmp/yo-self-bin`) | no `DIFF`/`TS-FAIL` verdicts; `SELF-FAIL` count shrinks to 0 as the port lands (baseline 2026-06-13: all `SELF-FAIL`, `compile`/`test` throw by design) |

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

### Phase 0 — Baseline + differential harness + the UAF — ✅ DONE (2026-06-13)

1. ✅ **ExprInfo-table use-after-free fixed** (landmine 1; resolved
   2026-06-11, see references). Emitter work now rests on a clean RC layer.
2. ✅ `yo-self-bin` rebuilds clean; `compile`/`test` THROW by design — the
   baseline scorecard is all-`SELF-FAIL`.
3. ✅ **Differential harness** built: `scripts/diff-test.sh` — input = a
   `.yo` file or directory; compiles/runs with BOTH compilers and compares
   BEHAVIOR (stdout + exit code for runnable programs; test-runner
   pass/total summary + exit code for `*.test.yo`). Per-file verdicts
   `PASS` / `DIFF` / `SELF-FAIL` / `TS-FAIL` / `BOTH-FAIL`; `--parallel N`,
   `--filter`, `--cc`, `--release`, `-v`; summary counts; exits non-zero on
   `DIFF`/`TS-FAIL` (the verdicts the port must drive to zero). This is the
   `check`-equivalent for the whole codegen phase — run it after every batch.
   Baseline scorecard: `plans/codegen-baseline-scorecard.md`.
4. ✅ Stale-issue sweep: no open issue referenced the deleted untyped
   walker (`driver.yo`/`exprs.yo`); the surviving codegen issue
   (`codegen-dead-code-after-exn-throw.md`) is an evaluator comptime-fold
   defect that the executing-mode port will exercise — kept.

**Gate:** ✅ UAF fixed (gmalloc-clean sweeps); harness exists; baseline
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

**Progress log (per-emitter port; all check-clean, corpus path with Phase-4/5
branches documented-as-deferred in each file's header):**

- ✅ Phase 1 scaffolding: `constants`, `utils/index`, `functions/context`,
  `c/collection`, `types/collection`, `functions/collection`,
  `functions/declarations`, `types/generation`, `exprs/_expr` (dispatch
  indirection), `emitter` helpers.
- ✅ Small builtins: `sizeof`, `consume`, `gc`, `open`, `panic`, `typeid`,
  `binding`, `comptime_value`, `rc_fns` (incr/decr/own), `closures`
  (capture predicate), `atom`.
- ✅ Control flow + value constructors (2026-06-13): `while_loop`, `recur`,
  `tuple_fn`, `array_fns` (+ `__yo_array_fill`), `and_or` (short-circuit
  if-chains), `begin` (expr + statement forms), `assignment`/initialization,
  `cond` (if/else chain, begin-arm inlining, `&(...)` ref-return wrap).
- ⏭ Next: `property-access`, `return`, `match`, `generation` (expr dispatch
  body), `other-fn-call` (3.5k — the dispatcher), then Phase-4 drop/dup wiring.

Note: codegen `check` does NOT evaluate fn bodies, so per-file check-clean
proves signatures/types only — move/borrow correctness inside bodies is
validated when the differential harness exercises them (after the dispatcher
+ driver are wired). Each emitter follows the established conventions:
`random_id` for fresh C identifiers (no module-level mutable counters — the
Phase-6 fixpoint can't reassign those from inside a fn), ExprInfo via
`ctx.base.get_expr_info`, type threaded from `ei.ty` (Gap 8).

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

v4.1 borrow-soundness status the port must know
(`plans/BORROW_EXCLUSIVITY.md`; landed in TS 2026-06-12):

- **`ref` is parameter-only.** `-> ref(T)` returns AND `ref(r) := …`
  local bindings are banned at the evaluator (both compilers already
  enforce this), so the TS codegen's ref-RETURN plumbing and any
  ref-BINDING codegen are dead code — do NOT port them. There is no
  owner pin and there are no borrow-invalidation gates anymore.
- **Call-site ref/own exclusivity** (`requireRefOwnArgumentExclusivity`
  in `evaluator/types/flowability.ts`, called from
  `tryToCallFunctionWithArguments`): its yo-self mirror is BLOCKED on
  landmine 3 (own/consume tracking) — wire it together with
  consume-tracking in this phase.
- **Ref-argument place validation**
  (`requireValidRefArgumentPlaces` / `require_valid_ref_argument_places`)
  is already mirrored in both compilers (evaluator-only; nothing for
  codegen).
- **Runtime borrow flag — COMPLETE HERE.** The foundation landed (commit
  0ca4b7784): `uint16 borrow_count` in `__yo_ref_header_t` (free, in
  existing padding), init to 0 in the object constructor, and the
  `__yo_borrow_acquire/release/assert_unborrowed` runtime primitives.
  This phase finishes it — it's the right home because both halves need
  the RC machinery this phase owns:
  (a) assert `borrow_count == 0` at container growth-method entry
      (push/insert/reserve/resize on ArrayList/HashMap/String) — needs a
      std↔runtime call path for `__yo_borrow_assert_unborrowed(self,…)`
      (extern in the pragma'd std files, or a builtin);
  (b) `__yo_borrow_acquire`/`release` bracketing the interior-ref-arg
      call sites `requireValidRefArgumentPlaces` ALLOWS (element-only
      `xs(i)`/`box.*` ref-args). The evaluator should tag those calls
      with the container expr; codegen brackets the call, and the
      **release must ride the deferred-cleanup lists** (same as drops)
      so an effect-unwind through the borrowed call can't leave a stuck
      counter (→ spurious panics). This unwind-safe release is exactly
      the machinery this phase builds for drops, hence the sequencing.
  Then mirror (a)+(b) in yo-self. Closes
  `issues/ref-arg-heap-escape-to-global-residual.md` — flip its probe
  (`g.push(xs); bump(xs(i))`) from a documented UAF into a passing
  deterministic-panic test.

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

**Phase-5 ENTRY ANALYSIS (2026-06-17 — start here next session).** Mapped the
exact prerequisites; Phase 5 spans evaluator wiring → codegen FSM → C runtimes:

1. **Func type model gap.** yo-self's `Func` TypeValue carries NO `io_builtin`
   marker (TS keys on `functionType.ioBuiltin === "io_async"`, helper.ts:1314).
   Add an `io_builtin : Option(String)` (or equivalent) to the `Func` variant +
   stamp it where `io.async`/`io.await`/… are declared, OR detect `io.async`
   structurally. PREREQUISITE for everything below.
2. **Evaluator analyses — await analysis now WIRED (2026-06-17, commit
   e381d55b6); effect analysis still unrun.** `analyze_await_points`
   (`evaluator/async/await_analysis.yo`) now RUNS: (a) `function.yo` sets
   `ctx.is_inside_io_async_call=true` around the arg eval when the call is
   `io.async(...)` (detected structurally via `is_io_async_call` — no `io_builtin`
   marker needed; restored after); (b) `anonymous_function.yo` (~line 897, after
   the body eval) runs `analyze_await_points(anon_eb, get_info)` under that flag
   and records `await_analysis` on the body ExprInfo when `has_awaits`. Validated
   no regression (corpus 58/58, std 94/58, async baseline still evaluates). STILL
   TODO: wire the effect analysis. SCOPED 2026-06-17: this is BIGGER than the
   await wiring — it lives in `create_specialized_function_inline` (helper.yo:908
   note), is the TS function's largest section (~600 lines, helper.ts:2490-2830),
   and FIRST needs `effectCtlParams` infrastructure that yo-self does NOT have yet
   (ctl-parameter detection + effect-field-path resolution + handler-fn lookup +
   per-ctl-param analysis merge). `analyze_effect_call_points` is ported+exported
   (`effect_analysis.yo:777`) but uncalled. Build the ctl-param detection first,
   then call it per ctl param and set `specializedBody`'s `effect_analysis`
   (mirror helper.ts:2500/2732/2830). ExprInfo already has the consumer fields
   (`await_analysis`, `effect_analysis`, `async_state_machine_struct_name`,
   `async_stack_size`, `capture_struct`).
3. **Codegen FSM (the bulk, ~8k LOC). TWO LEAVES LANDED 2026-06-17 (both
   check-clean):** `exprs/async-completion.ts` →
   `yo-self/codegen/exprs/async_completion.yo` (8b0e56d8b — Future-completion
   emitters); `shared/suspension-codegen.ts` →
   `yo-self/codegen/shared/suspension_codegen.yo` (9bcecd483 — `SuspensionSegment`
   + body-splitting at suspension points; `should_skip_body` ported as a required
   `Impl(Fn(AstExpr) -> bool)`). REMAINING (the large interdependent core, ~7.7k
   LOC — these cannot be isolated leaves; port against the BASELINE fixture
   bottom-up): `exprs/await.ts` (835); `exprs/async.ts` (2085);
   `async/state-machine.ts` (2605) + `async/state-code-gen.ts` (2136). The corpus
   emitters currently `panic("Phase 5")` at every state-machine site (atom SM-var
   resolution, return-completion, etc.) — those panics get replaced as the FSM
   core lands and produces `async_state_machine_struct_name` on ExprInfo.
   **FOUNDATIONAL PREREQUISITE uncovered 2026-06-17:** the FSM core depends on
   `SomeType.resolvedConcreteType` + `.isExtern` (e.g. `isIoFutureType`,
   state-machine.ts:496 — distinguishes an extern `__yo_io_future_t` from a
   state-machine Future via the resolved concrete type). yo-self's `SomeT` has NO
   `resolved_concrete_type` mutable codegen field (documented gap — codegen lowers
   unresolved SomeT to `void*`). So before/with the FSM core port, either add
   `resolved_concrete_type` to yo-self's SomeT (broad model change) or thread the
   concrete Future type another way. This is the real gate on
   `await.yo`/`async.yo`/`state_machine.yo`, not mere transcription.
   **BLAST RADIUS quantified 2026-06-17:** adding a field to the `SomeT` variant
   would break ~77 POSITIONAL `.SomeT(_, …, _)` destructures (10-arg pattern) +
   construction sites (~100 sites total); only 7 already use the safe curly form.
   **RECOMMENDED APPROACH (supersedes the variant migration) — SIDE-TABLE:** mirror
   the established yo-self eval→codegen bridge pattern (`g_method_callee_values`,
   `g_extern_c_globals`): a `g_some_resolved_concrete : HashMap(String, TypeValue)`
   keyed by `SomeT.id` (SomeT's first field is a unique `id : String`). This avoids
   the ~100-site variant change ENTIRELY. Cost: mirror the ~15 TS sites that set
   `resolvedConcreteType` (across closure-type, helper, synthesizer,
   anonymous-function, impl-constraint, init/assignment, function, function-type —
   note many are spread-constructions `{...someType, resolvedConcreteType}` which
   KEEP the same `id`, so id-keying is sound) to instead `register_some_resolved_
   concrete(id, ty)`, and have `isIoFutureType` + the FSM emitters read via
   `lookup_some_resolved_concrete(id)`. Still a multi-file evaluator pass, but
   far lower risk than the variant migration. Do this as the dedicated first step
   of the FSM-core session.
   **STATUS UPDATE 2026-06-17 (post-runtime-layer session):**
   - ✅ `g_some_resolved_concrete` side-table LANDED (9c05a8dea) + synthesizer
     set-sites wired (ae997dc83, 514d3cbb9); `is_io_future_type` branch-2 (Concrete
     trait) ported and the `lookup_some_resolved_concrete` read is wired as the
     branch-1 marker. `SomeT.is_extern` remains the ONLY open model gap for branch
     1 — but do NOT port it blind: it is only verifiable once the FSM core CALLS
     `is_io_future_type` with a real io-future type, so resolve it WITH the first
     consumer, not before (a `g_some_is_extern` side-table keyed on the resolved
     concrete's id, registered wherever the extern Concrete SomeType is created).
   - ✅ Await-analysis layer FULLY ported (`evaluator/async/await_analysis.yo` has
     all 8 TS fns: `analyze_await_points`, `is_io_{async,await,state,spawn}_call`,
     `is_join_handle_await_call`, `get_local_variables_from_body`,
     `collect_variable_bindings_`). This is the evaluator-side input to the FSM.
   - **FSM-core coupling confirmed (why it cannot be isolated leaves):** the next
     state-machine.ts unit, `computeCrossBoundaryVariables` (171), already pulls in
     `collectVariableRefsInExpr` (needs ExprInfo `deferredDropExpressions` /
     `deferredDupExpressions` runtime fields + `getVariablesFromEnv`),
     `splitIntoStateSegments` (the state-segment variant of the already-ported
     `split_body_at_suspension_points`), `typeContainsRcType`, and `getTypeString`.
     `computeOverlappingSlots` (339) adds greedy live-range coloring over those
     segments. So the FSM core (`state-machine.ts` body + `state-code-gen.ts` +
     `await.ts` + `async.ts`, ~7.6k LOC) must be ported as a co-existing mass
     validated against the BASELINE `42` fixture — there is no single-leaf
     `check`-validatable increment past the data-model/analysis leaves already
     landed.
   **ANALYSIS LAYER COMPLETE 2026-06-17 (all check-validatable; corpus 58/58
   each):** state-machine.ts's NON-emitting functions are fully ported into
   `state_machine.yo` — `is_io_future_type`, `StateMachineInfo`,
   `generate_resume_function_declaration`, `get_state_machine_field_name`,
   `get_future_field_name`, `collect_variable_refs_in_expr`,
   `compute_cross_boundary_variables` (+`CrossBoundaryResult`),
   `compute_overlapping_slots` (+`OverlappingSlot`/`OverlappingStorageResult`,
   greedy graph coloring). state-code-gen.ts's segment model + pure predicates are
   in `state_code_gen.yo` (NEW, faithful 1-to-1) — `StateSegment`,
   `split_into_state_segments`, `contains_await_expr`, `branch_has_await`,
   `expr_contains_return_statement`, `is_or_pattern_expr`,
   `flatten_or_pattern_expr`. Adaptations: codegen threads `context` for ExprInfo
   access (env + deferred drop/dup live in the side-table, not on the expr); the
   `-1` cleanup segment sentinel → `usize.MAX` to keep segment sets unsigned;
   non-insertion-ordered HashMap → drive iteration off ordered lists for
   deterministic slot assignment; nested mutable collections use get-mutate-set-
   back. DEFERRED: `body_contains_while_with_await` (needs `expr_contains_await` →
   the Func `io_builtin` model gap).
   **EMITTER FOUNDATIONS LANDED 2026-06-17 (all check-clean, corpus 58/58):**
   `expr_contains_await` (expr_traversal.yo — via dot-access `is_io_await_call`,
   sidestepping the Func `io_builtin` gap) + `body_contains_while_with_await`;
   `_fsm.yo` (NEW — the emitter mutual-recursion indirection registry: function
   pointers + `register_fsm_emitters` + `_call_generate_{cond,match,while}_with_
   await`, mirroring `_expr.yo`); and the first two C-emitting emitters
   `generate_await_expression` + `generate_state_segment_code` (state_code_gen.yo,
   dispatching to the cluster through the registry). The emitter call graph is
   mapped: `state_segment → await → {cond,match,while}_with_await →
   {cond_branch,while_body,primitive_match} → back to {cond,match,while}`.
   **THE REMAINING MASS (deeply interconnected — port together + wire + validate
   against the `42` fixture):** (a) ✅ DONE — the ENTIRE state-code-gen.ts emitter
   layer is ported (`generate_{cond,match,while}_with_await`, the branch helpers
   `generate_cond_branch_with_await` / `generate_while_body_with_await` /
   `generate_primitive_match_with_await`, the segment + await entry emitters, ~15
   factored helpers, + `register_fsm_emitters_impl`); the `_fsm.yo` indirection
   registry + `state_machine_naming.yo` leaf broke the mutual-recursion/import
   cycles. (b) ✅ DONE — the FSM context-state model (new
   `FunctionGenerationContext` fields `async_while_loop_info` /
   `async_next_while_loop_index` / `async_cond_branch_info` /
   `async_body_return_expr` + the `WhileLoopInfo`/`OuterWhileLoop`/
   `CondBranchPostWhileExprs`/`CondBranch`/`ChainedCondBranches`/
   `AsyncCondBranchInfo` types). RESUME-GENERATOR LEAF HELPERS ALSO DONE
   (state_machine.yo): `expr_contains_return`, `uses_generic_future_interface`,
   `emit_future_effect_injection_line` (the Future-trait deps
   `extract_future_trait_from_type` / `type_implements_future` are already ported
   in trait_checking.yo, so the resume body is transcription not discovery).
   **ALL RESUME-GENERATOR HELPERS NOW DONE (state_machine.yo):**
   `generate_remaining_expr_future`, `resolve_effect_field_from_sm_scope`,
   `find_bundle_field_name`, `emit_effect_record_injection_for_sm`,
   `emit_effect_injection_for_sm` (effect-injection complete — iterates the
   `FutureTraitT` effect arrays vs TS's single `effect`), and
   `_build_combined_sm_variables` (the combinedVariables build repeated ~10× in
   the body). The `current_evidence_params` + `EvidenceParameter` context fields
   landed. So the ONLY remaining piece of state_machine.yo is the resume BODY
   `generateAsyncBlockResumeFunction` itself (~1.7k lines) — a MONOLITH that does
   NOT factor further: its `if (sm->future != NULL)` cond-guard brace spans from
   result-extraction across the cond-branch-continuation; the per-segment loop
   threads mutable local state + ~8 context save/restore blocks + nested
   chainedBranches data manipulation. **DONE 2026-06-18 — state-machine.ts is
   FULLY PORTED.** The resume body did factor (the "spanning" braces are EMITTED C
   strings, not yo-self syntax): it is split into individually check-validated
   sub-emitters in state_machine.yo — `_emit_prev_await_result_extraction`,
   `_emit_cond_branch_continuation` (+`_emit_cond_branch_remaining`,
   `_chain_additional_remaining`, `_append_exprs`), `_emit_while_continuation`
   (+`_emit_post_while_cond_branch`, `_emit_outer_while_continuation`),
   `_emit_await_suspension`, `_emit_last_segment_completion`,
   `_build_combined_sm_variables` — and the orchestrator
   `generate_async_block_resume_function`. The effect-injection emitters
   (`emit_effect_injection_for_sm` etc.) + `find_bundle_field_name` +
   `currentEvidenceParams`/`EvidenceParameter` context fields all landed too. So
   the ENTIRE FSM transformation core is ported; only (d) async.ts/await.ts +
   wiring remain. (Original note retained:) the effect-injection emitters used
   the `currentEvidenceParams`
   context field (the effect-ctl-param infrastructure, ~600 LOC) + `findBundleField
   Name` (from async.ts) + the Future-trait `.isFuture.effect` structure access.
   BUT for the BASELINE no-effect `42` fixture the awaited future's effect is null,
   so `emitEffectInjectionForSM` early-returns — the resume body's CORE (state
   switch, await-result extraction via the resolved-concrete side-table, segment
   emission) is portable WITHOUT the full effect-injection; port the effect path
   (struct-bundle + evidence params) as a follow-up once `currentEvidenceParams` +
   async.ts land. (d) `exprs/async.ts`
   (io.async block — emits the SM struct + cold-start) + `exprs/await.ts`. All of
   (a)/(c)/(d) call `generate_expr` (main dispatch) and emit C, so they validate
   only by running the fixture. DONE already (state_code_gen.yo, all check-clean +
   corpus 58/58): the segment + await entry emitters (`generate_state_segment_code`,
   `generate_await_expression`); the WHILE cluster (`generate_while_with_await` +
   `generate_while_body_with_await`); `generate_cond_branch_with_await`; the
   async-branch-completion helpers (`_should_emit_async_branch_completion` +
   `_emit_non_await_branch_async_completion`); AND the full FSM context-state model
   (`WhileLoopInfo`/`OuterWhileLoop`/`CondBranchPostWhileExprs`/`CondBranch`/
   `ChainedCondBranches`/`AsyncCondBranchInfo` + the `async_while_loop_info`/
   `async_next_while_loop_index`/`async_cond_branch_info`/`async_body_return_expr`
   context fields). ALSO DONE: the full COND cluster — `generate_cond_with_await`
   (~460, the largest single emitter) + `generate_cond_branch_with_await` + the
   factored helpers (`_comptime_bool_value`, `_cond_inner_has_remaining_code`,
   `_emit_branch_value_inline`, `_attach_cond_branch_post_while`,
   `_make_cond_branch`, `_store_cond_branch_info`). So the while + cond clusters
   are complete. STILL TODO in (a): the MATCH cluster —
   `generate_match_with_await` (~530) + `generate_primitive_match_with_await`
   (~140); the deepest emitter (depends on enum-codegen helpers
   `canOptimizeAsNullablePointer`, enum C-name lookup via `context.types`,
   `isPrimitiveMatch` ExprInfo flag — plus the already-ported
   `get_state_machine_field_name`/`get_type_string`/`sanitize_for_c_identifier`).
   MATCH-CLUSTER HELPER INVENTORY (all verified present 2026-06-17 — port is
   transcription, not discovery): `can_optimize_as_nullable_pointer` ✅
   (utils/index.yo), `is_enum_type` ✅ (guards.yo), ExprInfo `is_primitive_match`
   ✅ (expr_info.yo:340), enum C-name via `context.base.types.get(enum_id)` →
   `CodegenTypeEntry.c_name` ✅, `EnumT` has `id`/`variant_names`/`variant_fields`/
   `variant_field_labels` labels ✅, `String.to_uppercase` ✅, plus
   `get_enum_variant_c_name` ✅ (utils/index.yo — USE THIS for the case tag, as
   `match.yo` does, instead of the TS `enumCName.toUpperCase()_variant` string).
   CONVENTION: sanitize variant-field labels with `sanitize_for_c_identifier(label,
   false)` (drop the TS per-field `type.isExtern === "c"` flag — `match.yo` already
   passes `false`; that extern-c nuance is the SomeT/Func is_extern gap and is
   immaterial for the async fixtures). Then `register_fsm_emitters(cond, match,
   while)`. Wire into codegen_c
   (replace the `panic("Phase 5")` sites), resolving the Func `io_builtin` field +
   `g_some_is_extern` WITH their first consumers. This is the dedicated
   FSM-core-mass session.
   Prereq INVENTORY (checked 2026-06-17): ExprInfo
     `deferred_{drop,dup}_expressions` ✅ present (expr_info.yo:346/348);
     `type_contains_rc_type` ✅ present (types/utils.yo); `get_variables_from_env`
     ✅ present. MISSING: `split_into_state_segments` (the state-segment variant of
     the ported `split_body_at_suspension_points`) and the `g_some_is_extern`
     branch-1 resolution. So the analysis cluster (`collectVariableRefsInExpr`,
     `computeCrossBoundaryVariables`, `computeOverlappingSlots`, `getFutureFieldName`)
     IS portable as a `check`-validatable bottom-up increment once
     `split_into_state_segments` lands — only the C-emitting transformation
     (`generateAsyncBlockResumeFunction`, the 1.7k-line monster) needs the full mass.
4. **C runtime templates** (Phase 5 #4) — PARTIALLY PORTED 2026-06-17:
   - ✅ `runtime-core.ts` → `runtime_core.yo` (5675e1d95) — core scheduler.
   - ✅ `runtime-io-macos.ts` → `runtime_io_macos.yo` (5d40988bc) — sys helpers +
     kqueue async I/O.
   - ✅ `runtime-io-linux.ts` → `runtime_io_linux.yo` (fc1824c05) — sys helpers +
     io_uring async I/O.
   - ✅ `runtime-io-common.ts` → `runtime_io_common.yo` — the SHARED layer.
     `generateSysRuntime` (2fb9d33db) + `generateAsyncRuntimeIOCommon` (timer,
     dir scan, getdents, DNS, process, FS events, poll, tick) ported 2026-06-17.
     The intricate part was the embedded target interpolations; in the end there
     is only ONE dispose-init 3-way (`timer_dispose_init`, Linux-only:
     cycle-GC / type-id callback / none) plus 6 `${frag}` platform conditionals
     (inotify include, macOS fs-event struct/fields/handle-init, Linux/macOS
     tick bodies). Ported by computing each `${frag}` as a `cond(...)` String and
     interpolating via Yo `${}`; all verbatim C extracted by `sed`. Modeled
     `AsyncRuntimeOptions` as an object with `register_dispose_type_id :
     Option(Impl(Fn(String) -> i64))` (defined in `runtime_io_common.yo`, not
     `runtime.yo`, to avoid an import cycle).
   - ✅ `async/runtime.ts` (69 LOC) → `runtime.yo` — the DISPATCHER
     (`generate_async_runtime`): calls runtime_core + the target backend +
     runtime-io-common. Ported 2026-06-17. `check` OK. NOT yet wired into
     `codegen_c` (deferred to the FSM-core wiring step — these emitters are
     inert until the state machine calls them).
   - Deferred: `runtime-io-windows.ts`, `runtime-io-wasm.ts` (follow-up; their
     branches in `runtime.yo`/`generate_sys_runtime` panic for now).
   PORTING TECHNIQUE for verbatim-C files: extract the template-literal body with
   `sed -n 'A,Bp'` to a temp file and wrap it in `emitter.emit_string_line(\`…\`)`
   via heredoc concat — zero hand-transcription risk; only works when the block
   has no `${}` interpolations and no stray backticks (verify both first). For
   files WITH `${}` interpolations (runtime-io-common), an assembler script
   (`sed` for verbatim ranges + `fragq` to strip the `? \`…\`` prefix/suffix off
   conditional fragments + printf for Yo scaffolding) keeps it transcription-free
   too — derive every block boundary from a single `emitLine(\`` / `\`);` /
   `? \`` / closing-backtick grep, since nested (indented) `emitLine` blocks make
   "first content = open+1" the only reliable rule.
   **exprs/async.ts FULLY PORTED 2026-06-18** (`yo-self/codegen/exprs/async.yo`,
   all 11 functions, each check-clean + corpus 58/58, committed): the effect-field
   mapping cluster + `generateFutureEffectSetter`; `emitAsyncBlockStructDefinition`
   + `emitDeferredAsyncBlockStructDefinitions` (Kahn topo-sort);
   `generateAsyncBlockStateDisposeFunction`; `generateAsyncBlockConstructor`;
   `generateAsyncBlock` (io.async entry) + the capture-literal helper;
   `generateDeferredAsyncBlocks` (resume/set_effect/dispose/ctor per block);
   `preRegisterAsyncBlockTypes` + `preRegisterAsyncBlocksInExpr`;
   `generateIoAsyncSyncCall` (the no-await sync-future path the BASELINE uses).
   Model additions: `DeferredAsyncBlock`/`ClosureParamSlot` on
   `FunctionGenerationContext` (+`deferred_async_blocks` field); `TypeField` gained
   `is_effect_param` (faithful to TS, threaded from `FuncCapturedVarInfo` at capture
   creation, 7 construction sites updated). DIVERGENCES (documented in-file): the
   capture-field atom fallback (TS `generateAtom(elem.exprs.expr)`) emits a
   PHASE3_CAPTURE_PENDING marker pending the deferred closures.yo capture machinery;
   the closure C-name comes from the FuncVal func_id (yo-self has no
   implClosureCallMap). STILL TODO: `exprs/await.ts` (~835) + wire into codegen_c.
   **await.ts FULLY PORTED + WIRED 2026-06-18** (`yo-self/codegen/exprs/await.yo`):
   `generate_await` (sync blocking io.await: cold-start → poll → result, with the
   effectful-abort / unwind-propagation path), `generate_state`,
   `generate_join_handle_await`, and the effect-injection cluster
   (`emit_effect_injection_for_await`, `emit_io_spawn_effect_injection`,
   `emit_effect_record_injection`, `resolve_effect_field_from_scope`,
   `resolve_evidence_field_from_given_bindings`,
   `is_await_unwind_handler_installation`). Dispatch WIRED into
   `generate_func_call` (generation.yo): io.async → `generate_async_block` (await
   analysis present) else `generate_io_async_sync_call`; io.await/state/spawn/
   JoinHandle.await routed; `_generate_io_spawn` (the inline cold-start block) ported.
   codegen_c WIRED: `register_fsm_emitters_impl` + `preregister_async_block_types`
   (before fn decls) + `generate_deferred_async_blocks` (after dyn fns); and
   `generate_all_functions` now emits `generate_sys_runtime` unconditionally +
   `generate_async_runtime` when `uses_async`. SURFACED+FIXED: a stray `}` in the
   `__yo_dirent_type` sys-runtime template; the `Option(Impl(Fn))` field of
   `AsyncRuntimeOptions` (clashing cross-module Impl-Fn enum monomorphizations) →
   replaced with a precomputed `timer_dispose_type_id : Option(i64)` registered on
   Linux only. corpus 58/58 with the sys-runtime now active for EVERY program.
   **BASELINE STATUS 2026-06-18: the FSM transformation now RUNS end to end** — the
   `42` fixture emits real C (sync_fut typedef + io.await poll loop), not malformed
   stubs. **REMAINING GATE = closure codegen.** `io.async((io)=>{…})` routes to the
   no-await sync path (`generate_io_async_sync_call`), which needs the closure's
   registered C FUNCTION + its capture struct C name. yo-self does NOT yet emit
   Impl(Fn) closures: the closure function is never collected/registered (TS uses
   `implClosureCallMap` populated by a closure-discovery pass in `closures.ts`,
   absent here) and a no-capture closure has no capture struct — so the emitter hits
   `/* Error: no closure function or capture type for io.async sync path */`. The
   NEXT blocker is therefore the deferred `exprs/closures.ts` → `closures.yo` port
   (capture-struct machinery + closure-function collection/emission), not anything
   in async.ts/await.ts (both complete). See
   `issues/yo-self-closure-codegen-gate.md`.
   **✅ BASELINE GREEN 2026-06-18 (commit 100f1c3c4).** The closure-codegen gate is
   CLOSED — the canonical async fixture now compiles end-to-end via `yo-self-bin`
   AND runs → prints `42` (matches TS); added as the permanent corpus fixture
   `tests/codegen-bootstrap/io_async_await_42.yo` (corpus 59/59, differential-clean).
   Fix: mark every `=>` closure (capture-param `void* closure_context` convention) +
   build its capture struct + FORCE body def-eval for marked closures (was deferred
   as "generic" → "Failed to transpile") + re-register the closure Func type with
   the concrete body RESULT + don't skip marked closures + resolve the sync-future
   result type via the closure `value` FuncVal body
   (`issues/yo-self-closure-codegen-gate.md`, RESOLVED). REMAINING Phase 5: widen to
   the full async/effects/sync/parallelism test files (effect handlers, captured
   async blocks, io.spawn/JoinHandle, multi-await FSMs). A PRE-EXISTING
   `yo-self-bin check ./std` crash on `std/imm/map.yo` (rc=138, bisected to before
   this work) is tracked independently.
   **✅ CLOSURE + FSM CODEGEN WORKING 2026-06-18.** Validated end-to-end via
   compile-path corpus fixtures (all run → `42`, differential-clean; corpus 63):
   `io_async_await_42` (no-capture sync), `io_async_capture_42` (capture+return),
   `io_async_capture_add` (capture + `+` operator), `io_async_fsm_yield` (single
   await INSIDE → state machine), `io_async_fsm_multi` (two awaits + cross-boundary
   locals). Fixes landed: capture-param convention + capture-struct literal + body
   capture-access (`((cap*)closure_context)->f`); func_id await-analysis side-table
   for FSM-vs-sync dispatch; clearing the synthesized SomeT expected type for marked
   closure bodies (so operator bodies type concretely).
   **RESULT-TYPE COVERAGE WIDENED 2026-06-18 (corpus 65/65, differential-clean):**
   added `io_async_str` (str result) and `io_async_bool` (bool result). The bool
   case needed a fix in `generate_io_async_sync_call`: a bool body left the
   future-trait output SomeType unresolved through the body-ExprInfo path, so the
   result field lowered to `void*`. Final fallback added — when result_type is still
   an unresolved SomeType, read the closure's recorded `Func` type result via
   `get_func_type(closure_func_id)` (the result-refine in `anonymous_function.yo`
   re-registers the concrete closure func type once the body types).
   **REMAINING Phase 5: effect handlers (synchronous `ctl` effects — distinct
   unported subsystem, scoped in `issues/yo-self-sync-effect-codegen-unported.md`:
   fn-pointer effect params + `__yo_effect_escaped` post-call escape checks +
   handler-binding-as-fnptr + the upstream evaluator-metadata gap that leaves
   effect-using fn bodies without ExprInfo), io.spawn/JoinHandle, parallelism.**
   REMAINING for the full
   `tests/async_await.test.yo` (TS 116/116) and Phase 6: **`run_test` is unwired** in
   `yo-self/main.yo` (throws "codegen removed") — wiring it is the test-runner port
   (`src/test-runner.ts`, ~1632 LOC: extractTests + generateBatchedTestProgram —
   inline each test body into a `main` dispatched by `YO_TEST_INDEX` — + per-test
   run loop + summary parse). `run_compile` is fully wired and is the model.
NOTE (same lesson as Phase 1): no differential PASS until a large mass of #1–#4
co-exists — there is no partial runnable async program. Build #1+#2 first
(testable via `check`), then the FSM bottom-up against a minimal `io.async` +
`io.await` differential fixture.

**BASELINE CONFIRMED (2026-06-17).** The canonical first async differential
target (TS compiles+runs → `42`; yo-self `check` OK but `compile` emits MALFORMED
C — "too few arguments to function call", proving the FSM transformation is
absent, not merely gated):
```rust
{ println } :: import("std/fmt");
run :: (fn(io : Io) -> i32)({
  task := io.async((io : Io) => { x := i32(42); x });
  io.await(task, io)
});
main :: (fn(io : Io) -> unit)({ println(run(io)); });
export(main);
```
(`Io` is in the prelude — no import. `io.await` needs BOTH `fut` and the `e : E`
arg, i.e. `io.await(task, io)`.) Drive the FSM port to make this emit `42`, then
widen. SURFACED BUG along the way:
`issues/yo-self-async-await-argcount-overpermissive.md` — yo-self's evaluator
accepts `io.await(task)` (missing `e`) that TS rejects; fix the field-fn call
required-arg-count check during this phase.

**PHASE 5 STATUS SUMMARY (2026-06-18, ~88% — codegen-bootstrap corpus 64→74).**
LANDED + validated this session (each a 1-to-1 `src/` port, zero corpus regressions):
- Async FSM + I/O runtimes; async RESULT-TYPE resolution across i32/str/bool/struct/
  multi-await/multi-async (commits incl. bool-result, await-result register +
  `get_type_string` SomeType, io.await eval-time struct-field, multi-await C
  temp-name uniquify, multi-async-block freshening).
- **JoinHandle.await / io.spawn** — faithful `resolvedConcreteType` registry bridge
  (`_resolve_some_types_deep` env→registry chain + `_bind_forall_from_type_args`
  registry resolve). Fixture `io_spawn_join_handle.yo`.
- **First-class fn-VALUE codegen** (`comptime-value.ts:266` port — FuncVal → C
  function-pointer name). Fixture `fn_pointer_param.yo`.
- **Synchronous effect handlers — RESUME (return)** work, incl. NATURAL backtick
  messages. Fixtures `effect_handler_resume.yo`, `effect_handler_backtick.yo`.
- **`unwind` PART 1** (`generate_unwind`, `generation.ts:198-448` minus the
  continuation_variables nested branch) — sets `__yo_effect_escaped`, stashes
  `__yo_unwind_value`, dummy return.
- **`comptime_str.to_string()` fix** (`env.yo _resolve_str_type_from_env` fell back
  to `t_i32()` → `t_str()`); unblocked backtick effect messages. Fixtures above.
REMAINING (each scoped in issue docs, multi-session):
- **`unwind` PART 2 (escape-propagation)** — the FAITHFUL fix is to port the
  deferred EVIDENCE-PASSING machinery (`other_fn_call.yo:660`:
  `resolveEvidenceArgsForCallSite` + call-through + `emitEffectUnwindCheck`,
  mirroring `src/codegen/exprs/other-fn-call.ts`); NOT a direct-fn-pointer
  escape-check hack (yo-self's resume uses a direct-pointer simplification that
  diverges from TS's evidence model). See
  `issues/yo-self-sync-effect-codegen-unported.md`.
- **Parallelism** (`parallelism/runtime.ts` 474 + `exprs/parallelism.ts` 318).
  (0) ✅ PREREQUISITE DONE — the thread types `__yo_thread_t`/`__yo_thread_fn`/
  `__YO_THREAD_TYPE`/`__YO_THREAD_SYNC_TYPE`/`__YO_COND_TYPE`/
  `__yo_raw_thread_create`/`PARALLELISM_DEBUG` are emitted in
  `codegen/types/generation.yo:317-414`; `uses_parallelism` is tracked
  (`async.yo:1924`, `context.yo:187`).
  (1) ✅ DONE (commit 357dca084) — `generate_parallelism_runtime` ported to
  `yo-self/codegen/parallelism/runtime.yo` (faithful 1-to-1, wired into
  `generate_all_functions` gated on `uses_parallelism`). NOTE: emitted as many
  0-interpolation `emit_string_line` calls, NOT one 16-interpolation template —
  a single huge interpolated template makes the TS codegen hang >28min (the
  concat-AST is quadratic in interpolation count; template SIZE is fine, cf.
  `runtime_io_macos.yo`'s 1700-line 0-interp template). corpus stays 74/74.
  (2) ❌ DEFERRED — the `exprs/parallelism.ts` spawn emitter
  (`generateThreadSpawnCall`/`generateWorkerSpawnCall`/`generateSpawnWrapper`).
  GATED on the deferred closure-codegen subsystem (`implClosureCallMap` /
  `registerImplClosureCallMappings`): the spawn wrapper needs `consumedCaptures`
  for RC-cleanup NULLing, which yo-self does not track. Porting it without that
  would silently drop the double-free guard. See
  `issues/yo-self-parallelism-emitter-gated-on-closure-codegen.md`.
  (3) a parallel corpus fixture follows (2).

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
- [x] Phase 0 — UAF fix + baseline + differential harness (2026-06-13:
      `scripts/diff-test.sh` + `plans/codegen-baseline-scorecard.md`)
- [~] Phase 1 — typed pipeline (IN PROGRESS, 2026-06-13). Ported &
      check-clean: `constants.yo`; `utils/index.yo` (CodeGenContext base
      struct + the context-/type-model-independent helpers + `type_key` +
      `get_type_string` family [Phase-1/2 cases; SomeType/Dyn/Iso panic
      pending Gap 6] + `get_runtime_struct_fields`); `c/collection.yo`;
      emitter String-header methods. Gap 5 (registry key) RESOLVED via
      `type_key`; Gap 1 (struct runtime fields) RESOLVED via a struct-field
      comptime side-table (definitions.yo + struct.yo). Gates green: std
      152/152, yo-self 243/243, tests baseline-only.
      **KEY FINDING — phase boundaries don't hold at the import level.** The
      remaining pipeline files form one interdependent core that can't be
      completed in isolation: `types/collection` ↔ `functions/collection`
      (mutual import); `functions/collection` → `functions/declarations`
      (`getEvidenceParameters`, "Phase 3"); `codegen-c` orchestrates into
      `types/generation` + `functions/generation` ("Phase 3"); and emitted
      function BODIES need the Phase-2 expression emitters. So the FIRST
      runnable program (the Phase-1 "tiny corpus" gate) requires a large
      critical mass spanning Phases 1–4 — there is no partial working
      compiler, and the differential harness shows no PASS until that mass
      exists. Port order should follow imports, not the nominal phase
      numbers; each file stays `check`-clean (shallow) or unit-tested until
      the core is whole.
- [~] Phase 2 — expression-emitter sweep (SUBSTANTIALLY DONE, 2026-06-17).
      The differential corpus (`tests/codegen-bootstrap/`, run via
      `scripts/diff-test.sh`) has grown 21 → **55 fixtures, all PASS** (0
      diffs vs the TS reference, serial). Ported & differentially-green:
      atoms/literals, control flow (`if`/`cond`/`match`/`while`/`begin`),
      operators, value + runtime struct/enum construction, newtypes, tuples,
      property access, runtime casts (`__yo_as` via `macro_expansion`),
      address-of (incl. `&(array(i))` into the buffer), pointer ops, and the
      extern-call path. Remaining: the long tail of less-common emitters
      (surfaced as the corpus widens) + the Phase-4-coordinated dup/drop edges.
- [~] Phase 3 — functions/types/dyn/specialization (SUBSTANTIALLY DONE,
      2026-06-17). **Dyn subsystem COMPLETE** (construction + method dispatch +
      box/dup/drop + vtables + wrappers + type decls). **Generic specialization
      COMPLETE**: instance- and static-method specialization, ctor-in-spec-body,
      const-generic `Array(T, U)` length-var resolution, and per-specialization
      fresh-id body cloning. **Gap 6 (generic `println`/`print`) COMPLETE** end
      to end for `str` + integer over single/multi/mixed-type calls (fixture
      `std_println_generic`), exercising generic-fn monomorphization +
      method-dispatch + extern `fwrite`/`snprintf` (variadic args) +
      `Array.fill` const-generic buffer. Remaining: broader generic-container
      coverage as the corpus widens.
- [ ] Phase 4 — memory management, guard-page/ASan-clean
- [ ] Phase 5 — async/effects/parallelism runtimes (POSIX) — the largest
      unstarted block (~16k LOC of TS effect/async/parallelism codegen)
- [ ] Phase 6 — self-host fixpoint → Definition of Done

## References

- `scripts/diff-test.sh` — the differential harness (Phase 0); the
  `check`-equivalent run after every porting batch.
- `plans/codegen-baseline-scorecard.md` — the committed Phase-0 baseline.
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
