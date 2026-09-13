# Handover — 2026-09-13, immediately after cutting v0.2.32

**Status: LIVE INSTRUCTIONS.** Written for the agent taking over. Everything
below is measured or links to the run/PR it came from; where something is a
belief rather than a measurement it says so.

**The one-line state:** the std API stabilization campaign is complete except
`spawn_blocking`, which is blocked on a compiler defect that is now
ROOT-CAUSED but not fixed. v0.2.32 is cut. Four docs branches are parked
behind a merge freeze that lifts when the release publishes.

---

## 1. Read these first

| file | why |
| --- | --- |
| `AGENTS.md` § "CI runs: cancelling, freezing, and what a battery actually covers" | three rules that WILL bite you; they landed today and each one fired once |
| `plans/STD_API_STABILIZATION.md` § 0 | the campaign's state; §0 names the single remaining item |
| `issues/a-generic-function-returning-impl-future-t-miscompiles-at-a-second-t.md` | the remaining item's root cause, plus three disproven hypotheses |
| `plans/BUILD_AND_DEPENDENCY_SYSTEM_REDESIGN.md` | the other active plan; P1 landed, §4.5.2–§4.5.4 next |

---

## 2. What happened today (2026-09-13)

**develop was red on four independent gates at the start of the day.** All four
diagnosed and fixed:

| PR | what |
| --- | --- |
| #637 | three stale constructor sites left behind by #626 |
| #643 | the `build-test-suite-flags` golden had pinned itself to macOS's abort exit code |
| #649 | **my own #619 regression** — the RRE adoption arm took a type CONTAINING an existential instead of an existential; a `Box` over an `Impl(Fn)` emitted as two C structs |
| #650 | `Manifest.workspace_members` needed a default (#646 added the field without one) |

