# Shared module-compilation cache for the test runner

**Status: PHASE 1 COMPLETE AND VALIDATED 2026-08-15** (branch
`perf/shared-module-cache`, off `p2/group-c-goldens` — rebase onto develop and
open the PR once the GATE 3 merge train lands). Phase 2 (yo-self) is
researched but NOT started; its prerequisite is
`issues/yo-self-missing-duplicate-impl-checks.md`.

**Full-tier measurement 2026-08-15** (`test ./tests/internal --parallel 1`,
TS runner, Mac Mini M4): **34.2 min against the documented 40.5 min baseline
(~1.19×, soft — different build; see the A/B caveat below), 872 passed / 0
failed**, peak 13.8 GB accumulated across 60 files in one process.

### The authoritative number: a same-build per-file A/B

This is the measurement that matters, because **CI runs one process per file**
(see the CI section below). `macro_expansion.test.yo`, one build, sharing
toggled with `YO_TEST_NO_SHARED_UNIVERSE=1`, `/usr/bin/time -l`:

|                    | sharing OFF | sharing ON | delta     |
| ------------------ | ----------- | ---------- | --------- |
| wall-clock         | 158.7 s     | 95.4 s     | **1.66×** |
| batch Yo→C (`yo=`) | 73.7 s      | 10.8 s     | **−85%**  |
| clang (`cc=`)      | 17.3 s      | 17.2 s     | unchanged |
| peak memory        | 8.13 GB     | 6.03 GB    | **−26%**  |

**Sharing LOWERS peak memory per file by 26%** — it evaluates the closure once
instead of twice. An earlier draft of this doc claimed the opposite
("12.9 GiB vs ~6.5 GiB baseline"); that comparison was invalid — it put a
whole-tier accumulated peak against a SINGLE FILE's documented peak. The
13.8 GB tier figure is real but it measures 60 files accumulating in one
process (and V8's heap high-water mark, which never returns to the OS,
contributes in BOTH arms).

The 40.5 min tier baseline quoted below is the DOCUMENTED figure
(2026-08-05, older build), not a same-build A/B — a same-build baseline tier
run was attempted twice and killed by this machine's background-job reaper
both times. The tier-level ratio is therefore soft; the per-file ratio above
is not, and it is the one CI collects.

### The RSS bound was measured-harmful and REMOVED

Same tier with the bound active (limit = totalmem/2 = 8 GiB): **36.2 min
(2 min SLOWER than unbounded) at an identical 13.86 vs 13.81 GB peak.** An
instrumented probe (`YO_TEST_DEBUG_SHARED=1`) explained it exactly — the
reset reclaims NOTHING:

```
[shared] rss=3026MB limit=3000MB reset=true rssAfter=3026MB
[shared] rss=3642MB limit=3000MB reset=true rssAfter=3642MB
[shared] rss=5402MB limit=3000MB reset=true rssAfter=5402MB
```

`rssAfter == rssBefore` on every reset, and RSS keeps climbing regardless,
because V8 does not return its heap high-water mark to the OS and
`tryForceGC()` is inert unless node runs with `--expose-gc` (CI passes it;
the `./yo-cli` wrapper does not). So the first trip makes every later file
reset too — full first-touch evaluation per file, zero memory saved. It is
replaced by an explicit `YO_TEST_NO_SHARED_UNIVERSE=1` opt-out (verified from
both directions: pins pass either way, and the opt-out is measurably slower).

Verdict identity established without a 40-minute baseline re-run, by
reconciling against CI's own last green tier on develop (run 31708389473,
all four TS shards): baseline **868 tests across 59 files**; this branch has
60 files (it adds `tests/internal/gc_runtime_atomics.test.yo`, 4 thread-safety
pins) and reported **872 = 868 + 4**. So test DISCOVERY is byte-for-byte the
baseline set plus the four known new tests, and every one passed — the shared
universe neither lost, duplicated, nor mis-attributed a single test.

