# VALUES_BY_DEFAULT handover — 2026-10-20 (after v0.2.67)

> **Status: CLOSED record of the v0.2.67 cycle; the next agent starts v0.2.68 from §0.**
> It continues `plans/handover/VBD_HANDOVER_2026-10-19.md` (its §1 process rules and §1.1 lessons
> still apply) and `plans/handover/VBD_HANDOVER_2026-10-17.md` (§7 release-notes format). The
> release-by-release plan for the rest of the campaign is `plans/handover/VBD_RELEASE_SCHEDULE.md`;
> `plans/VALUES_BY_DEFAULT.md` stays authoritative.

## 0. Start here — on the 64 GB box

v0.2.67 was cut on the 16 GB Mac. **v0.2.68 moves to the 64 GB / 32-thread AMD Ryzen AI Max+ 395 box**
(Linux under WSL, the machine v0.2.66 was cut on; maintainer, 2026-10-20). The move buys parallel
heavy slots, the memory the B1 regeneration needs, and Linux numbers — CI's memory ratchet is Linux.
Per-job latency does not improve (the evaluator is mostly single-threaded; the M4's single core is as fast).

### 0.1 Machine setup (once)

1. `~/Workspace/Yo-wt/heavy-lock.conf`: `HEAVY_SLOTS=6` (the Mac used 3) and `HEAVY_MIN_AVAIL_MB=12288` (a stage-2 emit
   peaks near 10 GB, and admission checks memory only once). Every session on the box must agree. A ticket label containing
   "measure", "timed", "profile", "sample" or "A/B" counts as EXCLUSIVE: an attribution job labelled "build+measure" held
   the whole box for 30 minutes on 2026-10-20 before the label was renamed.
2. **Long background steps get SIGKILLed (exit 137)** — mid-run and while queued in the heavy lock. Run every
   long step detached: `setsid bash -c '…' > log 2>&1 &`, then poll the log.
3. **clang comes from the repo's nix shell** (a WSL update removed the system one):
   `nix develop . --command bash -c 'yo build --std-path ./std --cc clang'`. Run the binaries you build inside
   the same wrapper — outside it the nix-glibc/system-lib mix dies on `allocate_stack: size != 0`.
4. Install the newest seed: `yo --version` must say `0.2.67` (`bash scripts/install.sh`, `--no-deps` on nix).
5. Agent caps on this box (maintainer, 2026-10-20): at most **10 subagents** and **6 concurrent heavy tasks** (the Mac's
   16 GB caps were ≤7 and 3).

### 0.2 First tasks, in order

1. **§3.1 sharing prerequisites** (2026-10-19 handover §3.1/§4.2; maintainer 2026-10-20: right after the cut).
   Intern or `Rc`-share `module_path` + `input_string` FIRST and alone, with an `exclusive` heavy-lock
   before/after `check ./src` time and max RSS; then shared envs at the adopt sites, shared `TypeValue`
   label/type lists, and the read-by-clone mut-global caches (`synthetic_token`,
   `_stable_type_id_owner_memo`), each measured.
   This work also owes the v0.2.67 ratchet re-baseline (§2.1): attribute the +38 MB of `check src/main.yo`
   RSS the cycle added (1,061,416 → 1,099,472 kB, Linux CI) per PR and reclaim it.
2. **Gate and land the pushed prep branches** (§2.3) — each needs its first build:
   `feat/explicit-copy-guards`, then the `Acyclic` stack (`perf/acyclic-compiler-containers` on #1486).
   The `Acyclic` stack must be rebased onto develop (#1501 re-keyed enum identity) and its probe table
   re-run BEFORE any RSS number is read; then the Linux `check src/main.yo` RSS against
   `scripts/bootstrap/memory-ratchet.tsv` decides whether #1486 lands as-is.
3. **The B1 regeneration** (listing-heavy, `--hot-path src/evaluator`, from a clean-tree binary). It needs
   ~45 GB of headroom if it regresses again — only this box can run it.
4. Then the schedule's v0.2.68 row (`VBD_RELEASE_SCHEDULE.md` §1).

## 1. Maintainer directives this cycle (2026-10-20)

- **Delete user macros and `Iso`** (PR #1488, written by the maintainer, reviewed three ways, taken over,
  revised, merged as `plans/backlog/MACRO_AND_ISO_REMOVAL.md`). Iso removal (Part A) waits for V2b B8–B11:
  today `Iso` is the only safe cross-thread move of a `String`/collection. The campaign adds no release
  boundary (its Schedule section).
- **The Iso `Send` hole is filed, not fixed**: `issues/2026-10-20-an-iso-graph-holding-a-non-send-handle-crosses-threads.md`
  (S2). `Iso(T)` is `Send` for every `T`, so `^w` moves a graph holding `Io`/`JoinHandle` across threads.
  The window is accepted until Part A; it never widens, because Part A precedes decision 43 step 2.
- **#1486 deferred past v0.2.67**: +20 % `check src/main.yo` RSS (48 compiler containers newly registered with
  the collector; the ratchet job failed). Recover with the `Acyclic` declarations first.
- **Open schedule questions were delegated** ("consult with your advisor to pick the best solution that fits
  Yo"): the picks are `VBD_RELEASE_SCHEDULE.md` §5 "Decided 2026-10-20" — V2c one PR; decision 47 locals
  Gen B at v0.2.72; `RefCell.get`/`get_mut` wait for decision 43 step 2; the V3 std half splits (cell-free
  resources at v0.2.70, every `atomic(...)` type with V5 Gen A); `__yo_cell` as a named Gen A PR in the
  v0.2.71 cut; V5 Gen A at v0.2.72 after decision 43 step 1 (ceiling v0.2.73); `--hot-path` has no default;
  macro-plan B3 deletes `from_array`; the `Acyclic` stack rules.
- **CI: only the develop tip's battery matters for a cut** — superseded develop batteries are cancelled
  (a sweeper did this every 4 min this cycle; §4.1). Never `Release`, `ubsan.yml`, `fixpoint-arm64.yml`.
- Admin merges and Yo / markdown_yo patch releases stay pre-authorized.

## 2. Where everything stands

### 2.1 v0.2.67

- **Battery:** develop `7def2203b` (#1510, the maintainer-approved re-baseline of the `check src/main.yo` RSS ratchet,
  973,268 → 1,099,472 kB) ran green as run 39417930151; the previous tip's battery had been green except that ratchet.
  The battery-head diff (`git diff --stat 7def2203b..origin/develop -- src/ std/ tests/ .github/ scripts/ build.yo`) was empty at dispatch.
- **Release run:** 39434915219 (`bump=patch`, dispatched 2026-10-20 from the 64 GB box after the cutting session handed over),
  every job green on the first attempt (release, the two static musl bundles, four cross-emits, four seed bundles, portable `yo.c`,
  publish, SEED bump, site deploy).
- **Tag:** `v0.2.67` → `f2be3282a` (`chore: bump version to 0.2.67 [skip ci]`), the commit the bundles were built from;
  published 2026-10-20T15:37:28Z. 13 assets, the same set as v0.2.66: `.tar.gz` bundles for
  aarch64/x86_64 apple-darwin, pc-windows-msvc and unknown-linux-musl, `.c.gz` single-file C for aarch64/x86_64 apple-darwin,
  pc-windows-msvc and unknown-linux-gnu, and `yolang-0.2.67.vsix`. The 63 diagnostic codes are unique at the tag.
- **SEED bump:** `d18b3a274` (`ci: bump SEED_VERSION to v0.2.67`) moved all five pins (`test.yml`, `release.yml`, `ubsan.yml`,
  `fixpoint-arm64.yml`, `leak-verdict.yml`); its battery, run 39450161481, is the first to run S1 on the new codegen and ran
  uncancelled; every job was green except three macOS-intel suite shards still running when this handover merged (maintainer, 2026-10-21: do not wait for it).

### 2.2 Merge ledger (v0.2.66 tag → v0.2.67)

- **Fixed (S1):** #1508 (a combinator specialized for a first-class future skipped a borrowing operand's
  checks — a write through a borrow of a dropped local). #1485 also closed the 2026-10-19 S1 record of the
  #1476 regression.
- **Fixed (S2):** #1485 (#1476 re-land: closure/pattern/fn-literal parameters shadowing a live borrow), #1484
  (Windows AF_UNIX accept), #1496 (fixed-array literal of runtime elements), #1500 (phantom type argument;
  the nested-index read half), #1501 (recursive-enum identity), #1503 + #1506 (capture structs per
  instantiation / per producer future), #1504 (substitution occurs check — the ArrayList same-named binder),
  #1507 (CTFE memo compares enum type arguments).
