# VALUES_BY_DEFAULT handover — 2026-10-13

**Status: SUPERSEDED by [`VBD_HANDOVER_2026-10-15.md`](VBD_HANDOVER_2026-10-15.md) (2026-10-15). That document still cites its §3 order, its §2.3 batch table and its §4 open-bug table; everything else is history.**
- **Supersedes:** [`VBD_HANDOVER_2026-10-10.md`](VBD_HANDOVER_2026-10-10.md). Its §5 ("How to work in this repository") still applies unless §1 below amends it.
- **Written:** by the agent running the campaign on 2026-10-13.
- **What it covers:** v0.2.60 and v0.2.61, the v0.2.62 batch, the branches in flight, the next steps in order, and the decisions recorded this cycle.
- **Before acting on a branch,** verify it with `git log origin/<branch>` and `gh pr list`.
- **The authoritative design** is [`plans/VALUES_BY_DEFAULT.md`](../VALUES_BY_DEFAULT.md) (decisions 1–45, phases in §6). This document points into it and does not restate it.

---

## 1. The standing goal and the maintainer's rules

The goal is unchanged: finish every phase in `plans/VALUES_BY_DEFAULT.md`. These rules were added or confirmed 2026-10-11/13; the earlier handovers' rules stand otherwise.

- **Admin merges on local gates, then fix forward on develop.** The maintainer's standing OK (2026-10-13): open the PRs, admin-merge them once their local gates pass, watch develop's battery, and fix what it finds. Cutting and dispatching patch releases is part of the same OK.
- **Three-tier gating (2026-10-14; AGENTS.md "Git: worktrees, branches, merges").** A PR is admin-merged as soon as its Tier-1 targeted local gate passes (about 20–30 min). PR batteries are not waited for. Develop's battery is the full check: watch it, and fix any red job forward. Releases still need develop green on the exact tip. Never hold the lock while idle.
- **At most 7 concurrent agents** (raised 2026-10-14), subagents and workflow agents combined.
- **While a release candidate's develop battery runs, PR runs may be cancelled** so that develop has the runners (2026-10-13). Never cancel a `Release` run. Never cancel develop's tip run without the maintainer's OK.
- **Heavy steps take the shared lock:** `source ~/Workspace/Yo-wt/heavy-lock.sh; heavy_take "<what>"; …; heavy_drop`. This covers builds, `check ./src`, the language suite, `tests/internal` files, the fixpoint and cli-diff-test. The lock is FIFO. Several agents queue on one machine, so the lock, not the agent count, is the bottleneck.
- **"Whenever we could be explicit, do explicit"** (the maintainer, re-applied this cycle). A closure into a `Dyn(Fn)` slot is `dyn(f)`. `Drop` follows Rust exactly, receiver included.

## 2. Where everything stands

### 2.1 The releases