### Phase 1 exposed a latent TS bug (fixed here)

`ModuleManager.loadModule` registers a partial StructValue as "currently
loading" before evaluating and unregisters after — but the `Evaluator`
CONSTRUCTOR is what evaluates, so a module whose evaluation THREW leaked its
partial value in `loadingModules` forever. The next load of that path hit the
leaked entry and returned the partial value with **no error**, so an import
that must fail silently succeeded.

Invisible while every compile built a fresh `ModuleManager`; live the moment
one is reused. It surfaced as `tests/circular_import.test.yo`'s
"Error on accessing not-yet-exported field in circular import" —
`comptime_expect_error(import(...))` reporting "the expression was evaluated
successfully" — failing under sharing and passing without it.

yo-self already carried the fix (its `mm_eval_entry_exprs` comment: "ALWAYS
unregister, error or not — a leaked currently-loading entry poisons every
LATER file in a directory check",
issues/fixed/yo-self-dir-check-state-corruption-after-failure.md), so this is
TS/yo-self parity, not a workaround. Fixed with a `try/finally`, pinned by
`src/tests/module-manager-loading-leak.test.ts` (red-first verified: the pin
fails with the `finally` disabled on the same build).

A speculative second fix — scrubbing the test file's sibling sources from the
shared universe on the theory that warm fixtures change import semantics — was
implemented, then REMOVED: instrumentation showed the circular-error fixtures
were never cached at all (failed loads are not), and the corpus is green
without it. Recorded so it is not re-derived.

**Hermeticity pins are red-first proven:** with the per-file scrub disabled,
both pin fixtures fail (duplicate-method / leaked module state); with it
enabled, both pass — `src/tests/shared-eval-hermeticity.test.ts` +
`src/tests/hermeticity-fixtures/`.

## Problem

`yo test ./tests/internal` (60 files) re-compiles the self-hosted compiler's
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
- **Out of scope entirely:** an on-disk cache OF EVALUATOR STATE. Serializing
  EvalValues (closures, envs, interned type identities) is not feasible; do
  not attempt. This does NOT rule out caching extraction's string OUTPUT on
  disk — see Phase 3, which is exactly that and is now the leading lever.

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

> **This estimate was too optimistic — recorded as-written for calibration.**
> Delivered: **1.66× per file** (the CI-relevant shape) and ~1.19× over the
> whole tier. The estimate assumed cross-file extraction savings would compound;
> in practice each file still pays first-touch evaluation for whatever it is the
> first to import — and per-process, extraction is not amortized at all. What
> dominates after Phase 1 is therefore EXTRACTION (62.4 s of 95.4 s on the
> heavy file), not clang; see Phase 3, which is aimed squarely at it.

## How CI actually runs the tier (measured against, 2026-08-15)

**CI does NOT run `test ./tests/internal` as one process.** The TS arm is a
4-way shard matrix (`.github/workflows/test.yml:496`, sharded 2026-08-06),
and inside each shard the step loops **one `node ... yo-cli.cjs test <file>`
invocation per file** (test.yml:578) so a failure is attributed with
`::error file=` and the remaining files still run. The self-hosted
differential job runs alongside it.

Consequences for Phase 1, and they cut both ways:

- **CI gets the WITHIN-file win, which is the big one.** Extraction's
  evaluated closure is reused by that file's batch compile(s) — the
  measured −85% on batch Yo→C (73.3 s → 11.0 s on the heavy file, whose
  single-invocation total went 157.7 s → 94.7 s). Every shard contains
  exactly one heavy file by design, so every shard collects that saving.
- **Cross-file growth never happens in CI** (fresh process per file), so
  the RSS bound added in Phase 1 is a LOCAL-runs safeguard, not a CI one.
