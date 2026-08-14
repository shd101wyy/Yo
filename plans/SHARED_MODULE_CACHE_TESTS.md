# Shared module-compilation cache for the test runner

**Status: PHASE 1 IMPLEMENTED 2026-08-14 (branch `perf/shared-module-cache`,
off `p2/group-c-goldens` — retarget/rebase onto develop when the GATE 3
merge train lands); full-tier validation in progress.**

**Full-tier measurement 2026-08-15** (`test ./tests/internal --parallel 1`,
TS runner, Mac Mini M4): **34.2 min vs the 40.5 min baseline (1.19×), 872/872
verdicts identical, zero failures.** Peak memory footprint **12.9 GiB**
(baseline ~6.5 GiB per-file peak) — the shared universe grows monotonically
across 58 files (trap 5 confirmed): the modest tier-level speedup vs the
1.67× single-file microbenchmark is consistent with later-file evaluation
paying for ever-larger registries/envs. Phase 1 finalization decision:
bound the universe — recreate the shared manager when process RSS crosses a
threshold (self-tuning; also caps registry bloat), then re-measure. Note
the parallel CI path (`--parallel 2`, child process per file) gets
within-file sharing (extraction + batches) with no cross-file growth by
construction.

**Phase 1 results so far** (macro_expansion.test.yo, single-file run):
157.7 s → 94.7 s (1.67×); batch Yo→C 73.3 s → 11.0 s (−85%, the closure
cache-hits from extraction); clang unchanged (17 s) as predicted; verdicts
identical. Single-file runs still pay extraction's first closure load
(~67 s) — in multi-file runs files 2+ cache-hit that too, which is where
the tier-level win multiplies. Hermeticity pins red-first proven: with the
per-file scrub disabled, both pin fixtures fail (duplicate-method /
leaked-state); with it enabled, both pass
(src/tests/shared-eval-hermeticity.test.ts + hermeticity-fixtures/).

## Problem

`yo test ./tests/internal` (58 files) re-compiles the self-hosted compiler's
import closure (~99k lines) from scratch for every test file — and in fact
**at least twice per file**:

1. **Extraction** (`extractTests`, src/test-runner.ts:270): fresh
   `ModuleManager` + full global clears, evaluates the test file and its
   whole import closure to find `test(...)` declarations.
2. **Batch compile** (`compileBatchedBinary`, src/test-runner.ts:504):
   ANOTHER fresh `ModuleManager` + full clears, re-evaluates the same
   closure inside the synthetic `.yo_test_batch_*.yo` program, then
   codegens the whole program. Bisection on a failing batch repeats this.

Measured (2026-08-05): 40.5 min for the tier under TS, 22.2 min under the
self-hosted binary; `macro_expansion.test.yo` alone peaks at 6.52 GB. The
closure evaluation is identical across files — it is pure recomputation.

The `check` subcommand already proves the alternative: it walks 247 files
through ONE shared `ModuleManager`/evaluator universe (yo-cli.ts:591
comment), and after the GATE 3 fix (canonical cache keys, populate-once
prelude) that sharing is sound.

## What a cache can and cannot buy

- **Cacheable (dominant):** compile-time EVALUATION of the shared closure
  (std + yo-self modules). In-process reuse — same mechanism as `check`.
- **Not cacheable in Phase 1:** per-batch codegen (C emission is
  demand-driven per program) and clang time on the emitted ~MBs of C.
- **Out of scope entirely:** an on-disk cache. Serializing evaluator state
  (EvalValues contain closures, envs, interned type identities) is not
  feasible; do not attempt.

Phase 0 exists to size these buckets before building anything
(memory rule: profile before trusting perf plans).

## Phase 0 — Measure

For 3 representative files (`lexer.test.yo` light, `parser.test.yo` medium,
`macro_expansion.test.yo` heavy), under BOTH compilers, record per stage:
extraction-eval ms, batch-eval ms, codegen ms, clang ms, run ms
(the TS runner already logs `yoCompileMs`-style timings; add temporary
stage prints if needed). Decision gate: proceed only if closure
re-evaluation is ≥50% of tier wall-clock (expected: yes, by a lot).

**Measured 2026-08-14 (TS compiler, `--profile`, Mac Mini M4). `yo` =
batch Yo→C (eval + codegen); `cc` = clang; "extract+overhead" = file total
minus batch minus runs:**

| file                    | total   | extract+overhead | batch yo | batch cc |
| ----------------------- | ------- | ---------------- | -------- | -------- |
| lexer.test.yo (light)   | 9.0 s   | ~5.6 s           | 2.6 s    | 0.4 s    |
| parser.test.yo (medium) | 10.7 s  | ~6.3 s           | 3.4 s    | 0.5 s    |
| macro_expansion (heavy) | 157.7 s | ~67 s            | 73.3 s   | 17.0 s   |

