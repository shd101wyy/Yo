# VALUES_BY_DEFAULT handover — 2026-10-17

> **Status: FINAL (2026-10-18).** v0.2.65 is published and all in-flight work has stopped. The next agent starts at §4.1.
>
> **Final status (2026-10-18 16:47 CST):** **v0.2.65 is published** (tag on `53995438d`) and `SEED_VERSION` is v0.2.65 (`29329cdea`). After the release, #1442 (`a0bac44ea`) and #1443 (`47607baf5`, CI fmt-checks `plans/`) merged; this handover merges last. `MERGE_FREEZE` is removed. No agent or cron is running. Four held branches are re-gated on #1440 and wait in §2.4; §4 is the ordered path to the end of VBD.
>
> **If develop's tip is newer than the SHA in this box, this document was not finalized.** Before acting on any row, reconstruct §2.4 from `gh pr list --state open --json number,headRefName,headRefOid,isDraft` and `git log --oneline v0.2.64..origin/develop`. Treat every "what is left" as the state at the timestamp above.

This handover continues `plans/handover/VBD_HANDOVER_2026-10-15.md`. That document's §7 (how to work here), §8 (process recipes) and §9 (inlined scripts) are still valid; this one only records what changed after it. The plan itself is `plans/VALUES_BY_DEFAULT.md`.

## 1. The standing goal and the maintainer's rules

The goal is unchanged: finish `plans/VALUES_BY_DEFAULT.md` and the handover's step list (§4 below). AGENTS.md is authoritative for everything not stated here. Directives given in this cycle:

- **Admin merge:** "I allow you to admin merge any PRs" (2026-10-17). Merge on Tier 1, as AGENTS.md describes. In auto mode the classifier sometimes denies `gh pr merge --admin` or `git push -f` from a sub-agent ("Merge Without Review"). A sub-agent must not retry or route around a denial. It reports its head SHA and gate summary, and the coordinator merges.
- **Releases:** patch releases of Yo and `markdown_yo` are pre-authorized. For v0.2.65: "no rush. include necessary generation A PRs" (§2.3).
- **Agents:** run at most 7 sub-agents at once, and spawn no large Workflow runs ("Let's not spawn large workflow"). Each piece of work gets one agent.
- **Status pings keep the sub-agent prompt cache warm:** the maintainer runs Claude Code with `subagentPromptCacheTtl` set to 1h. The coordinator pings every live sub-agent every 40 minutes, which leaves margin under the TTL for cron lateness (a recurring job can fire up to 10% of its period late). Use the light format: a reply of one or two lines from what the agent already knows (step, last gate result, PR/head, blockers, ETA), with no tool calls unless something changed or is blocked. Measured 2026-10-17: agents pinged after ~40 idle minutes resumed with 300–470K cache-read tokens and only a few hundred written. A ping costs ~0.1× input on the context, while a cold resume rewrites it at the 1h write price (~2×), so one avoided miss pays for ~20 pings. Workflow agents are never messaged, because a message resumes a duplicate copy. (A 50-minute interval was tried briefly on 2026-10-17 and dropped: its worst case is 65 minutes.)
- **Don't idle on CI:** "keep working and dont wait for CI". Start the next piece as a draft PR, stacked when it depends on unmerged work.

### 1.1 Process rules learned this cycle (portable)

- **The rebase overlap rule.** After a rebase onto develop, rebuild and re-check only if develop brought `src/`/`std/` changes to files the branch also changes. Compare `git diff --name-only <old-base>..origin/develop -- src/ std/` with `git diff --name-only origin/develop...HEAD`; under zsh, pipe the list through `xargs`, because an unquoted `$F` is not word-split. If nothing overlaps, the earlier green Tier 1 stands. Strict up-to-date is off, and develop's battery scores the combination. Re-gating on every develop move cost hours per PR on a 6-slot box.
- **No rebase after the final gate.** Once the gate on a rebased head passes, merge it as is, even if develop has moved again; rebase only if GitHub reports `mergeable=CONFLICTING`. #1437 rebased onto an overlapping change twice in one evening and re-queued its gate each time.
- **SHAs come from git output.** A sub-agent copies any head SHA it reports from `git rev-parse HEAD` or `git ls-remote` in the same turn. Three SHAs reported from memory on 2026-10-18 were wrong; check one with `git ls-remote origin <branch>` before merging on it.
- **Heavy lock.** `scripts/heavy-lock.sh` has an `exclusive` mode and, since #1413, a `priority` mode.
  - `priority` is for release blockers only.
  - An `exclusive` ticket holds every slot it has taken while it waits for the rest to drain, so the whole machine stops admitting work. Run exclusive measurements, such as A/B timings, only when the queue holds 3 or fewer tickets.
- **Thread tests and wasm.** A test file that spawns a `Thread` must carry `pragma(Pragma.SkipWasm32Wasi)` and `pragma(Pragma.SkipWasm32Emscripten)`. The wasm32-wasi job has no pthreads, and #1380's cross-thread test hung that job for its full 120 minutes (#1418, `tests/async/mutex_threads.test.yo`).
- **std stays unmarked until its Generation B sweep.** `yo fix --migrate mut-bindings` on a std file adds local `mut(...)` marks, but std is exempt from E0917 and develop's std carries none. Each re-gate agent reverted that output (2026-10-18). Marking std piecemeal would be a partial locals Generation B, and it risks the seed-with-tree-std build.
- **Leak verdicts.** CI runs `yo test` with `YO_TEST_LEAK_VERDICT=0`. A local run with verdicts on prints many `Memory leak detected` failures that develop's binary also shows. Before calling a leak "pre-existing", compare per-file leak counts against develop's binary at the same base. A leak fix needs a Drop-counter test, or `pragma(Pragma.NeedsLeakVerdict)`, to be visible to CI.
- **A deadlocked pre-fix test.** When capturing "fails before the fix" evidence for a concurrency bug, the old code can deadlock and hold a heavy slot indefinitely. Watch for 0% CPU and kill the test binary by literal PID once the failure is captured.
- **A Generation A test sweep against seed-run CI steps.** Some CI steps run `yo test` with the SEED. The `verify` job did this for five `tests/internal/verifier*.test.yo` files until #1441. The seed cannot parse a test file written in new syntax. #1440's tree-binary Tier 1 was green, yet its merge turned develop red (`issues/fixed/2026-10-18-the-fv-job-runs-generation-a-test-files-with-the-seed.md`). Before merging a change that gives `tests/` syntax the seed lacks, grep `.github/workflows/` for seed-run `yo test` steps. Either run those files with the seed, or move the steps to stage 1. V2b B2's sweep over `tests/` is the next change this applies to.

