# VALUES_BY_DEFAULT handover — 2026-10-06

**Status: ACTIVE handover.**
- **Written:** 2026-10-06 by the agent that ran the campaign from 2026-10-04 to 2026-10-06, on the maintainer's instruction to stop and hand over.
- **Who it is for:** an agent on another machine.
- **What it covers:** what is done, what is open, the exact next steps, and the traps.
- **The authoritative design** is [`plans/VALUES_BY_DEFAULT.md`](VALUES_BY_DEFAULT.md) (decisions 1–38, phases in §6). This document points into it and does not restate it.

Read in this order:
1. AGENTS.md;
2. this document;
3. `plans/VALUES_BY_DEFAULT.md` §0, §4 (decisions) and §6 (phases);
4. the `.github/instructions/` file for the area you touch.

---

## 1. The standing goal and the maintainer's rules

**The goal, in the maintainer's words, 2026-10-04:**
- "finish every phases in plans/VALUES_BY_DEFAULT.md";
- "Open stacked PRs so your work won't be blocked by … GitHub CI";
- "document and fix any surfaced bug and issue along the way";
- "No workaround is allowed";
- "Feel free to adjust the plan and cut any patch release if needed";
- "I also allow you to admin-merge your PRs based on your decision".

The campaign's earlier releases (v0.2.51 and v0.2.52) are published.

**Rules the maintainer set during the campaign. Follow them:**
- **Design style:**
  - "whenever we could be explicit, lets do explicit". Migration cost and backward compatibility never decide a design (AGENTS.md: no compatibility scaffolding).
  - When a design question comes up, propose a recommendation and ask. Record every confirmed decision as a dated amendment in `VALUES_BY_DEFAULT.md` §4, never as a silent edit.
- **Admin merges:** allowed. Still wait for a green CI battery on any PR whose fixes target platforms you cannot run locally, which is Windows, Linux, arm64 and TSan for a macOS host.
- **Releases:** patch releases only (v0.2.x). Cut them whenever a seed is needed.

## 2. Where everything stands

### 2.1 Landed on `develop` (tip `8d6ae6437` at handover)

`src/version.yo` and `SEED_VERSION` are both **0.2.52**. These have landed since v0.2.52 (59 commits):

