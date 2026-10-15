# VALUES_BY_DEFAULT handover — 2026-10-15

**Status: ACTIVE handover, current as of 2026-10-15 (v0.2.63: RELEASE_STATE_PLACEHOLDER).**
- **Supersedes:** [`VBD_HANDOVER_2026-10-13.md`](VBD_HANDOVER_2026-10-13.md). Its §3 order and the 2026-10-10 handover's §5 ("How to work in this repository") still apply unless this document amends them.
- **Written:** 2026-10-15 by the agent that ran the campaign from 2026-10-13 through the v0.2.63 cut. The maintainer's instruction: "stop all your work after v0.2.63 is out. Then please create a handover doc in new PR so another agent on another machine can pick it up. Please make it as detailed as possible".
- **Who it is for:** an agent on **another machine**. Nothing below depends on the old box. Every branch named here is pushed. Every script the work needs is either in the repository or inlined in §9. The previous machine's paths appear only in §10, and only as history.
- **The authoritative design** is [`plans/VALUES_BY_DEFAULT.md`](../VALUES_BY_DEFAULT.md): decisions 1–46 in §4, phases in §6. This document points into it and does not restate it.
- **Before acting on any branch,** verify it with `git log origin/<branch>`, `gh pr view <n>` and `gh pr list --state open`. Other sessions may have moved it since.

Read in this order:
1. `AGENTS.md`. The Tier 1 rule is in "Git: worktrees, branches, merges".
2. This document.
3. `.github/instructions/testing.instructions.md`, in particular "Choosing a Tier 1 gate" and "The heavy lock".
4. `plans/VALUES_BY_DEFAULT.md`: the header's progress list, decisions 44–46 in §4, §3.13 (async), and §6's V2b, V4, "Evaluator performance", "Decision 43" and "Decision 46".
5. The `.github/instructions/` file for the area you touch.

---

## 1. The standing goal and the maintainer's rules

**The goal is unchanged:** finish every phase in `plans/VALUES_BY_DEFAULT.md`. The maintainer said "Finish everything in VBD_HANDOVER_2026-10-10.md and VALUES_BY_DEFAULT.md" and then stopped this session at the v0.2.63 cut. Pick up at §4.

These rules were set or confirmed 2026-10-13/15. Each one overrides older text that says otherwise.

### 1.1 Merging