## 2. Where everything stands

### 2.1 Releases

- **v0.2.64** was published on 2026-10-17. Tag on `398a18e93`, `SEED_VERSION` bump `583115085`, built from develop `4d7c15caa` after battery 38999661126 went green (one infrastructure rerun). It carries decision 47 globals Generation A, decision 46 Generation A (`RefCell`, `make_mut`, `try_unwrap`), decision 45 (`Drop` only), A5 (move-only wakers), the async `Mutex` (#1380), D3 (#1397), the async leak fixes (#1405), stdio Generation B (#1399), `--migrate explicit-copy` (#1385) and release-mode mimalloc (#1406). Its release notes are curated.
- **v0.2.65** was published on 2026-10-18.
  - Tag on `53995438d`; `SEED_VERSION` bump `29329cdea`.
  - Release run `39106358669`, 15/15. It was cut after develop battery `39099399553` went green (58/58) on `e34b6b0f3`, with an empty battery-head diff.
  - It carries decision 47 locals Generation A (#1440), decision 39 Generation A (#1429), the unwind S1 fix (#1438), V3 A4's compiler half (#1432), move-only collection values (#1420), and the #1441 CI fix.
  - Its release notes are curated from §7; the generated body is saved at `~/Workspace/Yo-wt/vbd-logs/v0.2.65-generated-body.md`.
- **markdown_yo v0.0.18** was published the same day as v0.2.64. It marks markdown_yo's written globals `mut(...)`, for decision 47 globals Generation B (#1414).

### 2.2 Landed on develop since v0.2.64

| PR | What |
| --- | --- |
| #1416 | `consume(x)` of an owned value releases it, as `drop` does (S2 leak) |
| #1408 | V2b Generation B as a PR sequence B0–B14, with the open questions decided (§3.1) |
| #1427 | `YO_TEST_FORK=N`: `yo test` over many files in forked workers (PARALLEL_COMPILATION P4 step 1) |
| #1417 | The epoll teardown frees its free lists at thread exit (S2); `leak-verdict.yml`'s vacuity probe has been fixed (it was broken since #1328) |
| #1428 | A generic function's by-value closure parameter owns a deferred closure literal (S2) |
| #1425 | `yo check` reports errors in any closure with an `io : Io` parameter (S3; it was not specific to D3) |
| #1426 | A recursive enum's self-shell lowers like its nullable-pointer final (derive Clone S2) |
| #1423 | Handover status notes |
| #1424 | A closure capture struct is `Send`/`Sync` by its per-variable capture verdicts (D4 at the type level), so `arc` of a closure over a closure crosses threads (S2). `arc(named fn)` stays open: its root cause is the `Arc(V)` constructor's where clause, and the fix waits on `issues/retired/2026-10-17-how-a-named-function-value-carries-send.md`. Two new S2s filed |
| #1420 | Collections hold move-only keys and values (`HashMap`, `HashSet`, `BTreeMap`, `Deque`, `PriorityQueue`); unit pointer moves and a moved `Index` argument lower (3 S2s; bug-fix workflow) |
| #1432 | V3 A4 compiler half: a generic combinator's by-value future operand accepts a borrowing future (re-rooted at the parameter, so the combinator's future is second-class); decision 38 B overlap is E0910. Only a generic function is a combinator slot (a non-generic one would let two `&mut` operands of one place pass). The std half (`timeout`/`select` over futures) stays parked on `wip/vbd-a4-std-half` behind an S2 |
| #1409 | A `downcast`/`upcast` result (and `Iso(T)(v)`) declares its owning temp, so a receiver or discarded result is released (S2); the rule is in `c-codegen.instructions.md` |
| #1429 | Decision 39 Generation A: the borrowed `for` walks a cursor over a local borrow, and a push to the list being walked is E0911 (v0.2.65 gate item 2). Its end token sits in #1419's `LocalBorrowMacroSite` |
| #1419 | A `mut` match place binding lives across an `await` (S2), a `mut` match on a field writes a copy (S1), and a nullable-pointer binding's slot (S2) (bug-fix workflow) |
| #1437 | A generic `derive(Clone)` over a container field of its parameter (`Option(A)`) works: the deferred generic trials swallow the auto-generated-code miss, while a miss on a concrete receiver still fails at the `derive` line (S2). `IterPeekable`'s conditional `Clone` derive waits for a seed carrying #1437 (`plans/backlog/SEED_VERSION_AUTOMATION.md`) |
| #1433 | A false E1101 is gone (S2; mtxfollow); the strict-FIFO async mutex (#1434) follows |
| #1438 | S1: an `unwind` through a frame whose destructor makes a call is no longer lost (v0.2.65 gate item 3) |
| #1412 | V3 A5: `Waker` implements `Clone` over `__yo_waker_clone` (Generation B on the v0.2.64 seed); `cross_thread_wake` uses `w.clone()` again |
| #1435 | V4: the verifier's `Z3Sexpr` is a value enum (no `Box` needed: its children live in an `ArrayList`). `VcSort`/`VcTerm` wait on `issues/retired/2026-10-17-should-the-verifier-terms-take-box-or-rc-children.md` (recommends `Rc` for `VcTerm`, `Box` for `VcSort`, once maps hold move-only values). Its exclusive timing A/B runs once the heavy queue drains. |
| #1440 | Decision 47 locals, Generation A: bindings are immutable unless `mut(...)`; E0917 for the four writes; `yo fix --migrate mut-bindings`; `std/time` read-only methods take `&Self` (merged as `00eddd3e4`, v0.2.65 gate item 1) |
| #1441 | fix(develop): #1440's locals rule broke four CI jobs. The FV job runs its `tests/internal` verifier files on stage 1 instead of the seed; the musl stack probe, the Docker epoll probe and `compile.test.yo`'s embedded fixture mark their written locals; AGENTS.md's Tier 1 names the three blind spots (merged as `e34b6b0f3`) |
| #1442 | plans: self-verification honesty pass (vacuity gate, pinned known-answer rows, claim-number rule). Merged after the release on the maintainer's request, with its re-fenced FORMAL_VERIFICATION blocks tree-formatted (`a0bac44ea`) |
| #1443 | ci: `yo fmt --check` covers `plans/`. 317 Yo blocks fenced ` ```rust ` became formatted ` ```yo `, 233 became ` ```yo ignore `, and 22 genuine Rust blocks kept ` ```rust ` (`47607baf5`) |

### 2.3 The v0.2.65 release gate

**Met on 2026-10-18; v0.2.65 is published (§2.1).** The gate was:

1. ~~**Decision 47 locals, Generation A** has merged.~~ **Done:** #1440, `00eddd3e4`.
2. ~~**Decision 39 iterators, Generation A** has merged.~~ **Done:** #1429, `29ceb209d`.
3. ~~**The unwind S1 fix** has merged.~~ **Done:** #1438, `fbd79fc90` (§5.1).
4. ~~**Develop's battery is green on the exact tip**~~ **Done:** run `39099399553` on `e34b6b0f3`, 58/58, and `git diff --stat <battery-head>..origin/develop -- src/ std/ tests/ .github/ scripts/ build.yo` is empty.

Items 1 and 2 add syntax and semantics that their Generation B sweeps need a seed to parse; that is why they gate the release. The other open PRs (§2.4) land whenever they are ready and do not gate it. Never cancel a `Release` run.

### 2.4 Open PRs and pushed branches

Every branch below is pushed to `origin` at the head shown, as of the live-status timestamp. Each row says what is left. Gate logs do not travel: a new machine re-runs each branch's Tier 1 before merging it, whatever this table says. "Tier 1 green" means the AGENTS.md Tier 1 set passed on the stated head. Unless a row says otherwise, the next step is to rebase, apply the overlap rule (§1.1), run fmt and refs, then merge.

| PR / branch | Piece | State and what is left |
| --- | --- | --- |
| #1414 `feat/d47-globals-genb` (draft) head `8db9c7b6a`; **re-gated as `wip/feat-d47-globals-genb-on-d47` head `5322ab05e`** (base `00eddd3e4`) | Decision 47 globals, Generation B: std and src mark `mut(G)`, the exemption is removed for globals, markdown_yo `^0.0.18` | **Re-gated 2026-10-18 on #1440.** The conflict was resolved so the src/std/scripts/`build.yo` exemption now guards only #1440's locals rule. The auto-merge had deleted `is_global_mut_rule_exempt` and its export, and both were restored. #1440's six new global writes in src were handled: two are marked `mut`, and four handle globals are reset in place. No `mut(...)` was put on any std local, because std is still exempt. Results: build; check src 278/278 and std 172/172; 14 feature/std files; `yo test ./std` 7/7; site build; cli-diff 407/0 (its one NO-GOLDEN is the filed environment-size case); fmt; refs. **Not done:** the full `tests/internal` run, which needs an `exclusive` in-process slot. Four selected files pass in CI mode. **After v0.2.65:** run that internal run, move the PR head to the wip head (`git push -f origin wip/feat-d47-globals-genb-on-d47:feat/d47-globals-genb`), mark it ready and merge (§4.1 step 1). Commit `dbb412f65`'s title is stale; the squash replaces it. |
| #1434 `fix/async-mutex-strict-fifo` head `40dc96b0b`; **re-gated as `wip/fix-async-mutex-strict-fifo-on-d47` head `6fda44704`** (base `00eddd3e4`) | The async `Mutex` is FIFO across event loops (S3) | **Re-gated 2026-10-18 on #1440**, with a clean rebase. The test files needed no `mut` marks; the tool's 4 marks in `std/async/mutex.yo` were reverted, because std is exempt. Results: `check ./std` 172/172; `mutex` 11/11, `mutex_threads` 3/3, `sm_protocol` 15/15; fmt; refs. **After v0.2.65:** move the PR head to the wip head and merge (§4.1 step 2). |
| #1421 `feat/vbd-d46-genb` (draft) head `d43e9bc8b`; **re-gated as `wip/feat-vbd-d46-genb-on-d47` head `5bf89e675`** (base `00eddd3e4`) | Decision 46, Generation B: a write through a plain `Rc` is E0919, and E0909 accepts `&` through an `Rc` | **Re-gated 2026-10-18 on #1440: Tier 1 is green, and the full `tests/internal` run passes 1418/1419 in CI mode.** The one failure is `compile.test.yo`'s fixture, which #1441 fixed on develop. The rebase was 22 commits with conflicts resolved by hand. Look at one hand edit first: #1419's 11 `Rc` result-cell writes in `tests/match_async_arms.test.yo` became `rc(RefCell(T).new(..))` with `with_mut`. The migration made 3 marks in tests, none of them a write through an `Rc` payload; the std output (89 marks) was reverted. The 27 changed test files and 4 related files pass. An E0919 census of develop's 28 newer `Rc`-touching tests (evaluated and code-generated) found 0. cli-diff: 399 pass, 8 hash-only goldens re-recorded. fmt and refs pass. New S2 filed on the branch: a closure parameter named like a live local borrow extends that borrow (false E0911). **After v0.2.65:** move the PR head to the wip head, mark it ready and merge (§4.1 step 3). |
| `fix/trial-specialization-drops-store` (no PR) head `8c65f8fb4`; **re-gated as `wip/fix-trial-specialization-drops-store-on-d47` head `e0a785c5c`** (base `00eddd3e4`) | The S1 fix in §5.2: `create_specialization_at_call` clears the checking-phase flag while it evaluates the body | **Re-gated 2026-10-18 on #1440**, with a clean rebase and no marks needed. Results: build; check src/std; 19 feature files; `module_invalidation` 12/12 in CI mode. With leak verdicts on, its leaks are identical, byte for byte, to develop's binary on the same file, so the fix adds none. fmt and refs pass. **After v0.2.65:** open the PR from the wip branch with the drafted body `~/Workspace/Yo-wt/vbd-logs/rgtrial/pr-body.md` (copy it into the PR; that path is machine-local), fill in the `#PRNUM3` placeholder in its fixed issue doc, and merge (§4.1 step 4). |
| `feat/v2b-genb-b1-migration` (no PR) head `6016c121c` | V2b B1: the explicit-copy sweep over std and src, plus the recursive E0916 structural-clone exemption (§3.2) and a generic-body guard fix for #1385's migration (S2) | Stacked on #1414. Its Tier 1 had only reached the build (green) when WSL crashed. Re-run check src/std and the sweep's tests, then open it as a draft on #1414 (§4.2 step 8). |
| #1439 `feat/vbd-v4-pattern-box` (draft) head `44d9ec526` | V4: the `Pattern` tree with `Box` children (a hand-written `Clone`, because `derive(Clone)` refuses an enum that mixes `Box(Self)` with `ArrayList(Self)`) | **Generation B. Merge only after `SEED_VERSION` carries #1438 (v0.2.65).** A stage 1 built by the v0.2.64 seed crashes on `move_only`, which is the #1438 bug in its own code. Stage 2, built with #1438, is green: `move_only` 55, `match_nested` 25, `match_at_binding` 4, `algebraic_effects` 79. Emit-diff 0 lines; allocations +0.27%. **After the seed bump**, in `~/Workspace/Yo-wt/v4vc-esc`:<br>1. Rebase and rebuild stage 1 with the new seed.<br>2. Run check src/std, `move_only` and the match tests.<br>3. Compare the leaks of `verifier_quantifiers`, `module_invalidation` and `verifier_loops` against develop's binary (never done).<br>4. Run fmt and refs, mark it ready, and merge. |
| #1422 `fix/collection-clone-through-borrow` head `843e88fd8`; #1436 `fix/field-write-through-shared-borrow` head `7fc559d68`; #1430 `fix/yo-fix-multi-file-generic-impls` head `02919b3cf` | The bug-fix workflow's remaining three: a collection clone through a borrow; a field write through a shared borrow (E0908); `yo fix` over several files (generic impl coherence keys carry the module) | Implemented and adversarially reviewed. Their gates died with the workflow when WSL crashed. Read each PR's latest comment, then run its own Tier 1 again and merge (§4.1 step 5). |
| `wip/vbd-a4-std-half` (no PR) head `a83d6ac8b` | A4's std half: `timeout`/`select` over futures | Parked behind two bugs (§4.2 step 10). |
| #1162 `tss/phase6-step4` (draft) head `7e6024532` | Type-soundness phase 6, step 4 | Unchanged. It is blocked as the 2026-10-15 handover describes. |

## 3. Decisions recorded this cycle

### 3.1 V2b Generation B's open questions (#1408, decided 2026-10-17)

The verdicts are written into `plans/VALUES_BY_DEFAULT.md` under "V2b unique buffers — Generation B: PR sequence".

- **Q1:** a collection global written in place becomes an unmarked module-level `RefCell(T)` global, used through `with`/`with_mut`. The probe on develop showed three things:
  - such a global checks and runs clean;
  - a `Thread.spawn` closure that reaches it is rejected as not `Sync`;
  - `thread_local` cannot hold a reference-counted type.
  B5 does not wait for the `get()`/`get_mut()` projections.
- **Q2–Q6:** as recommended. B0 (`RefCell`) is already landed as #1415, and only its projections are pending.

### 3.2 Reading a non-`Copy` `mut(G)` global after unique buffers (decided 2026-10-17)

A reassigned explicit-copy global (`mut(G) : String`; nine in src after #1414) is read as `v := G.clone()`. A structural `clone()` receiver is exempt from E0916. The exemption is recursive: every `Clone` impl the clone reaches must be derived or std-structural, and a user `impl(T, Clone)` anywhere inside stays E0916. The question doc ships with #1414, and the implementation is on `feat/v2b-genb-b1-migration` (commit `73da377dc`, tests in `tests/global_lend.test.yo`).

### 3.3 v0.2.65 waits for the Generation A pieces

See §2.3. The maintainer chose to keep the release open for them rather than ship the fixes early.

### 3.3a Maintainer questions from #1429 (decision 39)

Decided; see §3.4. The record is `issues/retired/borrowed-for-over-user-defined-collections.md`.

### 3.4 The open questions, decided 2026-10-18 (the maintainer took the advisor's recommendations)

- **The verifier terms' children** (`issues/retired/2026-10-17-should-the-verifier-terms-take-box-or-rc-children.md`). `VcTerm` takes `Rc` now; `VcSort` takes `Box` after V2b B6. Decision 21 is amended to choose by sharing, not by size:
  - a tree whose subtrees are shared or substituted takes `Rc` children;
  - a tree built once and consumed takes `Box`;
  - a type with no direct `Self` child is a plain value.
- **How a named function value carries `Send`** (`issues/retired/2026-10-17-how-a-named-function-value-carries-send.md`).
  - First, fix the structural-compat rule: `issues/fixed/2026-10-17-a-closure-typed-field-accepts-a-named-function-and-emits-invalid-c.md` (S2).
  - After decision 43, give each named function its own item type (§4 step 16).
  - Until then, PARALLELISM_RULES D9 recommends a capture-free closure, `dyn(() => f())` or `arc(() => f())`.
- **The borrowed `for` over user collections** (`issues/retired/borrowed-for-over-user-defined-collections.md`).
  - `BorrowedWalk` stands until decision 43 step 3.
  - `HashSet` and `PriorityQueue` refuse `for(&mut …)` by design.
  - A read of the collection in the body is E0911 by design; use `indices()`.
  - A macro from another file keeps its template borrow live for the whole call. This is accepted.
  - The forwarding gap was narrower than the question said. A value collection forwards `&mut self.items(cur)` safely. Two bugs were filed:
    - the `ref`-receiver runtime panic (S2);
    - the bare-tail E0601 (S3).
- **#1440's two departures** are accepted, and the plan's decision 47 step 2 records them as built:
  - module-level `mut(x) ::`;
  - E0917 before "needs a writable place".
- **Neither the `void*` S1 nor the explicit-copy migration S2 gates v0.2.65.** Both go under the known issues in the release notes.
- **Keep six heavy slots.** The two WSL crashes came from the WSL update, not from the load; the user then updated to WSL 3.

## 4. After v0.2.65: what is left to finish VBD, in order

Every step names its spec. Where this list and `plans/VALUES_BY_DEFAULT.md` §6 disagree, the plan is authoritative. Each step is its own PR with the AGENTS.md Tier 1 gate. A Generation B half is built and gated as a stacked draft on a develop-built compiler while its Generation A waits for a release, and it merges after the pipeline bumps `SEED_VERSION`.

### 4.1 Right after the release: land what the freeze held

None of these needs anything new. Remove `~/Workspace/Yo-wt/MERGE_FREEZE`, then merge them one at a time. For each one, rebase, apply the overlap rule (§1.1), and run fmt and refs. Merge without another rebase unless GitHub reports a conflict. The resume point for each branch is its row in §2.4.

**Every branch below was gated before #1440 made local bindings immutable.** After rebasing, run `yo fix <the branch's added or changed test files> --migrate mut-bindings` with a tree-built binary. Commit that output as its own commit, rebind any parameter writes it lists by hand, and then re-run those tests. The overlap rule cannot see this change: it is the language changing under the branch's tests, not develop touching the same files. Test files per branch, counted 2026-10-18: #1421 has 28; #1436 has 4; #1434, #1422 and B1 have 2 each; #1414, #1430 and the trial-specialization branch have 1 each; #1439 has none.

1. #1414: decision 47 globals, Generation B.
2. #1434: the strict-FIFO async mutex.
3. #1421: decision 46, Generation B (a write through a plain `Rc` is E0919).
4. `fix/trial-specialization-drops-store`: the S1 in §5.2.
5. The bug-fix workflow's PRs, #1422, #1430 and #1436, plus `fix/field-write-through-shared-borrow` if it is still separate.
6. Once `SEED_VERSION` is v0.2.65:
   - #1439 (`Pattern`);
   - `IterPeekable`'s conditional `Clone` derive, which is parked in `plans/backlog/SEED_VERSION_AUTOMATION.md` because it needs #1437 in the seed.

### 4.2 On the v0.2.65 seed: the Generation B halves and V2b

7. **Decision 47 locals, Generation B** (plan §6 "Decision 47", step 2).
   - Run `yo fix --migrate mut-bindings` over `src/`, `std/`, `docs/` (both languages) and `markdown_yo`.
   - Then enforce everywhere by dropping the src/std exemption.
   - It must land before decision 43 (step 14), whose `&mut` rules assume `mut`.
8. **V2b unique buffers, Generation B** (plan §6 V2, "B0–B14", in #1408's sequence). This is the largest phase left. Do the B steps in order.
   - **B1:** the explicit-copy sweep over std and src. The `v2bb1` draft is stacked on #1414 at head `6016c121c` or newer.
     - std: 165 copies inserted, 138 sites listed.
     - src: 3,106 copies inserted, 1,338 sites listed.
     - It also carries two migration S2 fixes.
   - **B2:** the same sweep over `tests/`, the build scripts and `markdown_yo`.
   - **B3:** hand edits in std, at the 138 listed sites.
   - **B4:** hand edits in src at the 1,338 listed sites, one PR per directory. It may use `RefCell`, since v0.2.65 carries #1415.
   - **B5:** the collection globals become `RefCell` globals. It needs #1414.
   - **B6:** decision 20's accessors. After B6, `VcSort` takes `Box` children (decision 21, as amended 2026-10-18).
   - **B7:** decision 39, Generation B (iteration and entries). Its plan is in `issues/collection-iterators-have-no-sound-post-v2b-shape.md`. If a read-only walk that yields `&T` is added here, `HashSet` and `PriorityQueue` implement it.
   - **B8:** the flip for `ArrayList` and `String`. It needs B1–B7.
   - **B9–B11:** the other collections.
   - **B12:** `Dyn`, Generation A. **A release is needed before B13.**
   - **B13:** `Dyn`, Generation B.
   - **B14:** follow-ups.
   - B0's `RefCell` projections (`get()`/`get_mut()`) and the binding ban are an ergonomic pass; B5 does not wait for them.
9. **Decision 46's follow-up** (plan §6 "Decision 46", step 3). The cycle collector's predicate narrows to cells that reach a `RefCell`, `Mutex` or `RwLock`. Measure on the collector's own benchmarks.
10. **A4's std half**, parked on `wip/vbd-a4-std-half`: `timeout`/`select` over futures.
    - First fix its S2: a generic `io.async` body shares one capture struct across futures.
    - Also fix the S1 in §5.3: awaiting a future parameter emits a `void*` result.
11. **`VcTerm` takes `Rc` children** (decision 21, as amended 2026-10-18). It is independent of V2b, so it can go any time.

### 4.3 After V2b

12. **The allocator interface, version 2** (plan §3.11, and §6 "After V2b: the allocator interface, version 2"). `alloc` and `realloc` take an alignment, and `free` receives the size and the alignment, so Zig-style allocators fit.
13. **V2c: decision 17** (plan §6 V2, "V2c"). Generation A, then a release, then Generation B.
    - An implicit `Rc`/`Arc` handle copy becomes E0901, and `yo fix` inserts `Rc.clone(x)` / `Arc.clone(x)`.
    - Size: 63 sites in src, 136 in std, 640 in tests.
    - It also settles A6's `Rc` bundle fields.
14. **V4's remaining trees** (plan §6 V4). For each conversion, measure `check ./src` time and stage-2 RSS against develop. The value-enum `TypeValue` lost on time, so expect the handle approach to win.
    - `AstExpr` gets `Rc(Self)` children.
    - `EvalValue` comes last, because its comptime-place model aliases on purpose.
15. **Decision 43: references as types** (plan §6 "Decision 43"; `plans/backlog/NON_ESCAPABLE_TYPES.md` R1–R7). It needs V2b, V4's `TypeValue` work and step 7. It takes four PRs.
    1. **`TypeValue.Reference(T, mutable)`** replaces the slot flags, with no change to the language. It is the largest refactor in the plan. It is gated on identical behavior: every test, the fixpoint, and an emit-diff of the self-build that shows no C change.
    2. **Generation A:** `&T`/`&mut T` as types in user code, `.*`, and `yo fix --migrate deref`. This step breaks user code.
    3. **Root-joining containers** (R7, N2). This step also decides whether `impl(&mut C, IntoIterator(…))` replaces `BorrowedWalk`. If it does, the implementors migrate and the trait is deleted.
    4. **Generation B**, after a release: std and src adopt it.
16. **Function-item types** (decided 2026-10-18; `issues/retired/2026-10-17-how-a-named-function-value-carries-send.md`). This comes after step 15, because both rework `TypeValue` and `type_key`.
    - Each named function gets its own item type, as in Rust.
    - This closes `issues/arc-of-a-named-function-value-fails-its-send-bound.md` and `issues/2026-10-17-a-declared-send-binding-of-a-named-function-is-rejected.md`.
    - It is not on the critical path.
17. **V5: remove `ref(...)` and `atomic(...)`** (plan §6 V5). Generation A, then a release, then Generation B.
    - **Generation A:**
      - std and src stop using them: about 60 context objects become `Rc(struct(...))`, and about 135 result records become plain structs.
      - The wrappers move onto `__yo_cell`/`__yo_atomic_cell`.
      - About 150 test declarations in 68 files migrate.
      - #1421's two cursor-walk tests need a redesign, not a rewrite. They keep `ref(struct)` because a `RefCell` cannot hand a `&mut` out of `with_mut`.
      - With `ref` gone, the S2 `issues/2026-10-18-a-projection-forwarded-through-a-ref-receiver-leaves-its-borrow-flag-set.md` either closes or moves to `Rc(RefCell)`.
    - **Generation B:**
      - The parser drops the constructors.
      - The 527 sites in 73 files that test `is_reference_semantics`/`is_atomic_rc` are reread against the new meaning.
      - The docs change in both languages, and so do the skills (re-record the seven skill goldens) and the pack.
18. **After V5: retire the `yo fix` migrations** (plan §6 "After V5").
    - The gate: each of the six README example projects builds and passes its tests on the last release that ships every migration, with `.yo-version` pinned there.
    - Then delete each migration's record mode, its `ExprInfo` state, its CLI handling, its cli-cases and its docs.

### 4.4 Releases still needed

After v0.2.65, at least five releases are on the critical path, one at each boundary between a Generation A and its Generation B:
1. B12 → B13 (`Dyn`);
2. V2c;
3. decision 43, step 2 → step 4;
4. V5;
5. the final release that ships every migration, before step 18 retires them.

Cut a patch release whenever a Generation A that something waits on has landed, provided the develop battery is green on the exact tip and the battery-head diff is empty. Releases are pre-authorized.

### 4.5 Decided 2026-10-18 (the maintainer took the advisor's recommendations)

Nothing is waiting on the maintainer. The verdicts are in §3.4 and in the retired docs. For later decisions, follow the same practice: write the question up in `issues/questions/` with a recommendation, then retire it into the plan once it is decided.

### 4.6 Queued for after VBD (not part of the campaign)

- Evaluator performance steps 1–2 (plan §6 "Evaluator performance"). The maintainer deferred them until after VBD.
- The issue-date rename (2026-10-15 handover §4 step 15; its script is in that handover's §9.1).
- PARALLEL_COMPILATION P4 step 2, a forked `check <dir>`, and sizing `YO_TEST_FORK`'s N on an idle machine.
- The AGENTS.md note that the `tests/cli-cases` exclude avoids "~4 false failures" is slightly stale: #1427 added two fixtures that fail on purpose.

## 5. Open bugs to know about

### 5.1 S1 (fixed in #1438): an `unwind` is lost when a destructor runs on the escape path

It is in v0.2.64 and reproduces with user code. When an `unwind` passes through a frame that drops a `Box`, or any value whose `Drop` makes a call, the destructor clears `__yo_effect_escaped`. The unwind is lost, and the frame returns its dummy result. Fixed by #1438 (`fbd79fc90`): `return.yo` re-raises `__yo_effect_escaped` after the escape-path drops, with a regression test in `algebraic_effects` that fails on the v0.2.64 seed. `dyn.test` (3 tests) and `internal/error` (1 test) show LSan-only leaks there, identical on the seed with the base tree.

### 5.2 S1: a store in a comptime-parameterized fn is dropped when its first call is the operand of `!`

The doc and its repro (`issues/repros/`) arrive with the E1101 PR. The suspected cause: an overload trial for `!` evaluates the specialization with checking-phase shortcuts, and the real call reuses it. The fix is on `fix/trial-specialization-drops-store`.

### 5.3 Other open issues filed this cycle

On develop:

- `issues/fixed/2026-10-16-awaiting-a-future-parameter-typed-by-a-generic-binder-emits-a-void-pointer-result.md` (**S1**, landed with #1432; pre-existing, seed v0.2.63 does the same): a generic function awaiting an `Impl(Future(T, E))` parameter emits a `void*` result or `T v = ;`, and the tail form `io.async({ op }(io : Io) => io.await(op, io))` silently returns a wrong value. Not a v0.2.65 gate item (it is not a regression), but list it under the release's known issues.
- "a match through a borrowed element copies the element" (S2; its doc is on the #1439 branch until that merges: `match(&xs(i), …)` is E0901 although E0901 suggests that form)
- `issues/2026-10-17-a-declared-send-binding-of-a-named-function-is-rejected.md` (S2, from #1424: D9's documented workaround is E0601)
- `issues/fixed/2026-10-17-a-closure-typed-field-accepts-a-named-function-and-emits-invalid-c.md` (S2, from #1424: passes `check`, fails in the C compiler; also a `Send` bypass)
- `issues/2026-10-16-a-generic-io-async-body-shares-one-capture-struct-across-futures-of-one-generic-producer.md` (S2; blocks A4's std half)
- `issues/fixed/2026-10-16-a-fetch-that-times-out-leaks-an-8-kib-buffer.md` (S2; found by #1409, also fails on develop with leak verdicts on)
- `issues/fixed/2026-10-16-the-warnings-stash-test-leaks-under-leak-verdicts.md` (S3; found by #1409, the same test leaks on develop)
- "the async mutex is not FIFO across event loops" (2026-10-16; the FIFO branch moves it)
- `issues/fixed/2026-10-17-a-closure-passed-into-a-comptime-expect-error-call-leaks-its-moved-capture.md`
- `issues/fixed/2026-10-17-comptime-expect-error-over-a-moving-call-leaves-the-argument-consumed-so-it-leaks.md`
- `issues/fixed/2026-10-17-spawn-blocking-s-detached-worker-can-outlive-main-and-lsan-reports-its-captures.md`
- `issues/2026-10-18-compile-allocator-fixed-oom-case-fails-under-a-large-caller-environment.md` (S3, from #1440's cli-diff: from a shell whose environment is about 2 KB larger than 34 KB, the probe's parent runs out of its 64 KiB fixed heap and the case scores a vacuous NO-GOLDEN; develop behaves the same)
- `issues/2026-10-18-a-projection-forwarded-through-a-ref-receiver-leaves-its-borrow-flag-set.md` (S2, found while deciding #1429's questions: a `ref(struct)` collection whose `walk_elem` forwards `&mut self.items(cur)` panics at the next container call; arrives with #1431)
- `issues/2026-10-18-a-bare-projection-call-as-a-projection-body-is-a-misleading-e0601.md` (S3: a bare tail `self.items.walk_elem(cur)` reports an internal pointer type instead of naming `&mut`; arrives with #1431)

Filed on in-flight branches; they arrive with those PRs:

- two S2s in the async `Channel` once it sits behind `RefCell` (#1421);
- `std/time` getters and `Array.len` now take `&Self` (S2, decision 47 locals);

The open S1s already on develop are listed in the 2026-10-15 handover §6.1.

## 6. When v0.2.65 is out: the stop sequence (done 2026-10-18)

The maintainer asked for all work to stop once v0.2.65 is published, with this document up to date. Every step below was carried out on 2026-10-18; it is kept as the record. The coordinator:

1. Curates the v0.2.65 release notes (§7 has the draft) and checks that `SEED_VERSION` was bumped.
2. Stops its schedulers: the status-ping cron jobs (session-only; all deleted 2026-10-18 once no subagent was live) and any PR-run cancel loop.
3. Messages every running agent: "STOP after your current tool call. Push your current head. Reply with: branch, head SHA, what passed, what did not run. Do not merge." Any agent that does not answer is stopped.
4. Rewrites §2.4 from the replies, with head SHAs, and updates the live-status box.
4a. Merges #1442 (`plans/self-verification-honesty-pass`, plans-only plus one `AGENTS.md` line; the maintainer asked for it to merge once v0.2.65 is out). The steps:
   - Rebase onto develop. It was trial-rebased cleanly onto `53995438d` as `rg/1442` in `~/Workspace/Yo-wt/pr1442`. Leave the `~/Workspace/Yo-wt/honesty` worktree alone: it belongs to the session that wrote the PR.
   - Run refs. All 7 ` ```yo ` blocks parse with the tree compiler.
   - `git push -f origin rg/1442:plans/self-verification-honesty-pass`, then `gh pr ready 1442` and `gh pr merge 1442 --squash --admin`.
   - Delete the remote branch by hand if `--delete-branch` refuses.
4b. Lands `ci/fmt-check-plans`, the maintainer's 2026-10-18 request to fmt-check `plans/` in CI and format every plan. It is pushed as a bare branch with no PR yet, two commits on `53995438d`:
   - **The sweep** (regenerable). 317 Yo blocks fenced ` ```rust ` become ` ```yo ` and are tree-formatted. 233 become ` ```yo ignore `: historical syntax, plus the six syntax and formatter docs, where a block's layout is the illustration. One C snippet becomes ` ```c `. The 22 genuine Rust blocks keep ` ```rust `.
   - **The gate.** `./plans` joins `test.yml`'s fmt step and `gates_fast.sh` GATE 6, and `AGENTS.md` and `documentation.instructions.md` name it.
   - It overlaps only #1442, in `FORMAL_VERIFICATION.md`, `THEOREM_PROVING_NEXT.md` and `BEND_LAWS_AND_AGENT_LOOP_LESSONS.md`. After #1442 merges, rebase it. On a conflict, take develop's side, re-run `python3 ~/Workspace/Yo-wt/vbd-logs/fmtplans/refence.py <tree yo> plans <tmp>` and `yo fmt ./plans`, and amend the sweep commit.
   - Tier 1: tree-binary `fmt --check ./plans` (idempotent), refs, and a look at the diff of any newly re-fenced block. Then open the PR from the template and admin-merge it.
   - From then on, any ` ```yo ` block added under `plans/` must be formatted (GATE 6).
5. Re-runs `check-issue-refs.sh` on this PR's rebased head, repointing any citation whose doc moved to `issues/fixed/`, then merges it.

A new agent starting from this document re-runs Tier 1 for any branch before merging it (§2.4).

## 7. v0.2.65's curated release notes (final text, written 2026-10-18)

When the release publishes, keep line 1 (`Patch release v0.2.65`) and the whole `## Native bundles (bootstrap seed chain)` section byte for byte. Replace only the generated `## Changes` section with the text below (2026-10-15 handover §8.4):

```bash
gh release view v0.2.65 --json body --jq .body > /tmp/old-body.md
# new body = line 1 + blank line + the block below + blank line + the "## Native bundles" section of old-body.md
gh release edit v0.2.65 --notes-file /tmp/new-body.md
```

Before pasting, add a bullet for any PR that lands before the cut (#1441 is CI-only and is omitted). Re-check that each known-issue path is still open at the tag.

````markdown
## Changes

### Language (values by default, `plans/VALUES_BY_DEFAULT.md`)
- **Local bindings are immutable unless declared `mut(name)`** (decision 47 locals, Generation A), like Rust's `let mut`.
  - The marker works in every binding position: `mut(x) := v`, `(mut(x) : T) = v`, `mut(x) :: v`, `comptime(mut(x)) := v`, a `match` pattern (`.Some(mut(v))`) and a destructuring (`{ a, mut(b) }`, `(a, mut(b))`).
  - Four writes to an unmarked binding are **E0917**: a reassignment, a field or `Array` element write, a `&mut` lend (`&mut x`, `y := &mut x`, `match(&mut x, …)`, a `&mut x` capture), and a `&mut self` method call. A `ref` handle is still written through without the marker. `String` is a value, so `s.push_str(…)` needs `mut(s)`.
  - Parameters, capture-list entries and `for` elements take no `mut`. Writing one is E0917, and its help suggests rebinding: `mut(p_m) := p;`, or `for(&mut coll, x => …)` for a loop element.
  - `yo fix <path> --migrate mut-bindings` inserts the markers and lists the writes to rebind by hand. `YO_AUDIT_MUT_BINDINGS=1` prints every write without rejecting it.
  - The rule is enforced outside `src/` and `std/` until a seed that parses `mut(` builds them; this release is that seed (#1440).
- **`std/time`'s read-only methods take `self : &Self`.** The 27 methods (`Duration.as_secs`, `Instant.elapsed`, `DateTime.to_unix`, …) and `Array(T, N).len` took `&mut Self`, which would have made `d.as_secs()` on an unmarked `Duration` an E0917. Their `yo doc` signatures change (#1440).
- **The borrowed `for` walks a cursor over a local borrow** (decision 39, Generation A).
  - `for(&mut xs, x => …)` no longer goes through `iter()` and no longer copies the collection; each step re-derives the element. `ArrayList`, `Deque`, `HashMap`, `BTreeMap`, `OrderedMap` and `LinkedList` implement the new prelude trait `BorrowedWalk`.
  - `xs.indices()` on `ArrayList` and `Deque` gives a cursor that survives changes to its container. Use it when the loop body must read or grow the collection.
  - Behavior change (decision 18, Rust's `iter_mut` rule): a body that names its collection is now **E0911**, for reads such as `xs.len()` as well as writes, and so is a nested loop over the same collection. `return(x)` of the element is E0912; bind a copy first. `HashSet` and `PriorityQueue` no longer accept `for(&mut …)`, because a write in place could break their hashing or order (#1429).
- **A generic future combinator accepts a borrowing future as its by-value operand** (V3 A4, compiler half). Two operands of one call that lend overlapping places, when either side is `&mut`, are **E0910** (decision 38 B). A non-generic future-to-future function still rejects a borrowing future (#1432).
- **A closure capture struct is `Send`/`Sync` by what it captures**, so `arc` of a closure that captures another closure over an `Arc(AtomicI32)` now crosses threads (#1424).

### Type checking
- Fixed (S2): a generic `derive(Clone)` whose field is a container of its parameter (`Option(A)`, `ArrayList(A)`, `Box(A)`) failed with `No method "clone"`. A concrete miss is still reported at the `derive` line (#1437).
- Fixed (S2): a generic function's by-value closure parameter now owns a closure literal passed to it, so a closure holding a `Drop` value can be moved on inside the callee instead of failing with E0901 (#1428).
- Fixed (S2): `!unsafe(p.*.flag)` inside a `comptime(T)` function was a false **E1101** (#1433).
- Fixed (S3): `yo check` reported nothing for an error inside a closure whose parameter is `Io`, which covers `Thread.spawn` and `io.async` bodies (#1425).

### Compile and codegen
- **Fixed (S1): an `unwind` through a frame whose destructor makes a call was lost.** The frame returned its zeroed dummy result as if it had returned normally: a SIGSEGV for a `ref` result, a wrong value for a scalar. Dropping a `Box` on the escape path was enough to trigger it (#1438).
- **Fixed (S1): `match(&mut s.o, …)` on a field or a dereference wrote to a copy.** Replacing a counted payload then freed `s.o`'s value twice (#1419).
- Fixed (S2): a recursive enum that folds to a nullable pointer (`enum(JNull, JArr(xs : ArrayList(Self)))`) failed to C-compile with `unknown type name`. An enum whose payload points back to itself (`enum(Leaf, Node(b : Box(Self)))`) no longer emits a self-referential typedef (#1426).
- Fixed (S2): a `downcast`/`upcast` result used as a method receiver or discarded was never released, and neither was an `Iso(T)(v)` constructor result (#1409).
- Fixed (S2): `consume(x)` of an owned value leaked it. It now releases the value, as `drop` does (#1416).

### Async runtime
- **A `&mut` match place binding can live across an `await`.** Decision 26's restriction is lifted, and a place reached through a local-borrow cursor is checked across every await, including one a macro expands to (E0911). Also fixed: an S2 where a nullable-pointer `match` binding was stored into another arm's task slot (#1419).
- `Waker` implements `Clone`: a clone is another handle on the same token (#1412).
- Fixed (S2): the epoll backend leaked its recycled pendings and registrations at thread exit, 248 bytes for one parked `recv` (#1417).

### Standard library
- **Collections hold move-only keys and values:** `HashMap`, `HashSet`, `BTreeMap`, `OrderedMap` values, `Deque` and `PriorityQueue` move entries bitwise and compare in place. Two codegen S2s found on the way are fixed too: a pointer move of a `unit` place, and an `Index` call that moves a named local (#1420).

### Toolchain for agents (CLI, test runner, diagnostics)
- **`YO_TEST_FORK=N`:** `yo test` over many files warms one in-process image and forks a worker per file, at most N at a time, replaying output in file order. Linux and macOS only (#1427).

### Known open issues filed this cycle
- `issues/fixed/2026-10-16-awaiting-a-future-parameter-typed-by-a-generic-binder-emits-a-void-pointer-result.md` (S1, not a regression; v0.2.63 does the same)
- `issues/fixed/2026-10-17-a-store-in-a-comptime-parameterized-fn-is-dropped-when-its-first-call-is-an-operand-of-not.md` (S1)
- `issues/fixed/2026-10-17-an-assignment-through-an-index-call-runs-the-call-twice.md` (S1)
- `issues/2026-10-16-a-generic-io-async-body-shares-one-capture-struct-across-futures-of-one-generic-producer.md`
- `issues/fixed/2026-10-17-a-closure-typed-field-accepts-a-named-function-and-emits-invalid-c.md`
- `issues/2026-10-17-a-declared-send-binding-of-a-named-function-is-rejected.md`
- `issues/fixed/2026-10-16-a-linkedlist-of-a-move-only-element-cannot-pop-or-clear.md`
- `issues/2026-10-16-an-orderedmap-of-a-move-only-key-does-not-compile.md`
- `issues/2026-10-17-a-nested-index-call-on-generic-impls-calls-an-unspecialized-method.md`
- `issues/2026-10-17-a-generic-copy-impl-rejects-a-field-that-is-a-conditional-copy-container-of-its-parameter.md`
- `issues/2026-10-17-a-module-level-local-borrow-is-not-checked-across-a-call-a-macro-expands-to.md`
- `issues/2026-10-18-compile-allocator-fixed-oom-case-fails-under-a-large-caller-environment.md`
- `yo fix --migrate explicit-copy` can rewrite a generic body seen at only one type, and an arm-tail copy of a borrowed binding (S2). The fixes are on V2b B1's branch.
- A `ref(struct)` collection that forwards a projection from `walk_elem` panics at its next container call (S2), and a bare projection tail reports a misleading E0601 (S3).
````

## 8. Machine-specific notes (ignore on a new machine)

The coordinator on the Linux box kept these files under `~/Workspace/Yo-wt/vbd-logs/`; none of them travels:

- `QUEUE.md`, the running log;
- `AGENT_BRIEF.md` and `bugfix-brief.md`, the sub-agent briefs, whose rules are restated in §1;
- `release-notes-v0.2.64-final.md`;
- each agent's gate logs.

Heavy-lock configuration: `~/Workspace/Yo-wt/heavy-lock.conf` (6 slots on the 64 GB box).
