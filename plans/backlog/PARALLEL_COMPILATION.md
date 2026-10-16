# Parallel compilation: using more than one core

**Status: DESIGN; P1.1 and P4 step 1 (`YO_TEST_FORK`) landed.** Written 2026-10-16 at the maintainer's request:
"If we make evaluator and codegen multi threads, then can we speed up?" The
measurements below were taken that day on develop `6986090a1`. P0 below re-takes
them on an idle machine before any code changes.

## 0. The answer

Yes, but the order matters, and threading the evaluator should come last.

- **A self-build spends most of its time outside the evaluator.**
  - Code generation (collect plus emit) is 34% of a self-compile.
  - The C compile is another 27%, and the self-build runs it as one
    single-threaded `clang -O2` over one 138 MB file.
  - Neither phase needs the evaluator's state to be thread-safe.
  - Both can run on N cores with child processes that share nothing:
    - the C compile already can (`--emit-chunks`);
    - the emit phase can after a fork, because the emit phase mints no new
      function (§1).
- **The evaluator is hard to thread** (§2):
  - 576 module-level mutable globals;
  - non-atomic `Rc` on every tree;
  - lazy, order-sensitive demand evaluation;
  - byte-identical emission required by the bootstrap gates.

  A threaded evaluator is a long project with a modest ceiling: rustc's
  parallel front end reports up to roughly 50% lower wall time on 8 threads
  after years of work.
- **Two single-core fixes stack with all of it** (§3, P1):
  - markdown_yo's two data tables take 17% of evaluation;
  - the vendored mimalloc is compiled in debug mode on Linux.

Estimated effect on a self-build (§4): about 2× from P1–P3, without touching
the evaluator's threading. A threaded evaluator (P5) would then act on the
40–50% that is left.

## 1. Measured (2026-10-16, Ryzen AI Max+ 395, 32 threads, WSL2)

**Idle machine, nothing else running:**

| Step | Wall | CPU |
| --- | ---: | ---: |
| `yo build --std-path ./std` (seed v0.2.63, cold) | 18 min 4 s | 99% (one core) |
| `check ./src` (tree-built binary), run 1 | 261 s | 99% |
| `check ./src`, run 2 | 284 s | 99% |

The maintainer's Mac Mini M4: a self-build in under 10 minutes and
`check ./src` in about 140 s.

**Most of the remaining gap was the allocator.** The vendored mimalloc was
compiled in debug mode on Linux, while macOS links the system allocator. The
same emitted C was linked both ways and timed on `check ./src` under the
exclusive lock:

| Allocator build | Run 1 | Run 2 | Max RSS |
| --- | ---: | ---: | ---: |
| as shipped, `MI_DEBUG=2` | 594 s (outlier) | 292 s | 1,057 MB |
| `-DMI_BUILD_RELEASE` | 202.1 s | 202.5 s | 1,060 MB |

With the release build the gap to the M4 is 1.44×, about what single-core speed
explains. P1.1 is the fix.

**Phase profile of `yo compile src/main.yo --optimize 2 --allocator mimalloc --profile`.**
This ran with up to five other heavy jobs on the machine, so the absolute
times are inflated; read it for the shares.

| Phase | Time | Share |
| --- | ---: | ---: |
| prelude evaluation | 4.0 s | 0.4% |
| entry module evaluation | 377.7 s | 38.1% |
| codegen: collect | 51.9 s | 5.2% |
| codegen: emit | 290.5 s | 29.3% |
| write C | 0.1 s | 0% |
| cc compile + link (single file, `-O2`) | 263.7 s | 26.6% |

**Evaluation by area** (exclusive per-module time, 424 modules):

| Area | Time |
| --- | ---: |
| `src/evaluator/` | 122.6 s |
| markdown_yo (a dependency of `src/doc`) | 63.7 s |
| `src/codegen/` | 44.5 s |
| `std/` | 31.0 s |
| everything else in `src/` | 116 s |

- **markdown_yo's two largest modules are data tables.**
  - `src/data/emoji_data.yo` is 1.3 MB of source and takes 30.1 s.
  - `src/common/entities.yo` is 0.9 MB and takes 23.0 s.
  - Together they are 14% of all evaluation.
