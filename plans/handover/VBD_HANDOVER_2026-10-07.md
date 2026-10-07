# VALUES_BY_DEFAULT handover — 2026-10-07

**Status: ACTIVE handover.**
- **Written:** 2026-10-07 by the agent that ran the campaign from 2026-10-06 (evening) through 2026-10-07, on the maintainer's instruction to finish the v0.2.54 release, stop, and hand over.
- **Who it is for:** an agent on another machine.
- **What it covers:** what landed (v0.2.53 shipped most of it; v0.2.54 ships the rest), the repository's new CI/merge machinery, the exact next steps in order, and the traps.
- **The authoritative design** is [`plans/VALUES_BY_DEFAULT.md`](../VALUES_BY_DEFAULT.md) (decisions 1–40, phases in §6). This document points into it and does not restate it. The previous handover is [`VBD_HANDOVER_2026-10-06.md`](VBD_HANDOVER_2026-10-06.md) — its §1 (the maintainer's rules) still applies unless amended below.

Read in this order:
1. AGENTS.md;
2. this document;
3. `plans/VALUES_BY_DEFAULT.md` §0, §4 (decisions) and §6 (phases);
4. the `.github/instructions/` file for the area you touch.

---

## 1. The standing goal and the maintainer's rules

The goal is unchanged: finish every phase in `plans/VALUES_BY_DEFAULT.md`. The maintainer's 2026-10-04 rules (explicit design, no workarounds, document and fix every bug, adjust the plan when needed, admin-merge at your discretion) still stand. **Amendments made 2026-10-06/07:**

- **Admin merges and the batch-merge pattern are sanctioned.** The pattern that worked twice: merge `origin/develop` into each PR branch (a MERGE, never a rebase; resolve; verify locally), push, then squash-merge all PRs in quick succession, and let **develop's own battery be the gate** for the combination — fix forward if it goes red. This saves one battery per PR. Do NOT use it for a change you cannot afford to have red on develop for a few hours.
- **Strict ("require branches up to date") is OFF, by the maintainer's deliberate choice** (2026-10-06; the #147 counterexample is recorded in `test.yml`'s merge-group comment). A PR green on its own head may merge while behind; the combination is scored by develop's battery after the merge. The pre-release battery-head diff (AGENTS.md) is the guard that matters before cutting a release.
- **The ruleset has exactly ONE required check**: `Merge gate (all checks)`. It is a summary job that passes only when every job it needs ended `success` or `skipped`, so nothing merges while any check is pending, and the docs-only fast path still merges. Adding a CI job means adding its id to its `needs:` list in `test.yml` — an in-file edit, not a ruleset change.

## 2. Where everything stands

### 2.1 The releases