- **The unclaimed CI lever is the loop itself.** Each of a shard's ~15
  invocations pays first-touch closure evaluation (~5.6 s for a light file,
  ~67 s for a heavy one). Running a shard's LIGHT files in ONE invocation
  would pay it once — order ~70-80 s per shard, more for medium files.
  Cost of doing that: per-file `::error file=` annotation is lost (the
  runner's own per-file reporting would have to carry it), a crash takes
  the whole batch down instead of one file, and the shard becomes subject
  to cross-file memory growth (hence the bound). Suggested shape if
  pursued: keep each shard's heavy file as its own invocation (isolation +
  6.5 GB peak), batch the light files into one. Decide with a measurement
  of a real shard file list, not from this estimate.

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

## Phase 3 — REFUTED 2026-08-16. Do not build it as specified.

Everything below this banner is the ORIGINAL sketch, kept for the reasoning
trail. A survey of the actual code before implementing refuted six of its
assumptions; one is fatal to the payoff. Read this section first.

### FATAL — the projected win double-counts Phase 1. A perfect hit is a wash.

The sketch projects "batch + clang ~= 30 s on a warm hit" by adding the WARM
batch number (10.8 s) to clang. The batch is warm **only because extraction
already evaluated the import closure into the shared universe**:

- `runTests` builds one empty `ModuleManager` per run (`src/test-runner.ts:1586-1588`).
- `extractTests` calls `loadModule` (`:299`), demand-loading the whole closure.
- The post-extraction scrub deletes ONLY the entry module and its dependents
  (`:272-276`, `:360` -> `src/module-manager.ts:223-247`). The closure stays resident.
- `compileBatchedBinary` reuses that warm map (`src/test-runner.ts:545`,
  `src/module-manager.ts:349-356`).

On a cache HIT extraction is skipped, so the batch compile becomes the first
thing to touch the universe and pays the full cold closure evaluation — this
plan's own measured 73.7 s.

Measured (two `extractTests` calls on one ModuleManager):

| file                                     | cold extraction | warm extraction |
| ---------------------------------------- | --------------- | --------------- |
| `tests/internal/macro_expansion.test.yo` | 61,232 ms       | **33 ms**       |
| `tests/internal/lexer.test.yo`           | 2,224 ms        | 114 ms          |
| `tests/basic.test.yo`                    | 1,878 ms        | 256 ms          |

**99.95% of the heavy file's extraction IS closure evaluation.** The 62.4 s
extraction and the 62.9 s cold-warm batch delta are the same work; exactly one
of them can be eliminated and Phase 1 already eliminated it. Warm-hit total
under CI's one-process-per-file shape: `73.7 + 17.2 + ~5 ~= 96 s` vs **95.4 s
today**. The only recoverable part is extraction's NON-closure work (parsing the
entry file, the swallowed per-test trial eval, stringification) — bounded by
roughly 0-5 s on the heavy file.

The cache only pays when the closure is already warm from ANOTHER file in the
same process — i.e. the "batch a shard's light files into one invocation" lever
listed separately and still unclaimed. Phase 3 and that lever are complements;
Phase 3 alone buys ~nothing in the shape this plan targets.

### The real lever: TS should extract WITHOUT evaluating, as yo-self already does

The sketch's "Applies to BOTH runners (yo-self does the same extract-then-compile
dance)" is **false**. The self-hosted runner parses and walks the RAW parse tree
— no `loadModule`, no evaluator, no closure:

- `yo-self/main.yo:1732` — `prog := parse(src, file.clone(), exn);`
- `yo-self/main.yo:1734-1756` — walks `prog`, collecting
  `TestDecl(name, body_src : ast_expr_to_string(tbody))` and `non_test.push(...)`.

The whole corpus is green under it, and it runs the `tests/internal` tier in
22.2 min against TS's 40.5 min. So there is nothing to cache on the yo-self
side.

**But porting parse-only extraction into TS is NOT the 62 s win it looks like,
and the survey that proposed it overstated the case.** The same argument that
kills the cache kills this: the closure evaluation has to happen SOMEWHERE,
because the batch compile needs it. Today extraction pays it and the batch runs
warm; with parse-only extraction the batch pays it cold. One evaluation either
way:

```
today:            62.4 (extract, warms closure) + 10.8 (warm batch) + 17.2 = 95.4 s
parse-only:       ~0.1 (parse)                  + 73.7 (cold batch) + 17.2 ~= 91 s
```

The real saving is only extraction's non-closure work — the entry-file parse and
the swallowed per-test trial evaluation — i.e. the same 0-5 s bound as the cache.
It does still cut extraction's 3.80 GB peak, which matters on a 16 GB box where
two concurrent children already swap, so it has value as a MEMORY lever, not a
wall-clock one. (Derived from this plan's own numbers plus the cold/warm
measurements above; worth confirming with a direct A/B before anyone builds it.)

### So what IS the remaining lever

Closure evaluation is now paid exactly once per FILE and is irreducible per
file. The only way to amortize it further is to pay it once per SHARD: run
several test files in ONE process so the second and later files hit the warm
universe (measured 33 ms vs 61,232 ms for `macro_expansion.test.yo`). That is
the "batch a shard's light files into one invocation" lever this plan lists and
leaves unclaimed — and Phase 1's per-file scrub plus its hermeticity pins are
exactly the machinery that makes it safe.

Caveat to weigh first for ANY of this: the benefit is confined to the TS shards,
and `src/` retires in P2 Groups E/F. Time-box the work against that.

### The other four refutations (each would have shipped a silent bug)

1. **Output is not strings.** `ExtractTestsResult` is
   `{tests: TestDeclaration[]; nonTestExprs: Expr[]}` (`src/test-runner.ts:105-108`)
   and `TestDeclaration.bodyExpr` is a live `Expr` (`:87-92`). Every evaluated
   Expr carries `$` with REQUIRED `env: Environment` and `type: Type`
   (`src/expr.ts:179-192`); `JSON.stringify` throws on the cycle. The strings
   exist only downstream in `runTests` (`:1638-1651`), so the cache boundary
   would be there, not at `extractTests`.
2. **Ordering trap — silently runs the wrong tests.** `--test-name-pattern`
   filters at `:1622-1624`, BEFORE stringification at `:1638-1651`. Caching
   "exactly what runTests already builds" persists a FILTERED subset; a later
   unfiltered run then silently runs only those tests. Any implementation must
   cache the unfiltered extraction and apply the regex after the read.
3. **`modules.keys()` is not the closure.** Under the shared manager it is the
   union of every file processed so far in the run (measured 185 entries after
   `macro_expansion.test.yo` alone), it is missing the entry itself (scrubbed at
   `:360`), and it OMITS files that were read, evaluated and FAILED, because the
   map is written only on success (`src/module-manager.ts:408-411`). The repo
   has a live case: `tests/circular_import.test.yo:26` deliberately imports a
   failing module — dependency-graph closure 23, `modules` map 22, the two
   missing entries being exactly the circular-error files. Repair one and the
   file's verdict flips with the recorded list unchanged: a silent stale hit.
   The correct source is the private forward-edge `dependencies` map
   (`src/module-manager.ts:120`), whose edge is added at `:344-347` BEFORE the
   cache-hit return, the loading-placeholder check and evaluation — and it must
   be harvested BEFORE the scrub calls `clearDependencies` (`:243`, `:292-304`).
4. **"A new import can only appear if some closure file changed" is false.**
   Import resolution reads filesystem SHAPE, not just contents: extensionless
   imports probe `<p>.yo` vs `<p>/index.yo` and raise "Ambiguous import" when
   both exist (`src/evaluator/exprs/import.ts:212-238`), the project root is
   found by probing ancestors for `yo.lock`/`build.yo` (`:284-298`), and
   dependency names are repointed through `yo.lock` (`:143-186`,
   `src/fetch.ts:510-536`). Creating `foo/index.yo` beside `foo.yo`, adding an
   ancestor `build.yo`, retargeting a symlink or deleting a recorded file all
   change resolution while every recorded file's content hash is unchanged.

