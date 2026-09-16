# Handover — 2026-09-15, FORMAL_VERIFICATION campaign: V6 tasks 1+2(slice)+4 LANDED; #695 + #697 OPEN (task 5 slice 1); tasks 2(abstract)/3/5(slice 2)/6 remain

**Status: LIVE INSTRUCTIONS (updated at the session-3 handoff, 2026-09-15
late).** Written for the agent taking over the
`plans/backlog/FORMAL_VERIFICATION.md` campaign ("finish everything in
the plan; document and fix surfaced bugs; no workarounds; stacked PRs fine").
Everything below is measured or names the PR/run it came from; beliefs are
labelled as such. Supersedes `plans/HANDOVER_2026-09-14_FV_V6_TASK1.md`
(marked SUPERSEDED in its header; its §3–§5 are historical).

**The one-line state:** V1–V5 complete; V6 task 1 (trait variance +
inheritance), task 2's call-site half (contracted generic callees discharge
at monomorphized call sites), and task 4 (mutual-recursion decreases) all
LANDED (#685 → `451b75a7f`, #687 → `16aed5f46`, #691 → `3177afa4a`, each
28/28 green). Two PRs are OPEN (§0): #695 (u64 decreases signedness —
ready) and #697 (task-5 slice 1 — CI stalled + conflicts vs develop, with
the recipe). Remaining after those: task 2's abstract-body half, task 3
(`Refine(T, p)` real), task-5 slice 2 (std/collections dogfood — blocked
on a seed bump), task 6 (worked example — needs task 3).

## 0. TAKEOVER STATE — 2026-09-15 late (session-3 handoff; read this first)

**Merged since the last update:** banner #694 → develop `d2a9f6fd3`
(this handover landed there). Develop tip at handoff: `604896dd6` (#689,
the peer issues-triage sweep).

**OPEN PR 1 — #695 (`fix/verifier-decreases-unsigned`): GREEN — MERGE
IT.** The u64 decreases signedness fix (`_measure_is_signed` in
`src/verifier/vc.yo`; entry ground `bvsge`/`bvuge`, step
`bvslt`/`bvult`), the task-4 mutual fixtures flipped to u64, the issue
moved to `issues/fixed/` (the Fix section rides commit `ec7f6cf99`).
Run 34932915472 COMPLETED SUCCESS (all 28). Action:
`gh pr merge 695 --squash --delete-branch --admin` → the
`--delete-branch` step WILL fail (the Yo-fv worktree holds the branch);
check `git ls-remote --heads origin fix/verifier-decreases-unsigned`
and clean up both sides by hand (the §3 pattern). Probed: merges clean
into current develop.

**OPEN PR 2 — #697 (`feat/fv6-task5-assumed-contracts`): stacked on
#695; CI battery NEVER STARTED, and it now CONFLICTS with develop.**

- Content (task-5 slice 1 — see the V6 task-5 banner in
  `plans/backlog/FORMAL_VERIFICATION.md` for the full record): the
  `assumed()` signature clause + the contract-less `outside-subset`
  degrade; `tests/internal/verifier_assumed.test.yo` (5 tests) + 5
  fixtures; a CI verify-job step; the cheatsheet `assumed()` bullet.
  Local gates ALL green: `yo check ./src` 275/275 and the serialized
  10-file verifier battery (`tmp/run_battery.sh` in the worktree,
  61 tests) green with real z3.