- **Function census:**
  - 14,967 functions: 8,772 from std, 6,195 from the project.
  - `minted_during_emission` is **0**: every specialization exists before the
    emit phase begins. This is the fact that makes §3's P3 possible.

## 2. Why the evaluator does not take threads cheaply

These are the constraints a threaded evaluator would have to remove. Each one
is a project of its own.

1. **Global mutable state.** `src/` holds 576 module-level mutable globals.
   - Where they live: the `ExprInfo` side tables (`src/expr_info.yo`, 89),
     the type creators and intern tables (`src/types/`), the environment
     (`src/env.yo`, 29), the impl and trait registries and the evaluator
     context.
   - Every one would need per-thread confinement, sharding with locks, or a
     merge step.
   - Yo's own thread-safety rules (D1, decision 47) reject a closure that
     reaches such a global from another thread. That is correct for user
     code, and it is exactly what the compiler would have to restructure
     away.
2. **Non-atomic `Rc` on every tree.**
   - `AstExpr`, `TypeValue`, `EvalValue` and the environments are all
     reference-counted with plain increments.
   - RC traffic is already 34 s of the 2026-10-14 `sample` profile
     (`plans/VALUES_BY_DEFAULT.md` §6 "Evaluator performance").
   - Making it atomic would slow the single-threaded case, which is every
     `check` and every agent loop.
   - Sharing a tree across threads needs a frozen form that skips counting
     (an "immortal" bit in the header, checked by `dup`/`drop`).
3. **Evaluation is demand-driven and order-sensitive.**
   - Definitions are forced lazily (`plans/reference/LAZY_TOPLEVEL_BINDINGS.md`)
     and modules are demand-loaded.
   - Specializations are memoized on first use, and `impl` registration is
     global.
   - Two threads forcing the same definition must agree on one result and
     one `ExprInfo` id range.
4. **Determinism.**
   - The bootstrap fixpoint and the chunked gate compare emitted C.
   - Function symbols are numbered in first-registration order (`yo_id_N`).
   - Diagnostics print in evaluation order.
   - A parallel evaluator needs content-stable names and a deterministic
     merge before it can pass either gate. The `.o` cache wants
     content-stable names anyway (`plans/reference/CHUNKED_C_EMISSION.md`,
     "What is left behind").

Processes avoid all four. A `fork()` after evaluation gives each child a
copy-on-write snapshot of the whole evaluator, with no locks and no atomic
counts. Each child writes its own output, and the parent merges the outputs in
a fixed order. P2 and P3 take that route. Windows has no `fork`, so both fall
back to today's sequential path there.

## 3. The plan

### P0: measure on an idle machine (prerequisite, about one day)

1. **Re-take §1's phase profile** under the exclusive heavy lock, with three
   runs of each of `yo build`, `check ./src` and
   `yo compile src/main.yo --profile --profile-json`. Record the medians here.
