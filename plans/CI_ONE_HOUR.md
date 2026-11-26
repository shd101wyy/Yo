# CI in about an hour

**Status: ACTIVE.** Phase 1 (identical coverage) is implemented in `test.yml` by the PR that adds this
plan. Phase 2 (engineering, identical coverage) is proposed. Phase 3 is the maintainer decisions (§7): every
item that changes what a battery covers or costs money. Measured
2026-11-26 on develop batteries 45417105015, 45460102665, 45513685564, 45604698557, 45652683010 and
45674049929 (all green, heads c0f92a85f to 5c985877d).

The maintainer asked whether the whole CI can take about an hour. Short answer:

- **Not with today's per-push coverage on free runners.** Two things bound it, whatever the job layout. The
  account runs at most 40 jobs at once (observed peak 37-38; GitHub's documented Pro limit is 40) and at most
  5 macOS jobs. One battery is ~2,700 runner-minutes, so even perfect packing needs ~70 minutes. The macOS
  Intel leg alone holds ~230 runner-minutes of tests on the 3 macOS slots it can get, and it cannot start
  before a tree-built compiler has been cross-emitted for it (~50-75 minutes in).
- **Phase 1 (this branch) changes no coverage.** It cuts the tail and roughly 15-25 minutes off the median:
  from a median of 182 minutes (range 164-209) to ~150-165 minutes. The macOS chain is then the battery's only
  long pole.
- **About 60-75 minutes is reachable for a merge-critical core battery.** It takes decision D2 (the native
  macOS/Windows and Linux-arm legs move to their own develop workflow that still runs on every develop push),
  decision D1 and the phase 2 engineering. Projected: ~96 minutes on a cold build, ~68 when the compiler inputs
  are unchanged and the build cache hits. The moved native workflow runs ~145 minutes beside it.

| Battery                                                          | Wall time (min)          | Runner-min |
| ---------------------------------------------------------------- | ------------------------ | ---------- |
| Today (6 green develop batteries)                                | 164-209, median 182      | ~2,700     |
| Phase 1, implemented (identical coverage)                        | ~150-165 (sim. 168)      | ~2,900     |
| Phase 2, engineering only (identical coverage), build-cache miss | ~150-165                 | ~2,950     |
| Phase 2, build-cache hit (~40% of develop commits)               | ~125                     | ~2,700     |
| Phase 2 + D1                                                     | ~160                     | ~2,950     |
| Phase 2 + D1 + D3 (two test processes per runner)                | ~130                     | ~2,650     |
| Core battery: phase 2 + D1 + D2, cache miss / hit                | ~96 / ~68                | ~1,900     |
| The moved native workflow (D2), beside it                        | ~145                     | ~950       |

The simulated figures come from a list scheduler over the measured job DAG (40-job cap, 5-macOS cap, FIFO by
ready time, median durations). It reproduces today's battery at 178 minutes against the measured 164-209. Each
battery runs only after the previous develop battery: develop runs queue (§8), so a merge's verdict arrives
after the queue plus the wall time.

## 1. What a battery is made of today

**Measurements.** Per-job and per-step times come from `gh api repos/:owner/:repo/actions/runs/<id>/jobs`.
Per-file and per-test times come from the job logs (`/actions/jobs/<id>/logs`). Times are minutes after the
battery's first job started. Queue wait is a job's `started_at` minus its `created_at`, which is when its
dependencies finished.

**Shape.** 66 jobs. The `changes` and `tree-hygiene` jobs fan out at once into:

- the compiler builds: `stage1`, `suite-candidate`, the two `test` build legs, the five wasm/wasi jobs (each
  builds its own stage 1) and the musl leg;
- after `stage1` (~31 min), 21 jobs: 8 `tests/internal` shards, origins, FV ×2, the self-test, the hollow sweep,
  the fixpoint and the short jobs;
- after `suite-candidate` (~59 min), the 4 cross-emits and the chunked gate. After the cross-emits (~75-86 min),
  16 native legs: macOS ×6, Windows x64 ×4, Windows arm64 ×4.

**Runner-minutes per battery** (median of the six batteries):

| Group                                    | Runner-min | Of which compiler builds and emits |
| ---------------------------------------- | ---------- | ---------------------------------- |
| `tests/internal`, 8 shards               | 604        | ~5-12 min re-evaluating the compiler per file, 110 files |
| test-native Windows (8 legs)             | 372        | 4-7 min native compile per leg     |
| test-native macOS (6 legs)               | 330        | 3-11 min native compile per leg    |
| wasm / wasi (5 jobs)                     | 262        | ~125 (five seed builds of stage 1) |
| Formal verification (2 legs)             | 170        | ~45 (five batch compiles)          |
| Linux suite shards (8)                   | 163        |                                    |
| `test` build legs (2)                    | 121        | all of it (stage 1 + stage 2 twice) |
| origins                                  | 104        |                                    |
| chunked gate                             | 92         | all of it (four full compiles)     |
| cross-emit (4)                           | 74         | all of it                          |
| self-test, hollow sweep                  | 129        |                                    |
| fixpoint, stage 3, ratchet, 8 GB build   | 113        | most of it                         |
| `suite-candidate`, `stage1`, musl        | 119        | all of it                          |
| other                                    | 41         |                                    |
| **total**                                | **~2,700** | **~550 in builds that repeat another job's work** |

**Two runner limits shape everything:**

- **macOS: 5 concurrent jobs per account.** Every one of the six batteries peaked at exactly 5 macOS jobs.
  `test-native` has 6 macOS legs, so one leg waits for another to finish: 32, 51 and 45 min of queue on
  batteries 45674049929, 45652683010 and 45604698557. The waiting leg is the battery's last job in each of
  those.
- **All jobs: 40 concurrent** (observed peaks 33-37 with no Linux queueing). A develop battery and a PR battery
  running together share these 40 and the 5 macOS slots. In the simulation, a PR battery holding 15 slots
  delays phase 1's critical path by ~18 min.

## 2. The critical path today

Measured end times are minutes into the battery: min to max over the six batteries, median in parentheses.

| Chain                                                                                          | Ends at             |
| ---------------------------------------------------------------------------------------------- | ------------------- |
| `suite-candidate` 58-64 → cross-emit 17-21 → macOS legs (+ the 6th leg's queue)                | **164-209** (~180)  |
| `suite-candidate` → chunked gate 93-115                                                        | 150-175             |
| `stage1` 24-34 → FV list-model 85-128                                                          | 120-161             |
| `stage1` → origins 103-110                                                                     | 136-145             |
| `stage1` → `tests/internal` shards 63-105                                                      | 95-140              |
| `test` arm 67-73 → suite shards 23-29                                                          | 95-101              |
| `stage1` → fixpoint 27 → memory ratchet 44-51                                                  | 105-112             |
| `stage1` → self-test 70-78; hollow sweep 55-68                                                 | 89-108              |
| wasm / wasi (own seed build + tests)                                                           | 53-69               |

The native legs start when all four cross-emits finish, at 71-86 min. The last macOS leg then ends 78-128 min
later (median ~100). The Windows legs end 55-65 min after their start.

## 3. Where each long job's time goes, and its lever

| Job | Today | Where the time goes (measured) | Lever | After |
| --- | --- | --- | --- | --- |
| macOS legs (6) | Intel shards 46-94 each, arm shards 31-56; one leg queues 0-51 | Intel: 11 min native compile + 50-75 min of tests per quarter. Arm: 2-6 + 28-48 per half. The 6th leg waits for a macOS slot | **P1:** 5 legs (arm 2 + Intel 3), so none waits. Phase 3: D1 starts them ~25 min sooner, D3 halves the tests, D5 adds larger runners | Last leg ~76-95 after start (today 78-128) |
| `suite-candidate` | 58-64 | seed `yo compile -o` 28-36 (emit and cc in one process) + stage 2 22-29 | **P1:** stage 1 through the split route the `test` and wasm jobs use (17-33). Phase 2: the build cache | ~54 (~4 on a cache hit) |
| cross-emit (4) | 17-21 each | one full-tree emit per target | D1: emit with `stage1`, ~25 min sooner | |
| chunked gate | 93-115 | four sequential full compiles: build single 20, build chunked 19, single self-emit 27, chunked self-emit 27 | **P1:** two parallel legs (each one build + one emit) and a 2-min comparison job | ~50 + 3 |
| FV list-model | 85-128 | 10 min batch compile, then 39 tests of 1-4 min each (in-process evaluation at `-O0` + ASan) | **P1:** the 39 tests striped 3 ways by name. D4 (`-O1` test binaries) would cut the run part ~2-3x | ~40 |
| FV harness | 78-87 | four files back to back: 5 + 33 + 20 + 24 (each ~12 min of batch compile) | **P1:** 3 legs: harness (unit + assumed + `yo verify`), negative, refine | ~25-36 |
| origins | 103-110 | G-B 71-77 (552 programs: `yo check` each, ASan compile+run for the positives); G-A 8, G-E totality 13, target set 9 | **P1:** G-B striped 4 ways (`SHARD=i/n`), plus one leg for G-A/G-E | ~23 and ~33 |
| `tests/internal` (8) | 63-105 each | each of 110 files re-evaluates the compiler: 5-12 min of Yo compile, then clang + run; ~545 min of slowest-sample time in all | Phase 2: more shards once the slot budget allows (12 → ~60 min, 16 → ~45). D6: in-process or forked compiles | ~45-60 |
| self-test | 70-78 | GATE 7 (464 cli-cases) is 46 min of it; GATE 4 (`check ./src`) 11 | Phase 2: GATE 7 striped across 3 jobs (cases are sandboxed) | ~27 + 3 × ~19 |
| hollow sweep | 55-68 | 188 language files through stage 1, serially | Phase 2: 2 stripes, allowlist filtered per stripe | ~34 |
| memory ratchet | 44-51 | allocation-count measurement 34, check-RSS measurement 10, rebuild 6 | Phase 2: the two measurements in two jobs | ~37 |
| `test` arm leg | 67-73 | native seed stage 1 (35-39) + stage 2 (30-34) on arm64 | D7: cross-emit arm64 C instead (drops "the arm64 seed builds the tree natively") | |
| wasm / wasi | 53-69 | own seed stage-1 build 17-33, tests 15-33 | Phase 2: download `yo-stage1` (saves ~125 runner-min; wall unchanged, these sit off the critical path) | |
| Windows legs (8) | 40-65 | 4-7 compile + ASan suite (x64) or plain suite (arm64) | Phase 2: 6 shards per arch when the slot budget allows | ~35-45 |

## 4. Constraints every phase must respect

- **The seed build is the floor of every tree-compiler job.** Every test of the tree's compiler waits for a
  seed-built stage 1: 24-34 min on a 16 GB runner, which swaps (the self-emit peaks at 12-15 GB). Nothing
  under the same free runner gets it below ~25 min, except the cache, which skips it.
- **The 40-job cap makes sharding a trade.** Each shard repeats a 2-4 min setup and, for compiler-sized
  files, its batch compile. Past ~40 concurrent jobs, a new shard delays someone else's job. Phase 1 keeps the
  simulated peak at 37.
- **Runner speed varies up to 2x within one battery**, worst on macOS Intel (44-99 min for the same quarter in
  2026-11). Budgets are set against the slowest sample, as `differential-shard-weights.tsv` does.
- **macOS Intel runners are lost mid-job ~5% of the time**
  (`issues/2026-11-05-the-macos-26-intel-test-runner-repeatedly-loses-communication.md`). Three longer Intel
  legs expose about the same runner-minutes as four shorter ones, so the per-battery loss rate barely moves. A
  lost leg costs one rerun of ~80 min instead of ~60.
- **Fail-slow stays.** No change here adds `fail-fast`, and every new job joins `merge-gate`'s `needs:`.

## 5. Phase 1: implemented (identical coverage)

Every item runs the same commands on the same inputs. It only moves work between runners or orders it
differently.

1. **macOS legs fit the 5-job cap.** `test-native` has `macos-latest` ×2 and `macos-26-intel` ×3 (was ×4):
   the same files, striped by the existing `--shard i/n`.
2. **The chunked gate runs as two parallel legs plus a scorer.** `chunked-gate` is a `side: [single, chunked]`
   matrix. Each leg builds one compiler and emits its C (`scripts/bootstrap/chunked_gate.sh` `SIDE=single` /
   `SIDE=chunked`, the unchanged commands) and uploads it. The new `chunked-gate-compare` job runs the unchanged
   hollow count and byte comparison (`SIDE=compare`). Both legs use the same checkout path and candidate, as the
   fixpoint's stage-3 comparison already does across runners. The script without `SIDE` behaves as before.
3. **Formal verification runs as six legs.** The parts are `harness` (unit tests, assumed-contract tests and
   the `yo verify` steps), `negative`, `refine`, and `list-model` ×3. The list-model legs each run one stripe
   of `verifier-list-len.test.yo`'s tests: `scripts/test-name-shard.sh` builds an anchored, escaped
   `--test-name-pattern` from `yo test --list` and fails unless `--list` with that pattern selects exactly its
   stripe. Checked locally on every test file with three or more tests: the three stripes always partition the
   file.
4. **The origins job runs as five legs.** The `gates` leg runs G-E's grep gate, G-A today, G-E totality and the
   informational target set. Four `unsound` legs each run a G-B stripe (`SHARD=i/n` in
   `scripts/origins-unsound.sh`, over the byte-sorted program list; unset means every program, as before).
5. **`suite-candidate` builds its stage 1 through the split route** (`.github/actions/build-stage1`: the seed
   emits C and exits, then clang compiles it). Same flags as before; stage 2 and the uploaded candidate are
   built by the unchanged commands.

Left out of phase 1 because they are not on today's critical path, and each extra job costs a slot under the
40-job cap: more `tests/internal` shards, the self-test and hollow-sweep splits, and the ratchet split
(phase 2).

**Expected effect.** The candidate → cross-emit → macOS chain shortens by ~5 min (split route). The last macOS
leg ends ~76-95 min after its start, where the queue made it 78-128 today. The chunked gate drops from
93-115 to ~53, FV from 85-128 to ~40, origins from 103-110 to ~35. The battery becomes ~150-165 min, bounded
by one chain: candidate (~54) → cross-emit (~20) → Intel thirds (~76-95). Runner-minutes rise ~7% (~2,900):
the new legs' setups plus three extra 10-min batch compiles of `verifier-list-len`.

## 6. Phase 2: engineering with identical coverage

1. **A build cache keyed on the compiler's inputs.** Cache `yo-stage1`, the candidate and the four
   cross-emitted C files under a key that hashes everything that reaches the binary: `src/**`, `std/**`,
   `build.yo`, `yo.toml`, `yo.lock`, `vendor/**` (submodule SHAs), `SEED_VERSION`, the runner image's clang
   version and the exact build command lines. The build jobs restore on a hit and skip the build steps. A PR can
   restore develop's entries.

   On develop, 24 of the last 60 first-parent commits touched none of those inputs (tests, scripts, docs,
   issues, workflows). Hits are rarer on collapsed develop batteries than on PRs.

   Coverage is unchanged: the cached binary is byte-for-byte what the build would produce, and "the seed builds
   this tree" was proven by the battery that stored it. The risk is a key that misses an input, so the first
   version should also rebuild on a schedule and compare.
2. **Stop rebuilding the same compiler.**
   - The wasm/wasi jobs download `yo-stage1` instead of building it five times (~125 runner-min).
   - The `ubuntu-latest` `test` leg builds the same stage 1 and stage 2 as `stage1` + `suite-candidate`. It can
     download the candidate as its stage 2, keeping fmt, doc imports and the smoke (~40 runner-min). It stays
     the route that proves the split build, unless `suite-candidate` (phase 1 item 5) is accepted as that proof.

   Wall time does not move. The point is to free slots under the 40-job cap for item 3.
3. **Spend the freed slots on the long legs.** `tests/internal` to 12 shards (`differential_shard.sh` already
   balances by measured minutes). Windows to 6 shards per arch. GATE 7 of the self-test as 3 cli-case stripes:
   `gates_fast.sh` skips GATE 7 under an environment flag, and a new job passes its stripe's case names to
   `cli-diff-test.sh`, which already accepts names. The hollow sweep as 2 stripes, with the `known-failing.tsv`
   comparison restricted to the stripe's files. The ratchet's two measurements in two jobs.
4. **Per-test durations as weights.** `test-name-shard.sh` and `--shard` stripe by position. Feeding measured
   per-file and per-test minutes to them, as `differential-shard-weights.tsv` does for `tests/internal`, would
   even out the Intel and FV stripes.

Phase 2 does not move the full-coverage wall time much on a cache miss: the macOS Intel chain stays the bound
(simulated ~165). It cuts runner-minutes and tails, gives ~125 on a cache hit, and is the base the decisions
build on.

## 7. Phase 3: maintainer decisions (each changes coverage or costs money)

| # | Decision | Saves | Coverage trade-off | Recommendation |
| --- | --- | --- | --- | --- |
| D1 | Cross-emit (and run the chunked gate) with the seed-built `stage1` instead of the stage-2 candidate | ~25-30 min on the native chain; ~25 on the chunked chain | Today the C reaching macOS/Windows is emitted by a compiler that the tree's codegen compiled. Under D1 it is emitted by the seed-compiled stage 1. Both run the tree's codegen; the emitted C differs only if the seed miscompiled the emitter. The fixpoint job checks that only for the host target, so a seed miscompile in a target-specific emitter path (e.g. the macOS runtime emitter) would ship to the native legs unseen until the next seed | **Adopt.** The fixpoint gates the same battery, and D1 tests the route that ships: release.yml's `seed-cross-emit` emits the released macOS/Windows C with a seed-built stage 1 (`yo compile -o yo-candidate`), not a stage 2 |
| D2 | Move the native legs (macOS ×5, Windows ×8, the Linux arm64 `test` leg and its suite shards) to their own workflow. It runs on every develop push and keeps its own concurrency group, but is not in `merge-gate` | the core battery drops to ~96 min (~68 on a cache hit) | Develop coverage is unchanged: every push still runs every leg, in a second workflow. Only the core battery's verdict arrives without the native result; the native verdict lands ~145 min after the push. Since PRs merge on Tier 1 and develop's battery is the full check, the release rule must read "both workflows green on the exact tip" | **Adopt, with the release check covering both workflows.** This is the only free-runner route to ~60-75 min |
| D3 | Run two test processes per runner in the suite legs (a real `--parallel` in `yo test`, or two `--shard` stripes per job) | ~30-40% of each suite leg; the macOS Intel thirds drop to ~50 min | Tests that bind fixed ports, `/tmp` names or global state can interfere, and a test green alone could turn flaky, or the reverse. Detection power is unchanged once the suite is clean under concurrency | **Adopt after a validation battery.** Run the corpus twice in parallel on each OS and fix every collision first. It is also the cheapest route for macOS Intel |
| D4 | Compile `tests/internal` and FV test batches at `-O1` (ASan kept) | FV list-model's 75 min of test runtime → ~25-35; similar on in-process-heavy internal files | ASan at `-O1` is the configuration ASan recommends. It can miss uninitialized-stack patterns `-O0` exposes, and catch some it does not | Measure on the FV legs first; adopt if the run part drops ≥2x |
| D5 | Paid larger runners: Linux 16-core / 64 GB for `stage1`, `suite-candidate`, the cross-emits, the chunked legs and the fixpoint; macOS large (Intel 12-core) for the Intel legs | Linux: no swap during the 12-15 GB self-emits, and the chunked build's cc fans out. The evaluator is single-threaded, so expect ~1.3-2x on builds; unmeasured. macOS large: 3x the cores, so with D3 ~3x on the Intel legs | None | **Measure before buying.** Dispatch the build jobs once on a 16-core runner. Cost scales with minutes: ~160 runner-min of builds per battery at the 16-core rate, plus ~230 Intel minutes at the macOS-large rate, times ~6-10 develop batteries a day plus PR batteries. Check current GitHub larger-runner pricing; the account is user-owned, so org-only plans (Team, 60 jobs) need a move to an organization |
| D6 | `tests/internal` through one resident evaluator per shard (`YO_TEST_IN_PROCESS=1` with a high `YO_TEST_MAX_RSS_MB`, or `YO_TEST_FORK`) | about half of the ~600 runner-min | The batch compile path changes from a child process to in-process: a hollow-batch regression in that path would show as hollow batches, and the in-process path is opt-in today (testing.instructions.md) | Trial on one shard and compare verdicts and hollow counts; adopt only with the hollow check kept |
| D7 | The Linux arm64 leg runs a cross-emitted compiler, like macOS and Windows, instead of building stage 1 and stage 2 natively | ~60 min on that leg (it is off the critical path today) | Drops "the arm64 seed bundle builds the tree natively on arm64"; the release workflow still builds that bundle | Defer: only needed if D2 is rejected and the arm leg becomes the core battery's bound |
| D8 | A scheduled or nightly run instead of per-push for any slow leg | everything that leg costs | A regression in that leg is found hours later, attributed across many merges | **Reject in favour of D2**, which keeps per-push runs and only takes the leg out of the merge-critical verdict |

## 8. Develop batteries queue behind each other

`test.yml`'s concurrency group is per ref with `cancel-in-progress` only for pull requests. A develop battery
that has started always finishes. GitHub keeps one pending run per group, so a burst of merges collapses into
one pending battery at the newest tip, which waits for the running one: battery 45674049929 waited ~2.5 h
before its 2 h 45 min run.

| Option | Effect | Recommendation |
| --- | --- | --- |
| Shorten the battery (this plan) | The queue wait shrinks with the run: at most one battery's length | Yes |
| D2's split | The core and native workflows queue separately, so the fast verdict never waits behind a slow native battery | Yes, with D2 |
| A per-SHA group (batteries overlap) | Every tip gets its own battery, but two batteries share 40 slots and 5 macOS slots, so both run ~1.5x slower | No |
| `cancel-in-progress` on develop | The newest tip starts at once, but a merge storm can leave no tip with a finished battery (the 2026-09-12 failure recorded in `test.yml`) | No |
| Cancel stale PR batteries promptly (AGENTS.md "CI runs") | Frees slots for the develop battery | Already the rule; it matters more as batteries share 40 slots |

## 9. Runner-minute cost

GitHub-hosted runners are free for a public repository, so runner-minutes cost wall time (the 40-job cap), not
money, unless D5 is adopted.

| Phase | Runner-min per battery | Note |
| --- | --- | --- |
| Today | ~2,700 | ~550 of it repeats another job's build |
| Phase 1 | ~2,900 | +~60 setup of the new legs, +20 extra batch compiles of `verifier-list-len` |
| Phase 2 (miss / hit) | ~2,950 / ~2,700 | dedup −165, more shards +~150; a cache hit skips ~250 of builds |
| Core + native (D1 + D2) | ~1,900 + ~950 | split across two workflows |

## 10. Verification

Phase 1 is checked by:

- `actionlint`: no new finding against develop's `test.yml`; the only diff is one fewer unknown
  `macos-26-intel` label line.
- `shellcheck`: clean on the three changed scripts.
- `merge-gate` needs every job except `docs-checks`, which is report-only by design, as on develop.
- Dry runs of `chunked_gate.sh` in every `SIDE`, against a stub compiler: identical, then differing emissions.
- `origins-unsound.sh` stripes: 4 × 138 = 552 programs, each counted once.
- `test-name-shard.sh` stripes: every multi-test file partitions.

The draft PR's battery is the end-to-end check. Its measured wall time is recorded in the PR.