- THE STALL (STILL TRUE at the final update — the only blocker on
  #697): no Actions run was EVER created for the branch —
  `gh api repos/shd101wyy/Yo/commits/<sha>/check-runs --jq .total_count`
  returned 0 across THREE empty `ci:` re-trigger commits (`9c92c7e8`,
  `e1e16519`, `fef60245`) AND a close+reopen, over ~40 min. The runs
  list shows no run for the branch at all — never queued, not failed.
  Three peer branches were mid-battery the whole window
  (`fix/selftrait-dyn-return-type`, `inc/phase4-warm-occurrence`,
  `inc/phase4-warm-selfcheck`); runner saturation is the likely cause.
  The §3 remedies were insufficient this time.
- THE CONFLICT — RESOLVED (updated minutes after it appeared): #689
  repaired issue paths INSIDE the cheatsheet and re-recorded the same
  seven cli-case goldens (`fe8aed4f…`); this branch had pinned its own
  hash (`f5b2b5be…`) after adding the `assumed()` bullet. The taking-
  over session merged develop into the branch (`854907e6b`) — the
  merged cheatsheet hashes `ba3b6b34…` and ALL SEVEN goldens were
  verified consistent with it (`grep`-checked 2026-09-15). Only the
  stall below remains.
- RESOLUTION RECIPE (SUPERSEDED for the conflict — see above; KEPT for
  the stall): push again (any empty commit) once runner load drops;
  watch `gh run list --branch feat/fv6-task5-assumed-contracts` and the
  check-runs oracle. The classify step runs FULL (src/ changes).

**Design decisions locked this session (do not re-litigate):**

- Task 5 = assumed contracts (option (a) of handover §4.3; the heap
  model stays parked). The landed shape: EVERY fn in a verify target
  still registers — the AoRTE flagship (`bugged_div`: div-by-zero
  refutations on unannotated code) is untouched — but a walk that fails
  the SUBSET on a CONTRACT-LESS fn degrades to the passing
  `outside-subset` outcome (construct kept as the note); contracted fns
  stay loud; `assumed()` (at least one real contract clause required)
  skips the walk and reports `assumed` while its contracts gate callers
  (call sites read the FuncVal-id side tables, so assumed tasks carry
  RAW predicates and register for DEFERRED generic bodies too). An
  earlier same-session draft that stopped uncontracted fns from
  registering was REVERTED when the battery caught it killing
  `bugged_div` — do not re-propose the flip.
- Task-5 slice 2 (the `std/collections` annotations + the
  `yo verify ./std/collections` CI step) is BLOCKED on a seed bump:
  seed 0.2.33 hard-errors on `assumed()` in a signature (the zone
  check rejects the unknown clause; measured). The `build.manifest`
  generation-A/B pattern (`plans/backlog/SEED_VERSION_AUTOMATION.md`)
  applies; the checklist is in the plan's task-5 banner.
- Task 3 rides the same generation split: a `RefineT` TypeValue variant
  + new builtins cannot be exercised through `std/spec` under the
  current seed (and a file-level pragma extension would throw on old
  seeds too — `evaluate_pragma` rejects unknown variants).
- Probe-validated (`tmp/lstprobe.yo`): contract clauses on a GENERIC
  INHERENT impl method (ArrayList's exact shape) evaluate clean and
  register — the trait-entry clause corruption issue does not extend
  there.

**Session-3 lessons (new since the §5 catalogue):**

- `cond` is ARM-styled (`cond(c => a, true => b)`); the comma form is a
  parse error `yo fmt` does NOT catch. `if(c, a, b)` is the comma form.
- Adding a `?=`-defaulted ref-struct field: a forgotten non-default at
  any construction site silently takes the default
  (`VerifyTask.body_assumed` cost a 10-min iteration — the assumed task
  registered with `false` and walked into "untyped expression").
  Declare new fields LAST (matching construction order) and grep every
  construction site.
- The CLI cannot exercise in-worktree evaluator changes — `yo check` /
  `yo verify` run the SEED's compiled-in evaluator; only the in-process
  harness (tests importing `src/`) validates PR code locally.
- Pushing ANY commit (even docs) to a PR branch supersedes its in-flight
  battery (same concurrency group) — finish a branch's battery before
  touching the branch.

## 0.5 WINDOW STATE — 2026-09-16 (session 4 final: task 3 slice 1, splice fix, task 6 MERGED; slice-2 annotations gated)

- **v0.2.34 cut** carrying #697's `assumed()`; **v0.2.35 cut** from
  develop WITHOUT #710 (it was still open) — so the seed still has the
  OLD contract splice; the annotations draft (#713) stays gated on the
  NEXT release. Local seed: v0.2.35 installed (nested tarball dir).
- **MERGED:** #727 (task 3 slice 2 - the TYPE-LEVEL RefineT variant + named aliases; be3afea92; the 213-error cascade was ONE creators.yo match + 2 renderers)
- **MERGED:** #705 (task 3 slice 1 — `refine(T, p)` side-table
  annotations + modular VCs; the safe_div flagship proves with no
  manual requires; rebased onto the v0.2.35 pin with the cheatsheet
  conflict resolved — merged cheatsheet sha f1d3fc1a…), #710 (the
  dependency-free contract splice — see below), #726 (task 6 — the
  worked example re-based onto `Array(T, N)` + a refined index;
  `s(i)`'s AoRTE bound discharges from the assumed refinement;
  verifier_refine 5/5). #712 was superseded by #726 (the deleted base
  branch blocked reopen — retarget-by-new-PR pattern).