2. **Add the per-phase shares of the M4** (the maintainer's machine), so the
   plan is sized for both machines.
3. **Record `YO_SPEC_REPORT`** (forced definitions against collected
   functions).
4. **Record the emit phase's own split:** type declarations, functions,
   runtimes and dyn/async/main.
5. **Size the overlap for P4:** the import closure of each file under `src/`,
   with each module weighted by its exclusive evaluation time. This bounds
   what a forked `check <dir>` can gain.

### P1: single-core fixes that multiply everything else

These are not parallelism, but every later stage divides the time they leave.

1. **Build mimalloc in release mode on Linux.**
   - The bug: `issues/fixed/2026-10-14-the-vendored-mimalloc-is-compiled-in-debug-mode.md`
     (S3). Every compile line that links `vendor/mimalloc/src/static.c` gets
     `MI_DEBUG=2` and `MI_STAT=2`.
   - The fix: add `-DMI_BUILD_RELEASE -DNDEBUG` to `yo compile --allocator mimalloc`
     (`src/main.yo`, "Bundled mimalloc allocator") and to the CI and release
     compile lines that list `static.c`.
   - The A/B (§1): 292 s → 202 s on `check ./src`, same memory. **Done on
     `perf/mimalloc-release-build`**, with a CI guard: the stage-2 step fails
     when the binary still carries the debug build's assertion message.
   - CI needs no new gate: the memory ratchet's RSS baseline moves, and is
     re-recorded in the same PR.
2. **Evaluate large literal tables in time linear in their size.**
   - Today markdown_yo's 2.2 MB of tables costs 53 s, 23 µs per source byte,
     and every `check ./src` and every self-build pays it.
   - Profile the evaluation of a synthetic table module (10k, 100k, 1M
     entries) to find the super-linear step: per-element type inference,
     per-element `ExprInfo` growth, or the per-element interning of a
     `String` key.
   - Fix it in the evaluator, with an allocation-count ratchet entry for the
     synthetic module.
3. **The evaluator-performance steps already planned after VBD**
   (`plans/VALUES_BY_DEFAULT.md` §6 "Evaluator performance", steps 1–2).

### P2: compile the self-build's C in parallel (exists; one decision)

- `--emit-chunks auto` already splits the emitted C into N translation units.
  They compile in parallel with ThinLTO and a content-hashed `.o` cache.
  Measured on the M4: the C leg went from 72 s to about 34 s cold, and a
  warm rebuild is a link (`plans/reference/CHUNKED_C_EMISSION.md`).
- `yo build` turns it on for DEBUG executables only. The compiler's own
  `build.yo` builds `ReleaseSafe`, so the self-build still runs one `clang`.
- **The decision:** chunk the self-build's development artifact (`yo build`),
  and keep the single-file emission for the bootstrap fixpoint, the
  portable-C distribution and `release.yml`, which compare or ship it.
  - The chunked-built binary is already gated: the full language suite
    passes on it, and it emits byte-identical C to a single-file-built
    compiler (`scripts/bootstrap/chunked_gate.sh`).
  - It runs 2.9% faster with ThinLTO.
- **Expected:** the C leg of a self-build drops from about 27% of the total to
  about 7%. On this box that is roughly 264 s → 60–80 s.

### P3: emit the C in parallel (forked emitters)

The emit phase is 29% of a self-compile, and it reads state the evaluator has
finished writing.

1. **The split.** After `codegen: collect`, the function list is final
   (`minted_during_emission` = 0). Partition it exactly the way chunked
   emission already assigns functions (`fnv1a(c_name) % N`,
   `src/codegen/chunk_assembly.yo`).
2. **The fork.** The parent emits the shared prefix: runtimes, type
   declarations, dyn box types. Then it `fork()`s N children. Child `i`
   emits the bodies of partition `i` into its own buffer and writes it to
   `<out>.part-i`, together with a header delta: every C declaration it had
   to create that the parent's prefix did not contain (a type lowered for
   the first time in a body, a string-literal pool entry, a `typeid`).
3. **The merge.** The parent waits for every child, unions the header deltas
   in a fixed order (by name), and assembles the translation units:
   - one file for a single-file build;
   - N chunks for a chunked build, which then feed P2's parallel clang
     directly.
4. **Mutation audit, the main risk.** Any state the emit phase writes and a
   later function reads must either be produced before the fork, or travel
   in the header delta. Known candidates:
   - the type-string cache;
   - the deferred-drop bookkeeping (`emitted_deferred_drop_ids` is per
     function, so safe);
   - dyn and async registration;
   - the superseded-stub rewrite in `generate_function`.

   Build the audit as a debug knob: run the emit twice, sequential and
   forked, and diff the merged C.
5. **Gates:**
   - the chunked gate's behavioural fixpoint (a P3-built compiler emits
     byte-identical C to a sequentially built one);
   - the full language suite on a P3-built compiler;
   - `--jobs 1` keeps today's in-process path bit for bit.
6. **Platforms.** POSIX hosts use `fork`. Windows keeps the sequential emit:
   the measured hosts are macOS and Linux, and a Windows port would need the
   evaluator serialized into a child process, which is P5-sized.