- **Fixed (S3):** #1493 (`check` of a verify file with `match`), #1494 (env-independent temp_dir/TZ tests),
  #1495 (non-routable connect test mitigation; its issue stays open), #1502 (where-bound dedupe).
- **Features / Generation B on the v0.2.66 seed:** #1509 (A4 std half: `timeout`/`select` over `Io` futures —
  BREAKING: no `JoinHandle` operand), #1497 (IterPeekable conditional `Copy`), #1491 (`build.manifest()`),
  #1490, #1498, #1492.
- **Docs/plans:** #1483 (decision 43 amended), #1487, #1489, #1488 (macro/Iso plan), #1499, #1505.

### 2.3 Pushed branches (no PR merged)

| Branch | State | Next |
| --- | --- | --- |
| `fix/linkedlist-managed-element-cycles` (draft #1486) | correct, Tier 1 green; +20 % check RSS | lands with the `Acyclic` stack |
| `perf/acyclic-compiler-containers` | stacked on #1486; decision-21 declarations on the AstExpr/VcSort/VcTerm families; regression test 24/24 with #1486's binary; never built | rebase onto develop, re-probe, build, measure (§0.2 step 2) |
| `feat/explicit-copy-guards` | dying-temporary-as-move + explicit `--hot-path <path>`; hand-computed cli goldens; never built | build, `check ./src`, the six explicit-copy cli cases (one must stay byte-identical), the internal files importing `src/main.yo`/`evaluator/utils.yo`. Its issue doc is already in `issues/fixed/` with gates unrun, and it edits the 2026-10-19 handover §4.2 — expect a conflict |
| `feat/v2b-genb-b1-migration` @ `e556161b0` | the parked explicit-copy sweeps (2026-10-19 handover §2.3) | do not regenerate before §0.2 step 1 lands |
| `tss/phase6-step4` (#1162) | unchanged, type-soundness track | — |

## 3. Open questions and bugs to know about

- **The cycle walk's holder asymmetry** (found by the `Acyclic` agent; not yet filed): `ref(struct(e : X))`
  with `X` a cycle-capable ref ENUM reads acyclic, while `ref(struct(y : Y))` with `Y` a ref STRUCT reads
  cyclic — the walk re-roots at ref structs only. If the enum answer is wrong it is an uncollected-cycle
  bug. Decide the predicate (VBD §3.12 "reaches an Rc") and file an issue or an `issues/questions/` doc first
  thing; it is why `SuspensionPoint` registers on #1486.
- The `Acyclic` branch (`perf/acyclic-compiler-containers`) carries an `issues/questions/` doc on whether the cycle
  walk should infer acyclicity for Self-only ref enums; it recommends NOT inferring (it lands with that branch).
- The S2/S3 issues filed this cycle are the v0.2.67 notes' known-issues list (§5).
- **Which PRs hold the cycle's +3.6 % `check` RSS** is unmeasured (§0.2 step 1). The candidates' own bodies
  name the mechanism: #1501, #1503, #1506, #1507, #1508 (one specialization per distinct operand producer),
  #1493 (+0.5 %, measured).
- Pre-cycle S1s unchanged: `a-write-through-a-string-copy-is-lost-when-the-string-was-empty` (expect V2b B8
  to remove it), the FTT stub, the self-hosted emit leak classes, the RC depth cap.

## 4. Process notes from this cycle

### 4.1 What worked

- **Implement → adversarial review → finalize-and-merge per cluster**, six clusters in one pipeline, one
  agent per item at a time (so the agent cap held), a `mkdir` merge lock under `Yo-wt` making rebase →
  overlap check → re-gate → admin-merge one critical section. 26 PRs merged in ~8.5 h on 3 heavy slots;
  every review found real defects (dead helpers, a broken issue link, overclaiming docs) before merge.
- **Lock-free prep agents** (no heavy-lock slot, no PR, no merge) used the queue time to prepare the next
  release's branches without moving develop under the release battery.
- **The CI sweeper** (`~/Workspace/Yo-wt/ci-sweep/sweep.sh`, machine-local): cancels develop
  `Build and Test` runs not on the tip and runs on branches that are neither develop nor an open PR head;
  keeps Release/ubsan/fixpoint-arm64. Stop it (`touch ~/Workspace/Yo-wt/ci-sweep/STOP`) BEFORE dispatching a
  release: the SEED-bump commit's battery is the first to run S1 on the new codegen and must not be
  cancelled by a later docs merge.

### 4.2 What cost time

- A workflow agent cannot be redirected: changing one item's scope (the Iso fix → file-only) meant stopping
  the whole workflow and relaunching. Keep items that may change scope in their own workflow.
- **A superseded develop battery hides a red short job.** The ratchet failed on 400413ac3's battery at
  05:51 (1,083,500 kB > 1,070,594) and nobody saw it. The next merges superseded that battery, and the
  sweeper cancelled them, so the failure surfaced only on the release candidate's battery four hours and
  14 merges later. When cancelling a superseded battery, first read the jobs it already finished.
- An agent's permission classifier refused raising the memory-ratchet baseline (correctly — that is the
  maintainer's call). Escalate ratchet changes instead of retrying them.

## 5. v0.2.67 release notes — final state

The published body (`gh release view v0.2.67`) keeps line 1 (`Patch release v0.2.67`) and the `## Native bundles
(bootstrap seed chain)` section byte-for-byte; `## Changes` is the curated text from the `notes/release-v0267` scratch branch
(deleted after the edit). Sections: Type checking (#1485, #1501, #1500, #1504, #1503, #1507, #1502), Compile and codegen (the S1
#1508, #1506, #1496), Async runtime (#1509 with its BREAKING `JoinHandle` note, #1484), Standard library (#1497), Build system and
verification (#1491, #1493), Compiler performance and memory (the +3.6 % `check src/main.yo` RSS and the #1510 re-baseline), and
Known open issues filed this cycle (eight `issues/` paths, each checked to exist at the tag). No `*` commit bullets, trailers or AI
attribution. The RSS bullet names the de-sharing PRs as the cause; the per-PR attribution (§0.2 step 1) is measured after the
cut, and if it disagrees the next release's notes carry a "Retracted claims" entry.