- **v0.2.53** (published 2026-10-06 22:01Z): both s3 batches (#1200, #1231), the handover doc (#1249), the merge-gate job (#1250). Notes curated (sections: Language, Compile and codegen, Async runtime, Toolchain for agents; 15 known issues listed).
- **v0.2.54** (dispatched after develop's battery on the final tip went green; check `gh release view v0.2.54`): the five wave-2/S1 PRs and the CI-hygiene layer below. **Its seed is the one to install** — it carries Copy, Sync, capture lists and local borrows, which every Generation B sweep in §3 needs.

### 2.2 Landed on develop this cycle (2026-10-07)

| PR | What |
| --- | --- |
| #1256 | **S1 fix**: a `Dispose` that resurrects a cycle member keeps the resurrected cells (PEP 442-style re-check of white counts); `issues/fixed/a-dispose-that-resurrects-a-cycle-member-leaves-a-dangling-handle.md` |
| #1255 | **Local borrows Gen A** (decisions 18/25/38 A): `imm(y) :=`/`mut(y) :=` places, last-use live ranges, place-based exclusivity, re-points; negative tests for returning a local borrow. Error codes **E0911/E0912** |
| #1253 | **Copy trait Gen A** (decision 36 as amended through #1248): `Copy :: trait(where(Self <: Clone))` + impls, the open-pattern Clone coverage fix, derive order, the #1248 raw-pointer clash rule, `YO_AUDIT_COPY_TRAIT` |
| #1254 | **Send/Sync Gen A** (decision 38 E): `Sync` in the prelude, raw pointers lose blanket `Send`, evaluator derivation, std opt-ins, widened `Iso` |
| #1259 | **Closure capture lists Gen A** (decision 35 with 38 A/B/D): `{ x, imm(y) : &y, mut(z) : &mut z }(params) => body`; second-class escapes, freezes, call exclusivity. Error codes **E0909/E0910**. The round-1 review blockers were fixed first (see git history for the three) |
| #1260 | **CI hygiene**: `tree-hygiene` job (no committed `<<<<<<<` markers; `check-issue-refs.sh` machine-enforced) wired as a fail-fast gate before the whole battery; `issues/TRIAGE.md` UNTRACKED and gitignored (a locally generated index — run `python scripts/gen-issue-triage.py`, never `git add` it) |
| #1261 | `check-issue-refs` tolerates citations to the untracked TRIAGE; the old handover's S1 citation follows its doc into `fixed/` |
| #1262 | `issues/ci-flake-episodes-nondeterministic-job-failures-across-platforms.md` (S3): today's two infra-flake episodes and the rerun-first guidance |

**Error-code registry state:** E0909/E0910 = capture-list borrow escapes/conflicts; E0911/E0912 = local-borrow conflict/escape. The collision was resolved by agreement, not by renumbering after the fact — keep this split.

**The integration precedent worth knowing:** landing the five branches produced real cross-branch conflicts (capture-lists ↔ local-borrows in the evaluator: shared files like `utils.yo`, `begin.yo`, `assignment.yo`, the registry). All were additive unions — both sides' imports, both diagnostic families, both state blocks — but the unions must be done carefully: **duplicate `export(...)`/import statements are a compile error** (merge them into one statement with the union of names), and a scripted hunk-union can eat a `);`, a comma, or splice an import into a doc comment. Reconstruct a damaged 1-hunk file from `git show <pre-merge>:<path>` plus the single intended line rather than patching the splice. Verify with a full build before pushing.

### 2.3 New CI behavior you will hit

- **tree-hygiene fails the whole battery fast** (~3 min) on: committed `<<<<<<<` markers anywhere, a `check-issue-refs` violation (duplicated issue docs, a cited `issues/**` path that does not resolve, an open doc without `**Severity:**`, a questions/ doc without `## Recommendation`), so an issues-touching PR must have its discipline in order up front.
- **After moving/adding/closing any `issues/` doc**, nothing is owed to git — TRIAGE is untracked. Generate locally for your own orientation only.
- **Platform-scattered bare-exit-1 failures on an implausible diff are suspect infra first**: rerun failed jobs once before investigating content (the flake doc, #1262, has the evidence and the signature).

## 3. The next steps, in order

1. **Install the v0.2.54 seed** (`bash scripts/install.sh`; verify `yo --version`). Everything below assumes it.
2. **FnOnce (decision 37), stacked on capture-lists.** Gen A: the compiler accepts and checks `FnOnce` bounds (the plan's §decision 37 has the full rules; only escaping APIs get it). Then its Gen B: the std signatures — `Thread.spawn`/`ThreadPool.spawn` and the `io.async` exception only, per the amended list. This was never started; it is a clean, well-specified PR.
3. **Generation B tranche** (each is a sweep on the new seed; stack as PRs, or batch-merge per §1):
   1. **Box→Rc rename** (V1 step 1 Gen B): the plan records the counts — 215+16+633 `Box(` and 91+8+170 `box(` across src/std/tests, plus docs and the skills; then delete the prelude `Box`/`box` (Rc becomes canonical until V1 step 2's unique `Box`).
   2. **Decision 32 Gen B**: the wrapper/payload member clash becomes an error; #1241 measured 2 `.clone()` sites plus 6 derive-generated clones needing the derive rule.
   3. **V3b Gen B** — the big one: the `yo fix` sweep (`imm(...)` on non-implicitly-copyable params/receivers, `inout`→`mut`, `own`/`sink`→plain; #1240 measured **36,677 / 2,759 / 2,921** `&`/`&mut` marker sites in src/std/tests, the tests figure a lower bound), then the flip (plain params and scrutinees become by-value), then delete `own`/`sink`/`inout` and raw-pointer `&x`, turn on the mismatch error, rename the snake_case builtins' diagnostics. Decision 34's operator-trait `imm` operands are V3b Gen B's first item.
   4. **The wave-2 Gen B halves** — `plans/backlog/SEED_VERSION_AUTOMATION.md` now carries BOTH sections verbatim (Send/Sync bounds and the Copy flip): the `derive(T, Copy, Clone)` sweep and `type_requires_explicit_copy(T)` → `!(T <: Copy)`, then `MoveOnly` deletion; `Arc`'s `Sync` bound, `Mutex`/`RwLock`/`Channel`/`Thread`/`std/imm`/PARALLELISM.md signatures; the capture-list and local-borrow adoption sweeps (opportunistic — the plan's Progress header tracks the counts).
4. **Then the later phases** (§6 of the plan): V3's async work (A1/A2/A4/A6; the `async-handle-gena` branch is noted in §3.13 A3), V1 step 2 (the unique `Box`), V3's std half, V2b (projections — test both the allowed parameter-yield case and the rejected local-yield case), V2c (explicit Rc/Arc clones; decision 27's lint lands with the first clone sweep), V4 (the compiler's own trees), V5 (remove `ref`/`atomic`; move `std/imm` out).
5. **Cut patch releases whenever a seed is needed** (v0.2.55+). Curate `## Changes` right after publish — the v0.2.38 format, one bullet per user-visible change with PR numbers, `### Known open issues filed this cycle` from the still-open docs.

## 4. Open bugs to know about

| Issue | Severity | Note |
| --- | --- | --- |
| `issues/a-binary-operator-called-through-a-dyn-is-an-internal-compiler-error.md` | S3 | Needs the design choice decision 34 left open. |
| `issues/a-partially-applied-constructor-names-its-instances-with-an-internal-name.md` | S3 | Cosmetic in diagnostics. |
| `issues/a-member-read-on-a-primitive-value-has-no-diagnostic.md` | S3 | Test lands with the fix. |
| `issues/a-borrowing-future-can-carry-an-imm-borrow-across-an-rc-deref-with-no-mark.md` | open | Filed on the copy-trait branch during the rescue. |
| `issues/collection-iterators-have-no-sound-post-v2b-shape.md` | open | Same; relates to decision 39's audit. |
| `issues/ci-flake-episodes-nondeterministic-job-failures-across-platforms.md` | S3 | Rerun-first guidance inside. |
| The remainder of the open list | various | Generate TRIAGE locally (`python scripts/gen-issue-triage.py`) for the current categorized view. |

## 5. How to work in this repository (portable)

The previous handover's §5 still applies (setup, the §5.2 gate, CLI goldens, seed gating, ALWAYS `--std-path ./std`). Additions from this cycle:

- **Merging**: the merge-gate required check enforces "all checks green" mechanically — a normal squash merge on a green battery. The batch-merge pattern (§1) is the sanctioned accelerator. Never admin-merge past a red tree-hygiene.
- **CLI goldens**: unchanged policy (take develop's golden, re-record with the tree-built binary, absolute `YO_SELF_BIN`, run under bash). On a squash-merge sequence, re-merge develop into a PR branch before its merge whenever develop moved — a stale golden set conflicts textually.
- **Verify merges by state, not exit codes**: after any `gh pr merge`, read `gh pr view <n> --json state`. If a piped `gh` command's exit code matters, `set -o pipefail` first — a bare `| tail` swallows failures (this fake-merged a PR once).
- **A deleted PR branch is recoverable**: `git fetch origin refs/pull/<n>/head && git push origin FETCH_HEAD:refs/heads/<branch>`, then `gh pr reopen <n>`.
- **Worth budgeting**: an adversarial review round on every Gen A PR found real defects every time this campaign ran one (5/5). The reviewer needs the branch's handover-known-defects list and the AGENTS.md pitfalls; give it the diff, not the summary.

## 6. Open design items

`plans/VALUES_BY_DEFAULT.md` §9's parked sub-decisions stand (A6's bundle Rc copy; StrictBorrow's fate; containers' `new_in`; decision 37's non-escaping consuming mode; the Hylo-style stateful call). Still awaiting a maintainer position from the previous handover: **binding a projection result as a local borrow** (`imm(y) := g(&n)` where `g` returns `imm(T)`; decision 18 vs 24 vs 38's minor list) — resolve before V2b's projections. Decision 39 (index-based post-V2b iterators) and decision 40 (no `Pin`; live non-Copy values never relocate) were recorded by the maintainer's parallel session; read them in the plan before touching iterators or moves.

## 7. Machine-specific notes from this cycle (ignore on a new machine)

The campaign box was Windows. If the next machine is too: `world.run("bash")`-style bare `bash` may resolve to WSL — use Git Bash's absolute path; `check-issue-refs.sh` takes hours under MSYS (fine on Linux CI); `printf` with Windows paths mangles `\U`; `python`'s `/tmp` differs from bash's; the `yo` shim is `yo.cmd` (a `version install` REWRITES it — check what the in-flight work expects); and pushing to a merged PR's deleted branch recreates it harmlessly.