Minor: `lineNumber` is listed in the sketch's payload but is dead — assigned
once (`src/test-runner.ts:349`) and read nowhere; `StringifiedTestData` is
`{name, bodyString, filePath}` (`:99-103`).

Also note the cached strings would be the RENDERED OUTPUT OF EVALUATION, not
source text: the evaluator rewrites the AST in place, and `$.originalExpr` is
written in exactly one place, for test BODIES only
(`src/evaluator/exprs/test.ts:169`) — `nonTestExprs` never carry it, so
`nonTestContent` is always the post-evaluation form. A content-hash key cannot
cover that.

---

## Phase 3 (ORIGINAL SKETCH — refuted above) — the data says: cache EXTRACTION on disk

Measured 2026-08-15 on `macro_expansion.test.yo` with Phase 1 sharing ON.
Extraction was isolated by asking for a test name that matches nothing
(`--test-name-pattern zzz_matches_nothing`), so extraction runs and the batch
compile does not:

| stage                | time       | share   |
| -------------------- | ---------- | ------- |
| **extraction alone** | **62.4 s** | **65%** |
| batch Yo→C           | 10.8 s     | 11%     |
| clang                | 17.2 s     | 18%     |
| test runs + overhead | ~5 s       | ~5%     |
| (total)              | 95.4 s     |         |

Extraction alone also peaks at 3.80 GB. **Phase 1 solved the batch-side cost
(−85%) and thereby promoted extraction to the bottleneck** — and in CI, which
runs one process per file, extraction is paid in full for every file with no
in-process reuse available to amortize it.

**The lever: extraction's OUTPUT IS STRINGS.** `extractTests` exists to find
`test(...)` declarations and hand back test names, line numbers, stringified
test bodies and stringified non-test content — kilobytes of source text. That
is trivially serializable, and it is NOT the thing the "no on-disk cache"
prohibition above forbids: that prohibition is about evaluator STATE
(EvalValues, closures, envs, interned type identities). Caching strings on
disk dodges it entirely.

Design sketch (not implemented):

- Payload: exactly what `runTests` already builds — `{name, bodyString,
filePath, lineNumber}[]` plus `nonTestContent`.
- Key: hash of the entry file's contents + the contents of every file in its
  transitive import closure + a compiler build identity.
- Getting the closure without evaluating (the chicken-and-egg): record the
  closure file list at cache-WRITE time — it is just
  `ModuleManager.modules.keys()` after a successful extraction — and validate
  on read by re-hashing the entry plus that recorded list. A _new_ import can
  only appear if some existing file in the closure changed, and that change
  already invalidates the key, so the recorded list is sufficient.
- Expected effect on the CI shape: the heavy file goes from 158.7 s
  (pre-Phase-1) to roughly batch + clang ≈ 30 s on a warm hit — and it helps
  the LIGHT files proportionally more, since extraction is ~62% of their
  wall-clock too (Phase 0: ~5.6 s of a 9.0 s total).
- Applies to BOTH runners (yo-self does the same extract-then-compile dance),
  and is independent of Phase 2's registry work — so for CI wall-clock this is
  arguably the higher-value next step.

Correctness risk to respect: a stale hit compiles the WRONG tests, silently.
Any implementation needs a red-first pin that mutates a transitively imported
file and proves the cache misses.

Alternatives considered and ranked below it:

- Per-module C-emission cache (hard: emission is demand-driven by
  specialization use, and clang is only 18%).
- Cross-file test batching (one binary for N files' tests — cheaper to build,
  but weakens file isolation and complicates bisection).

## Sequencing

1. GATE 3 merge train lands (this plan's soundness rests on that fix, and
   Phase 2's prerequisite issue came out of it).
2. Phase 0 measurements (idle machine, one child at a time).
3. Phase 1 as its own PR off develop; Phase 2 as a follow-up PR.