| Area | PRs |
| --- | --- |
| V3 compiler Gen A: move-only values, value-type `Dispose`, interim `sink(x)`, read-after-move E0901 for every type | #1217 |
| V2a: collection mutators take `inout(self)` | #1204 |
| V1 Gen A follow-ups: `Allocator` in the prelude (#1207); V1 step 1 Gen A, the `Rc`/`rc` names in the prelude and compiler (#1232) | #1207, #1232 |
| V3b Gen A: `imm(x)`/`mut(x)` parameters and receivers, `mut(y) :=`, `&x`/`&mut x` call-site markers (mismatch error deferred to Gen B), `addr_of(x)`, `size_of`/`align_of`/`type_of`/`type_id` | #1240 |
| Decision 32 Gen A: `Rc.clone(w)` / `Box.clone(b)` through an unapplied generic constructor | #1241 |
| String S3a (`as_bytes` removed → `to_bytes`/`into_bytes`/`get_byte`) and S4 docs | #1190, #1175 |
| The implicit-copy audit (`YO_AUDIT_IMPLICIT_COPY=1`) and its numbers | #1220 |
| S1 fixes: an io.async alias capture (#1218); capture-slot identity by declaration site (#1234) | #1218, #1234 |
| Smaller fixes and tests | #1206, #1208, #1226, #1187, #1219 |
| Plan PRs that record decisions 30–38 and the review rounds | #1205–#1216, #1221–#1225, #1227–#1239, #1242–#1248 |

### 2.2 Open PRs

| PR | Branch | State at handover | What to do |
| --- | --- | --- | --- |
| **#1200** (S3 batch 0: Windows fs/socket semantics, thread-exit task release, leak-verdict gating, E13xx/E15xx codes, `-Os`, Windows ASan, …) | `s3/batch-0-fixes` @ `f1f336f22` | **CI 42/42 green** on that head (run 37395892866). `mergeStateStatus` is **DIRTY**: develop moved after the last merge. | Merge `origin/develop` into the branch (a **merge**, not a rebase). Conflicts are likely only in plan text and CLI goldens. Re-record goldens with the tree-built binary (§5.3). Push and wait for the full battery; **`test (windows-latest)` takes about 2.4 h** under ASan, and its timeout is now 240 min. The PR touches `.github/workflows/test.yml`, so `gh pr merge --admin` refuses while it is behind. Then squash-merge and delete the branch. |
| **#1231** (S3 batch 2: tuple-literal temps, escape-path drops, `dyn()` inference, io.async inference, prelude owners, fmt idempotence, loud doc degradation) | `s3/batch-2-fixes` @ `39a0e77f7` | CI 38 green, 4 pending at handover (run 37398251339). **DIRTY** against develop. | Same as #1200: merge develop, re-record goldens if needed, wait for green, squash-merge. Its body has a `CI_PLACEHOLDER` for the run link. |
| #1162 (draft, `tss/phase6-step4`) | — | Belongs to a different campaign (type-system soundness). | Leave it alone. |

Both S3 PRs were merged up to develop several times. Their bodies describe each conflict resolution and the fallout they fixed:
- **#1200:** a wasm timer S1, a Windows ASan PATH S2, the readlink test, the windows-latest timeout.
- **#1231:** an S1 double free from escape drops of macro-expanded `for` temps. Its `std/` re-format was regenerated with the tree's `yo fmt`.

Two backup branches can be deleted after the merges: `wip/s3b0-merge` and `wip/s3b2-merge`.

### 2.3 Develop's own CI

**Develop's latest battery was cancelled with nothing newer queued**, because successive docs-only merges each superseded the last code-carrying run. At handover, run **37404073512** (develop @ `8d6ae6437`) was re-run.
- **Check its verdict first.** The code merged since the last green develop battery is #1241, #1240, #1234 and #1232. Each was green on its own PR battery, but not yet as a combination.
- **A rule learned the hard way:** don't merge docs or plan PRs to develop while waiting for a develop verdict. Each push supersedes the pending run (AGENTS.md, "Never merge a docs-only PR to develop while a battery you are waiting on is in flight").

### 2.4 Wave-2 Generation A branches (pushed, not PRs)

Four branches were in progress when work stopped. Each is pushed with every commit, including a final `WIP (handover …)` commit of whatever was uncommitted. None has a PR or a full gate. Each needs finishing, a gate, a PR, and an adversarial review. A review found real bugs in each Gen A PR so far.

| Branch | Plan decisions | State | Known problems |
| --- | --- | --- | --- |
| `feat/vbd-capture-lists` (5 commits, +2031) | 35, with 38 A/B/D | Parser, evaluator and codegen for `{ x, imm(y) : &y, mut(z) : &mut z }(params) => body`; second-class escapes, freezes and call exclusivity. Its tests passed in the agent's last run (`tests/closure_capture_list.test.yo`). New issues: `a-closure-value-with-an-impl-fn-parameter-emits-invalid-c.md` and `a-literal-sub-pattern-in-a-variant-arm-skips-the-wildcard-arm.md`, each with a repro. | **Error-code collision:** it registers **E0909/E0910**, and `feat/vbd-local-borrows` also uses **E0909** for a local-borrow conflict. Renumber one before either lands (check `src/diagnostics_registry.yo` on develop for the next free code). No adversarial review has run. Decision 37's `FnOnce` was planned as a second PR stacked on this one (`feat/vbd-fnonce`); it was never started. |
| `feat/vbd-copy-trait` (9 commits, +1580) | 36, as amended by #1244/#1245/#1246/#1247/#1248 | The prelude `Copy :: trait(where(Self <: Clone))` and its impls, the impl check, structural `Copy`, the supertrait check, the pointer clash, the `YO_AUDIT_COPY_TRAIT=1` audit, `tests/copy_trait.test.yo`. The last WIP commit holds an unfinished edit to `src/evaluator/values/impl.yo`, an open-pattern coverage query for review finding 1. | An **adversarial review** found, at commit `7cfbae417`:<br>1. **Blocking.** The tree compiler cannot load its own `std/prelude.yo`: `impl(generic(T : Type), *(T), Copy())` is rejected as "without Clone". `_copy_without_clone_msg` (`trait_checking.yo`) asks `type_implements_trait` about an open generic pattern, which always answers false. The same happens for `Option(T)`, `Result(T, E)` and the plan's own `Pair(T)` example. The fix being written was a coverage query over open patterns, deferred to the end of the module walk.<br>2. The branch's plan text claims gates that never ran.<br>3. The tests and docs use a generic `derive(…, Clone)` spelling that neither the seed nor the tree compiler accepts.<br>4. The raw-pointer clash check is narrower than #1248's rule and hard-codes trait names.<br>5. Minor issues.<br>The review's "checked and fine" list: concrete `derive(T, Copy, Clone)` in both orders, the `derive(_S, Copy)` error, the hand-written-`Clone` rejection, `Copy`+`Dispose` rejected, structural tuples/arrays/closures, and `where(T <: Copy)` ⇒ `Clone`. The measurement decision 36 asks for has **not** run yet. |
| `feat/vbd-send-sync` (7 commits, +1266) | §3.8 and 38 E | The prelude declares `Sync`; raw pointers lose their blanket `Send`; `Sync` derivation in the evaluator; std opt-ins for raw-pointer atomic objects; the `Iso(T)` bound widened; `tests/send_sync*.test.yo`. New issues: `a-move-only-value-cannot-be-moved-into-thread-spawn.md`, `naming-joinhandle-inside-a-sync-test-body-emits-a-call-to-an-undeclared-runtime-function.md`, and `fixed/a-move-only-capture-sent-to-another-thread-is-disposed-twice.md`. | No full gate, no review. Its agent was running "build + test" when work stopped. |
| `feat/vbd-local-borrows` (2 commits, +2362) | 18 (place-based), 25, 38 A as it applies to locals | `imm(y) :=`, last-use live ranges, place-based exclusivity, re-points; `tests/local_borrows.test.yo`; three CLI cases (E0908/E0909). The last WIP commit is large and unverified: docs, the plan, the registry, `assignment.yo`, `utils.yo` and several test files. | The **E0909 collision** above. The maintainer asked (2026-10-06) that this PR carry **negative tests for returning a local borrow** (`return(borrow)`, and a block tail that yields one) as well. Both are rejected by decision 18 rule 1 and decision 38 A. |

**Recommended order:**
1. `copy-trait` first: fix finding 1, which blocks every program on that branch.
2. `send-sync` and `local-borrows`, in parallel.
3. Resolve the code collision.
4. `capture-lists`.
5. Then start `FnOnce`, stacked on `capture-lists`.

Each is Generation A: src/ and std/ must still build with the v0.2.52 seed (§5.1).

## 3. The next steps, in order

1. **Get develop green** (§2.3).
2. **Land #1200 and #1231** (§2.2).
3. **Cut v0.2.53.** The maintainer's plan was to cut it once those two land and develop is green. It does not need the wave-2 branches.
   - Procedure: AGENTS.md "CI runs" and "Release notes". Dispatch the Release workflow; **never cancel a `Release` run**; the `bump=none` resume and the draft `target_commitish` fix are described there.
   - Curate `## Changes` from the §2.1 list right after it publishes, using v0.2.38's format. Known-issue bullets come from §4.
   - The pipeline bumps `SEED_VERSION` to v0.2.53. That battery is the first to run stage 1 on the new codegen (AGENTS.md).
4. **Generation B on the v0.2.53 seed.** Each needs the seed to carry the Gen A feature. Stack them as PRs:
   1. **Box → Rc rename** (V1 step 1 Gen B). The plan records the counts: 215 + 16 + 633 `Box(` and 91 + 8 + 170 `box(` in src/std/tests, plus docs and skills. Then delete the prelude `Box`/`box`; `Rc` becomes canonical until V1 step 2's unique `Box`.
   2. **Decision 32 Gen B.** A wrapper/payload member clash becomes an error. #1241 measured only **2** `.clone()` sites, plus 6 derive-generated clones, which need the derive rule changed.
   3. **V3b Gen B.**
      - The `yo fix` sweep: `imm(...)` on parameters and receivers of non-implicitly-copyable types, `inout` → `mut`, `own`/`sink` → plain. #1240 measured **36,677 / 2,759 / 2,921** `&`/`&mut` marker sites in src/std/tests; the tests figure is a lower bound.
      - The flip: plain parameters and scrutinees become by-value.
      - Delete `own`/`sink`/`inout` and raw-pointer `&x`, turn on the mismatch error, and switch diagnostics to the new spellings.
      - Rename the snake_case builtins.
      - Decision 34's operator-trait `imm` operands are V3b Gen B's first item.
   4. **The wave-2 features' Generation B halves,** as each branch's plan section records: the `Copy` sweep and flip, then `MoveOnly` deletion; std's `Send`/`Sync` bounds; `FnOnce`'s std signatures (only `Thread.spawn`/`ThreadPool.spawn` and the `io.async` exception, per decision 37's amended list).
5. **Then the later phases** (§6 of the plan):
   1. the rest of V3 compiler (async A1/A2/A4/A6, with the `async-handle-gena` branch noted in §3.13 A3);
   2. V1 step 2 (the unique `Box`);
   3. V3's std half;
   4. V2b (projections, explicit-copy `String`/collections/`Dyn`, decision 27's lint landing with the first clone sweep);
   5. V2c (explicit `Rc`/`Arc` clones);
   6. V4 (the compiler's trees);
   7. V5 (remove `ref`/`atomic`; move `std/imm` out as a separate package).

   The campaign's estimate was 6–8 patch releases in total.

## 4. Open bugs to know about

| Issue | Severity | Note |
| --- | --- | --- |
| `issues/fixed/a-dispose-that-resurrects-a-cycle-member-leaves-a-dangling-handle.md` | **S1** | Confirmed in that day's runtime. The repro is `issues/repros/…`; it printed `resurrected v=0 rc=0 tracked=1`. The fix was PEP 442-style: re-check white counts after the dispose pass and keep resurrected cells — **FIXED in #1256** (2026-10-07). |
| `issues/a-binary-operator-called-through-a-dyn-is-an-internal-compiler-error.md` | S3 | Filed by #1240. The fix is a design choice that decision 34 leaves open (binary operator traits label their first operand `lhs`, so they have no vtable slot). |
| `issues/a-partially-applied-constructor-names-its-instances-with-an-internal-name.md` | S3 | Filed by #1241. |
| `issues/a-member-read-on-a-primitive-value-has-no-diagnostic.md` | S3 | No test yet; the test lands with the fix. |
| The issues each wave-2 branch filed | various | Listed in §2.4. They land with their branches. |

## 5. How to work in this repository (portable)

### 5.1 Setup on a fresh machine

```bash
git clone <repo> Yo && cd Yo
git -c protocol.file.allow=always submodule update --init   # vendor/ is empty otherwise
bash scripts/install.sh            # installs the latest published seed (yo --version should be 0.2.52 until v0.2.53 ships)
yo build --std-path ./std          # tree-built compiler → yo-out/<target>/bin/yo
```

Use git worktrees for parallel work (AGENTS.md: never under `/tmp`). `gh` must be authenticated: merges, reruns and branch deletes use it.

### 5.2 The gate the campaign ran before each PR

The campaign used a local wrapper script. It is not in the repo; this is what it ran, in order, with `B` = the tree-built binary:
1. `yo build --std-path ./std`;
2. `$B fmt --check <every .yo file changed vs origin/develop>`;
3. `$B test ./<each touched test file> --parallel 1`;
4. `S1=$B P=<label> bash scripts/bootstrap/gates_fast.sh`;
5. `S1=$B P=<label> bash scripts/bootstrap/fixpoint_only.sh` (must print `FIXPOINT_HOLDS`);
6. `$B test ./tests --exclude tests/internal --exclude tests/cli-cases` (the fast suite, about 5,060–5,090 passing at handover);
7. `$B test ./std`.

Also:
- each touched `tests/internal/*.test.yo`, **one file per invocation** (they compile the compiler; several need 6+ GB);
- `bash scripts/check-issue-refs.sh` (must exit 0);
- the CLI goldens if diagnostics, LSP or skills changed.

Seed gating:
- `yo check ./src --std-path ./std` and `yo build --std-path ./std` with the **installed seed** must pass for every Generation A change.
- **Always pass `--std-path ./std`.** Without it the seed uses its bundled std. Since S3a, `src/` calls `String.get_byte`, which the v0.2.52 bundled std lacks, so the check fails spuriously.

### 5.3 CLI goldens

```bash
YO_SKILLS=$PWD/.github/skills YO_SELF_BIN=$PWD/yo-out/<target>/bin/yo bash scripts/cli-diff-test.sh --record <case>...
```
- The binary path must be **absolute**: the harness changes directory, and a relative path records rc 127 goldens.
- Run it under **bash**; zsh does not word-split a `$CASES` variable.
- Any edit to `.github/skills/**` moves the seven skill-tree goldens (init\*, skills-install\*, build-stamp-dotted-dir).
- Two branches that both edit a skill file conflict there. Resolve by taking develop's golden and re-recording; the diff should then be only the hash line of the file this branch changed.

### 5.4 Traps hit during this campaign

- **Stale Progress header.** A plan's Progress header goes stale unless the PR that lands a phase moves its line. The restored `.github/pull_request_template.md` (#1247) has a checklist item for this. The header was found stale four times.
- **The PR template had been deleted** by an unrelated PR (#1117). It was restored in #1247; see `issues/fixed/the-pull-request-template-was-deleted-by-an-unrelated-lexer-pr.md`.
- **Workflow-touching PRs must be up to date** before `gh pr merge --admin` accepts them. Other PRs need not be ("require up to date" is off for develop).
- **windows-latest takes about 2.4 h per PR battery** under ASan. Sharding it means renaming a required check, which only the maintainer can do.
- **Generation A/B.** std/ and src/ cannot use a feature, spelling or runtime macro until `SEED_VERSION` carries it. Land the compiler side (A), release, then sweep (B). `plans/backlog/SEED_VERSION_AUTOMATION.md` tracks each pair.
- **Adversarial review is worth it.** Every Gen A PR's review in this campaign found real defects: #1241 three, the `Copy` branch five, the closure-design audit (decision 38) seven critical. Budget an implement → review → fix cycle per feature.
- **Agent tooling (if you orchestrate subagents):**
  - Sending a message to an agent whose run already ended **resumes a second copy**. Two copies then write to one worktree.
  - Change a running workflow item's spec by landing it in the plan on develop instead; later stages read the plan from origin/develop.
  - A killed agent can orphan a shared lock. Check for dead owners before waiting.
- **Machine-specific to the original Mac** (ignore on a new machine): the SSH key for GitHub stopped working on 2026-10-06, and pushes used HTTPS with `gh auth git-credential`; and a FIFO "heavy lock" serialised builds across agents on a 16 GB machine. On a larger machine, two heavy jobs at once is fine.

## 6. Open design items

`VALUES_BY_DEFAULT.md` §9 lists the sub-decisions parked with a phase:
- A6's bundle `Rc` copy;
- `StrictBorrow`'s fate;
- containers' `new_in`;
- decision 37's possible non-escaping consuming mode;
- the Hylo-style stateful call, if `FnMut` is ever wanted.

Raised on 2026-10-06 and not yet recorded as decisions:
- **Binding a projection result as a local borrow** (`imm(y) := g(&n)` where `g` returns `imm(T)`). Decision 18 allows local borrows of places; decision 24 says a projection's yielded place "may not be bound". Decision 38's minor list says the conflict must be resolved before V2b's projections land. Recommend a position to the maintainer.
- **Returning a projection that yields its parameter** (`fn(imm(x) : T) -> imm(T) { x }`) is allowed by decision 24. Its yielded place is rooted at a parameter. Make sure V2b's projection PR tests it, together with the rejected case (a projection that yields a local).