**A recurring structural cause, worth internalising:** `check ./src`,
`check ./std`, the CLI corpus and the fixpoint are the per-slice gates and
**none of them compiles `tests/internal/`**. A field added to a type in `src/`
is therefore invisible to all four and takes whole internal test files out.
This happened three times (#626 ×3 sites, #646 ×1). Before landing a type
change: `grep -rn "<TypeName>(" tests/internal/`, and prefer a default when
the empty value is the documented meaning.

**#638 (Windows IOCP audit) — taken over from an unreachable third session and
landed.** Its `tests/net/unix.test.yo` failure was dispositioned in the PR body
as "pre-existing/environmental". That was wrong and the disproof is the method
worth copying: develop's own job `103609844499` at `cbbff5208` logged that exact
test PASSING, while both Windows legs failed it at `0fc80fd78`. Cause: the
ConnectEx family gate read `getsockname()`, which fails `WSAEINVAL` on an
unbound socket — precisely the fresh client socket the overlapped path exists
for — so the `AF_INET` fallback fired every time and the gate never gated.
Fixed with `getsockopt(SO_PROTOCOL_INFOW)`, failing closed. Added the suite's
first IPv6 **client** connect test.

> **The rule that came out of it, now in the issue doc:** a probe used to GATE a
> code path must not have a failure fallback that SATISFIES the gate. Either
> read a property valid in the state the path targets, or fail closed.

**Also landed:** #653/#655 (the CI cancel rule and its docs-only trap), #660
(the generic-async root cause + the three-T reproducer).

---

## 3. The release — FINISH THIS FIRST

v0.2.32 was dispatched as run **`34741618499`** on **`6907f4ee0`**, gated by
run `34736633080` (28 jobs, 28 green, **0 skipped** — a full battery).

### 3.1 What the release pipeline does for you

- tags, builds bundles, drafts and publishes the GitHub release;
- **auto-bumps `SEED_VERSION`** on develop across `test.yml`,
  `fixpoint-arm64.yml` and `release.yml` (the `publish-release` job). You do
  NOT do this by hand.

### 3.2 What it does NOT do — YOUR JOB

**The release body is filled from the last commit message only.** The real
notes are hand-pasted at publish time, same as v0.2.26–v0.2.31. They are
written and ready:

- `plans/RELEASE_NOTES_v0_2_32_DRAFT.md` (59 commits; headline is the build +
  dependency redesign, and it carries #638's Windows IOCP section).

Paste that into the release body. **Hazard, learned the hard way:** a body-only
`PATCH` on a DRAFT release resets `tag_name` to `untagged-…`. Always send
`tag_name` in the same PATCH, and re-read the release before publishing.

Then archive the notes file to `plans/archive/` with a closing banner, per
`plans/README.md`.

### 3.3 FIRST THING TO CHECK: the seed-bump battery

**v0.2.32 published successfully (13 assets, `SEED_VERSION` bumped to `v0.2.32`
in all three workflows by `6943c89af`), and the release notes are pasted into
the release body. But the run that validates v0.2.32 AS A SEED was still in
flight when both agents stopped.**

Run **`34745371233`** on **`6943c89af`** — a real battery, 18 jobs, 0 skipped.
It is the first battery in which every self-building job bootstraps from the
v0.2.32 bundle instead of v0.2.31. **Check its verdict before anything else.**

Why this one deserves a named check rather than trust: a seed run cannot be
fixed by fixing the compiler. The seed is the PREVIOUS release's binary, so
today's fixes and today's flags are absent from it — if the tree now needs
something only a newer compiler emits, the seed-built stage fails and no change
to `src/` repairs it. The class also hides from ordinary gates: green codegen
suites and a holding fixpoint said nothing about the v0.2.30 gen-1 binary
crashing in `fetch_package`, because that crash was in the compiler's own
compiled-in runtime on a path no suite drove.

This release is more exposed to that than usual, because **#638 rewrote the
emitted Windows async I/O runtime** and an emitted-runtime change is carried by
every binary the new compiler emits immediately — see the rule in §6.

If it is red: read which job, and check WHICH BINARY produced the failure
before theorising. `plans/backlog/SEED_VERSION_AUTOMATION.md` documents the
generation A/B split for changes that cannot land in the same release as the
builtin they depend on.

A second run, `34745479809` on `b22f3f9d7`, was queued behind it — that one is
the docs-only merge of this handover and takes the fast path, so it proves
nothing. Do not read its green as the seed's verdict. (develop pushes QUEUE
rather than cancel, so it did not supersede the real battery.)

### 3.4 If the release run FAILED

Do not re-dispatch with `bump=patch` blindly. `release.yml` takes
`bump: none`, which **RESUMES** an interrupted release at the version already
in `src/version.yo` — use that if the run died past its version-bump commit.

---

## 4. The merge freeze, and what is parked behind it

**A freeze is in effect on `develop`.** It lifts when the release PUBLISHES —
not when the gate went green. A merge mid-release-run is not worth reasoning
about.

Everything parked is pushed as a branch with **no PR**, which costs zero runner
time (`test.yml`'s push trigger is develop-only; it is the PR that starts a
battery, and an already-open PR starts one on every push, draft or not).

**Merge in this order once the release publishes:**

1. **`plans/std-campaign-last-item-root-caused`** (mine, docs-only, 6 commits):
   - the campaign's last item root-caused in `plans/STD_API_STABILIZATION.md`
   - the AGENTS.md three-rule block, grouped under one heading
   - `issues/the-published-windows-bundle-is-only-smoke-tested-with-yo-compile.md`
   - the v0.2.32 notes updated to carry #638
   - **this handover file**
2. **`docs/only-build-fetches`** (peer `yo-d1`'s, docs-only) — corrects an
   AGENTS.md dependency pitfall that reads as "a fresh clone works". It does
   not: `check`/`test`/LSP resolve import roots but never FETCH, so on a clean
   checkout they fail with ``git dependency "<name>" is not in the store — run
   `yo install` ``. Only `yo build` materializes one.
3. **#654 `dogfood/unvendor-markdown`** (peer's, currently a DRAFT) — blocked
   solely on `SEED_VERSION` moving off v0.2.31, which the release does
   automatically. The peer rebases, re-gates and merges it themselves.
   **Its previous `FIXPOINT_HOLDS` is stale** — #638 rewrote
   `src/codegen/async/runtime_io_*.yo`, so the emitted C differs from the tree
   that produced that verdict. A fixpoint result only means something against
   the tree that produced it; it must be re-earned.

### Coordinating with the peer session

`yo-d1` is another Claude session working the same repo, reachable by
`SendMessage` at `uds:/tmp/cc-socks/43726.sock`. They have a watcher polling
develop's `SEED_VERSION` and the release list, so they will notice the bump
without a ping — but ping anyway, it is faster.

**They are being handed over at the same time as me**, and they wrote their own
handover: `plans/HANDOVER_UNVENDOR_MARKDOWN_2026-09-13.md`, parked on
`plans/handover-unvendor`. **Read both.** The split: this file is authoritative
on the release and the std campaign; theirs is authoritative on the build and
dependency redesign and on #654, and carries the resume procedure as
copy-pasteable commands plus the measurements behind the seed bump. The merge
order in §4 is shared between the two documents.

**What actually worked between the two sessions, and is worth repeating:** the
valuable moments were the ones where one of us re-derived the other's number
INDEPENDENTLY instead of reading the conclusion and agreeing. Note the
asymmetry — **not one of them came from carefully reading the other's
reasoning.** Reasoning reads as plausible precisely when it is wrong in a way
you would not have spotted; a second measurement does not care how plausible it
sounded. That is an argument for the habit, not for any particular pair of
agents. A `Pair(lo:3, hi:4)` baseline whose right and wrong
answers both summed to 7; a "skips 15 of 18" figure that looked unverifiable
against a 28-job battery and turned out to be exactly right once the docs-only
denominator was found; a claim that cancelling develop runs unblocked a queue,
when `cancel-in-progress` is false for pushes so it only freed runners. None of
those would have surfaced from agreement.

> **`/Users/yiyiwang/Workspace/Yo` is SHARED with other sessions.** It can be
> sitting on someone else's branch with their uncommitted work. Do not
> `checkout`, `pull` or `stash` there, and **never `git add -A`** — use explicit
> paths, and do compiler work in your own `git worktree`.
>
> **The hazard is bidirectional, and the second direction is the one that
> surprises people.** It is not only that a `checkout` can yank a branch out
> from under someone mid-task. It is that **two sessions writing untracked files
> into one tree will silently commit each other's work**: a `git add -A` sweeps
> in whatever the other session happened to leave there, and nothing warns you.
> Both sessions hit this from opposite sides on 2026-09-13 — one nearly
> committed the other's scratch files, and the other declined to write a
> handover into `plans/` for exactly that reason, even though that is where the
> maintainer had asked for it. Write to a worktree and commit from there.

---

## 5. THE remaining campaign item: `spawn_blocking`

`plans/STD_API_STABILIZATION.md` §0 is explicit that this is the only thing
left. `std/thread.yo`'s `spawn_blocking` is written, eager, measured working
end to end, and left unexported. `std/net/dns.yo` still names it as the reason
`lookup_host` blocks.

It is blocked on
`issues/a-generic-function-returning-impl-future-t-miscompiles-at-a-second-t.md`.
**Read that document before touching anything** — it contains three disproven
hypotheses, and re-running them is the main way to waste a day here.

### 5.1 The root cause (measured 2026-09-13)

A generic
`wrap(generic(R), f : Impl(Fn() -> R), io) -> Impl(Future(R))` has **ONE `R`
SomeT id for every instantiation**, because the declaration is evaluated once.
That id is read through two channels which disagree:

- the global registry (`register_some_resolved_concrete`) — **last write wins**;
- the SomeT's own per-object `resolved_concrete` cell, which
  `resolve_some_type_to_concrete` consults FIRST — **trails the registry by one
  call**.

The emitted C takes whichever wrong answer its reader consulted. Async
generation 0 is never re-registered at all (at the first call `R` is still
abstract, so the `has_some == 0` gate in
`src/evaluator/values/anonymous_function.yo` rejects the body type) and so falls
through to the registry's LAST write; later generations get their own cell, one
call stale.

### 5.2 What is already disproven — do NOT redo these

1. **The two wrapper bridges** in `_evaluate_funcval_runtime_call`
   (`src/evaluator/calls/function.yo`). They DO copy a stale value — measured:
   `resolved_ret` is correct at all three calls while `rb_binfo.ty` lags — but
   guarding them leaves the emitted C **byte-identical**, with `check ./src`
   275/275 and `check ./std` 175/175 still green. The stale write is real and
   inert.
2. **The io.async stamp** in the `rt` arm (`register_some_resolved_concrete`
   near `src/evaluator/calls/function.yo:6420`) — **never reached** for this
   shape. Zero probe output.
3. Earlier: a cell drain, and `_pin_io_async_closure_result`. Both measured
   no-ops.

### 5.3 The method that cracked it, worth reusing

**Extend the observation until the candidate mechanisms disagree, before
reaching for a probe.** At TWO instantiations a lag-by-one, a swap and a
reversal are the same permutation, so no probe can separate them — and the
first instrumentation round came back ambiguous precisely because the suspected
fix WAS reaching the path. A third instantiation separates them, and cost one
`--emit-c` of a twelve-line program:
`issues/repros/generic-future-return-three-t-closure-param.yo`.

### 5.4 The fix direction

Structural: **per-call identity for a user generic callee's forall binders** —
what `_freshen_io_builtin_callee` already does for io.async's own `T`/`E`, and
what the one working shape (the METHOD-CALL form) gets for free by reading the
specialization's own freshly-cloned body.

The surgery has to happen **upstream of parameter binding**, where the callee
type is first taken — `ret_type` and `callee_func_type_opt` in
`_evaluate_funcval_runtime_call` are both derived from `callee_info_opt.ty`
AFTER `fresh_env` is built, so freshening there is too late.

Candidate 3's obstacle in the issue doc is about RENAMING binders; note that
`_freshen_io_builtin_callee` freshens **ids, not names**, so the by-name
forall-label match (`fv_mn == flabel`) keeps working. That obstacle may
therefore not apply — verify before believing either way.

### 5.5 How to gate a fix here

This is the hottest type-resolution path in the evaluator. Red-first baseline,
captured on `eb6586290`:

| shape | before |
| --- | --- |
| `b.run(…)` method-call | COMPILES, `a=7 b=8` — **must stay green** |
| `Box3.run(b, …)` explicit receiver | FAILS, 7 C errors |
| impl entry, no `self` | FAILS, 7 C errors |
| free function, two T | FAILS, 7 C errors |
| free function, three T | FAILS, 9 C errors |

Gate in this order: `check ./src` and `check ./std` FIRST (minutes, and an
over-narrowed guard shows up there long before the suite), then the table
above, then `tests/async_mutex.test.yo` — `with_lock` is the known-good path
and an over-eager guard would silently un-fix it. Then the full suite.

**Watch the value collision:** use `Pair(lo:3, hi:5)` so `b=8`. With `hi:4` the
sum is 7, which collides with the i32 case's `a=7` and a wrong answer becomes
invisible.

---

## 6. Other open work

- **`issues/the-published-windows-bundle-is-only-smoke-tested-with-yo-compile.md`**
  (filed today). `install-scripts.yml`'s windows job compiles a `hello.yo`
  whose `main` **takes no `io` at all**, so the async runtime is linked into the
  published artifact and never executed. Fix is one step: `yo init` +
  **`yo build run`** with the installed bundle (`run` also EXECUTES the produced
  binary, so the freshly-emitted runtime starts up in its own process — the gap
  is "linked but never executed", so that half is the one that closes it).
  Verified hermetic: with `YO_CACHE_DIR` at a scratch dir it returns rc=0 and
  leaves the dir EMPTY, so no network and no flake.

  > The general rule it records: a CODEGEN change reaches users only after the
  > next seed bump, so a regression gets a release cycle to be caught in. A
  > change to the emitted RUNTIME is carried by every binary the new compiler
  > emits, the bundle's own `yo` included, from the FIRST release containing it.
  > **That difference is invisible in the diff** — both are edits under `src/`.

- **#556** (`issues/a-bodyless-http-response-is-not-read-until-the-deadline.md`,
  branch `std-http-client-pool`) — a lost read wake-up reproducing identically
  on kqueue and io_uring, so a defect in neither backend. Tracked with the std
  campaign but outside its scope.

- **`plans/BUILD_AND_DEPENDENCY_SYSTEM_REDESIGN.md`** — P0 and P1.1–P1.4b
  landed; next is `build.manifest` and §4.5.2–§4.5.4. Note the seed-gate
  subtlety already recorded in AGENTS.md: a module-level `::` VALUE binding in
  `std/build.yo` breaks the whole module under an older seed, but a FUNCTION
  wrapper does not, because its body is deferred.

---

## 6b. One tooling trap, because it nearly produced a wrong rule

**`git diff A..B` and `git diff A...B` answer different questions, and only the
three-dot form answers "what does my branch change?"**

- `origin/develop..HEAD` (two dots) compares the two TREES. Every commit
  develop gained since your branch point shows up as a DELETION, because it is
  absent from your tree. A docs branch parked behind a freeze therefore reads
  as though it reverts everything that landed while it sat.
- `origin/develop...HEAD` (three dots) diffs against the MERGE BASE — the
  changes your branch introduces. **This is what the PR shows and what merges.**

One catch from today is worth more than the rest, and this is it: a wrong FACT
gets corrected by the next measurement, but a wrong RULE gets followed. This one
would have sat in a handover telling future agents to distrust correct PRs and
rebase against a phantom.

Measured on this very branch, pre-rebase: two-dot said 19 files, +567/-1164,
apparently reverting #638's 314-line `runtime_io_windows.yo` and the release's
version bumps. Three-dot said 5 files, +528/-1. The three-dot number was the
true one — confirmed by simulating the merge with
`git merge-tree --write-tree origin/develop <branch>` and inspecting the
result: `runtime_io_windows.yo` came out at 4890 lines, identical to develop,
and `CURRENT_YO_VERSION` was still `"0.2.32"`.

**A stale base causes CONFLICTS, never silent reverts** — a squash merge applies
the merge-base-to-head diff through a three-way merge, so commits the branch
never saw are preserved by construction. If it could revert, every long-lived
PR in every repository would be a landmine.

Cheapest cross-check when a stat looks alarming: `gh pr view <n> --json files`,
which is always merge-base relative. If it disagrees with your local stat, the
two-dot one is the liar.

**And a trap inside the verification itself.** Do not read a file out of a bare
tree with `git cat-file -p "<tree-oid>:<path>"`. It does not reliably resolve
the path against a bare tree — in one attempt it printed the ROOT TREE LISTING
regardless of the path asked for, and "29 lines" nearly read as evidence that a
4890-line file had been gutted. Resolve the blob first and read that:

```bash
B=$(git ls-tree -r <tree> -- <path> | awk '{print $3}')
git cat-file -p "$B"
```

The same syntax returned genuine file content for the other session, so it
sometimes works — which makes it worse, not better. A check that silently
ignores your argument and returns plausible output is more dangerous than one
that errors.

---

## 7. Standing constraints from the maintainer

- **No workarounds.** Probe before working around; a genuine language gap goes
  in `plans/backlog/`.
- **No backward-compat shims** — single user, only the seed gate matters.
- `--optimize 2` on every compile.
- **Do not use the Workflow tool** for compiler work (usage cost).
- Admin-merging your own PRs to save CI cycles is explicitly allowed. Cutting a
  patch release when you judge it necessary is explicitly allowed.