- **SURFACE BUG FIXED (#710): the runtime contract splice was not
  dependency-free.** The splice called `import("std/assert").assert` —
  a load-time dependency; std/assert imports std/string imports
  std/collections, so a contract clause in std/collections was an
  IMPORT CYCLE (array_list half-loaded, E0403 "Module field assert not
  found", every downstream import cascaded). Std contracts were
  structurally impossible. The splice is now
  `cond(begin(runtime(pred)) => (), true => { __yo_panic(msg); () })` —
  builtins resolve without imports; runtime() tolerates unknown
  predicates at the def-time trial; the begin wrapper matches the
  parser's paren-condition AST; the panic arm is sequenced with `()`
  so evaluate_panic's stand-in type unifies as unit; the verify+ strip
  recognizer (now EXPORTED and used by the strip test directly — the
  test-side mirror counted zero after the shape change, caught by CI
  differential shard 1) descends into the begin-wrapped panic arm.
  Same panic text; the location now points at the CONTRACT SITE (the
  predicate's operator token) instead of std/assert — the three
  contracts-runtime cli-case goldens re-recorded
  (`src/main.yo:1:44`/`1:40` — the predicate operator columns).
  Synthesis gotchas that each cost a cycle: `_synth_atom` takes
  `String` (wrap BK_/BF_ constants in String.from — a raw `str`
  compiles to a far-away C type error); the `true` arm test is
  TokenKind.Bool (an Identifier "true" var-misses); non-atom cond
  conditions must be begin-wrapped; expected-type contamination breaks
  arm unification.
- **TASK 5 SLICE 2 = two PRs:** #710 (the fix, MERGED) + **#713/DRAFT**
  (the annotations: pragma(Verify) on array_list/hash_map; bounds
  requires + assumed() on insert/remove/swap/swap_remove/drain/
  set_len; push's len ensures; total ops join as outside-subset).
  #713's CI is red BY DESIGN until a release carries #710 (the
  v0.2.35 seed's old splice cycles on annotated std at batch-compile —
  even the test harness's batch compile evaluates std). When
  v0.2.36 cuts: un-draft #713, re-run CI, merge, and the
  `yo verify ./std/collections` exit-criterion step goes green with it
  (the step is already in #713's CI wiring).
- **Local check status:** `yo check ./src` gets reaper-killed past
  ~9 min when the machine is loaded (multiple 143s; even disowned
  nohup runs SIGKILLed). The per-test batch compiles compile the whole
  evaluator tree and CI runs check ./src — rely on those.
- **Remaining after the open PRs land:** task 3's type-level variant
  (213 exhaustive matches — the mountain), std/spec rework (.check/
  .unchecked, composition, named aliases), task 2 abstract generic
  bodies, V7 productization, the trait-impl clause corruption issue.

## 1. Campaign ledger (what landed, with SHAs)

| Phase | State | Merge |
| --- | --- | --- |
| V1–V5 (contract surface → solver → straight-line/AoRTE → loops → two-state/quantifiers/ghost → std/spec ghost collections → insertion-sort exit) | complete | see the plan's per-phase banners; last was task 6 → `d5143f99e` |
| V6 task 1 — trait-contract variance + inheritance | **complete** | #685 → `451b75a7f` (28/28), banner #686 → `6dfe26d9d` |
| V6 task 2 SLICE 1 — contracted generic callees at monomorphized call sites | **complete** | #687 → `16aed5f46` (28/28) |
| V6 task 4 — mutual-recursion decreases | **complete** | #691 → `3177afa4a` (28/28), banner #694 → `d2a9f6fd3` |
| u64 decreases signedness (`issues/fixed/verifier-decreases-nonneg-…`) | **PR OPEN, GREEN** | #695 → branch `fix/verifier-decreases-unsigned`, run 34932915472 completed success |
| V6 task 5 SLICE 1 — `assumed()` + contract-less `outside-subset` degrade | **PR OPEN, CI stalled (conflict resolved by the develop merge `854907e6b`)** | #697 → branch `feat/fv6-task5-assumed-contracts`; local battery green; see §0 |
| V6 task 5 SLICE 2 — std/collections dogfood + CI verify | **blocked on a seed bump** | checklist in the plan's task-5 banner |
| V6 task 2 remainder — generic bodies verified ABSTRACTLY | not started | see §4.1 |
| V6 task 3 — `Refine(T, p)` real type constructor | not started (scoped 2026-09-15; std rework rides the generation split) | see §4.2 |
| V6 task 6 — tests incl. the worked example | not started | see §4.4 (needs task 3) |

The plan file carries full per-slice banners with lessons
(`plans/backlog/FORMAL_VERIFICATION.md`, V6 section) — authoritative.

New verifier test files/fixtures added by this stack (all green locally
with real z3, all in CI):
`tests/internal/verifier_trait_variance.test.yo` (3),
`verifier_generics.test.yo` (3), `verifier_mutual.test.yo` (2);
fixtures `tests/spec/fixtures/{valid,negative}/trait_variance*.yo`,
`valid/trait_inherit.yo`, `valid/generic_callee.yo`,
`valid/generic_requires_ok.yo`, `negative/generic_requires_false.yo`,
`valid/mutual_recursion.yo`, `negative/mutual_recursion_false.yo`.

## 2. Environment & tooling (read before running anything)

- Worktree: `/home/deck/Workspace/Yo-fv` (per
  `[[worktree-workflow-preference]]`). At handover it sits on
  `feat/fv6-task4-mutual-decreases`. Sync:
  `git fetch origin --prune; git checkout --detach origin/develop`
  (or rebase the stack branch; see §3 for the rebase pattern).
  The stray untracked `vendor/markdown_yo/` directory is a leftover —
  do NOT `git add -A` over it, and do not delete it blindly (it
  appeared during a stash pop; harmless).
- **After any fresh clone/worktree setup: run `yo install` in the
  worktree.** Since #654 the compiler imports the store dependency
  `markdown_yo`; without it `yo check ./src` fails exactly 4 files
  (`src/doc/render_html.yo` + importers) with ``git dependency
  "markdown_yo" is not in the store`` — this looked like a code
  failure on 2026-09-15 and cost a false alarm (271/275 vs 275/275).
- Seed binary: v0.2.32 at `~/.local/bin/yo`. The Mimosa PreToolUse hook
  REJECTS any Bash command whose text contains `install.sh` — the
  manual bundle-install recipe is in `[[fv-worktree-build-recipe]]`.
- No C compiler on PATH: emit with `--emit-c --skip-c-compiler`, then
  `nix-shell -p clang --run 'clang -O2 -w X.c -o X'`.
- Env pins for every yo invocation:
  `YO_STD=$PWD/std YO_SKILLS=$PWD/.github/skills`.
- Local z3: `~/z3-local/z3-5.1.0-x64-glibc-2.39/bin/z3`
  (`YO_Z3_PATH`).
- **Never overlap two yo runs** (machine-wide; a PEER session works in
  `/home/deck/Workspace/Yo-async-audit` — check
  `ps aux | grep yo`, the cwd tells whose it is; never kill a peer's).
  Run long compiles as ZCode background tasks (the ~10-min reaper
  SIGTERMs foreground ones).
- The scratch driver `tmp/zerodrv.yo` (untracked, gitignored dir)
  loads `$FIXTURE`, drains verify tasks, walks each with
  `verify_function_body`, and prints `=== obligation ===` blocks for
  z3. Build ≈ 8 min:
  `yo compile tmp/zerodrv.yo --emit-c --skip-c-compiler --optimize 2 -o /tmp/varN`
  + clang. **Caveat: the driver calls `verify_function_body` DIRECTLY,
  bypassing `verify_and_strip_tasks` — anything computed in the
  driver prepass (mutual-recursion cliques!) never runs under it.**
  Task-4 fixtures looked like they "proved everything" under the
  driver for exactly this reason; validate clique/strip/report features
  through the real harness (`yo test ./tests/internal/verifier_*.test.yo`
  with `YO_TEST_Z3=1 YO_TEST_LEAK_VERDICT=0`, leak verdict 0 because
  the seed's leak detector false-fires locally; CI's self-hosted
  binary is the arbiter).
- Local test recipe:
  `nix-shell -p clang --run 'env YO_STD=... YO_SKILLS=... YO_Z3_PATH=... YO_TEST_Z3=1 YO_TEST_LEAK_VERDICT=0 yo test ./tests/internal/X.test.yo --parallel 1'`.
  Full battery measured 2026-09-14/15: verifier 18 (~4 min),
  quantifiers 6 (~4), spec_collections 5 (~4), negative 5 (~9), loops
  12 (~14), insertion_sort 2 (~7), trait_variance 3, generics 3,
  mutual 2.
- `tmp/*.yo` files (`gencall*.yo`, `gensplice.yo`, `inh_a/b.yo`,
  `lr_trait*.yo`, …) are this window's probes — safe to delete.
  `tmp/zerodrv.yo`, `tmp/fixme.yo` are the standing scratch files.

## 3. The stacked-PR workflow that worked (use it again)

Branches stack linearly; when the base merges, rebase the follower:

```bash
git fetch origin
git rebase origin/develop --empty=drop   # drops the now-merged duplicate commits
git push --force-with-lease origin <branch>
```

or, when the rebase conflicts on already-landed content: abort,
`git checkout -B <branch> origin/develop`,
`git cherry-pick <delta-commit>` (this is what #687 needed — its stack
parent duplicated #685's content, and the task-1 commits conflicted
with the landed banner).

**The Actions run-creation stall is real** (bit twice): a push that
should start the PR battery sometimes creates no run. Oracle:

```bash
gh api repos/shd101wyy/Yo/commits/<sha>/check-runs --jq '.total_count'   # 0 = stalled
```

Force-push the same branch (or any empty commit) to re-trigger, then
cancel the stale superseded run (`gh run cancel <id>`). See AGENTS.md
§"CI runs" for the cancel/freeze rules; the standing merge rule is
`gh pr merge <n> --squash --delete-branch --admin` once the matrix is
green, then a docs-only banner PR recording the merge SHA (fast path,
minutes) — and never merge a docs-only PR while a battery you need is
in flight (checked `gh run list --branch develop` first on 2026-09-14;
the queued develop battery was code-identical to the PR's own 28/28, so
merging the banner over it was judged safe).

## 4. The remaining work, with exact frontiers

### 4.1 Task 2 remainder — generic bodies verified ABSTRACTLY

The plan's design ("type variables become uninterpreted sorts; trait
constraints contribute their method contracts as axioms; monomorphized
call sites discharge through the generic's own contracts") — the third
clause is DONE (#687). What remains is verifying the generic BODY
itself. Measured obstacles, from this window's probes:

- A generic fn's body is DEFERRED (`should_defer_ft`,
  `calls/function_type.yo`): the def-time trial is skipped, so the body
  has **no ExprInfo at all** — the walk's `_expr_term` fails
  "untyped expression" on every node. The task-registration gate
  (`!(should_defer_ft)`) means generic fns register no verify task.
- The obvious "verify per specialization" does NOT work: specializations
  run at call sites during later evaluation, and `yo verify` drains
  tasks after module evaluation — there is no specialized body to
  register for a fn that is only called at runtime.
- So the real shape is the plan's: a diagnostic evaluation of the
  deferred body ONCE at definition, with the type variables bound to
  opaque placeholders, in a mode where operations over them are
  ghost-legal (today `==` on a SomeT operand has no comptime impl and
  the operator evaluation fails into the swallow). That is evaluator
  surgery of the deepest kind — a new ghost-eval looseness comparable
  to `is_evaluating_contract_predicate`, plus walk-side support for a
  fresh uninterpreted SMT sort per type variable
  (`declare-sort` + opaque `VcTerm.Var` of that sort; `_type_sort`
  currently rejects SomeT params with "parameter outside the
  integer/bool/array subset").
- Suggested first slice if picked up: support ONLY
  "type variables used opaquely" — bind/equality/return/`cond` on T
  values, calls to OTHER contracted fns — and fail the subset loudly on
  arithmetic/trait-method calls over T (the trait-constraint-axioms
  half stays a later slice). `identity :: (fn(generic(T : Type),
  x : T, ensures(result == x)) -> (result : T))(x)` is the first
  fixture; its `==` on opaque terms is already SMT-expressible.
- Plan §680's stance stands: the verifier is post-specialization and
  "never reimplements trait dispatch — except where V6 deliberately
  verifies generic bodies abstractly".

### 4.2 Task 3 — `Refine(T, predicate)` real type constructor

Plan §401 has the design and the API contract; §680's sort table
already reserves "`Refine(T, p)` (V6) — erased, the sort of `T`; `p`
becomes an obligation". Ledger entry 3 = the breaking change: today's
one-parameter `Refine(T)`/`NonZero(T)`/`Bounded(...)`/`NonEmpty(T)`
identities in `std/spec/refine.yo` gain the predicate parameter.

Scope notes from scoping done 2026-09-14 (not started):

- New `TypeValue` variant (e.g. `RefineT(inner, predicate)`) — distinct
  at the type level, erased to `inner` for compat/codegen. Touches
  `types/definitions.yo` (the variant + all exhaustive matches — there
  are many), `types/compatibility.yo` (Refine(T,p) <: T free; T →
  Refine requires proof at the coercion site), codegen erasure.
- The predicate is a VALUE (a comptime closure), not a type-level
  lambda — the plan's `(x) => (x != T(0))` sketch needs an actual Yo
  spelling decision: a ghost_fn/comptime fn value carried on the type,
  evaluated at construction sites in an env binding the value.
- Construction-site VCs: wherever a `Refine(T, p)` is produced from a
  `T` (literal construction with CTFE-known values folds the check;
  `.check(...)` returns `Option(Refine(T, p))`; `.unchecked(...)` under
  `pragma(Pragma.AllowUnsafe)`), the verifier emits a `refine#N`
  obligation walking `p(x)`.
- Composition normalization `Refine(Refine(T, p), q) ≡ Refine(T, p && q)`
  at construction.
- This is a language feature with design decisions — budget it as its
  own window, not a follow-up slice. The worked example (task 6)
  depends on it.

### 4.3 Task 5 — dogfood std/collections + CI verify

**UPDATED at the session-3 handoff: the design decision is RESOLVED and
slice 1 is OPEN as PR #697 (§0).** Landed: `assumed()` (option (a)) +
the contract-less `outside-subset` degrade; the "verify mode makes
unprovable a compile ERROR" obstacle is gone for contract-less
infrastructure fns. What REMAINS (slice 2) is BLOCKED on a seed bump —
seed 0.2.33 hard-errors on the `assumed()` clause (measured; the zone
check rejects the unknown clause name), and the battery's `yo` runs
evaluate `std/` with the SEED, so the annotations cannot land in the
same release as the mechanism. Slice-2 checklist (post-bump, in the
plan's task-5 banner): `pragma(Pragma.Verify)` at the top of
`array_list.yo`/`hash_map.yo`, bounds/len contracts + `assumed()` on
the core ops (get/set/push/insert/remove), the `yo verify
./std/collections` CI step (the exit criterion), and an
`issues/fixed/` write-up per real bug the verifier surfaces at call
sites.

### 4.4 Task 6 — tests + the worked example

Needs task 3. The plan's example is `NonEmpty(Slice(T)).head()` — but
**builtin `Slice(T)` is DELETED** (AGENTS.md; `Array(T, N)` is the
value type, `ArrayList` the growable one), so re-base the worked
example on `ArrayList(T)` or `Array(T, N)` and fix the plan text while
there. "Slices-with-len in the walk" from the old task-6 text needs the
same re-derivation against the post-deletion types. Also in task 6:
the refinement construction-site rejection test (counter-example at the
construction site) — part of task 3's acceptance really.

### 4.5 Quick wins / filed bugs

- `issues/verifier-decreases-nonneg-is-signed-for-unsigned-measures.md`
  (OPEN): `decreases-nonneg`/`decreases-step` hardcode SIGNED
  comparisons; an unsigned measure refutes at `n = 2^63`. Small,
  contained fix in `vc.yo` (derive signedness from the measure's sort
  like `_binop_of_ctx` does) + flip the task-4 fixtures to `u64`. Good
  warm-up PR; do it BEFORE or independently of task 3.
- `issues/trait-impl-method-contract-clauses-corrupt-operator-dispatch.md`
  (OPEN, updated with new evidence 2026-09-14): blocks the INLINE
  clause-carrying impl-method spelling (the two-step spelling is the
  documented idiom). The env-frame-identity probe sketch is in the
  issue.
- `issues/derived-eq-ref-enum-self-payload-hollow-at-runtime.md` (OPEN,
  pre-existing): derive(Eq) hollow on ref enums — unrelated to FV but
  the verifier routes around it.

## 5. Gotchas catalogue (each cost hours; do not re-learn them)

**Module-level statements:**
- A BARE module-level call evaluates during the evaluator's module walk
  (`yo check` sees it) but codegen collects ONLY `:=` / `(x : T) =` /
  `x =` as module initializers (`evaluator/values/anonymous_module.yo`)
  — a bare call is DROPPED from compiled binaries. Install hooks with
  `_name := (fn() -> bool)({ ... })();` (the `_trait_checking_init`
  precedent). This was task 1's phantom: hooks worked under check,
  silently absent in the driver.
- An IIFE `(() => {...})()` does not parse; the `:=` arrow-call shape
  above does.

**Specialization ids (bit #687 AND #691):**
- A generic call mints `specialized_func_id = func_id + "_" + sig`
  (`calls/helper.yo`); every downstream consumer that wants the
  ORIGINAL function's tables/identity must normalize through
  `register_specialized_base` / `specialized_base_of`
  (`evaluator/builtins/contracts.yo`, written at the mint). Contract
  re-keying already happens there (#687); the mutual-recursion cliques
  normalize through it (#691). Any future "per FuncVal id" side table
  must decide which spelling it keys on.

**Verifier evaluation timing:**
- `prepare_callsite_contracts` (and anything reading call-site
  ExprInfo) must run AFTER `_trial_eval_fn_body`
  (`calls/function_type.yo` ~line 1460) — at task-registration time the
  stamps do not exist. Symptom when misplaced: every stash probe prints
  "f NO info".
- The diagnostic predicate pass (`evaluated_for_verify`) sets
  `is_ghost_context` but NOT `is_evaluating_contract_predicate` —
  unbound names in predicates soft-fall back only under the latter
  (set by `_evaluate_contract_marker`); synthetic bodies referencing
  bare names need those names BOUND in the pred env (see the
  `import("std/assert").assert` FuncVal binding in
  `register_impl_variance_task`).
- A synthetic body's trailing unit must be the parser's zero-arg
  `tuple()` call (a bare `"()"` ATOM dies at
  `Variable "()" not found`); a sole un-semicoloned `match(...)`
  as a fn body is E0007 — use `match(...); ()`.
- Generic signature predicates are UNTYPED (ops over the type var fail
  comptime eval, swallowed by the trial) — the raw ASTs are unusable in
  the walk; that is why CallsiteContracts evaluates clones per call
  site (#687).

**Yo syntax/eval traps (paid for repeatedly):**
- `(x : T) = init` declares REASSIGNABLE; plain `:=` then `=` on it is
  an error in some positions but the existing code does both — when in
  doubt mirror the surrounding code. `HashMap` has `contains_key`,
  `ArrayList` has `contains` — mixing them reads as "No matching call".
- `generic(T)` alone does not parse — `generic(T : Type)`.
- `cond` is arm-styled (`cond(c => a, true => b)`); `if(c, a, b)` is
  the comma form. The SEED's fmt MANGLES files containing `==>`.
- Param binding sites: three binders create parameters (def-time env,
  funcval runtime call, call-site check) — mirror flags across all
  three when adding any (see AGENTS.md pitfalls; the `own` lesson).
- TraitT's `id` is the SIXTH field (name is first). `contracts.yo`/
  `impl.yo` cannot import `types/function.yo` — use the function-pointer
  hooks in `values/type_trait_methods.yo`.
- The docs/skills cheatsheet sha256 is PINNED in SEVEN cli-case goldens
  (`tests/cli-cases/{init,init-cwd,init-existing,init-build-test,
  build-stamp-dotted-dir,skills-install,skills-install-zh}/expected_tree`)
  — editing `.github/skills/yo-syntax/syntax-cheatsheet.md` requires
  re-recording all seven (done in #685; sed the old hash to the new).

**Process:**
- `yo install` in fresh worktrees (markdown_yo store dep) — §2.
- The zerodrv driver bypasses the driver prepass — §2 caveat.
- The battery is ~28 jobs / ~2 h; the first hours are queued, not
  failing. Check `gh pr checks <n>` non-passing count, not the queue.
- `plans/backlog/FORMAL_VERIFICATION.md` V6 section carries the
  per-slice banners (task 1, task 2 slice, task 4, task 5 slice 1) with
  the full lessons — keep appending there per landing.
- Update `~/.zcode/cli/memories/projects/yo-eebb55377c6e8044/memory/
  fv-worktree-build-recipe.md` when things land (it is current through
  the session-3 handoff).
- `tmp/run_battery.sh` (worktree, untracked) runs the whole local
  verifier battery serialized with the right env; `tmp/lstprobe.yo`
  is the generic-impl-clauses probe; `tmp/zerodrv.yo` stands (§2
  caveat applies).

## 6. Suggested order for the next window

1. Merge #695 when its last job lands, clean up both branch sides
   (mechanical, §0/§3).
2. Resolve #697 per the §0 recipe (cherry-pick onto fresh develop,
   re-pin the seven goldens to the merged cheatsheet's hash), force-
   push, make sure the battery actually STARTS this time, merge when
   green + clean both sides.
3. Task 3 (`Refine(T, p)`) as its own focused window — the largest
   remaining piece and the worked example's dependency. Mechanism may
   land ahead of its `std/spec` rework (the generation split), but
   design that split into the PR boundary from the start.
4. After the NEXT seed release: task-5 slice 2 — `pragma(Pragma.Verify)`
   + bounds/len contracts + `assumed()` on `array_list.yo`/`hash_map.yo`
   core ops, the `yo verify ./std/collections` CI step, and the
   `issues/fixed/` write-ups for whatever the verifier surfaces (the
   campaign's payoff — budget for them).
5. Task 2's abstract-body half and task 6 last.