- **v0.2.60:** E0914 always on, effect rows by value, `Index` by value (#1314, #1318, #1319).
- **v0.2.61** (published 2026-10-13; SEED_VERSION bumped in 49016882a):
  - #1322: integer helpers take their operands by value;
  - #1323: A1 move-only futures, plus A3 Generation A;
  - #1324: V2b projections and the `Index`/`IndexMut` split, Generation A;
  - #1325: async-lowering ownership fixes;
  - #1326: A2 borrowing futures, plus A6 Generation A;
  - #1327: wrapper patterns `Rc(p)`/`Arc(p)`;
  - #1328: the unique `Box(V)`;
  - #1329: V4 prep (key-based type memos, `Acyclic`);
  - develop fixes #1332, #1335 and #1342.
  - The release notes are curated.
- **v0.2.62** (dispatched 2026-10-14 from 308b66935, after develop's battery went green on that exact tip):
  - #1337: the allocator hand-off audit and the `&&`/`||` constant-fold fixes;
  - #1341: per-type value-enum drops and one `Option(E)` C type;
  - #1346: E0910 for a later argument that moves a lent place;
  - #1347: `&Self` receivers for `Clone` and the other read-only traits;
  - #1343: decision 45 Generation A, `Drop`;
  - #1331 and #1344: plans only;
  - #1348: the develop fix for `gc_runtime_atomics`, the `dispose_fn_thunk` arity #1343 changed.
  - The first battery after the batch failed one `tests/internal` shard, because #1343's local gates skipped the `tests/internal` files importing `src/codegen/functions/constructors.yo`.

### 2.2 CI changes this cycle

- **The self-hosted differential `tests/internal` job runs 6 shards,** up from 4 (#1335). Shard 0 had outgrown its 150-minute budget.
- **That job passes `--compile-timeout-ms 1200000`** (#1342). `compile.test` hit the runner's 600 s batch deadline.
- **#1329 was admin-merged without its internal shards and turned develop red.** The structural type key merged nested empty-id types. #1335 fixed it (`issues/fixed/the-structural-type-key-merges-nested-empty-id-types.md`). Before admin-merging anything that touches `src/types/`, run the `tests/internal` files that import `src/types` locally.

### 2.3 The v0.2.62 batch

The integration branch `integ/v0262b` (worktree `~/Workspace/Yo-wt/integ-v0262`; rebuilt from develop on 2026-10-14 after #1343 was rebased) is develop plus every PR below except #1339. Its gate script is `~/Workspace/Yo-wt/integ-logs/gate2.sh`: build, check src/std, every cli case (re-recording the goldens the combination shifts), fmt, issue refs, the language suite and `yo test ./std`.

| PR | What | State |
| --- | --- | --- |
| #1331 | NON_ESCAPABLE R7 audit amendments, the `depends` grammar, this handover, the V2c and decision 43 design notes | plans only; closes issue #1330 |
| #1347 | `Clone`/`ToString`/`Hash`/`Debug`/`Format`/`ToJson`/`Error.source`/`Hasher.finish` take `&Self` (#1334 folded in; reopened from #1333, which GitHub's stack link to #1334 blocked) | merged |
| #1337 | allocator hand-off audit (ArrayList(ZST) double free, `String.clone`'s allocator), plus #1340's S1 `&&`/`\|\|` constant folds | gates green; goldens re-recorded |
| #1341 | V4's codegen blockers: per-type value-enum drop functions, one `Option(E)` C type for a recursive enum (#1338 folded in) | gates green |
| #1343 | decision 45 Generation A: `Drop` beside `Dispose`, E0915, `drop(x)`, `yo fix --migrate drop-trait`; `Drop.drop` takes `self : &mut Self`, and any other receiver is rejected at the impl | gates green |
| #1344 | decision 21 amended: `TypeValue` stays an `Rc` handle (the value enum measured 2.3x `check`, 2.6x emit) | plans only |
| #1346 | S1: a later argument that moves a place an earlier argument lends to the call is E0910 | gates green |
| #1339 | decision 44 follow-up: a bare callable in a `Dyn(Fn)` slot is E0618, `yo fix --migrate dyn-spelling` | waits for #1345 (the dyn-named-fn fix, stacked on it) to fold in, then a rebase; may slip to v0.2.63 |

All of these except #1339 merged on 2026-10-14 and shipped in v0.2.62.

**Review of the batch (2026-10-14).** An adversarial-review workflow covered the five areas and their interactions. Each finding was re-reproduced and checked against v0.2.61.
- **New in the batch:** S2 and S3 defects in Drop Generation A. The Drop follow-ups agent fixes them.
- **Inherited:** three S1 holes in E0910 (operator sugar, defaulted parameters, a `&x.f` argument overwritten later), fixed by the E0910 agent. The other inherited findings are filed as issues.
- The evidence is in the session scratchpad's `review-v0262.json` and in the probes under `~/Workspace/Yo-wt/review-v0262/`.

### 2.4 In flight (agents, 2026-10-14), all for v0.2.63

- **V3 Generation B** (#1349, local gates green): the maintainer said to admin-merge it on its local gates once v0.2.62 is out. **#1350** (another session's OWNERSHIP_AND_BORROWING draft catch-up): admin-merge as-is after the release.
- **V2b Generation B** (branch `feat/vbd-v2b-genb-r2`): ten mode-only `src/` write sites; its gate is queued.
- **V1 step 2 Generation B and decision 31 Generation B:** gates running.
- **V4 `TypeValue` as an `Rc` handle** (`feat/vbd-v4-typevalue-rc-handle`): time-neutral for `check`. It found and fixed unhashed specialized C names, a 17 KB name repeated 780 times (its S3 issue doc lands with the V4 PR). Its yo-s1 build-time split is still being measured.
- **Drop Generation A follow-ups:** all review findings except the regression fixed below; E0915 for a destructor method value; Drop/Dispose coherence; bound unification; the migration skipping non-destructor `dispose`. Also the regression where a user trait method named `drop` was left out of `Dyn` vtables.
- **E0910's three S1 holes.**
- **Closures follow Rust (maintainer, 2026-10-14):** `Copy` iff every capture is `Copy`, `Clone` iff every capture is `Clone`. Develop implicitly copied a closure owning a `String` by value.
- **dyn-named-fn workflow:** fixes `dyn(named_fn)`'s invalid C and the dyn-spelling migration's rc=1 (draft #1345, stacked on #1339), then folds into #1339.

## 3. The next steps, in order

1. **Ship v0.2.62** (§2.3): done 2026-10-14. Curate its notes; the draft is in `v0262-changes.md` in the session scratchpad.
2. **The Generation B halves that wait for v0.2.61** (trial-merged against `integ/v0262` on 2026-10-13; details in `~/Workspace/Yo-wt/notes/restack.txt`):
   - **V2b Generation B** (`feat/vbd-v2b-index-mut-genb`): cherry-pick 3fa0e4070 and 6affb0712. The only conflict is `HashMap`'s `Index`: keep the split and #1334's `_hash(&idx)`.
   - **V3 Generation B** (`feat/vbd-v3-genb`): only 505eee0c4, a1829649f and 7ae446308 are new. They cover ArrayList/Option bitwise moves, the move-only `JoinHandle`, A4's by-value combinators, and the tests/docs migration. Every other commit on the branch landed through #1325/#1326. a1829649f and 7ae446308 conflict and need a hand re-port.
   - **V1 step 2 Generation B:** `src/` sites move from `Rc` back to the unique `Box`.
   - **Decision 31 Generation B:** delete the implicit `Rc` look-through in patterns.
3. **After v0.2.62 is the seed:**
   - Decision 45 Generation B: `yo fix ./std ./src ./tests --migrate drop-trait`, delete `Dispose`, rename the docs.
   - std's own `dyn(f)` spelling.
3a. **Evaluator performance step 1** (§6 "Evaluator performance"): attribute the `check ./src` slowdown (113 s at v0.2.50, about 187 s on develop) to `.yo` functions, and fix the clear hot spots in v0.2.63. Tools are in `~/Workspace/Yo-wt/checktime/` (`emitmap.sh`, `analyze.py`). Step 2, structural tuning, follows V2b and V4. Step 3 is a deterministic allocation-count ratchet in CI.
4. **V4 `TypeValue`** in the measured shape, then `AstExpr`, `Pattern`/`VcSort`/`VcTerm`/`Z3Sexpr`, and `EvalValue` (§6 V4).
5. **The rest of V3 async** (§3.13): A5's remaining lines (wakers, channels, mutexes, streams) are built on `feat/vbd-v3-async-a5` (§3.13 A5 "As built"). Left over: `Waker.clone` Generation B once `SEED_VERSION` carries `__yo_waker_clone`; the maintainer's call on `issues/questions/2026-10-14-the-async-mutex-is-a-copyable-handle-not-move-only.md` (A5's move-only `Mutex` line contradicts A2's `Rc` rule; the branch keeps a copyable handle); A4's future operands; and A6's `Rc`-field half with V2c.
6. **The rest of V2b:** direct projection calls, unique buffers, the explicit-copy kind, and decision 39's iterators.
7. **The allocator interface, version 2** (§6, after V2b).
8. **V2c** (§6, with design notes). Decided 2026-10-13: an effect bundle stays a value. Its handlers are capture-free, and a control-bound record copies implicitly by decision 36's exemption, so after V2b and V2c a bundle copy can hide no owner. A6's check is unchanged. Shared state reaches a task through its `io.async` capture list. V2c also rewrites A6's E0901 help text.
9. **Decision 43** (§6 "Decision 43: references as types", four PRs, after V4's `TypeValue`). Decided 2026-10-13: step 2 lands the `.*` error together with `yo fix --migrate deref`.
10. **V5:** remove `ref(...)`/`atomic(...)`.
11. **After V5:**
    - [`AGENT_KNOWLEDGE_CONSOLIDATION.md`](../AGENT_KNOWLEDGE_CONSOLIDATION.md) K2/K3 → K5 → K7 (the docs sweep) → K4 (delete `yo skills install`) → K6;
    - migrate the README's six example projects;
    - retire the `yo fix --migrate` modes (§6 "After V5").

## 4. Open bugs to know about

These were filed since v0.2.59 and are still open at develop's tip:

| Issue | Severity | Note |
| --- | --- | --- |
| `issues/fixed/a-named-closure-flowing-bare-into-a-dyn-fn-slot-passes-check-and-emits-invalid-c.md` | S2 | Fixed by #1339 |
| `issues/a-field-write-through-a-shared-borrow-parameter-is-accepted-and-lost.md` | S2 | Pre-existing |
| `issues/a-hashmap-of-a-move-only-key-or-value-does-not-compile.md` | S2 | Needs V2b's non-copying access |
| `issues/an-impl-fn-local-returning-a-future-is-declared-as-a-void-pointer.md` | S2 | |
| `issues/cond-arms-with-different-impl-future-types-mix-c-pointer-types.md` | S2 | |
| `issues/dyn-before-the-impl-in-source-order-reports-the-trait-not-implemented.md` | S2 | |
| `issues/check-of-the-tests-directory-leaks-state-between-files.md` | S3 | Filed with #1340 |
| `issues/yo-fix-migrate-markers-skips-verify-pragma-files.md` | S3 | |
| `issues/yo-fix-migrate-aborts-a-directory-walk-at-a-malformed-manifest.md` | S3 | |

The 2026-10-10 handover's §4 lists the older ones. For the full list, run `python scripts/gen-issue-triage.py`.

## 5. Decisions recorded this cycle

- **Decision 44, amended (#1321):** `Dyn(Trait)` stays sized, and every erasure is spelled: `dyn(v)`, `dyn(&v)`, `dyn(f)`.
- **Decision 45 (2026-10-13):** `Dispose` becomes Rust's `Drop`, and explicit destructor calls are E0915.
  - `drop(x)` ends a value's life.
  - The receiver is `self : &mut Self`, as Rust's `drop(&mut self)` (the maintainer: "Lets just follow rusts approach").
  - Generation A is in v0.2.62; Generation B renames the tree.
- **V4 `TypeValue`:** a value enum or an `Rc` handle, decided by measurement. The maintainer prefers the handle if the numbers favor it.
- **The allocator interface, version 2,** is queued after V2b (§6).
- **A6 / V2c's bundle (2026-10-13):** an effect bundle is a value: capture-free handlers plus `Copy` data, copied implicitly through the control-bound exemption. It is never lent.
- **Decision 43's `.*` (2026-10-13):** the error and `yo fix --migrate deref` land in one PR. Still open, for step 2: whether `ctl` handler types become structurally second-class.
- **No shipped skills** ([`AGENT_KNOWLEDGE_CONSOLIDATION.md`](../AGENT_KNOWLEDGE_CONSOLIDATION.md), amended 2026-10-13).
  - `yo init` writes `AGENTS.md` and a one-line `CLAUDE.md`.
  - `yo skills install` and `.github/skills/` are deleted at K4.
  - `yo context` is the language pack.
  - A post-VBD docs sweep (K7) removes pre-VBD forms.
- **The `yo fix --migrate` modes are retired after V5,** once the README's six example projects are migrated and pinned (§6 "After V5").

## 6. Machine-specific notes (ignore on a new machine)

- **Worktrees:** `~/Workspace/Yo-wt/<name>`. The lock helper is `~/Workspace/Yo-wt/heavy-lock.sh`. Watcher scripts are in `~/Workspace/Yo-wt/notes/` (`watch-develop.sh`, `sweep-pr-runs.sh`), and so is the restack log `restack.txt`.
- **The installed seed is v0.2.61** (`~/.local/lib/yo/v0.2.61`).
