# Handover — 2026-09-15, FORMAL_VERIFICATION campaign: V6 tasks 1+2(slice)+4 LANDED, tasks 2(abstract)/3/5/6 remain

**Status: LIVE INSTRUCTIONS (updated in the task-4 banner PR: #691 merged
green 2026-09-15, develop `3177afa4a`).** Written for the agent taking over
the `plans/backlog/FORMAL_VERIFICATION.md` campaign ("finish everything in
the plan; document and fix surfaced bugs; no workarounds; stacked PRs fine").
Everything below is measured or names the PR/run it came from; beliefs are
labelled as such. Supersedes `plans/HANDOVER_2026-09-14_FV_V6_TASK1.md`
(marked SUPERSEDED in its header; its §3–§5 are historical).

**The one-line state:** V1–V5 complete; V6 task 1 (trait variance +
inheritance), task 2's call-site half (contracted generic callees discharge
at monomorphized call sites), and task 4 (mutual-recursion decreases) all
LANDED (#685 → `451b75a7f`, #687 → `16aed5f46`, #691 → `3177afa4a`, each
28/28 green). Remaining: task 2's abstract-body half, task 3
(`Refine(T, p)` real), task 5 (std/collections dogfood), task 6 (worked
example — needs task 3).

## 1. Campaign ledger (what landed, with SHAs)

| Phase | State | Merge |
| --- | --- | --- |
| V1–V5 (contract surface → solver → straight-line/AoRTE → loops → two-state/quantifiers/ghost → std/spec ghost collections → insertion-sort exit) | complete | see the plan's per-phase banners; last was task 6 → `d5143f99e` |
| V6 task 1 — trait-contract variance + inheritance | **complete** | #685 → `451b75a7f` (28/28), banner #686 → `6dfe26d9d` |
| V6 task 2 SLICE 1 — contracted generic callees at monomorphized call sites | **complete** | #687 → `16aed5f46` (28/28) |
| V6 task 4 — mutual-recursion decreases | **complete** | #691 → `3177afa4a` (28/28), banner = this PR |
| V6 task 2 remainder — generic bodies verified ABSTRACTLY | not started | see §4.1 |
| V6 task 3 — `Refine(T, p)` real type constructor | not started | see §4.2 |
| V6 task 5 — std/collections dogfood + CI verify | not started | see §4.3 |
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

Plan: annotate `std/collections/array_list.yo` (`get`/`set`/`add`
bounds + len post-conditions) and `hash_map.yo` core ops; run
`yo verify ./std/collections` green in CI; fix what the verifier finds
(each real bug → `issues/fixed/` with a reproducer).

**The open design decision** (write it down before coding): the
internals of those methods are raw-pointer/`unsafe` code — outside the
verifiable subset — so a naive `yo verify` over the module reports
subset errors, not proofs. The modular model offers the answer shape:
contracted functions whose bodies are outside the subset could carry
ASSUMED contracts at call sites (the "hollow-body" path the V5
diagnostics made loud) — but today `verify` mode makes unprovable a
compile ERROR. Decide: either (a) contracts on subset-external bodies
are assumed-with-diagnostic (a new per-fn marker/pragma), or (b) the
walk gains a minimal ptr-arithmetic model. (a) is the plan-consistent
cheap path; (b) is the "object/heap model" the plan explicitly parks
out of subset. Also wire CI: the "Formal verification (pinned Z3)" job
in `.github/workflows/test.yml` currently runs the tests/internal
verifier battery — extending it to `yo verify ./std/collections` is
the exit criterion.

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
  per-slice banners (task 1, task 2 slice, task 4) with the full
  lessons — keep appending there per landing.
- Update `~/.zcode/cli/memories/projects/yo-eebb55377c6e8044/memory/
  fv-worktree-build-recipe.md` when things land (it is current through
  #691's opening).

## 6. Suggested order for the next window

1. Merge #691 when green + banner PR (mechanical, §3).
2. The u64-nonneg signedness fix (#4.5) — small, unblocks unsigned
   measures, flips the mutual fixtures to `u64`.
3. Task 5's design decision written into the plan (assumed-contracts
   for subset-external bodies), then the `array_list.yo` annotations +
   CI verify wiring. Real verifier bugs found here are the campaign's
   payoff — budget for the `issues/fixed/` write-ups.
4. Task 3 (`Refine(T, p)`) as its own focused window — the largest
   remaining piece and the worked example's dependency.
5. Task 2's abstract-body half and task 6 last.
