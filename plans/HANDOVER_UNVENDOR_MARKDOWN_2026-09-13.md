# Handover — un-vendoring `vendor/markdown_yo` (the last item of the build/dependency redesign)

_Written 2026-09-13 by the session that built it, at the point where v0.2.32
was published. **One task remains: merge #654.** Everything it depends on is
verified and recorded below so you do not have to re-derive any of it._

**If you only read one thing:** §2 is the resume procedure for the one remaining
task (merge #654). §8 is what the PLAN itself still leaves open after that — six
deliberate deferrals, none of them blocking, listed so you can see the whole
surface without grepping for it.

**Companion document:** `plans/HANDOVER_2026-09-13_POST_V0_2_32.md`, written by
the peer session (`yo-0b`) that cut v0.2.32 and owned the std campaign, the
Windows async I/O audit (#638) and the generic-async closure-param defect. Read
both — they were written by two sessions working the same repository in
parallel, and the merge order in §2 is shared between them. Where they disagree,
that document is authoritative on the release and the std campaign; this one is
authoritative on the build/dependency redesign and #654.

---

## 1. The one-paragraph version

`plans/BUILD_AND_DEPENDENCY_SYSTEM_REDESIGN.md` is implemented and merged —
P0, P1, P2 (§5.1, §5.2, §5.4) and P3 (§4.6, §4.8, §4.9). **When #654 lands,
every phase of the plan is delivered** — give it a closing banner and move it to
`plans/archive/` per `plans/README.md`; §8 lists what it deliberately defers, and
none of that blocks archiving. The maintainer's
**dogfooding milestone** — delete the `vendor/markdown_yo` submodule and let the
compiler resolve the Markdown renderer through Yo's own package manager — is
written, gated and merge-ready as **PR #654**, and was blocked on a published
seed that understands `yo.toml`. **That seed is now v0.2.32, published
2026-09-13.** So the remaining work is: wait for `SEED_VERSION` to reach
`v0.2.32` on `develop`, rebase #654, re-run its gate battery, mark it ready,
merge it. Two tiny docs branches merge first.

---

## 2. Do this, in this order

### 2.0 Preconditions — check, do not assume

```bash
cd /Users/yiyiwang/Workspace/Yo && git fetch origin
gh release list --limit 1                      # expect v0.2.32
git show origin/develop:.github/workflows/test.yml | grep -m1 'SEED_VERSION: v'
```

**`SEED_VERSION` must read `v0.2.32`.** The release pipeline's `publish-release`
job bumps it across `test.yml`, `fixpoint-arm64.yml` and `release.yml`
automatically — it is NOT a manual edit, and a guard in `test.yml`'s `changes`
job fails the build if the three disagree. At the time of writing the release
run (`34741618499`) had published the tag but had not yet pushed that bump, so
`SEED_VERSION` still read `v0.2.31`. **If it still reads `v0.2.31`, stop and
wait** — #654 cannot pass CI until it moves (see §4 for why, measured).

Also confirm the merge freeze has lifted. A peer session (`yo-0b`) asked for a
freeze on `develop` merges while the release battery was in flight; it lifts
when the release run completes.

### 2.1 Merge the two parked docs branches first

Both are pushed, neither has a PR (branches were parked PR-less so they would
not start a CI battery — see §6).

1. **`plans/std-campaign-last-item-root-caused`** — yo-0b's branch. Four
   commits: the std campaign's last item root-caused, an AGENTS.md block of
   three CI rules, the Windows-bundle coverage issue, and the v0.2.32 release
   notes updated to carry #638. **This is theirs to open and merge, not yours**
   unless that session is gone.
2. **`docs/only-build-fetches`** (mine, commit `75ea780e5`) — one AGENTS.md
   bullet. Open a PR and merge it. Docs-only; `check`/corpus are not required,
   but do not merge it while a battery you care about is in flight (§6).

### 2.2 Rebase, re-gate and merge #654

```bash
cd /private/tmp/yo-unvendor          # existing worktree, branch dogfood/unvendor-markdown
git fetch origin && git rebase origin/develop
```

**Expect a conflict in `plans/BUILD_AND_DEPENDENCY_SYSTEM_REDESIGN.md` only if
someone else edited the dogfooding-milestone section.** It has conflicted once
already (against #659) and was resolved by MERGING both sides, not by taking
one: #654's landed-state text plus #659's measurement. If it conflicts again,
do the same — keep the measured facts. Also check the status banner near line 3
does not end up asserting both "the milestone landed" and "one item is not yet
shipped"; the second paragraph belongs to the pre-merge state and must go when
#654 lands.

Then build a compiler from the branch and run the full battery. **A binary built
from a PREVIOUS tree is not good enough for the corpus or the fixpoint.**

```bash
cd /private/tmp/yo-unvendor
# The seed builds it. Use the NEW seed once SEED_VERSION is v0.2.32:
YO_MAIN_STACK_MB=4096 ~/.cache/yo/versions/0.2.32/bin/yo build

B=/private/tmp/yo-unvendor/yo-out/aarch64-apple-darwin/bin/yo
YO_MAIN_STACK_MB=4096 "$B" check ./src  --std-path ./std | tail -1   # expect 275/275
YO_MAIN_STACK_MB=4096 "$B" check ./std  --std-path ./std | tail -1   # expect 175/175
"$B" fmt --check src std tests scripts
YO_SELF_BIN="$B" YO_SKILLS="$PWD/.github/skills" bash scripts/cli-diff-test.sh | tail -4
# expect: PASS 133  GOLDEN-DIFF 0  NO-GOLDEN 0  SKIP 1
for f in build_runner pkg_config doc_render_markdown doc_stability manifest lock_file install_command; do
  YO_MAIN_STACK_MB=4096 "$B" test ./tests/internal/$f.test.yo --parallel 1 --std-path ./std | tail -3
done
S1="$B" P=unvfix bash scripts/bootstrap/fixpoint_only.sh   # expect FIXPOINT_HOLDS
```

**The FIXPOINT verdict must be re-earned, not carried forward.** The last
recorded `FIXPOINT_HOLDS` for #654 was against `0d8937636`; #638 then rewrote
`src/codegen/async/runtime_io_*.yo`, so the emitted C differs and the old
verdict no longer covers the merge commit.

Then:

```bash
gh pr ready 654
gh pr merge 654 --squash --admin --delete-branch
# --delete-branch will fail while the worktree holds the branch; that is fine,
# the REMOTE branch is deleted. Then:
cd /Users/yiyiwang/Workspace/Yo
git worktree remove /private/tmp/yo-unvendor --force
git branch -D dogfood/unvendor-markdown
```

### 2.3 After the merge — the one thing that will bite

The first CI run on `develop` after #654 lands is the real test of the
`install-deps` plumbing across 18 jobs. Watch for any job failing with
``git dependency "markdown_yo" is not in the store … run `yo install` ``. That
means a job runs `yo` against the tree and did not get an `install-deps` step.
The fix is to add one (see §5 for which jobs need it and why).

---

## 3. What #654 actually contains

Branch `dogfood/unvendor-markdown`, one commit, ~19 files.

- **`yo.toml`** (new, repo root) — `[package] name = "yo"`, and a
  `[dependencies]` entry pinning `markdown_yo` **by `rev`**
  (`a46f7004bbf39ba8eb35692619e422b78026f6cb`), which is the exact commit the
  submodule held (`v0.0.4-9-ga46f700`). Pinned by rev rather than a semver
  range because the commit that compiles against the current language is the
  head of `migrate-to-latest-yo`, which carries no release tag. **This is
  deliberate: un-vendoring changes the resolution MECHANISM and nothing about
  which source is compiled, so a regression can only be the package manager's.**
  There is no `[modules]` table — the compiler is an executable, so nothing may
  `import("yo")`.
- **`yo.lock`** (new) — v2, with `integrity = "sha256-325f5e11…"`.
- **`src/doc/render_html.yo`** and **`scripts/build_site.yo`** — the two import
  sites, now `import("markdown_yo")`.
- **`vendor/markdown_yo`** — submodule deleted, `.gitmodules` entry removed.
  `vendor/mimalloc` remains a submodule, so `submodules: recursive` stays on
  every checkout.
- **`.github/actions/install-deps/`** (new composite) — runs
  `yo install --locked`. Added to 18 jobs across `test.yml`, `release.yml`,
  `fixpoint-arm64.yml`, `deploy-site.yml`, and to the `build-stage1` composite.
  Two jobs whose compiler is a downloaded artifact rather than a PATH entry
  pass its path: `suite-cross-emit` (`./yo-candidate`) and
  `bootstrap-fixpoint-stage3` (`/tmp/stage2/yo-stage2-bin`).
- **Docs**: `CONTRIBUTING.md` + `docs/zh-CN/CONTRIBUTING.md` (a fresh clone now
  needs `yo install`, and mimalloc is the only submodule), `docs/{en-US,zh-CN}/BUILD_SYSTEM.md`,
  `.github/instructions/documentation.instructions.md`, and the plan's
  dogfooding-milestone section.

---

## 4. Why it was blocked — measured, so you need not re-derive it

The v0.2.31 seed **cannot** resolve `import("markdown_yo")`:

```
$ ~/.cache/yo/versions/0.2.31/bin/yo check src/doc/render_html.yo --std-path ./std
error: Module not found: tried ".../markdown_yo.yo" and ".../markdown_yo/index.yo"
```

It has no manifest discovery — `_register_manifest_import_roots` is absent from
`src/module_manager.yo` at that tag — and falls through to path resolution.

Hand that same seed an `--imports` file naming the store path and it **succeeds,
rc=0**. So `--imports` genuinely works in that generation. **But nothing in that
generation can POPULATE the store**: the store, the resolver and `yo install`
all arrived with #601/#602, after v0.2.31. An import map can only point at a
directory something else already created, and on a fresh CI runner nothing has.

The plan originally prescribed the `--imports` route. **That prescription was
wrong**, and the correction is now in the plan on `develop` (#659): the route
reduces to "the bootstrap scripts `git clone` the dependency themselves", which
is re-vendoring in bash — exactly what the milestone removes — and every line of
it would be deleted at the next seed bump. Hence: wait for the seed. Do not
revive the `--imports` idea.

---

## 5. Verification already done — do not repeat it

All of this was measured on this machine and is recorded as a comment on #654.

**Cold-store round trip.** `YO_CACHE_DIR` (see `src/cache.yo:43`) overrides the
cache root, so a genuinely cold store can be tested without deleting the real
one:

- `yo install --locked` resolved **from `yo.lock`**, not by re-resolving the
  rev, rc=0.
- `yo.lock` byte-identical afterwards — the CI step cannot drift the lock.
- Store address equals the lock's `integrity` exactly
  (`store/sha256/325f5e11…` ↔ `integrity = "sha256-325f5e11…"`).
- A `.verified` sibling is written.
- Then, same cold cache, the literal CI invocation
  `yo compile src/main.yo --optimize 2 --std-path ./std --emit-c --skip-c-compiler`
  → rc=0, 132 105 698 bytes, **0 real** transpile failures.

**Which commands fetch.** `yo build` fetches on its own —
`install_dependencies` runs inside `resolve_build_import_roots` before the graph
is built, so a build into an EMPTY store re-fetches from `yo.lock`. Every other
command (`compile`, `check`, `test`, `doc`, `lsp`) resolves import roots but
**never fetches**. That asymmetry is the whole reason for `install-deps`: a job
that only calls `yo build` needs nothing; a job calling anything else needs the
store populated first.

**`yo doc std/` is unaffected.** #657 made `yo doc` read `[package] name`, and
#654 adds a root `yo.toml` naming the package `yo`. They do NOT compose into a
changed site title, because #657 looks in `base_path` only with no upward walk
and `scripts/build_site.yo` runs `yo doc std/`. Measured with a binary carrying
both: `<title>std — Documentation</title>`, 175 modules. Do not "fix" this.

**`yo init` + `yo build` is hermetic** — a scratch `YO_CACHE_DIR` came back
completely empty, so a scaffolded project never touches the dependency
machinery.

---

## 6. Hazards this session hit — read before touching CI or git

- **`/Users/yiyiwang/Workspace/Yo` is SHARED with peer sessions.** It was found
  sitting on another session's branch with their uncommitted work. Never
  `git checkout` / `git pull` / `git stash` there. Do branch work in your own
  `git worktree`. Repo-level ops that do not move the shared HEAD
  (`worktree add/remove/prune`, `branch -D <your-branch>`, `fetch`, `gh`) are
  fine from anywhere.
- **An already-open PR starts a CI battery on EVERY push, draft or not.** #654
  is an open draft, so pushing it starts a ~28-job run that is guaranteed red
  until the seed moves. Cancel those runs. A bare branch push with NO PR starts
  nothing (`test.yml`'s push trigger is `develop`-only), which is why the docs
  branches were parked PR-less.
- **Three CI rules, and applying one alone is how you break something.** Cancel
  superseded runs; never merge a docs-only PR to `develop` while a battery you
  are waiting on is in flight (the replacement takes the fast path — 15 of 18
  jobs skipped — and reports `success` having compiled nothing); and before
  cutting a release re-run
  `git diff --stat <battery-sha>..origin/develop -- src/ std/ tests/ .github/ scripts/ build.yo`.
  They are written up in yo-0b's parked branch.
- **A no-default field added to a `struct`/`ref` in `src/` breaks every
  `tests/internal` constructor of that type** — a hard eval error that takes the
  whole file out, and `check`/corpus/fixpoint never compile that directory.
  Before merging, `grep -rn "<TypeName>(" tests/internal/`. Prefer giving the
  new field a default when empty IS its documented meaning.
- **Never judge an emit by `grep -c "Failed to transpile"`.** It returns 16 on a
  healthy `src/main.yo` emit, under the 17 string-literal floor. Use
  `scripts/count-transpile-failures.sh`.
- **`git diff A..B` is not `git diff A...B`, and confusing them manufactures a
  phantom revert.** Two dots compares the two TREES, so every commit the target
  gained since your branch point appears as DELETIONS — a parked docs branch can
  look like it reverts 1163 lines of somebody else's merged work. Three dots
  diffs against the MERGE BASE: the changes your branch actually contributes,
  which is what GitHub shows and what gets merged. Verified 2026-09-13 on this
  very handover branch: two-dot said "15 files, 332 insertions, 1163 deletions",
  three-dot said "1 file, 293 insertions", and
  `git merge-tree --write-tree origin/develop <branch>` produced a tree still
  containing #638's `runtime_io_windows.yo` and `CURRENT_YO_VERSION :: "0.2.32"`.
  **A squash-merge applies the merge-base-to-head diff through a three-way
  merge; a stale base causes CONFLICTS, never silent reverts.** When a stat
  looks alarming, cross-check with `gh pr view <n> --json files`, which is
  always merge-base relative — if the two disagree, the two-dot one is lying.
  When you verify a merge by inspecting its tree, **resolve the blob OID with
  `git ls-tree -r <tree> -- <path>` and read that blob**; do not trust
  `<tree-ish>:<path>` to resolve against a bare tree oid. It can silently ignore
  the path and hand back the root tree listing, which looks like plausible
  output and reads as evidence the file was gutted.
- **A worktree has EMPTY submodules.** `src/doc/render_html.yo` on `develop`
  still imports `vendor/markdown_yo` by path, so a fresh worktree fails with
  "file or directory not found" until you populate it. Fastest fix without
  network: `cp -R ~/.cache/yo/store/sha256/325f5e11…/. vendor/markdown_yo/`
  (that store tree IS commit `a46f7004`). **After #654 this stops mattering.**

---

## 7. State inventory at handover

| Thing | State |
| --- | --- |
| `plans/BUILD_AND_DEPENDENCY_SYSTEM_REDESIGN.md` | COMPLETE; banner and milestone section corrected by #659 |
| PR #654 `dogfood/unvendor-markdown` | OPEN, **draft**, rebased onto `0d8937636`, full battery green there, applies cleanly to `6907f4ee0` |
| Branch `docs/only-build-fetches` (`75ea780e5`) | pushed, **no PR** — one AGENTS.md bullet |
| Worktree `/private/tmp/yo-unvendor` | branch `dogfood/unvendor-markdown`, has a built binary under `yo-out/` |
| Worktree `/private/tmp/yo-agentsdoc` | branch `docs/only-build-fetches` |
| Issues from the campaign | none open — #624 and the #620 scheduler bug fixed, #657 fixed, one retracted to `issues/retired/` |
| v0.2.32 | published; `SEED_VERSION` bump was still in flight at handover |

Merged this session: #596 #601 #602 #605 #611 #615 #616 #618 #620 #624 #626
#631 #632 #633 #640 #642 #646 #647 #656 #657 #659.

---

## 8. What remains in the plan after #654 — the complete list

Once #654 merges, **every phase of `plans/BUILD_AND_DEPENDENCY_SYSTEM_REDESIGN.md`
is delivered** and the plan should get a closing banner and move to
`plans/archive/` per `plans/README.md`. Nothing below blocks that — each is a
deliberate deferral recorded in the plan, not an unfinished piece of it. They
are listed here so the next agent can see the whole remaining surface at once
rather than rediscovering it by grep.

Ordered by how likely they are to be wanted.

### 8.1 On-demand fetch for `check` / `compile` / `test` — the most likely next ask

Cargo fetches for `cargo check` as well as `cargo build`; Yo fetches only in
`build` (§5 of this document). Closing that gap would delete the
`.github/actions/install-deps` step from 18 jobs and the "run `yo install`"
error with it.

**Why it was not done with #654:** import-root resolution is synchronous and
pre-`Io` by construction — `src/manifest.yo` says so at the top, because the
module resolver runs before any `Io` context exists — so on-demand fetching
there is a real design change, not a small one. And it would make the **LSP**
reach the network, which needs a deliberate decision rather than an implicit
one. Worth doing; worth doing as its own plan.

### 8.2 §5.3 `build.fetch({ url, sha256 })` — a fixed-output step

The plan says "later, if needed". `comptime_fetch` is a hard **no** and should
stay one (a compile that needs the network is neither reproducible nor
cacheable; `comptime_fetch` + `comptime_eval` is compile-time RCE by
construction). But Nix's discipline is explicitly the model to copy if a real
need appears — a prebuilt archive, a model file: network only as a
fixed-output step, `url + hash`, performed by the **build runner** not the
evaluator, stored in the content-addressed store, recorded in the lock.
The store and lock that make this cheap now exist.

### 8.3 §4.6 workspace items deliberately left out

`{ workspace = true }` dependency inheritance, and a single root `yo.lock`
shared by members. Today members refer to each other as ordinary path
dependencies and each carries its own lock. Both are **additive** — the plan's
trigger for doing them is "when a second version of one dependency across two
members actually becomes a problem". Do not do them speculatively.

### 8.4 §4.2 the two-majors relaxation

Resolution is currently **one version per dependency NAME**, because the import
namespace is flat. The plan's §4.2 design allows incompatible majors of the
same package to coexist (Cargo semantics — they compile as distinct module
paths, and nothing in codegen prevents it). The relaxation is deferred, not
rejected. It needs the import namespace to stop being flat first.

### 8.5 `[patch]` / `[replace]` manifest tables

"Come later if needed" (§4.2). Cargo's mechanism for overriding a dependency's
source without editing every requirer. Nothing needs it yet.

### 8.6 P4 / §4.10 — a static registry index and `yo publish`

Designed, **deliberately unscheduled**, and the plan's phase table says
"designed then, not now". Shape: a static index in Cargo's sparse-index / Go
module-proxy style — an HTTPS tree of `name → { repository, versions[] }` JSON,
mirrored to `index/` in the store, so `yo add json` resolves a short name to a
git URL. `yo publish` verifies `yo.toml`, tags `v<version>`, pushes the tag and
(with an index) opens a PR against the index repo. **No hosted registry service
is proposed** — do not build one on the strength of this.

### 8.7 Not a plan item, but adjacent: re-pin `markdown_yo` to a range

#654 pins by `rev` because the commit that compiles against the current
language is the head of `migrate-to-latest-yo`, which carries no release tag.
Moving to `version = "^0.0.x"` needs a tag pushed in the
`shd101wyy/markdown_yo` repo — a **cross-repo publish**, so it needs the
maintainer's say-so. The rev pin is exact and matches what the submodule held,
so there is no correctness reason to hurry.

---

## 9. Known-open issues NOT from this plan

The build/dependency campaign itself leaves **no open issues** (§7). But
`issues/` has entries filed by other work that a future agent may trip over
while in this area — check `issues/*.md` at the root for the current list
rather than trusting a snapshot here. At handover time the notable neighbours
were the generic-async closure-param defect (root-caused and being fixed by the
peer session) and the Windows-bundle coverage gap (filed, fix proposed: run
`yo init` + `yo build run` with the installed bundle in `install-scripts.yml`'s
windows job — verified hermetic, needs no network).
