# VALUES_BY_DEFAULT handover — 2026-10-17

> **Status: LIVING DOCUMENT until v0.2.65 is published.** The coordinator updates the "Live status" box below as PRs land. When v0.2.65 is out, all in-flight work stops and this document is final.
>
> **Live status (last update 2026-10-18 07:50 CST):** develop is at `29ceb209d` (#1429). v0.2.65 gate: items 2 and 3 done; item 1 (#1440) is re-gating. **`~/Workspace/Yo-wt/MERGE_FREEZE` is up:** only #1440 (decision 47 locals, rebasing once onto #1429) may merge until v0.2.65 is published. v0.2.65 gate: item 3 done; items 1 (decision 47 locals) and 2 (#1429) are gating. v0.2.64 is the published seed. v0.2.65 is not cut; its gate is in §2.3.
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
- **Leak verdicts.** CI runs `yo test` with `YO_TEST_LEAK_VERDICT=0`. A local run with verdicts on prints many `Memory leak detected` failures that develop's binary also shows. Before calling a leak "pre-existing", compare per-file leak counts against develop's binary at the same base. A leak fix needs a Drop-counter test, or `pragma(Pragma.NeedsLeakVerdict)`, to be visible to CI.
- **A deadlocked pre-fix test.** When capturing "fails before the fix" evidence for a concurrency bug, the old code can deadlock and hold a heavy slot indefinitely. Watch for 0% CPU and kill the test binary by literal PID once the failure is captured.

## 2. Where everything stands

### 2.1 Releases

- **v0.2.64** was published on 2026-10-17. Tag on `398a18e93`, `SEED_VERSION` bump `583115085`, built from develop `4d7c15caa` after battery 38999661126 went green (one infrastructure rerun). It carries decision 47 globals Generation A, decision 46 Generation A (`RefCell`, `make_mut`, `try_unwrap`), decision 45 (`Drop` only), A5 (move-only wakers), the async `Mutex` (#1380), D3 (#1397), the async leak fixes (#1405), stdio Generation B (#1399), `--migrate explicit-copy` (#1385) and release-mode mimalloc (#1406). Its release notes are curated.
- **markdown_yo v0.0.18** was published the same day. It marks markdown_yo's written globals `mut(...)`, for decision 47 globals Generation B (#1414).

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
| #1424 | A closure capture struct is `Send`/`Sync` by its per-variable capture verdicts (D4 at the type level), so `arc` of a closure over a closure crosses threads (S2). `arc(named fn)` stays open: its root cause is the `Arc(V)` constructor's where clause, and the fix waits on `issues/questions/2026-10-17-how-a-named-function-value-carries-send.md`. Two new S2s filed |
| #1420 | Collections hold move-only keys and values (`HashMap`, `HashSet`, `BTreeMap`, `Deque`, `PriorityQueue`); unit pointer moves and a moved `Index` argument lower (3 S2s; bug-fix workflow) |
| #1432 | V3 A4 compiler half: a generic combinator's by-value future operand accepts a borrowing future (re-rooted at the parameter, so the combinator's future is second-class); decision 38 B overlap is E0910. Only a generic function is a combinator slot (a non-generic one would let two `&mut` operands of one place pass). The std half (`timeout`/`select` over futures) stays parked on `wip/vbd-a4-std-half` behind an S2 |
| #1409 | A `downcast`/`upcast` result (and `Iso(T)(v)`) declares its owning temp, so a receiver or discarded result is released (S2); the rule is in `c-codegen.instructions.md` |
| #1429 | Decision 39 Generation A: the borrowed `for` walks a cursor over a local borrow, and a push to the list being walked is E0911 (v0.2.65 gate item 2). Its end token sits in #1419's `LocalBorrowMacroSite` |
| #1419 | A `mut` match place binding lives across an `await` (S2), a `mut` match on a field writes a copy (S1), and a nullable-pointer binding's slot (S2) (bug-fix workflow) |
| #1437 | A generic `derive(Clone)` over a container field of its parameter (`Option(A)`) works: the deferred generic trials swallow the auto-generated-code miss, while a miss on a concrete receiver still fails at the `derive` line (S2). `IterPeekable`'s conditional `Clone` derive waits for a seed carrying #1437 (`plans/backlog/SEED_VERSION_AUTOMATION.md`) |
| #1433 | A false E1101 is gone (S2; mtxfollow); the strict-FIFO async mutex (#1434) follows |
| #1438 | S1: an `unwind` through a frame whose destructor makes a call is no longer lost (v0.2.65 gate item 3) |
| #1412 | V3 A5: `Waker` implements `Clone` over `__yo_waker_clone` (Generation B on the v0.2.64 seed); `cross_thread_wake` uses `w.clone()` again |
| #1435 | V4: the verifier's `Z3Sexpr` is a value enum (no `Box` needed: its children live in an `ArrayList`). `VcSort`/`VcTerm` wait on `issues/questions/2026-10-17-should-the-verifier-terms-take-box-or-rc-children.md` (recommends `Rc` for `VcTerm`, `Box` for `VcSort`, once maps hold move-only values). Its exclusive timing A/B runs once the heavy queue drains. |

### 2.3 The v0.2.65 release gate

Cut v0.2.65 (2026-10-15 handover §8.4, then curate the notes as for v0.2.64) only when all of these hold:

1. **Decision 47 locals, Generation A** has merged: #1440, branch `feat/vbd-d47-locals-gena`.
2. ~~**Decision 39 iterators, Generation A** has merged.~~ **Done:** #1429, `29ceb209d`.
3. ~~**The unwind S1 fix** has merged.~~ **Done:** #1438, `fbd79fc90` (§5.1).
4. **Develop's battery is green on the exact tip**, and `git diff --stat <battery-head>..origin/develop -- src/ std/ tests/ .github/ scripts/ build.yo` is empty.

Items 1 and 2 add syntax and semantics that their Generation B sweeps need a seed to parse; that is why they gate the release. The other open PRs (§2.4) land whenever they are ready and do not gate it. Never cancel a `Release` run.

### 2.4 Open PRs and pushed branches

Every branch below is pushed to `origin` at the head shown, as of the live-status timestamp. Each row says what is left. Gate logs do not travel: a new machine re-runs each branch's Tier 1 before merging it, whatever this table says. "Tier 1 green" means the AGENTS.md Tier 1 set passed on the stated head. Unless a row says otherwise, the next step is to rebase, apply the overlap rule (§1.1), run fmt and refs, then merge.

| PR / branch | Piece | State and what is left |
| --- | --- | --- |
| #1440 `feat/vbd-d47-locals-gena` head `41118ff44` | Decision 47 step 2 Generation A: every `mut(...)` binding form; a write to an unmarked binding is E0917 outside src/std; `yo fix --migrate mut-bindings` | Full gate green on `41118ff44`: build, check src/std, suite (only environment-dependent failures, identical on develop), internal 108 pass / 0 non-leak, solo leak table identical to develop on 8 files, cli-diff 399/0 with every golden explained. Develop then moved 15 commits overlapping 6 of its files, so it rebases once onto #1429 and re-runs build, check src, develop's new tests (migrated) and cli-diff. Gates v0.2.65. Flags for the maintainer: module-level `mut(x) ::` is accepted; E0917 now fires before "needs a writable place" for a `&mut` capture of a parameter. |
| #1439 `feat/vbd-v4-pattern-box` (draft) head `44d9ec526` | V4: the `Pattern` tree with `Box` children (hand-written `Clone`: `derive(Clone)` refuses an enum mixing `Box(Self)` with `ArrayList(Self)`) | **Generation B: merge only after `SEED_VERSION` carries #1438 (v0.2.65).** A stage 1 built by the v0.2.64 seed crashes on `move_only` (the #1438 bug in its own code). Stage 2 (built with #1438) is green: `move_only` 55, `match_nested` 25, `match_at_binding` 4, `algebraic_effects` 79. `verifier_match`'s one leak is identical on develop (22,805 B / 340 allocations). Emit-diff 0 lines, allocations +0.27%. Steps after the seed bump: rebase in `~/Workspace/Yo-wt/v4vc-esc`, rebuild stage 1 with the new seed, check src/std, `move_only` and the match tests, compare `verifier_quantifiers`/`module_invalidation`/`verifier_loops` leaks against develop (never done), fmt, refs, ready, merge. Timing A/B never ran (needs a fresh pair from one base; the Z3Sexpr pair is ready: `bash ~/Workspace/Yo-wt/vbd-logs/v4vc/measure.sh 3 dev z3`, exclusive). |
| #1414 `feat/d47-globals-genb` (draft) head `8db9c7b6a` | Decision 47 globals Generation B: std/src mark `mut(G)`, the exemption is removed, markdown_yo `^0.0.18` | Tier 1 on the official v0.2.64 seed fully green: build, check src/std, 14 feature/std files, internal 1419/1419, cli-diff 398/0, site build, fmt and refs. Held by MERGE_FREEZE: after v0.2.65, rebase (overlap rule), refs/fmt, ready, merge. |
| `feat/v2b-genb-b1-migration` (no PR) head `73da377dc` | V2b B1: the explicit-copy sweep over std and src, plus the recursive E0916 structural-clone exemption (§3.2) and a generic-body guard fix for #1385's migration (S2) | Stacked on #1414. Restacked on its head `8db9c7b6a`; the sweeps run after the build. Opens as a draft until #1414 merges. |
| #1421 `feat/vbd-d46-genb` (draft) head `ab95b2321` | Decision 46 Generation B: a write through a plain `Rc` is E0919, and E0909 accepts `&` through an `Rc` | In-process `tests/internal` run found one E0919 site the census missed (it excludes `tests/internal`): `suspension_analysis`, fixed in `af4506896`. Every census-excluded directory was then checked: no other E0919. Remaining: the `suspension_analysis` rerun, the leak comparison against develop's binary on the top-5 leak files, the ratchet and the census. |
| `fix/not-runtime-bool-comptime-fn` (no PR) head `64127047a` | E1101: `!` on a runtime bool in a comptime-parameterized fn (S2) | Build, checks, cli-diff and `prefix_operators` 7/7 green; 3 test files left. It introduces the S1 doc in §5.2. |
| `fix/async-mutex-strict-fifo` (no PR) head `0cf600d93` | The async `Mutex` is FIFO across event loops (S3) | async/mutex 11/11; the 3 new tests fail before the fix. `sm_protocol`, both checks and cli-diff are left. |
| `fix/trial-specialization-drops-store` (no PR) head `7352518df` | S1 fix (§5.2); lands after the E1101 PR | Root-cause hypothesis written; its build is pending. |
| #1422 (`843e88fd8`) (#1419 and #1420 landed); `fix/field-write-through-shared-borrow` (`2f5301589`); `fix/yo-fix-multi-file-generic-impls` (`ce043660e`) | The 5-bug Workflow run (`match` binding across `await`, move-only collection keys and values, collection clone through a borrow, field write through a shared borrow, `yo fix` over several files) | Each was implemented and then adversarially reviewed; the review fixes are being gated. Check each PR's latest comment and head before merging. |
| #1162 `tss/phase6-step4` (draft) head `7e6024532` | Type-soundness phase 6 step 4 | Unchanged; blocked as described in the 2026-10-15 handover. |

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

### 3.x Maintainer questions from #1429 (decision 39)

1. A user-defined collection needs `pragma(Pragma.AllowUnsafe)` to implement `walk_elem`, because a projection body cannot return another projection. Recommendation: make that forwarding work (`issues/questions/borrowed-for-over-user-defined-collections.md`).
2. `HashSet`/`PriorityQueue` refuse `for(&mut …)` by design.
3. Reading the collection inside a borrowed `for` body is E0911; code that reads or grows it must use `indices()`.
4. The macro-site liveness rule applies only to a macro defined in another module (the prelude's `for`); a same-module macro keeps token-based liveness.

## 4. The next steps, in order

1. Land the v0.2.65 gate pieces (§2.3) and the other ready PRs in §2.4.
2. Cut v0.2.65, curate its notes, and let the pipeline bump `SEED_VERSION`.
3. On the v0.2.65 seed: Generation B for decision 47 locals (the sweep over src, std, tests, docs and markdown_yo, then enforcement) and for decision 39 iterators.
4. V2b Generation B as #1408's sequence. B1 (on #1414) is first; B5 converts the collection globals to `RefCell`.
5. Decision 46 Generation B (#1421) and the decision 47 globals Generation B (#1414), if they haven't landed by then.
6. The rest of the 2026-10-15 handover §4 step 14: A6's `Rc`-field half with V2c, the allocator interface version 2, V2c, decision 43, V4's remaining trees (`AstExpr`, `EvalValue`; `Z3Sexpr` landed as #1435, `Pattern` is in §2.4, `VcSort`/`VcTerm` wait on the #1435 design question), V5, then the post-V5 items.
7. The issue-date rename (2026-10-15 handover §4 step 15, script in its §9.1), once in-flight branches have drained.
8. Secondary: PARALLEL_COMPILATION P4 step 2 (a forked `check <dir>`), and sizing `YO_TEST_FORK`'s N on an idle machine. The AGENTS.md note that the `tests/cli-cases` exclude avoids "~4 false failures" is slightly stale: #1427 added two fixtures that fail on purpose.

## 5. Open bugs to know about

### 5.1 S1 (fixed in #1438): an `unwind` is lost when a destructor runs on the escape path

It is in v0.2.64 and reproduces with user code. When an `unwind` passes through a frame that drops a `Box`, or any value whose `Drop` makes a call, the destructor clears `__yo_effect_escaped`. The unwind is lost, and the frame returns its dummy result. Fixed by #1438 (`fbd79fc90`): `return.yo` re-raises `__yo_effect_escaped` after the escape-path drops, with a regression test in `algebraic_effects` that fails on the v0.2.64 seed. `dyn.test` (3 tests) and `internal/error` (1 test) show LSan-only leaks there, identical on the seed with the base tree.

### 5.2 S1: a store in a comptime-parameterized fn is dropped when its first call is the operand of `!`

The doc and its repro (`issues/repros/`) arrive with the E1101 PR. The suspected cause: an overload trial for `!` evaluates the specialization with checking-phase shortcuts, and the real call reuses it. The fix is on `fix/trial-specialization-drops-store`.

### 5.3 Other open issues filed this cycle

On develop:

- `issues/2026-10-16-awaiting-a-future-parameter-typed-by-a-generic-binder-emits-a-void-pointer-result.md` (**S1**, landed with #1432; pre-existing, seed v0.2.63 does the same): a generic function awaiting an `Impl(Future(T, E))` parameter emits a `void*` result or `T v = ;`, and the tail form `io.async({ op }(io : Io) => io.await(op, io))` silently returns a wrong value. Not a v0.2.65 gate item (it is not a regression), but list it under the release's known issues.
- "a match through a borrowed element copies the element" (S2; its doc is on the #1439 branch until that merges: `match(&xs(i), …)` is E0901 although E0901 suggests that form)
- `issues/2026-10-17-a-declared-send-binding-of-a-named-function-is-rejected.md` (S2, from #1424: D9's documented workaround is E0601)
- `issues/2026-10-17-a-closure-typed-field-accepts-a-named-function-and-emits-invalid-c.md` (S2, from #1424: passes `check`, fails in the C compiler; also a `Send` bypass)
- `issues/2026-10-16-a-generic-io-async-body-shares-one-capture-struct-across-futures-of-one-generic-producer.md` (S2; blocks A4's std half)
- `issues/2026-10-16-a-fetch-that-times-out-leaks-an-8-kib-buffer.md` (S2; found by #1409, also fails on develop with leak verdicts on)
- `issues/2026-10-16-the-warnings-stash-test-leaks-under-leak-verdicts.md` (S3; found by #1409, the same test leaks on develop)
- "`!` on a runtime bool in a comptime-type-parameterized fn is E1101" (2026-10-16; the E1101 branch moves it)
- "the async mutex is not FIFO across event loops" (2026-10-16; the FIFO branch moves it)
- `issues/2026-10-17-a-closure-passed-into-a-comptime-expect-error-call-leaks-its-moved-capture.md`
- `issues/2026-10-17-comptime-expect-error-over-a-moving-call-leaves-the-argument-consumed-so-it-leaks.md`
- `issues/2026-10-17-spawn-blocking-s-detached-worker-can-outlive-main-and-lsan-reports-its-captures.md`

Filed on in-flight branches; they arrive with those PRs:

- two S2s in the async `Channel` once it sits behind `RefCell` (#1421);
- `std/time` getters and `Array.len` now take `&Self` (S2, decision 47 locals);

The open S1s already on develop are listed in the 2026-10-15 handover §6.1.

## 6. When v0.2.65 is out: the stop sequence

The maintainer asked for all work to stop once v0.2.65 is published, with this document up to date. The coordinator:

1. Curates the v0.2.65 release notes (§7 has the draft) and checks that `SEED_VERSION` was bumped.
2. Stops its schedulers: the 40-minute status-ping cron jobs (three session-only jobs) and any PR-run cancel loop.
3. Messages every running agent: "STOP after your current tool call. Push your current head. Reply with: branch, head SHA, what passed, what did not run. Do not merge." Any agent that does not answer is stopped.
4. Rewrites §2.4 from the replies, with head SHAs, and updates the live-status box.
5. Re-runs `check-issue-refs.sh` on this PR's rebased head, repointing any citation whose doc moved to `issues/fixed/`, then merges it.

A new agent starting from this document re-runs Tier 1 for any branch before merging it (§2.4).

## 7. Draft of v0.2.65's curated release notes

Paste this over the generated `## Changes` section after the release publishes. Keep line 1 and `## Native bundles` byte-for-byte, as in the 2026-10-15 handover §8.4. Add a bullet for every PR that lands before the cut, and check each bullet against the merged PR's body.

- **Language:**
  - Decision 47 locals Generation A: every `mut(...)` binding form, and `yo fix --migrate mut-bindings`.
  - Decision 39 iterators Generation A (#1429): the borrowed `for(&mut coll, x => …)` walks a cursor (`BorrowedWalk`). Touching the collection inside the body, even a read, is now a compile-time E0911 with a hint to use `coll.indices()`; `HashSet` and `PriorityQueue` no longer accept `for(&mut …)` (a `&mut` element could corrupt their order or hashing); `return(x)` of the loop element is E0912 (copy it first).
- **Compile and codegen:**
  - Fixed (S1): an `unwind` through a frame whose destructor makes a call was lost (#1438).
  - Fixed (S2): a recursive enum's self-shell lowers like its nullable-pointer final (#1426).
  - Fixed (S2): a generic `derive(Clone)` over a container field of its parameter (#1437).
  - Fixed (S2): a `downcast`/`upcast` result used as a method receiver or discarded is released, and so is an `Iso(T)(v)` constructor result (#1409).
- **Type checking:**
  - A closure capture struct is `Send`/`Sync` by what it captures, so `arc` of a closure over a closure crosses threads (#1424).
  - V3 A4: a generic future combinator accepts a borrowing future as its by-value operand, and two operands lending overlapping places are E0910 (#1432).
  - Fixed (S2): a generic function's by-value closure parameter owns a deferred closure literal (#1428).
  - `yo check` reports errors inside any closure with an `io : Io` parameter (#1425).
- **Async runtime:**
  - Fixed (S1, S2): a `mut` match place binding lives across an `await`, and a `mut` match on a field no longer writes a copy (#1419).
  - `Waker` implements `Clone` (#1412).
  - Fixed (S2): the epoll teardown frees its free lists at thread exit (#1417).
- **Std:** collections hold move-only keys and values (`HashMap`, `HashSet`, `BTreeMap`, `Deque`, `PriorityQueue`) (#1420).
- **Leaks:** Fixed (S2): `consume(x)` of an owned value releases it (#1416).
- **Verifier internals:** `Z3Sexpr` is a value enum (V4, #1435); omit from the notes unless something user-visible changed.
- **Toolchain:** `YO_TEST_FORK=N` runs `yo test` over many files in forked workers (#1427).
- **Known open issues filed this cycle:** the §5.3 paths that are still open at the tag.

## 8. Machine-specific notes (ignore on a new machine)

The coordinator on the Linux box kept these files under `~/Workspace/Yo-wt/vbd-logs/`; none of them travels:

- `QUEUE.md`, the running log;
- `AGENT_BRIEF.md` and `bugfix-brief.md`, the sub-agent briefs, whose rules are restated in §1;
- `release-notes-v0.2.64-final.md`;
- each agent's gate logs.

Heavy-lock configuration: `~/Workspace/Yo-wt/heavy-lock.conf` (6 slots on the 64 GB box).