- **Tier 1 is the merge gate** (AGENTS.md since #1356, sharpened by #1374). Admin-merge a PR as soon as its targeted local Tier 1 passes:
  - `gh pr merge <n> --squash --admin --delete-branch`.
  - Do not wait for the PR's GitHub battery, and cancel it once the PR has merged.
  - Several PRs in a row are fine.
- **Develop's own battery is the full check.** Watch it pinned by run id (§8.3). Fix every red job forward with a `fix(develop): …` PR, which merges on its own Tier 1.
- **A release needs develop green on the exact tip** (§8.4).
- **The maintainer's standing OK** covers:
  - admin-merging new PRs;
  - dispatching patch releases of Yo and markdown_yo (pre-authorized);
  - cancelling CI runs as in §1.3.
- Claude Code's auto-mode classifier has sometimes refused `gh pr merge --admin`. If it does, ask the maintainer in the session.

### 1.2 Tier 1: select the tests by what the diff touches

`testing.instructions.md`, "Choosing a Tier 1 gate", is authoritative.

- **Always:**
  - `yo build --std-path ./std`, but only if `src/` changed;
  - `$B check ./src --std-path ./std` and `$B check ./std --std-path ./std` with the tree-built `B=yo-out/<target>/bin/yo`;
  - `$B fmt --check` on every changed `.yo` file;
  - `bash scripts/check-issue-refs.sh`.
- **Feature tests:**
  - every `tests/**/*.test.yo` that names a changed identifier;
  - `yo test` takes **ONE path per run**. A multi-path call fails in 0 s and verifies nothing, which is how decision 45 Generation B's first gate "passed".
- **`tests/internal`:**
  - only the files that import a changed `src/` module directly, or grep-name a changed identifier;
  - a std-only or prelude-only change does **not** select every internal file; it takes `compile.test.yo` plus the files that name a changed identifier;
  - each internal file re-evaluates the compiler, about 3–4.5 min apiece;
  - more than about 8 files → one `YO_TEST_IN_PROCESS=1 YO_TEST_MAX_RSS_MB=12000 yo test ./tests/internal --parallel 1` run, taken `exclusive` on the heavy lock. It took 95 min on an M4, not the 37 min AGENTS.md quotes.
  - Anything touching `src/types/` must run the internal files that import `src/types`: #1329 broke develop by skipping them.
- **cli-diff** (`YO_SELF_BIN=$PWD/yo-out/<target>/bin/yo bash scripts/cli-diff-test.sh`): only when CLI output, std, diagnostics, skills or migrations can move.
  - Re-record (`--record <case>`) only the cases whose diff is the intended one.
  - Under macOS's bash 3.2 the script now exits 2 on a harness error instead of 0 (#1388). Treat any exit other than 0 as a failure.
- **Not in Tier 1:** the full language suite, `yo test ./std`, the fixpoint. CI runs those.

### 1.3 CI runs

- **May be cancelled** (maintainer, 2026-10-15: "Feel free to cancel github workflow runs. I see some of them already failed some steps but are still running"):
  - any run, PR or develop, that already has a failed job, since it can no longer give a green verdict;
  - the PR run of a PR that has merged.
- **Never cancel:**
  - a `Release` run;
  - `ubsan.yml` or `fixpoint-arm64.yml` runs;
  - develop's **tip** run while it has no failure, because it is the release gate.
- Always print `workflowName` before cancelling (AGENTS.md).
- A flaky job gets one `gh run rerun <id> --failed`. A second failure is real.

### 1.4 Agents and the machine

- **At most 5 concurrent agents** (maintainer, 2026-10-15), subagents and workflow agents combined.
- **Every heavy step goes through `scripts/heavy-lock.sh`** (`source scripts/heavy-lock.sh; trap heavy_drop EXIT; heavy_take "<who>: <job>" [exclusive]`). Size the slots per machine in `$HEAVY_ROOT/heavy-lock.conf`.
  - Never hold a slot while idle: one script per gate, with no waits inside.
  - **Never backdate a ticket.** A gate script that rewrote `_heavy_now_ns` to jump the queue deadlocked it for every other waiter.
  - Timings and A/B runs take `exclusive`.
- **Do not run informational A/B timings while gates are queued.** This session deferred two (§6.3) so they would not block merges.

### 1.5 Design

- **"Whenever we could be explicit, do explicit."** Follow Rust's model wherever VBD has a choice: decisions 44–46, the async `Mutex`, the global-lend rule (§5).
- Design calls inside an approved decision are delegated: decide strict, explicit and sound, record the call as a numbered decision or an "as built" note, and prove it with tests.
- Ask the maintainer only when a choice changes the user-visible language beyond what the plan implies. This cycle that happened twice: the async `Mutex`/`Rc` model and the global-lend rule.
- **The evaluator-performance work is deferred until after VBD** (maintainer, 2026-10-15: "I am thinking about investigating the evaluator performance after we finish VBD"). Do not start §6 "Evaluator performance" step 1 or 2 before V5. Step 3, the CI guard, is already done (#1359).

### 1.6 Issue docs

- Every bug gets `issues/YYYY-MM-DD-<kebab-name>.md` (the filing date; #1357).
  - It carries a `**Severity:** S1|S2|S3` line.
  - It comes with a test that fails before the fix and passes after.
- An open design question goes in `issues/questions/YYYY-MM-DD-<name>.md` with a `## Recommendation`.
- Never put the severity in the file name.
- The one-time rename of the older, undated open docs is §4 step 12.

---

## 2. Where everything stands

### 2.1 The releases

| Release | Published | Notes |
| --- | --- | --- |
| v0.2.60 | 2026-10-12 21:58Z | E0914 always on, effect rows by value, `Index` by value |
| v0.2.61 | 2026-10-13 13:37Z | A1 futures, A2 borrowing futures, V2b projections Gen A, wrapper patterns, unique `Box`, V4 prep |
| v0.2.62 | 2026-10-14 03:52Z | Drop Gen A (#1343), E0910 lent-place moves (#1346), `&Self` read-only receivers (#1347), allocator audit (#1337), V4 codegen blockers (#1341) |
| **v0.2.63** | RELEASE_ROW_PLACEHOLDER | §2.2 below |

### 2.2 What v0.2.63 carries (develop `v0.2.62..6f6a2d8e9`)

**Language and type checking (VBD):**
- #1349: V3 async A3 Generation B and A4's handle half.
  - `JoinHandle(T)` is a move-only value: `await`, `join` and `timeout` consume it.
  - The `std/async` combinators take handles by value.
  - `ArrayList.pop`, `swap`, `remove` and `reverse`, and `Option.take` and `replace`, move bitwise.
- #1353: decision 31 Generation B.
  - The implicit `Rc` look-through in patterns is E0609.
  - `yo fix --migrate rc-pattern`.
  - `Box(p)` patterns.
- #1354: V1 step 2 Generation B. The verifier's cells are the unique `Box`, and ref-handle owner chains drop their cell.
- #1358: decision 45 Generation A follow-ups.
  - A trait method named `drop` keeps its `Dyn` vtable slot.
  - `T.drop` read as a value is E0915.
  - A type gets one destructor slot.
  - `Drop` and `Dispose` bounds unify.
  - The migration is semantic.
- #1361: V2b Generation B.
  - The prelude's `Index`/`IndexMut` are projections (`-> &Self.Output` / `-> &mut Self.Output`).
  - Every std impl is split.
  - `String` has a read-only byte index.
  - #1377 restored the unchecked twins as raw-pointer returns, so safe code cannot call them.
- #1366: closures are `Copy`/`Clone` the way Rust's are (decision 36 amended). A closure owning a `String` moves.
- #1339: decision 44. A callable bare in a `Dyn(Fn)` slot is E0618, and `yo fix --migrate dyn-spelling`.
- #1382: E0910's argument-overlap verdict no longer depends on evaluation order.
  - It used to be gated on a session-wide "some capture list borrowed" flag.
  - The check now applies when a capture borrow is one side, with a `Copy` exemption.
- #1387: the **two-phase borrow rule**. A later argument may not move, overwrite or `&mut`-relend a place an earlier argument lends; reads and `&` relends are fine. It covers operator operands and calls that omit a defaulted parameter.
- #1389: a module-level or `thread_local` binding lent to a **borrowing future** is E0909 (S1). The plain-call half is open (§5.1, §4 step 6).
- #1384: V2b unique buffers Generation A1.
  - `Trace` on buffer-owning values.
  - Owned-buffer cycle, reach and `Acyclic` walks.
  - Value-rooted borrow flags lower to nothing.

**Compile, codegen and runtime:**
- #1365: a block result that is not moved is released. Every assignment's old-value save is by bytes.
  - #1381 fixed the early-exit release of those saves. Without it, #1365 regressed memory: CI's stage-2 C lost 22,262 `__yo_decr_rc` sites, and the RSS ratchet went red.
- #1367: comptime enum payload assignment, a template backslash before `${…}`, and `runtime()` ownership.
- #1386: a block that yields an outer local takes its own reference (an S1 use-after-free on develop).
- #1388: `spawn_blocking`'s `sink` closure is captured with its own references; std/http's `serve`/`serve_once` take `sink(handler)`.
- #1376: the runtime treats offset `u64.MAX` as "the descriptor's own position". This is the stdio fix's Generation A; Generation B is §4 step 7.
- #1392 then #1393 (fix(develop), after `31ef8d7a3`): on Windows a positioned disk transfer moved the file pointer, while POSIX `pwrite` does not. #1376's seek test turned both Windows legs red.
  - #1392 first documented the divergence, as Rust and Zig do.
  - The maintainer then chose the runtime fix, #1393: `__yo_win_resolve_offset` records the pointer before each disk transfer, and `__yo_win_settle_position` puts it back, or advances it for `u64.MAX`.
  - Issue: `issues/fixed/2026-10-15-windows-positional-disk-io-moves-the-file-pointer.md`.
  - The Windows C was verified by splicing into cross-emitted C and running `clang -target x86_64-w64-windows-gnu -fsyntax-only` against zig's MinGW headers (§7).
- #1362: `String.to_cstr_checked()`. std's C boundaries reject an interior NUL.
- #1373: a warm compile replays its cached inputs, and a failed build removes its artifact.

**Performance:**
- #1369: V4, `TypeValue :: Rc(TypeValueNode)`. Against develop 93de1de73:
  - `check ./src`: 188.1 → 172.1 s;
  - self-emit: 401.6 → 334.5 s;
  - emitted C: 138.4 → 135.3 MB.

**CI, process and plans:**
- #1359: the deterministic allocation-count ratchet (`check_src_main_alloc_calls`).
  - Its baseline was re-based to **2,996,136,722** for V4 (#1391; attribution in `issues/fixed/2026-10-15-v4-typevalue-rc-raises-the-check-allocation-count-by-7-percent.md`).
- #1363, #1364, #1370: `scripts/heavy-lock.sh`, `heavy-lock.conf`, and its self-test `scripts/heavy-lock-test.sh`.
- #1355, #1356, #1374: three-tier gating and Tier 1 selection.
- #1357: dated issue names.
- #1383: `yo test --std-path` works under `YO_TEST_IN_PROCESS=1`.
- #1390: develop skew fix (`closure_capture_list` expects E0910 for the `&mut` relend).
- #1371: decision 46.
- #1372: the F* audit (backlog).
- #1350, #1351, #1352: plans.

### 2.3 Open PRs and branches at hand-over

Every one is pushed. "Next" is the exact next action.

#### #1378 — decision 45 Generation B: `Dispose` → `Drop` across the tree (`vbd-d45-genb`, head `5aa03a9ee`)

> **REBASED AND GATED 2026-10-15 — land it from `vbd-d45-genb-rebased` (head `cfc7e2e59`, on develop `6f6a2d8e9`). The steps below are done.**
>
> - **Conflicts as resolved:**
>   - `.Some(Rc(.TraitT(...)))` in `_is_destructor_trait_id`;
>   - the twins deleted;
>   - `docs/*/CYCLE_COLLECTION.md` take develop's Trace paragraph.
> - **Also done:**
>   - The prelude-path nit is fixed: the migration-only `Dispose` is appended only when the resolved entry equals `${std_path}/prelude.yo`.
>   - Develop's new `Dispose` sites are migrated: `tests/cycle_collector`, `tests/fixtures/owned_buffer.yo`, `tests/parameter_modes`.
> - **Tier 1 on `b0ff7866e`:**
>   - build; check src 278/278 and std 171/171;
>   - 45 feature tests;
>   - `tests/internal` in-process 1419/1419 (97 min);
>   - cli-diff 393 with 0 diffs;
>   - fmt (92 files), issue refs.
> - **Re-gate on `cfc7e2e59`** (develop's #1392/#1393 only): build, check src/std, `seek`, `cross_thread_wake`.
> - **Land:**
>   1. `git push -f origin vbd-d45-genb-rebased:vbd-d45-genb`
>   2. `gh pr merge 1378 --squash --admin --delete-branch`
>   3. Cancel its PR run.
>   4. If develop has moved, rebase first; the conflicts so far were comment-only.

- **What:** runs `yo fix --migrate drop-trait` over the tree and deletes the `Dispose` spelling. The compiler knows only `Drop`.
- **Seed:** the tree needs a seed that knows `Drop` (v0.2.62 does). It also needs v0.2.63 because of #1358's bound unification, which is why it was held for the cut.
- **Review (2026-10-15):** clean apart from the rebase.
- **Next:**
  1. Rebase onto develop. `src/evaluator/calls/function.yo` ~L417 conflicts with V4's `_destructor_trait_name_of_id`. Keep this PR's `_is_destructor_trait_id`, but V4 needs its `.Some(.TraitT(...))` pattern spelled `Rc(.TraitT(...))` (decision 31 Gen B).
  2. In `src/evaluator/trait_checking.yo` ~L1105, delete the twin functions, as the PR does.
  3. Nit: `src/module_manager.yo` ~L2970 appends the migration-only `Dispose` to any path ending in `prelude.yo`, which includes a user's own. Match the resolved std prelude path instead.
  4. Tier 1: `yo build`; check src and std; the tests naming `Drop`/`Dispose`/`drop(` (grep, one `yo test` per file); the `tests/internal` files importing `src/evaluator/calls/function.yo`, `trait_checking.yo`, `module_manager.yo` and `src/codegen/functions/constructors.yo` (more than 8 → the in-process run); cli-diff, since diagnostics and the migration changed.
  5. Admin-merge. Fix develop forward.
  6. **Merge this before #1379.**

#### #1379 — V3 async A5: move-only wakers, parks, channel halves; streams take `&mut self` (`feat/vbd-v3-async-a5`, head `2996a8419`)

> **REBASED ONTO #1378 AND GATED 2026-10-15 — land it from `feat/vbd-v3-async-a5-rebased` (head `4cc522f97`, stacked on `cfc7e2e59`). Steps 1, 2 and 4 below are done; step 3 waits for the seed.**
>
> - **Rebase:** with `--onto`, merge base `23787451b`. A5's commits `3838c6d8f` and `eb4f5a3c8` were skipped, because they duplicate #1382.
> - **B4 done:**
>   - `cross_thread_wake` and `std/async/{channel,waker}.yo` are on `Drop`;
>   - the §3.13 prose says `Drop`.
> - **`std/hash.yo` keeps its workaround** with a `// TODO(v0.2.63 seed)` note. Revert it once v0.2.63 is the installed seed.
> - **Tier 1 on `ec8958596`:**
>   - build; check src and std;
>   - 32 feature tests (`async_await` 280);
>   - 5 `tests/internal` files;
>   - cli-diff 393 with 0 diffs;
>   - fmt (102 files).
> - **Re-gate on `4cc522f97`:** build, check, `seek`, `cross_thread_wake`.
> - **Land, after #1378 squash-merges:**
>   1. `git fetch && git rebase --onto origin/develop cfc7e2e59 feat/vbd-v3-async-a5-rebased`
>   2. `git push -f origin feat/vbd-v3-async-a5-rebased:feat/vbd-v3-async-a5`
>   3. `gh pr merge 1379 --squash --admin --delete-branch`

- **What:** A5's remaining lines (§3.13).
  - `Waker` is move-only; `Waker.clone` Generation A adds `__yo_waker_clone`.
  - `Park` and the channel `Sender`/`Receiver` halves are move-only.
  - Streams take `&mut self`.
  - It also carries `std/hash.yo`'s workaround `t := self.tail; self._compress(t);` (commit `58adc48b5`) for the old order-dependent E0910.
- **Next, after #1378 is in:**
  1. Rebase onto develop. Conflicts:
     - `src/evaluator/exprs/begin.yo` ~L2552/2586: take `rc(TypeValueNode.Unit)` (V4).
     - `src/codegen/exprs/async.yo` ~L1588: take A5's `_capture_struct_fields`.
     - `src/main.yo` ~L6612: comment only.
     - `plans/VALUES_BY_DEFAULT.md` ~L126: take A5's bullet.
     - A5's E0910 rewrites in `begin.yo`, `utils.yo` and `main.yo` duplicate develop's #1382 and drop out of the diff.
  2. **B4, a semantic conflict with #1378:**
     - `tests/cross_thread_wake.test.yo:58` (`impl(_RawWaker, Dispose(...))`) merges cleanly but no longer compiles once `Dispose` is deleted.
     - `std/async/channel.yo` (`Sender`'s destructor, ~L416) and `std/async/waker.yo` (~L112) conflict textually. Keep A5's bodies under #1378's `Drop(drop : (fn(self : &mut Self) -> unit))` header.
     - Run `yo fix <files> --migrate drop-trait` with the tree-built compiler.
     - Change the §3.13 A5 prose "with a `Dispose`" to `Drop`.
  3. Revert the `std/hash.yo` workaround to `self._compress(self.tail)`. The v0.2.63 seed carries #1382, so the seed check accepts it.
  4. Tier 1: build; check src and std; `tests/cross_thread_wake`, `tests/async/channel*`, `tests/async/waker*`, `tests/async_await.test.yo`, and every test naming `Waker`, `Park`, `Sender`, `Receiver` or `Stream` (one file per call); the internal files importing `src/codegen/async/*` and `src/evaluator/exprs/begin.yo` (likely more than 8 → the in-process run, `exclusive`).
  5. Admin-merge.
- **Then (Generation B):** `Waker.clone` needs a seed carrying `__yo_waker_clone`, so it waits for the release after A5 merges. Change `std/async/waker.yo` to `impl(Waker, Clone(clone : … Waker(_p : unsafe(__yo_waker_clone(self._p)))))`, and move the cross-thread tests back to `Park` and `w.clone()` (§3.13 A5 "Waker.clone, Generation B").

#### #1380 — the async `Mutex` follows Rust (`feat/vbd-async-mutex-rust`, head `657146480`, draft, stacked on #1379)

- **What:**
  - the async `Mutex(T)` is move-only like tokio's, shared as `Arc(Mutex(T))`;
  - E0909 accepts a `&` through an `Arc` via a read-only-handle predicate;
  - D3 checks every hop.
- **Blocked:** do not merge as written. The review found two use-after-frees, each reproduced with the branch's stage-1 and rejected by v0.2.62.
  - **B1, the pragma-trust hole (S1):**
    - D3 trusts every mutator defined in a pragma file, so a spawned task can call `b.*.o.take()` on an `Arc` copy, because `Option.take` lives in the prelude.
    - Meanwhile `io.await(peek(&a.*, io), io)` holds the borrow, and the future reads 0 where 7 was written.
    - **Fix D3 first:** trust a pragma'd callee by its **mutation mask**, not by its file. The issue doc is on this branch: `issues/2026-10-15-d3-trusts-every-mutator-defined-in-a-pragma-file-so-std-writes-through-an-arc.md`. Land it on develop as its own PR, with its test.
    - The probe shape:

      ```yo ignore
      // a : Arc(Mutex-like(T)) whose payload has an Option field `o`
      b := a.clone();
      h := io.spawn(io.async({ b : b }(e : Io) => { b.*.o.take(); }));
      v := io.await(peek(&a.*, io), io);   // the borrow is live across the spawned write
      ```

  - **B2, a module-level `Arc` root:**
    - `G := arc(...)` is lent through `&G.*`, and `G = arc(...)` runs during the await, so the future reads a later allocation.
    - In `_check_future_call_lends`, reject a lend whose root is a module-level or `thread_local` binding. `_module_global_root_var` (`src/evaluator/exprs/assignment.yo`) already computes this, and #1389 uses it for plain lends.
  - **B3:** `tests/async_await.test.yo` goes red. The branch changed E0909's text from "lives in a shared cell" to "lives in a shared mutable cell", and 10 `comptime_expect_error` substrings at L7136–7207 expect the old text. Update them.
  - **Should-fix:**
    - `handle_payload_is_read_only` (`src/evaluator/utils.yo` ~L1175) matches by shape, so all 11 `std/sync/atomic.yo` types qualify too. Key it on the prelude `Arc`'s identity.
    - After the rebase, V4 needs `Rc(.Struct(...))` / `rc(TypeValueNode.Unit)` at `utils.yo` ~L1175 and ~L1299, and an import/export union with #1339's in `function.yo`, `assignment.yo` and `utils.yo`.
- **Next:**
  1. Land the D3 mutation-mask fix on develop.
  2. Restack this branch onto #1379 once #1379 merges (`git rebase --onto origin/develop <old-a5-tip> feat/vbd-async-mutex-rust`).
  3. Fix B2, B3 and the should-fixes. Re-run both probes.
  4. Tier 1, adding `tests/atomic_object`, `thread_safety`, `closure_capture_list`, `arc` and `async_await`.
  5. Merge.

#### #1385 — V2b unique buffers Generation A2: `yo fix --migrate explicit-copy` (`feat/vbd-v2b-explicit-copy-migration`, head `ffb6dc6af`, draft)

- **What:** the migration that inserts `.clone()` at every implicit copy of `String`, the collections and their aggregates whose source lives on. A written-after guard leaves copies that may share a buffer on purpose for a hand edit.
- **Dry-run surface:**
  - `src/`: 3,761 inserted, 644 left as written;
  - `std/`: 205 inserted, 97 left.
- **History:** stacked on #1384, which merged. #1385 was retargeted to develop before the base branch was deleted, so it stays open.
- **Its question doc** (copied to develop by the handover PR; identical, so the rebase merges it cleanly): `issues/questions/2026-10-14-explicit-copy-migration-cannot-see-writes-through-an-escaped-copy.md`. It recommends leaving those to the flip's E0901.
- **Next:**
  1. Rebase onto develop.
  2. Tier 1: check src and std; the cli-case `tests/cli-cases/fix-migrate-explicit-copy`; the internal files importing `src/evaluator/utils.yo`.
  3. Mark it ready and merge.
- **Then V2b unique buffers Generation B** (the v0.2.63 seed carries A1): run the migration over std, src and tests; hand-edit the left-as-written sites; then flip `String` and the collections to the explicit-copy kind, so an implicit copy whose source lives on is E0901.
  - The allocation ratchet will DROP by more than 5%. Lower `check_src_main_alloc_calls` in the same PR (`scripts/bootstrap/memory-ratchet.tsv`, with a dated comment).

#### #1368 — V2b direct projection calls, Generation A (`feat/vbd-v2b-projection-calls`, head `f857d65d2`, draft)

- **What:** a projection called by name (`t.index(i)`, `first(&t)`) yields its place: operand, receiver, argument, binding (a local borrow, E0911/E0912) and write target.
- **Tier 1 has NEVER run**: the session never got a slot for it.
- **Known gap:** `issues/2026-10-15-a-direct-projection-method-call-bound-to-a-local-reaches-the-c-compiler.md` (S2, #1375). `r := xs.index(usize(0));` fails in clang with an int-from-pointer error. This PR is its fix, so add that repro as a test.
- **Next:** rebase onto develop (V4 and #1361 moved the index code). Run the full Tier 1 (check src/std, `tests/index.test.yo` and every test naming `index(`, the internal files importing the touched evaluator modules). Fix, then merge.

#### #1162 — type-soundness phase 6 step 4: a live FTT stub is a compile error (`tss/phase6-step4`, draft since 2026-10-03)

- Not VBD. It is blocked on a codegen reachability pass; the PR body has the findings.
- It ties to the open S1 `issues/ftt-stub-in-live-closure-falls-off-non-void-function.md`.
- Leave it for the type-soundness track (`plans/handover/TYPE_SYSTEM_SOUNDNESS_HANDOVER.md`).

#### `feat/global-lend-to-call-is-an-error` — E0916, no PR yet (head `a6b8f3d4a`)

- **What:** the S1 `issues/2026-10-15-a-module-level-global-lent-to-a-call-can-be-reassigned-while-the-callee-holds-it.md`, with the decided design in §5.1.
- **State:** the branch holds the **strict** first cut, WIP commits (`393713de9`…):
  - E0916, "a module-level binding lent to a call";
  - the census knob `YO_AUDIT_GLOBAL_LEND=1`, one line per lend with a form tag;
  - E0916 `explain` examples using a `Copy` global.
- **The strict census:** 1,447 sites (src 1,345). 94% are lends of handle globals, and 49 are `Mutex` or atomic globals. The strict rule would have rejected its own suggested fix, which is why the maintainer chose the static model.
- **Since the strict cut (head `a6b8f3d4a`, census instrumentation only):**
  - `_call_lends` is computed once per call and shared by E0910 and E0916. With the knob set, `parameter_modes` 43/43, `closure_capture_list` 41/41 and `async_await` 280/280 pass, matching develop.
  - Messages print `G.push`, not `(G.push)`.
  - E0901's hint (`src/evaluator/utils.yo` ~L1134) names `&` and decision 18 rule 3.
  - `YO_AUDIT_GLOBAL_LEND=1` now also prints `[global-write] how=reassign|field` lines from `exprs/assignment.yo`. Lend lines carry `key=` and `reach=heap|binding`.
  - The strict E0916 is still ON by default on the branch; narrowing it is the next step.
- **The syntax that exists today:**
  - `G := v` / `(G : T) = v` are module-level runtime bindings and are always reassignable. `Variable.is_reassignable` is false only for parameters and `given(...)`.
  - `::` takes compile-time values only, so an immutable runtime static has to be the unmarked `:=` form.
  - `thread_local(name)` is a name wrapper, like `comptime(name)`, `given(name)` and `sink(name)`.
  - `mut` is reserved; it follows only `&`, and the old parameter mode `mut(x)` is E0009.
  - There is no `static`, `let` or `var`.
  - The v0.2.62 seed rejects every candidate marker (`(mut(G) : i64) = …` gives "Invalid binding to "mut"").
- **The agent's spelling proposal:** `mut(name)` at a module-level declaration, mirroring Rust's `static mut`. It composes with `thread_local(mut(name))`.

  ```yo ignore
  (mut(g_count) : usize) = usize(0);
  mut(g_level) := Level.Info;
  (thread_local(mut(_tl_state)) : _RngState) = _RngState.seed();
  ```

  - E0009 stays for parameter position; declaration position is new and unambiguous.
  - Rejected alternatives: `static_mut(name)` (reads badly inside `thread_local`), and `mutable(name)` (a new keyword Rust does not have).
  - `yo fix --migrate mutable-globals` inserts the markers, because the evaluator already sees every write.
  - **DECIDED (maintainer, 2026-10-15): `mut(name)`, as part of decision 47 (§5.11).** Globals are the first step of decision 47, so the global-lend fix is spelled `mut(G)` from its first commit.
- **Census, globals written after their initializer** (src, std, tests and the `markdown_yo` dependency):

  | tree | handle (reassigned) | value | total |
  | --- | ---: | ---: | ---: |
  | src | 57 | 179 | 236 |
  | std | 0 | 12 | 12 |
  | tests | 0 | 81 | 81 |
  | `markdown_yo` | 0 | 3 | 3 |
  | **total** | **57** | **275** | **332** |

  - std's 12 include `std/arena.yo` (6), `std/log.yo` (4) and `std/rand`'s `thread_local` `_tl_state` (a `&mut self` lend).
  - tests' 81 are almost all `g_*_disposed` counters that `Drop` impls reassign.
- **Lend sites that become E0916** (lends of marked globals), 259 in all:
  - src: 172 on reassigned handle globals, 76 on value globals;
  - std: 6;
  - tests: 5.
  - About 87 remain if the 57 reassigned handle globals are reset in place (`G.clear()`) instead of reassigned and stay unmarked.
- **Review amendment A today:**
  - 2 src sites lend a heap projection of a handle global that has `&mut self` calls.
  - The probes did **not** reproduce a use-after-free under ASan, on the v0.2.62 seed or the branch: `peek(&G(usize(0)))` while the callee does 64× `G.push`, the same with the element replaced, and `for(&G, …)` with growth.
    - Codegen copies the element out through `index(...)` with a dup and drop around the call (`set_expr_as_needs_to_call_dup_for_borrowed_projection`), so the callee never holds a pointer into the buffer.
    - The pointer-passing case cannot be reached until #1368's direct projection calls land.
  - So rule A guards the post-#1368 ABI, not today's behaviour. Keep it, and record this in the issue doc.
- **Review amendment B:** 8 unmarked handle globals (src 7, tests 1) take field or element writes, so their lends are checked by path.
- **Not built:** the "written-anywhere" inference registry, which was rejected for load-order dependence.
- **The census data** (`census2-*.err`, `analyze2.py`) stayed on the old machine. `YO_AUDIT_GLOBAL_LEND=1 yo check <tree> --std-path ./std` on the branch regenerates it.
- **Next:** narrow the branch to §5.1's rule. Steps:
  1. The spelling is decided: `mut(G)` (decision 47, §5.11). Record decision 47 in the plan's §4, and decision 18 rule 3's amendment pointing at it.
  2. Make a write to an unmarked global an error, with a census first (`YO_AUDIT_GLOBAL_LEND` already lists the writes). Expect about 150 rewrite sites, 56 of them reassigned handle globals (`G = new()` becomes `G.clear()` or similar).
  3. E0916 for lending a marked global or a place under it.
  4. The two review rules in §5.1.
  5. Generation B: sweep std and src, then turn the error on.
  - This is a language change, so it needs Generation A and then Generation B across a seed. The marker must parse in the seed before std or src may use it.

#### Stale remote branches

These have merged, or were superseded. Verify each with `git log origin/develop --grep` or `gh pr list --state merged --head <branch>` before deleting:

`feat/vbd-marker-sweep-part2`, `feat/vbd-readonly-receivers`, `feat/vbd-v2b-index-mut-genb`, `feat/vbd-v3-async-a1`, `feat/vbd-v3-genb`, `feat/vbd-v3b-addr-of-delete-inout`, `feat/vbd-v3b-flip-2`, `feat/vbd-v3b-marker-sweep-trial`, `feat/vbd-v3b-markers-a`, `feat/vbd-v3b-storing-by-value`, `feat/vbd-v4-typevalue`, `feat/vbd-v4-typevalue-2`.

---

## 3. CI state at hand-over

- **Develop battery:** DEVELOP_BATTERY_PLACEHOLDER.
- **The evaluator work ratchet** (`check_src_main_alloc_calls`, key in `scripts/bootstrap/memory-ratchet.tsv`) is **2,996,136,722**, ±5% both ways.
  - A PR that moves the count by more than 5% must change the baseline in the same PR, with a dated comment and its attribution.
  - V2b unique buffers Generation B and the memo-key optimization (§4 step 13) will both lower it.
- **The RSS ratchet:** #1381 brought `check` from 2.43 to 1.02 GB and `build` from 4.28 to 3.26 GB.
- **The self-hosted differential `tests/internal` job** runs 6 shards with `--compile-timeout-ms 1200000` (#1335, #1342).

---

## 4. The next steps, in order

0. **Install the newest seed:** `bash scripts/install.sh`. `yo --version` must say 0.2.63 or later, and every `SEED_VERSION: v…` pin in `.github/workflows/` (`test.yml`, `release.yml`, `ubsan.yml`, `fixpoint-arm64.yml`, `leak-verdict.yml`; `test.yml`'s `changes` job checks they agree) must say v0.2.63.
1. **#1378**, decision 45 Generation B (§2.3).
2. **#1379**, A5, rebased onto #1378 (§2.3), including the `std/hash.yo` revert.
3. **The D3 mutation-mask fix** (B1), its own PR. Then **#1380** (§2.3).
4. **#1385**, then **V2b unique buffers Generation B** (§2.3). Lower the allocation baseline in the same PR.
5. **#1368**, direct projection calls (§2.3). It also closes #1375's S2.
6. **The global lend, E0916** (§2.3 and §5.1): Generation A, then Generation B after a seed.
6a. **Decision 47, immutable bindings with `mut(name)`** (§5.11), after the queued Generation B items (#1378, A5, V2b Generation B) and before decision 43:
    - Generation A: the parser and evaluator accept every `mut(...)` form, and the errors are enforced outside src/std;
    - `yo fix --migrate mut-bindings`;
    - Generation B on the next seed: sweep src, std, tests, docs and `markdown_yo`, then enforce the errors everywhere.
    - Census first: `YO_AUDIT_MUT_BINDINGS=1` lists each binding that is written after its definition, with its kind.
    - `issues/2026-10-15-a-module-level-comptime-constant-can-be-assigned-at-runtime.md` (S2) closes with Generation A.
7. **stdio Generation B:** `std/io/stdio.yo`'s handles pass offset `u64.MAX` to the runtime, so redirected stdout/stderr is no longer overwritten positionally.
   - The runtime half shipped in v0.2.63 (#1376).
   - It closes the S1 `issues/stddoc-io-stdio-handles-write-positionally-and-clobber-redirected-output.md`.
   - Test: `tests/sys/seek.test.yo`, plus a redirect test that appends from two handles.
8. **The `std` `dyn(f)` spelling, if any is left:** #1339 found no bare site in the tree, so there may be nothing to do. Grep before opening a PR.
9. **`Waker.clone` Generation B**, once a seed carries A5's `__yo_waker_clone` (the release after #1379).
10. **Decision 46, `Rc` is read-only** (§6 "Decision 46"): Generation A (the `YO_AUDIT_RC_WRITE` census, `RefCell(T)` if not landed, `Rc.make_mut` and `try_unwrap`), then Generation B (the sweep, then the error). This also makes E0909's read-only-handle predicate true for `Rc`, so `Rc(Mutex(T))` works.
11. **The rest of the plan, in the 2026-10-13 handover's §3 order:**
    - V3 A6's `Rc`-field half together with V2c;
    - decision 39's iterators (V2b);
    - the allocator interface version 2;
    - V2c;
    - decision 43 (four PRs, after V4: `TypeValue.Reference`, then Generation A with `.*`/`impl(&T)`/`FnMut` and `yo fix --migrate deref`, then root-joining containers with `depends`, then Generation B);
    - V4's remaining trees (`AstExpr`, `Pattern`/`VcSort`/`VcTerm`/`Z3Sexpr`, `EvalValue`);
    - V5;
    - after V5: K-steps, the README examples, retiring `yo fix --migrate`.
12. **The issue-date rename.** Do it once the in-flight branches have drained, so that it rewrites citations once. The script is in §9.1.
    - Dry run on develop 2026-10-15: 201 docs to rename, 263 files rewritten.
    - Tier 1: `check-issue-refs.sh`, cli-diff (re-record only the cases whose diff is the rename), `fmt --check`.
    - Only the root and `questions/` docs move; `fixed/` and `retired/` keep their names.
13. **The allocation memo-key optimization** (`issues/fixed/2026-10-15-v4-typevalue-rc-raises-the-check-allocation-count-by-7-percent.md`, "Resolution"; S3, not a regression).
    - About 1.0 billion of the ~3.0 billion allocations of `check src/main.yo` are `type_key(ty)` strings (~5 KB each) built only to look up `g_move_only_memo` (`nominal_declares_move_only`, `src/evaluator/values/impl.yo`) and `g_lacks_copy_memo` (`type_lacks_copy_for_flip`, `src/evaluator/trait_checking.yo`).
    - Key them without building the string: an identity front cache, sound only for types with no unresolved type variables, or a hashed key.
    - Lower the ratchet baseline in the same PR.
    - This is a VBD-introduced cost, so it is in scope now, unlike the general evaluator tuning, which is deferred (§1.5).
14. **After VBD:** the evaluator-performance investigation (§6 "Evaluator performance" steps 1–2).
    - `check ./src` went from 113 s at v0.2.50 to about 187 s before V4, and about 172 s after V4.
    - The `sample` profile split, v0.2.50 → v0.2.61: Yo code 45.6 → 66.7 s, RC inc/dec 20.1 → 33.9 s, malloc/free 15.4 → 27.6 s.
    - To attribute, use a locally built `-g` compiler: the shipped binaries' `yo_id` hashes do not match a local emit.

---

## 5. Decisions recorded this cycle

### 5.1 The global lend to a call (maintainer, 2026-10-15; implementation pending; spelled with decision 47's `mut(G)`)

- **The bug:** with `w2(&G)`, the callee can reassign `G` through another function, or await while another task reassigns it, and then read freed memory. The future half is fixed (#1389).
- **The rule is Rust's `static` / `static mut` model, with an explicit marker.** The maintainer picked "Rust static model", then, after an advisor review, "Explicit marker".
  - A global is **immutable unless declared mutable**. Whether a global is written is DECLARED, never inferred whole-program: inference would make verdicts depend on module load order, the bug class #1382 fixed.
  - A **write to an unmarked global is an error.**
  - **Lending a marked (mutable) global, or a place under it, to a call is E0916.** Copy it out and write it back, or use a `Mutex`, `Cell` or atomic global.
  - An unmarked global may be lent `&` freely. That covers atomics, `RawMutex`, `&self` methods, `${G}` interpolation and `Copy` reads.
  - **Handle globals** (`ref` objects, collections) may be mutated through their methods (a `&mut self` receiver) while their **binding** stays unmarked, as long as it is never reassigned. Rewrite the 56 reassigned ones.
  - After V2b makes collections values, handle globals move to Rust's `thread_local` + `RefCell`.
- **Two rules from the advisor review:**
  - **Projections into a handle global's heap:** lending `&G(i)` or `&G(i).f` to a call is E0916 unless `G` has no `&mut self` calls anywhere. Otherwise a nested `G.push` reallocates the buffer under the borrow.
  - **Handle globals are path-sensitive:** a write to `G.f` rejects lends of `G.f` and anything below it, not lends of `&G`.
- **Rejected:**
  - the strict rule ("every lend of a global is E0916"): 1,447 sites, and it rejects its own `Mutex`/atomic fix;
  - whole-program inference of "never written": load-order dependent.
- **The spelling** is `mut(G)`, decided as part of decision 47 (§5.11).

### 5.11 Decision 47: bindings are immutable unless declared `mut(name)` (maintainer, 2026-10-15)

**The authoritative text is decision 47 in `plans/VALUES_BY_DEFAULT.md` §4**, with its phase "Decision 47: immutable bindings" in §6 and a pointer from decision 18 rule 3. This section records how it was decided.

**What the maintainer said, in order:**
1. "What about static(name)? As the variables in Yo are mutable by default, right?"
2. "Should we change our mutable by default behavior, and introduce mut as modifier to variables, like how rust does?"
3. After the recommendation below: "yes, record it as decision 47 in the handover. And we also need to support mut for comptime. I think we should allow syntax like mut(x) :: 12; and comptime(mut(x)) := 12;"

**The rule.** Every binding is immutable unless its name is wrapped in `mut(...)`. As in Rust, `mut` gates four things:
- reassignment (`x = v`);
- `&mut x`, `&mut x.f` and `&mut x(i)` lends;
- `&mut self` method calls on the binding or a place under it (`xs.push(v)`);
- field and element writes (`p.x = v`, `xs(i) = v`).

A `ref`-handle binding, until V5 removes `ref(...)`, is a pointer, so a field write through it does not write the binding; that stays allowed without `mut`. Its reassignment does need `mut`.

**The spellings:**

```yo ignore
mut(x) := 0;                       // runtime local or module-level binding
(mut(x) : i32) = 0;
mut(x) :: 12;                      // comptime binding, mutable at compile time
comptime(mut(x)) := 12;            // comptime variable
(thread_local(mut(st)) : State) = State.seed();
match(opt, .Some(mut(v)) => { v = (v + 1); v; }, .None => 0);
{ a, mut(b) } := pair;             // destructuring: per name
x := 0;                            // immutable
x :: 12;                           // a true constant
```

- **Module-level globals:** an unmarked global is Rust's `static`, and `mut(G)` is `static mut`. The global-lend rule (§5.1) follows: an unmarked global may be lent freely, and lending a `mut(G)`, or a place under it, to a call is E0916, with amendments A and B. The 57 reassigned handle globals in `src/` should be reset in place (`G.clear()`) so they stay unmarked. Without that, their 172 lend sites need hand rewrites.
- **Comptime (the maintainer's addition):** `x :: v` and `comptime(x) := v` become immutable. Today both can be reassigned, and a runtime write to a module-level `::` is accepted and diverges (issue below).
  - `mut(x) :: v` and `comptime(mut(x)) := v` are the mutable forms.
  - **Open point for the next agent:** module-level `::` bindings are order-independent and forced lazily (`plans/reference/LAZY_TOPLEVEL_BINDINGS.md`). A mutable lazy binding's value would depend on which definition forces it first, the load-order class #1382 fixed.
  - Recommendation: allow `mut(x) :: v` in ordered (block) scope, and at module level only if it is never written from a lazily forced definition. Or simply reject it at module level, pointing at `comptime(mut(x)) := v` in a block. Bring this to the maintainer before implementing.
- **Statics follow Zig (maintainer, 2026-10-15: "I am saying about static keyword to follow zigs way"). There is no `static` keyword or `static(...)` wrapper anywhere.** This supersedes a "blocks only `static(x)`" answer given minutes earlier.
  - **Where a binding is declared decides its lifetime**, as with Zig's container-level declarations:
    - a module-level `x := v` is an immutable global (Zig's container-level `const`);
    - `mut(x) := v` is a mutable global (Zig's container-level `var`);
    - `thread_local(mut(x)) := v` is Zig's `threadlocal var`;
    - inside a block, `x := v` / `mut(x) := v` are locals (Zig's local `const`/`var`), and `comptime(mut(x)) := v` is Zig's `comptime var`.
  - **Function-local statics get no dedicated syntax.** Zig writes them as a `var` inside a struct type declared in the function body, or as a file-level `var`. Yo's answer is a module-level `mut(_f_state)` next to the function. If Yo gains namespaced static members on a type declared in a body, that is the Zig-shaped extension; it is not part of this decision.
  - **Open, for the implementation phase:** Zig also makes container-level initializers implicitly comptime and lazily analyzed. Yo's module-level `:=` accepts runtime initializers today; whether to tighten that is NOT decided.
- **Parameters take no `mut`; they stay immutable.** A closure's parameters, `for` element bindings and capture-list entries follow the same rule. A body that needs to mutate a by-value argument rebinds it: `mut(y) := x;` (a move, not a copy, for an owning value). Why:
  1. **It is invisible to the caller.** In Rust, `fn f(mut x: T)` is sugar for `fn f(x: T) { let mut x = x; … }`. The `mut` is not part of the signature, the type or the calling convention, so it adds nothing to the contract.
  2. **Yo's parameters are already immutable:** `x = (x + 1)` on a parameter is E0902 today ("Cannot reassign"). Keeping them immutable changes nothing for parameters, except that field writes and `&mut self` calls on a by-value parameter now need the rebind.
  3. **`mut(x) : T` meant `&mut T` until v0.2.59** (decision 42), and a parameter mode word is E0009 today. Reviving the spelling with a different meaning would let pre-v0.2.59 code, or a model trained on it, compile with its writes going to a callee-local copy. For a `Copy` argument nothing reports it, and the caller's value never changes. Keeping E0009 in parameter position makes that mistake a compile error.
- **Errors:** a write of any of the four kinds to an unmarked binding is a new error code.
  - Its message names the binding, its definition, and the `mut(...)` form.
  - For a parameter, it names the rebind.
  - E0902's "You can mutate fields" hint goes away.
- **Rollout:**
  - The global-lend fix first, already spelled `mut(G)`.
  - The general phase (§4 step 6a) after the queued Generation B items and before decision 43, because decision 43's `&mut` rules can then assume `mut`.
  - Generation A needs the parser to accept `mut(` in binding position; the seed rejects it today ("Invalid binding to "mut"").
- **Bug found while checking the rule:** `issues/2026-10-15-a-module-level-comptime-constant-can-be-assigned-at-runtime.md` (S2). `G :: i32(1)` written at runtime reads 3, while `H :: G + 10` was folded from 1.

### 5.2 Decision 46: `Rc` is Rust's `Rc` (#1371)

- The payload is read-only through the handle (maintainer, 2026-10-14: "Rc in Yo shouldnt be mutable shared cell. Thats why we introduced the RefCell").
- Mutation goes through Rust's doors only: `RefCell(T)`, `Rc.get_mut` on a unique handle, `Rc.make_mut` when `T <: Clone`, or `Mutex`/atomics.
- Until decision 46's Generation B lands, the compiler still ADMITS writes through a plain `Rc` that the summaries prove (§3.10 outcome (a)). Never describe Yo's `Rc` as a mutable cell.

### 5.3 The async `Mutex` (maintainer, 2026-10-14: "lets match how rust does it?")

- `Mutex(T)` is move-only like `tokio::sync::Mutex`. `lock(self : &Self, io)` returns a future that borrows it.
- It is shared as `Arc(Mutex(T))`. E0909 accepts a `&` through a handle whose payload is read-only through the handle: `Arc` now, `Rc` after decision 46.
- This is PR #1380 (§2.3).

### 5.4 Closures follow Rust (decision 36 amended, #1366)

- A closure is `Copy` iff every by-value capture is `Copy`, and `Clone` iff every one is `Clone`.
- A `String`-owning closure moves.
- Fn values are `Copy` and `Clone`.
- `ctl` records are neither.

### 5.5 Decision 45: `Drop` (Generation A in v0.2.62, follow-ups in v0.2.63, Generation B is #1378)

- `drop : (fn(self : &mut Self) -> unit)`.
- An explicit `.drop()` is E0915; `drop(x)` ends a value's life.
- A Drop type is move-only.

### 5.6 Decision 44: `Dyn` stays sized, and every erasure is spelled

- The spellings are `dyn(v)`, `dyn(&v)` and `dyn(f)`. A bare callable into `Dyn(Fn)` is E0618 (#1339).
- `dyn(&f)` waits for decision 43.

### 5.7 V4 `TypeValue` is an `Rc` handle (#1369)

- The value enum was measured first and lost (2.3x `check`).
- The handle's cost is in type-key length (+21% per key of a compiler type), not in node boxes. Hence §4 step 13.

### 5.8 Three-tier gating, Tier 1 selection, dated issues, CI cancellation, ≤5 agents

See §1.

### 5.9 The evaluator-performance work waits until after VBD

See §1.5.

### 5.10 Kept from earlier cycles

- **The names `Exception` and `IoExn` stay.** The maintainer said not to rename them or propose renaming them.
- **No shipped skills after V5:** `yo init` writes `AGENTS.md` and `CLAUDE.md`, and `yo skills install` is deleted at K4.
- **The `yo fix --migrate` modes are retired after V5,** once the README's six example projects are migrated.

---

## 6. Open bugs to know about

### 6.1 The open S1s (develop at 31ef8d7a3)

| Issue | Note |
| --- | --- |
| `issues/2026-10-15-a-module-level-global-lent-to-a-call-can-be-reassigned-while-the-callee-holds-it.md` | §5.1; the branch is `feat/global-lend-to-call-is-an-error` |
| `issues/2026-10-15-d3-trusts-every-mutator-defined-in-a-pragma-file-so-std-writes-through-an-arc.md` (copied to develop by the handover PR) | B1 in §2.3 |
| `issues/stddoc-io-stdio-handles-write-positionally-and-clobber-redirected-output.md` | §4 step 7; the runtime half shipped in v0.2.63 |
| `issues/a-write-through-a-string-copy-is-lost-when-the-string-was-empty.md` | Older; expect V2b unique buffers to remove it, and re-test after Generation B |
| `issues/ftt-stub-in-live-closure-falls-off-non-void-function.md` | Type-soundness track (#1162) |
| `issues/self-hosted-emit-leaks-remaining-classes.md` | Memory track |
| `issues/vendor-markdown-punycode-encode-reads-past-the-buffer.md` | Fix it in `markdown_yo` and release it (pre-authorized), then bump `yo.toml` |
| `issues/yo-self-rc-depth-cap-skips-deep-teardown.md` | Older; RC teardown |

### 6.2 Filed this cycle and still open (S2/S3)

- `issues/2026-10-15-a-direct-projection-method-call-bound-to-a-local-reaches-the-c-compiler.md` (S2): #1368 fixes it.
- `issues/2026-10-15-the-generic-call-time-binder-binds-a-sink-closure-argument-at-a-bitwise-fn-type.md`: found by #1388.
- `issues/2026-10-14-the-vendored-mimalloc-is-compiled-in-debug-mode.md` (S3): a free speedup for every compile.
- `issues/2026-10-14-windows-af-unix-accept-blocks-the-event-loop.md`.
- `issues/a-generic-function-passed-to-an-impl-fn-parameter-fails-in-codegen.md`.
- `issues/a-generic-types-function-taken-as-a-value-is-not-emitted.md`.
- `issues/a-struct-field-of-type-option-box-emits-invalid-c.md`.
- `issues/arc-of-a-named-function-value-fails-its-send-bound.md`.
- `issues/array-clone-copies-self-out-of-the-borrow.md`.
- `issues/arraylist-clone-copies-elements-out-through-get.md`.
- `issues/e0908-calls-an-untyped-self-receiver-a-match-or-for-binding.md`.
- `issues/option-of-self-inside-a-payload-gives-option-of-a-recursive-enum-two-c-types.md`.
- New questions: `issues/questions/2026-10-14-effect-operation-contracts.md`, `issues/questions/2026-10-14-overflow-trap-freedom-as-a-default-obligation.md`.

For the full list, run `python scripts/gen-issue-triage.py`. It writes `issues/TRIAGE.md`, which is untracked and never committed.

---

## 7. How to work in this repository (portable)

The 2026-10-10 handover's §5 still applies. Additions and changes:

- **Worktrees:**
  - `git worktree add -b <branch> <durable-path>/<name> origin/develop`, then `git -c protocol.file.allow=always submodule update --init`.
  - A branch made from `origin/develop` tracks develop, so push the first time with `git push -u origin <branch>`, never the `HEAD:develop` git suggests.
  - Never under `/tmp`.
- **Commit and push before every heavy step.** A worktree is not a backup.
- **Stacked PRs:**
  - Retarget the child to `develop` **before** deleting a merged parent's branch, or GitHub auto-closes the child. A closed PR cannot be retargeted.
  - Restack with `git rebase --onto origin/develop <old-parent-tip> <branch>`.
- **Seed gate:**
  - New syntax, a new runtime macro or a new builtin may be used in std/src only once `SEED_VERSION` carries it: Generation A in one release, Generation B in the next.
  - Test std changes with a tree-built compiler and `--std-path ./std`, never with the seed's bundled std.
- **Rebases after V4** need `Rc(.Variant(...))` patterns and `rc(TypeValueNode.X)` constructors wherever a branch predates #1369 and matches on `TypeValue`.
- **Checking Windows C without a Windows machine:**
  - Cross-emit with a tree-built compiler: `yo compile x.yo --target x86_64-pc-windows-gnu --emit-c --skip-c-compiler`.
  - Splice in any runtime change.
  - Run `clang -target x86_64-w64-windows-gnu -std=c11 -fsyntax-only -w -nostdinc -isystem $(clang -print-resource-dir)/include -isystem <zig>/lib/zig/libc/include/any-windows-any -isystem <zig>/lib/zig/libc/include/generic-mingw x.c`. `zig cc` itself failed with `FileNotFound` under the session sandbox.
  - Inject a typo once to prove the check is real.
- **Shell traps seen this cycle:**
  - zsh's `echo =====` fails (equals expansion);
  - zsh's builtin `stat` is not `/usr/bin/stat`;
  - `gh pr edit` must run inside a checkout;
  - `gh run view --log` returns empty logs when run in parallel, so run it sequentially;
  - `sed` may be GNU sed (`sed -i 's/…/'`, never `sed -i ''`).
- **Agents die on API limits.** Resume them with SendMessage and have them push before every heavy step. Never SendMessage to a finished workflow stage, because that resumes a duplicate writer.

---

## 8. Process recipes

### 8.1 Admin-merge on Tier 1

```bash
gh pr merge <n> --squash --admin --delete-branch
# If --delete-branch fails with "used by worktree", the remote branch survives too:
git ls-remote --heads origin <branch>     # empty means it is gone
git push origin --delete <branch>; git worktree remove --force <path>; git branch -D <branch>
# Cancel the merged PR's battery:
gh run list --branch <branch> --json databaseId,status,workflowName \
  --jq '.[]|select(.status!="completed")|"\(.databaseId) \(.workflowName)"'
gh run cancel <id>
```

### 8.2 Merge a PR once its merge gate is green (when a PR battery is wanted)

The script in §9.3.

### 8.3 Watch develop's battery, pinned by run id

```bash
R=$(gh run list --branch develop --workflow 'Build and Test "std" library' --limit 1 --json databaseId --jq '.[0].databaseId')
while :; do
  J=$(gh run view $R --json status,conclusion,jobs) || { sleep 60; continue; }
  F=$(echo "$J" | jq -r '[.jobs[]|select(.conclusion=="failure")|.name]|join(" | ")')
  [ -n "$F" ] && { echo "FAIL: $F"; break; }
  [ "$(echo "$J" | jq -r .status)" = completed ] && { echo "DONE $(echo "$J" | jq -r .conclusion)"; break; }
  sleep 120
done
```

- Pin `R` once. Re-listing with `--limit 1` on every poll drifts onto another run.
- `test.yml`'s workflow is named `Build and Test "std" library`.
- A develop run that is pending with 0 jobs is queued behind an older develop run.

### 8.4 Cut a patch release

1. Develop's battery must be green on the **exact tip**. Check it against the battery's head:
   `git diff --stat <battery-head-sha>..origin/develop -- src/ std/ tests/ .github/ scripts/ build.yo` must be empty.
2. Dispatch: `gh workflow run Release --ref develop -f bump=patch`. **Never cancel it.** If one dies after its `release` job, resume with `bump=none`, and PATCH the draft's `target_commitish` (AGENTS.md).
3. When it publishes, curate `## Changes`. Keep line 1 and `## Native bundles (bootstrap seed chain)` byte-for-byte. The format is AGENTS.md's release-notes section (v0.2.38 and v0.2.62 are good models):

   ```bash
   gh release view vX.Y.Z --json body --jq .body > old-body.md
   # write new-body.md
   gh release edit vX.Y.Z --notes-file new-body.md
   ```

4. Confirm the release pipeline's auto-bump commit `ci: bump SEED_VERSION to vX.Y.Z` landed on develop, then `bash scripts/install.sh`.

---

## 9. Scripts (inlined, because the old machine's copies do not travel)

### 9.1 The one-time issue-date rename

Save as `issue-date-rename.py` outside the tree, run from a worktree root with `--dry-run` first, then for real, and commit the `git mv`s plus the rewritten citations as one PR.

```python
#!/usr/bin/env python3
"""One-time rename of open issue docs to issues/YYYY-MM-DD-<name>.md (maintainer, 2026-10-14).

Run from a worktree root:  python3 issue-date-rename.py [--dry-run]
- Renames every issues/*.md and issues/questions/*.md (not README.md / TRIAGE.md) that lacks
  the date prefix, the date being the doc's FIRST add (git log --diff-filter=A --follow).
- Rewrites every citation of the old basename in tracked text files (vendor/ excluded).
- Idempotent: already-prefixed docs are skipped, so a rebasing branch can re-run it.
Rewrites reach tests/cli-cases fixtures and .github/skills (cli goldens hash both) and std comments
(yo doc output): the PR's Tier 1 = check-issue-refs + cli-diff (re-record only the cases whose diff
is the rename) + fmt --check.
"""
import os, re, subprocess, sys
dry = '--dry-run' in sys.argv
def git(*a): return subprocess.run(['git',*a],capture_output=True,text=True,check=True).stdout
pref = re.compile(r'^\d{4}-\d{2}-\d{2}-')
docs = [p for p in git('ls-files','issues/*.md','issues/questions/*.md').split()
        if os.path.dirname(p) in ('issues','issues/questions')
        and os.path.basename(p) not in ('README.md','TRIAGE.md') and not pref.match(os.path.basename(p))]
renames = {}
for p in docs:
    dates = git('log','--diff-filter=A','--follow','--format=%as','--',p).split()
    if not dates: sys.exit(f'no add date for {p}')
    new = os.path.join(os.path.dirname(p), f'{dates[-1]}-{os.path.basename(p)}')
    renames[os.path.basename(p)] = (p, new)
print(f'{len(renames)} docs to rename')
if not renames: sys.exit(0)
# citations: the old basename as a whole token (not preceded by [\w-], so an already-prefixed name never matches)
pat = re.compile(r'(?<![\w.-])(' + '|'.join(re.escape(b[:-3]) for b in renames) + r')\.md\b')
files = [f for f in git('ls-files').split('\n') if f and not f.startswith('vendor/')]
touched = 0
for f in files:
    if not os.path.isfile(f): continue
    try: s = open(f, encoding='utf-8').read()
    except (UnicodeDecodeError, IsADirectoryError): continue
    def sub(m):
        _, new = renames[m.group(1) + '.md']
        return os.path.basename(new)
    t = pat.sub(sub, s)
    if t != s:
        touched += 1
        if not dry: open(f, 'w', encoding='utf-8').write(t)
print(f'{touched} files rewritten')
for b, (old, new) in sorted(renames.items()):
    if dry: print(f'{old} -> {new}')
    else: git('mv', old, new)
```

Before running it for real, check two things:
- No open doc shares a basename with a `fixed/` or `retired/` doc. If one does, its citations of the closed doc would be rewritten too: `comm -12 <(ls issues | sort) <(ls issues/fixed | sort)`.
- The cli-case goldens that hash `.github/skills` are re-recorded.

### 9.2 A/B timing of `check ./src` and the self-emit (the shape both deferred measurements use)

Two informational measurements were deferred so they would not hold the machine during the cut. Neither gates anything, but each fills a number the plan wants:
- **V4 after-merge A/B:** develop `fceb684a1` (before #1369) against `fa8f23fad` (#1369). It confirms the PR's numbers on merged develop. Record the result in decision 21's "As built" note.
- **V2b A1 timing:** `check ./src` on #1384's merge commit `41441c5b3` against its parent. Record it in V2b's "As-built plan".

```bash
#!/bin/bash
# usage: ab.sh <sha-A> <sha-B>  — run from a checkout; worktrees go under $WT
set -e; A=$1; Bc=$2; WT=${WT:-$HOME/Workspace/Yo-wt}; L=$WT/ab-logs/$A-$Bc; mkdir -p $L; S=$L/summary.txt; : > $S
for c in $A $Bc; do
  [ -d $WT/ab-$c ] || { git worktree add --detach $WT/ab-$c $c && git -C $WT/ab-$c -c protocol.file.allow=always submodule update --init; }
done
source scripts/heavy-lock.sh; trap heavy_drop EXIT
heavy_take "ab: check/emit A/B $A vs $Bc (timed)" exclusive
run() { local n=$1; shift; local t0=$(date +%s); ( "$@" ) > $L/$n.log 2>&1; echo "$n rc=$? $(( $(date +%s)-t0 ))s" >> $S; }
for c in $A $Bc; do (cd $WT/ab-$c && run build-$c bash -c "rm -rf yo-out && yo build --std-path ./std"); done
for i in 1 2; do for c in $A $Bc; do
  (cd $WT/ab-$c && run chk-$c-$i env YO_MAIN_STACK_MB=4096 /usr/bin/time -l ./yo-out/*/bin/yo check ./src --std-path ./std)
done; done
for c in $A $Bc; do
  (cd $WT/ab-$c && run emit-$c env YO_MAIN_STACK_MB=4096 /usr/bin/time -l ./yo-out/*/bin/yo compile src/main.yo --optimize 2 --emit-c --skip-c-compiler --std-path ./std -o $L/emit-$c)
done
for f in $L/*.log; do echo "$(basename $f) $(grep -E 'real|maximum resident' $f | tr -s ' ' | tr '\n' ' ')" >> $S; done
ls -la $L/emit-*.c >> $S; rm -f $L/emit-*.c; echo DONE >> $S
```

(`/usr/bin/time -l` is macOS; on Linux use `/usr/bin/time -v`. Interleave A and B, as above, to cancel drift.)

### 9.3 Merge each PR once its `Merge gate (all checks)` is green

```bash
#!/bin/bash
# usage: merge-on-green.sh <pr> [<pr> ...]
pending="$*"
while [ -n "$pending" ]; do
  next=""
  for n in $pending; do
    j=$(gh pr view $n --json state,mergeable,headRefOid,statusCheckRollup 2>/dev/null) || { next="$next $n"; continue; }
    st=$(echo "$j" | jq -r .state); mg=$(echo "$j" | jq -r .mergeable)
    g=$(echo "$j" | jq -r '[.statusCheckRollup[]?|select(.name=="Merge gate (all checks)")|(.conclusion // .status)]|first // "none"')
    if [ "$st" != OPEN ]; then echo "#$n $st (left alone)"; continue; fi
    if [ "$mg" = CONFLICTING ]; then echo "#$n CONFLICTING — needs a rebase"; continue; fi
    case "$g" in
      SUCCESS)
        if gh pr merge $n --squash --admin --delete-branch >/dev/null 2>&1; then echo "#$n MERGED ($(date +%H:%M))"; else echo "#$n merge FAILED"; fi ;;
      FAILURE|CANCELLED|TIMED_OUT|ACTION_REQUIRED) echo "#$n gate $g — needs a fix" ;;
      *) next="$next $n" ;;
    esac
  done
  pending="$next"
  [ -n "$pending" ] && sleep 180
done
```

---

## 10. Machine-specific notes (ignore on a new machine)

- **The box:** a Mac Mini (M4, 16 GB, `aarch64-apple-darwin`). Worktrees were under `~/Workspace/Yo-wt/`, the heavy lock's root and `heavy-lock.conf` too.
- **The installed seed at hand-over:** INSTALLED_SEED_PLACEHOLDER.
- **Session notes:** `~/Workspace/Yo-wt/notes/`, including `v0263-notes-draft.md` (the curated v0.2.63 body's source) and `issue-date-rename.py` (§9.1).
- **Logs:**
  - `~/Workspace/Yo-wt/memreg-logs/` (the #1381/#1391 attribution);
  - `~/Workspace/Yo-wt/global-lend-call-logs/` (the census runs, `analyze2.py`);
  - `~/Workspace/Yo-wt/checktime/` (the per-release `check` timings and `sample` profiles behind §4 step 14).
- **The review probes for #1380** (`m1w.yo`, `m6.yo`) were in a session scratchpad and did not survive. §2.3 describes their shape.
- The macOS RSS noise floor is about 180 MB, so memory claims need the Linux ratchet.