**Decision gate: PASSED.** For the heavy file, extraction (~43% of
wall-clock) is closure evaluation almost entirely, and a large share of the
73 s batch `yo` time is the SAME closure re-evaluated — clang is only 11%.
A shared universe removes the ~67 s extraction cost from every file after
the first and turns the batch's closure re-eval into cache hits;
worst-case-honest estimate is a 2–3× tier speedup before touching codegen.
(yo-self-side stage split still to measure; its runner is ~2× faster
overall, same shape expected.)

## Phase 1 — TS: shared evaluator universe in the sequential runner

One `ModuleManager` per `yo test` invocation (sequential in-process path
only — parallel mode spawns child processes and keeps its per-process
behavior):

- Extraction: `loadModule(testFile)` on the shared manager — closure
  modules cache-hit after the first file.
- Batch compile: `compileModule(batchFile)` on the shared manager —
  closure cache-hits; only the synthetic batch module evaluates fresh.
- After each file/batch: `deleteModuleAndDependents(fileModule)` +
  `clearImplsFromModule` / `clearGenericImplsFromModule` /
  `_clearPragmaForModule` / `resetModuleIdCounter` for the test/batch
  module ONLY — shared closure modules stay cached. This per-module scrub
  machinery already exists (built for the LSP).

**Known correctness traps (each needs a red-first pin):**

1. ~~Filter `moduleLevelInitExprs` collection to the entry's dependency
   closure~~ — **implemented, failed, reverted; the opposite is true.**
   The emit-closure EXCEEDS the import-closure: codegen emits specialized
   functions reached through the process-wide impl registries, which can
   come from cached modules the entry never imports. Filtering to the
   import closure stripped the C declarations those bodies reference —
   every tier file after the first failed with
   `use of undeclared identifier 'g_var_id_counter_yoc10a5ffb'` (env.yo's
   module global), while an A/B run with the filter off passed 337/337.
   All-modules collection is self-consistent because each init-expr
   emission carries its own declaration; the cost is an unreferenced
   global + its init in binaries that never read it (the per-file scrub
   keeps the cached set to shared closure + current batch, so the leak is
   bounded to shared modules).
2. Test files routinely define impls on shared/builtin types. The
   per-module scrub must actually remove them, or file A's impls change
   file B's verdict. Pin: two crafted test files where a leaked impl (or a
   leaked duplicate-method conflict) flips the second file's result.
3. Target switching (`setCurrentTarget` for wasm) invalidates evaluation —
   flush the shared universe on target change (tests/internal is
   host-only, so this is a guard, not a hot path).
4. Batch bisection rewrites batch files — unique batch module paths per
   attempt (already true) + scrub after every attempt.
5. Memory: one long-lived universe must not accumulate per-file garbage —
   verify RSS across a 10-file run stays near the single-file peak
   (cf. plans/backlog/YO_SELF_ENV_SHARING.md for why universes are huge).

Validation gate: full `tests/internal` run before/after must be
VERDICT-IDENTICAL per test (not just counts), plus the two new hermeticity
pins, plus the fast suite. Only then measure and report the win.

## Phase 2 — yo-self port

**History (do not repeat it):** yo-self already TRIED in-process
multi-batch compiles and retreated. `run_compile`'s comment
(yo-self/main.yo:1206-1230) records the measured failure — 47
`Failed to transpile` markers on the second file's batch of
`test ./tests/string` (59 on tests/internal) because three caches outlive a
batch's ExprInfoTable: the module cache, the cached prelude env, and the
specialization/impl registries. The "fix" was compiling each batch in a
CHILD PROCESS (one compile per process). The same comment states the
asymmetry Phase 1 leans on: **TS stores node info ON the AST (`expr.$`),
so cached ASTs carry their annotations; yo-self keys a SIDE TABLE by expr
id.** A yo-self shared universe therefore needs the side-table lifetime
solved (run-scoped table — `g_shared_expr_info_table` exists and is the
precedent) IN ADDITION to the registry scrub below, and it must undo the
child-process-per-batch design.

**Prerequisite:** yo-self currently CANNOT scrub per-module registry state —
`register_generic_impl` appends unconditionally, there is no
`source_module_path` on trait fields, and no per-module clear exists
(issues/yo-self-missing-duplicate-impl-checks.md). That hardening issue is
therefore a dependency of this plan, not optional polish: port TS's
duplicate checks AND the per-module clear machinery first, with the same
red-first pins, then port the shared-universe runner. Note yo-self already
shares one codegen `ExprInfoTable` across batches (`g_shared_expr_info_table`,
module_manager.yo) — precedent for run-scoped shared state.

This is the phase that matters long-term: src/ retires (P2), and the
self-hosted runner is what CI keeps paying for.

## Phase 3 (only if Phase 0/1 numbers demand it)

- Per-module C-emission cache (hard: emission is demand-driven by
  specialization use), or
- Cross-file test batching (one binary for N test files' tests — cheaper
  to build, but weakens file isolation and complicates bisection).

Decide on data, not upfront.

## Sequencing

1. GATE 3 merge train lands (this plan's soundness rests on that fix, and
   Phase 2's prerequisite issue came out of it).
2. Phase 0 measurements (idle machine, one child at a time).
3. Phase 1 as its own PR off develop; Phase 2 as a follow-up PR.
