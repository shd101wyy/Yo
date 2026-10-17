# VALUES_BY_DEFAULT handover — 2026-10-17

> **Status: LIVING DOCUMENT until v0.2.65 is published.** The coordinator updates the "Live status" box below as PRs land. When v0.2.65 is out, all in-flight work stops and this document is final.
>
> **Live status (last update 2026-10-18 03:00 CST):** develop is at `b95a982f4` (#1432). v0.2.65 gate: item 3 done; items 1 (decision 47 locals) and 2 (#1429) are gating. v0.2.64 is the published seed. v0.2.65 is not cut; its gate is in §2.3.
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
| #1432 | V3 A4 compiler half: a generic combinator's by-value future operand accepts a borrowing future (re-rooted at the parameter, so the combinator's future is second-class); decision 38 B overlap is E0910. Only a generic function is a combinator slot (a non-generic one would let two `&mut` operands of one place pass). The std half (`timeout`/`select` over futures) stays parked on `wip/vbd-a4-std-half` behind an S2 |
| #1409 | A `downcast`/`upcast` result (and `Iso(T)(v)`) declares its owning temp, so a receiver or discarded result is released (S2); the rule is in `c-codegen.instructions.md` |
| #1438 | S1: an `unwind` through a frame whose destructor makes a call is no longer lost (v0.2.65 gate item 3) |
| #1412 | V3 A5: `Waker` implements `Clone` over `__yo_waker_clone` (Generation B on the v0.2.64 seed); `cross_thread_wake` uses `w.clone()` again |
| #1435 | V4: the verifier's `Z3Sexpr` is a value enum (no `Box` needed: its children live in an `ArrayList`). `VcSort`/`VcTerm` wait on `issues/questions/2026-10-17-should-the-verifier-terms-take-box-or-rc-children.md` (recommends `Rc` for `VcTerm`, `Box` for `VcSort`, once maps hold move-only values). Its exclusive timing A/B runs once the heavy queue drains. |

### 2.3 The v0.2.65 release gate

Cut v0.2.65 (2026-10-15 handover §8.4, then curate the notes as for v0.2.64) only when all of these hold:

1. **Decision 47 locals, Generation A** has merged. Branch `feat/vbd-d47-locals-gena`, no PR yet.
2. **Decision 39 iterators, Generation A** has merged: #1429, branch `feat/vbd-decision39-gen-a`.
3. ~~**The unwind S1 fix** has merged.~~ **Done:** #1438, `fbd79fc90` (§5.1).
4. **Develop's battery is green on the exact tip**, and `git diff --stat <battery-head>..origin/develop -- src/ std/ tests/ .github/ scripts/ build.yo` is empty.

Items 1 and 2 add syntax and semantics that their Generation B sweeps need a seed to parse; that is why they gate the release. The other open PRs (§2.4) land whenever they are ready and do not gate it. Never cancel a `Release` run.

### 2.4 Open PRs and pushed branches

Every branch below is pushed to `origin` at the head shown, as of the live-status timestamp. Each row says what is left. Gate logs do not travel: a new machine re-runs each branch's Tier 1 before merging it, whatever this table says. "Tier 1 green" means the AGENTS.md Tier 1 set passed on the stated head. Unless a row says otherwise, the next step is to rebase, apply the overlap rule (§1.1), run fmt and refs, then merge.

| PR / branch | Piece | State and what is left |
| --- | --- | --- |
| #1429 `feat/vbd-decision39-gen-a` head `0c2f78962` | Decision 39 iterators, Generation A: the borrowed `for` walks a cursor over a local borrow, and a push to the list being walked is E0911 | Pre-rebase Tier 1 green except 4 ASan leak reports in `tests/internal/compile.test.yo`. **Before merging, run that file with develop's binary at the same base and compare the reports.** Gates v0.2.65. |
| `feat/vbd-d47-locals-gena` (no PR) head `f328f8b9e` | Decision 47 step 2 Generation A: every `mut(...)` binding form, `yo fix --migrate mut-bindings` | `check ./src` 278/278 and build green pre-rebase. The tests sweep is regenerated (2117 + 243 + 10 bindings, 9 parameter writes rebound). Remaining jobs: the rebased build, `check ./std`, the full suite with cli-diff, in-process internal, and the src/std census. Open it as a ready PR. It also accepts module-level `mut(x) ::`, which the PR must flag for the maintainer. Gates v0.2.65. |
| #1439 `feat/vbd-v4-pattern-box` (draft) head `44d9ec526` | V4: the `Pattern` tree with `Box` children | **Generation B: merge only after `SEED_VERSION` carries #1438 (v0.2.65).** On a stage 1 built by the v0.2.64 seed, `move_only` crashes: an E0901 thrown through a `Box`-dropping arm in `_augment_arm_pattern` loses its unwind (the #1438 bug, in the stage 1's own code). Otherwise its gate passed: build, check src/std, 10 of 12 files. `verifier_match` fails on a leak only (22805 bytes in 340 allocations); a comparison against develop's binary is queued, and so is a stage-2 run of `move_only`, the repro, the match tests and `algebraic_effects`. |
| #1414 `feat/d47-globals-genb` (draft) head `8db9c7b6a` | Decision 47 globals Generation B: std/src mark `mut(G)`, the exemption is removed, markdown_yo `^0.0.18` | Built on the official v0.2.64 seed. The full Tier 1 (internal in-process, cli-diff, `yo test ./std`, site build) passed with a develop-built compiler and is re-running on the seed build. Mark ready, then merge. |
| `feat/v2b-genb-b1-migration` (no PR) head `73da377dc` | V2b B1: the explicit-copy sweep over std and src, plus the recursive E0916 structural-clone exemption (§3.2) and a generic-body guard fix for #1385's migration (S2) | Stacked on #1414. Restacked on its head `8db9c7b6a`; the sweeps run after the build. Opens as a draft until #1414 merges. |
| #1421 `feat/vbd-d46-genb` (draft) head `ab95b2321` | Decision 46 Generation B: a write through a plain `Rc` is E0919, and E0909 accepts `&` through an `Rc` | In-process `tests/internal` run found one E0919 site the census missed (it excludes `tests/internal`): `suspension_analysis`, fixed in `af4506896`. Every census-excluded directory was then checked: no other E0919. Remaining: the `suspension_analysis` rerun, the leak comparison against develop's binary on the top-5 leak files, the ratchet and the census. |
| #1424 `fix/send-closure-and-fn-value` head `3bd849953` | A closure capture struct is Send/Sync by its captures (S2s) | Tier 1 green except the in-process internal run, which had reached file 63 of 108 with no failures. |
| `fix/not-runtime-bool-comptime-fn` (no PR) head `64127047a` | E1101: `!` on a runtime bool in a comptime-parameterized fn (S2) | Build, checks, cli-diff and `prefix_operators` 7/7 green; 3 test files left. It introduces the S1 doc in §5.2. |
| `fix/async-mutex-strict-fifo` (no PR) head `0cf600d93` | The async `Mutex` is FIFO across event loops (S3) | async/mutex 11/11; the 3 new tests fail before the fix. `sm_protocol`, both checks and cli-diff are left. |
| `fix/trial-specialization-drops-store` (no PR) head `7352518df` | S1 fix (§5.2); lands after the E1101 PR | Root-cause hypothesis written; its build is pending. |
| #1437 `fix/generic-derive-where-container-field` head `f4e6514cc` | Derive Clone PR B: a derive's generated body in a generic definition-time trial | Post-rebase gate on `9f7a958b4` all green (build, check src/std, derive 66, derive_clone_complex 21, copy_trait 29, impl 12, type_soundness 71, for_macro_borrow 27). #1432 then touched `calls/function.yo` again, so it rebased to `f4e6514cc` and re-queued the same gate. Merge on that gate without another rebase. |
| #1419 (`7e5b3d66b`), #1420 (`a6ff95233`), #1422 (`843e88fd8`); `fix/field-write-through-shared-borrow` (`2f5301589`); `fix/yo-fix-multi-file-generic-impls` (`ce043660e`) | The 5-bug Workflow run (`match` binding across `await`, move-only collection keys and values, collection clone through a borrow, field write through a shared borrow, `yo fix` over several files) | Each was implemented and then adversarially reviewed; the review fixes are being gated. Check each PR's latest comment and head before merging. |
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
- a generic `Copy` impl over an `Option(A)` field is rejected even when hand-written (S2, derive Clone PR B);
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
  - Decision 39 iterators Generation A: the borrowed `for` walks a cursor, and a push to the list being walked is E0911 (#1429).
- **Compile and codegen:**
  - Fixed (S1): an `unwind` through a frame whose destructor makes a call was lost (#1438).
  - Fixed (S2): a recursive enum's self-shell lowers like its nullable-pointer final (#1426).
  - Fixed (S2): a `downcast`/`upcast` result used as a method receiver or discarded is released, and so is an `Iso(T)(v)` constructor result (#1409).
- **Type checking:**
  - V3 A4: a generic future combinator accepts a borrowing future as its by-value operand, and two operands lending overlapping places are E0910 (#1432).
  - Fixed (S2): a generic function's by-value closure parameter owns a deferred closure literal (#1428).
  - `yo check` reports errors inside any closure with an `io : Io` parameter (#1425).
- **Async runtime:**
  - `Waker` implements `Clone` (#1412).
  - Fixed (S2): the epoll teardown frees its free lists at thread exit (#1417).
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