7. **Memory.** Children share the parent's pages copy-on-write. RC writes
   dirty the pages they touch, so a child's resident set grows with the
   objects it visits. Cap N with the same memory rule `--jobs` already uses
   (`plans/archive/BUILD_ON_8GB_MACHINES.md` Phase 3), and measure the peak
   RSS of N = 2, 4 and 8.

- **Expected:** emit at 8 workers drops from 29% to about 5% (plus fork and
  merge, measured in P0's style).

### P4: forked checking and testing of many files

`check <dir>` and `yo test <dir>` evaluate many entry files that share most
of their imports.

1. **`yo test ./tests/internal`: a fork server.** Each internal test file
   re-evaluates the compiler (about 4.5 min each; the in-process mode shares
   one evaluator and takes 37 minutes against 77, but peaks at about 10 GB).
   - Evaluate the shared closure once: the prelude, then the modules every
     internal test imports.
   - Fork one child per test file, up to N at a time. Each child evaluates
     only its own file on top of the snapshot.
   - The parent collects each child's verdict and output.
   - This is the test runner's existing `YO_TEST_IN_PROCESS` mode made
     parallel, without its shared-heap growth: each child exits and returns
     its pages.

   **Landed as `YO_TEST_FORK=N`** (opt-in, Linux and macOS; `src/main.yo`,
   `_TestForkPool`):
   - **Warm-up.** The runner runs the first file in process, exactly as
     `YO_TEST_IN_PROCESS` does. That leaves the prelude, std and the first
     file's import closure resident. No separate warm-up list: the first
     file's closure is what the in-process mode already proved safe to
     share.
   - **Workers.** Every later file runs in a `fork()` of that image, at most
     N at a time, through the same in-process compile, C compile and test
     runs. A worker writes its stdout, stderr and verdict
     (`passed failed bailed`) to three files under the temp directory, then
     `_exit`s.
   - **Replay.** The runner reaps with `waitpid(-1)` and replays each
     worker's output strictly in file order. The stream, the totals and the
     exit code are the sequential runner's. Under `--bail`, the first bailing
     file stops new launches, and the workers already running are reaped
     with their output dropped. A worker that ends without a verdict counts
     as one failed test and is named.
   - **Fork safety.** Before each fork the runner flushes stdio and tears
     down its own event loop (`__yo_io_cleanup`): an io_uring ring is a
     shared mapping, so a child that kept it would submit into the parent's
     ring. Both sides create a fresh ring at their next submission. The
     runner has no other user thread at that point: the main thread waits in
     `pthread_join` for the big-stack thread that runs `main`, and the only
     other task is the kernel's `iou-wrk` thread, measured.
   - **Off by design:** the RSS valve (`YO_TEST_MAX_RSS_MB`), `--list`, and
     Windows and wasm hosts (the knob is ignored with a note).
   - **Equivalence (2026-10-16, tree binary on develop `bc5bcf508` + this
     change, `--compile-timeout-ms 2400000`, `YO_TEST_LEAK_VERDICT=0`).**
     `YO_TEST_FORK=4` over `tests/internal` passed 1419 of 1419 in 108 files.
     The default runner over the same tree, run as four `--shard i/4` runs,
     passed 413 + 326 + 367 + 313 = 1419 of 1419. The per-file verdict lines
     match file for file. The only difference is the order of output lines
     that `concurrent_test_runs.test.yo`'s two concurrent nested runs print,
     which is nondeterministic in either mode.
   - **Full run, measured with five or six other heavy jobs on the box.**
     `YO_TEST_FORK=4` took 109.5 min, with a peak summed PSS of 14.2 GB
     (summed RSS 15.4 GB) across the runner and its workers. The four
     default-mode shards took 81.7, 119.8, 130.4 and 89.9 min (one process
     each, 2.1–2.9 GB each).
   - **Subset A/B ({{AB_SUBSET}}).** {{AB_RESULT}}
2. **`check <dir>`.** The same shape: evaluate the modules most files import,
   then fork K workers over disjoint file sets. Each worker buffers its
   diagnostics, and the parent prints them in file order.
   - P0's overlap measurement decides K and whether it pays: for `check
     ./src`, most files import the evaluator core, so the shared closure is
     most of the work.
   - It pays for `check ./tests` and `check ./std`, whose files are leaves
     over std.
3. **Gate.** The diagnostics output of `check <dir>` and `yo test <dir>` is
   byte-identical between `--jobs 1` and `--jobs N` on `./src`, `./std` and
   `./tests`.

### P5: a threaded evaluator (research; only if P1–P4 leave evaluation dominant)

After P1–P4, a self-build is mostly evaluation, and evaluation itself would be
next. That needs §2's four constraints removed, in this order:

1. **A context object instead of globals.**
   - Move the 576 module-level globals into an explicit `CompilerSession`
     the evaluator threads through.
   - Each piece is then marked per-thread, shared-immutable after a phase,
     or shared-mutable behind a lock.
   - It is useful on its own: the watch-mode and in-process test runners
     re-use one evaluator across rounds, and a session object can be reset
     as a whole instead of global by global.
2. **Frozen trees.**
   - After the prelude and std are evaluated, freeze their `AstExpr`,
     `TypeValue` and `EvalValue` graphs: set an immortal bit that makes
     `dup` and `drop` no-ops.
   - Threads then share them with no count traffic.
   - Measure the single-threaded cost of the extra branch in `dup` and
     `drop` first; the RC hot path was 54% of a self-compile once
     (`CHUNKED_C_EMISSION.md`).
3. **Content-stable names and deterministic merges.**
   - Function symbols named by content hash instead of registration order;
     diagnostics sorted by source position before printing.
   - This also makes P2's `.o` cache hit on ordinary source edits.
4. **Parallel function bodies.**
   - With signatures resolved, check function bodies on a work-stealing
     pool. Each body writes only its own `ExprInfo` range.
   - Specialization and memo tables become sharded maps with
     first-writer-wins insertion.

**Expected:** unknown until 1–3 exist. The reference point is rustc's
parallel front end (nightly, 2023), which reports up to about 50% lower wall
time at 8 threads.

## 4. Expected effect (estimates from §1's shares; P0 replaces them)

| Stage | Self-build share it acts on | After |
| --- | ---: | --- |
| today | 100% | 1.0× |
| P1.2 tables | 17% of evaluation (≈6.5% of a build) | ≈0.94× time |
| P2 chunked C (8 jobs) | 27% | C leg ≈ 7% |
| P3 forked emit (8 workers) | 29% | emit ≈ 5% |
| P1–P3 combined | | ≈ 0.5× time (about 2× faster) |
| P5 threaded evaluator, at rustc's ratio | ≈ 45% left | up to a further ≈ 0.75× |

P1.1 (release mimalloc) multiplies every row: `check ./src` 292 s → 202 s (§1).

`check ./src` gains only from P1 and P4, because it runs no codegen.

## 5. Order and dependencies

1. **P0 and P1.1 now.** They are independent of the values-by-default work.
2. **P2 is a `build.yo` change plus a decision.** It can land any time after
   P0.
3. **P1.2 and P3 touch the evaluator and codegen.** They wait until
   VALUES_BY_DEFAULT is done (maintainer, 2026-10-15: evaluator performance
   after VBD), so they do not rebase against V2b and V4.
4. **P4's test fork server** is independent of VBD. It shortens every
   `tests/internal` gate, which helps VBD's own gates. It is the one
   evaluator-adjacent item worth doing early.
5. **P5 comes after decision 43 and V5**, once the evaluator's data
   structures stop changing.

## 6. Risks

- **Copy-on-write is not free with reference counting.** A forked child that
  only reads still writes count fields, so it dirties every page it visits.
  P3's and P4's memory measurements decide N. On an 8 GB machine the memory
  cap may hold N at 1–2.
- **Merge order is a correctness surface.** Any state the emit phase creates
  while emitting a body must be in the header delta, or a chunk references an
  undeclared C name. The forked-against-sequential diff knob (P3 step 4) is
  how that is found, before CI finds it.
- **Two emit paths** (forked and sequential, plus Windows) must stay
  equivalent. `--jobs 1` stays the reference, and the gate compares against
  it.
