# Handover — 2026-09-14, FORMAL_VERIFICATION campaign: V5 landed, V6 task 1 mid-flight

**Status: SUPERSEDED — task 1 is COMPLETE.** Merged via #685 (develop
`451b75a7f`, 2026-09-14, all 28 checks green); the authoritative record
is the V6 task-1 banner in `plans/backlog/FORMAL_VERIFICATION.md`. The
frontier described in §3 resolved as: (a) the hook install was a bare
module-level call — evaluator-only, silently dropped by codegen (only
`:=` / `(x : T) =` / `x =` inits are collected as module initializers) —
fixed with the `_name := (fn() -> bool)({…})();` shape; (b) two latent
bugs in the synthetic variance body (bare `"()"` atom + unbound
`assert`) — fixed with the parser's `tuple()` call and a pred-env
binding of `import("std/assert").assert`; (c) INHERITANCE was
re-designed — planting under the impl fn-TYPE expr id re-triggers the
filed env-sharing issue, so the landed form plants under the FuncVal id
plus a synthetic `impl-inherits@…` body-proof task. Everything below is
the frozen mid-flight state.

**Was: LIVE INSTRUCTIONS.** Written for the agent taking over the
`plans/backlog/FORMAL_VERIFICATION.md` campaign ("finish everything in the
plan; document and fix surfaced bugs; no workarounds; stacked PRs fine").
Everything below is measured or names the PR/run it came from; beliefs are
labelled as such.

**The one-line state:** V1–V5 are COMPLETE and merged (the insertion-sort
exit criterion holds end-to-end). V6 task 1 (trait-contract variance) is
implemented on the parked branch `feat/fv6-trait-variance`, checks green,
and is blocked at ONE last unproven gate by diagnostics you can reproduce
in minutes — plus a separately filed pre-existing evaluator defect that
blocks the inline code spelling. This handover tells you exactly where the
probe trail stopped.

## 1. Campaign ledger (what landed, with SHAs)

| Phase | State | Merge |
| --- | --- | --- |
| V1 contract surface (runtime) | complete (pre-campaign) | — |
| V2 solver harness (z3 5.1.0, pinned) | complete | #484 → `a4627574f` |
| V3 straight-line + AoRTE + match/datatypes + verify+ strip | complete | #497 → `48df44429`, #512 → `175a53991`, #535 → `af84f69b5` |
| V4 loops/invariants/decreases/break/continue | complete | #538 → `d0c5fe165` |
| V5 two-state old() + hollow-body diagnostics | complete | #557 → `c801e54ec` |
| V5 quantifiers forall/exists/==> + inout | complete | #564 → `43d95eefa` |
| V5 ghost_fn gating; ghost_fn inlining + ghost bindings | complete | #606 → `bd8724b8c`; #613 → `80ae3dbd2` |
| V5 std/spec ghost collections (Seq/Multiset/Set/str) | complete | #636 → `e54e137d7` |
| **V5 task 6: Array(T,N) indexing + ms_of; insertion sort proves sorted+permutation** | **complete** | **#674 → `d5143f99e` (all 28 checks green), banner #675 → `5ee76da9e`** |
| V6 task 1 (trait variance) | **WIP, parked** | branch `feat/fv6-trait-variance` (pushed, NO PR) |
| V6 tasks 2–6, V7 | not started | see plan §V6/V7 |

The plan file itself carries the full per-slice banners with lessons —
`plans/backlog/FORMAL_VERIFICATION.md` is the authoritative record.

## 2. Environment & tooling (read this before running anything)

- Worktree: `/home/deck/Workspace/Yo-fv` (per `[[worktree-workflow-preference]]`).
  Sync it: `git fetch origin --prune; git checkout --detach origin/develop`.
  The submodule/vendor state is fine; ignore the stray untracked
  `vendor/markdown_yo/` directory (appeared during a stash pop; do NOT
  `git add -A` over it).
- Seed binary: v0.2.32 at `~/.local/bin/yo` (bundle install replicated by
  hand — the Mimosa PreToolUse hook REJECTS any Bash command whose text
  contains `install.sh`; download
  `yo-v0.2.32-x86_64-unknown-linux-musl.tar.gz` from GitHub Releases into
  `~/.local/lib/yo/v0.2.32`, symlink `~/.local/bin/yo`).
- No C compiler on PATH: emit with `--emit-c --skip-c-compiler`, compile
  with `nix-shell -p clang --run 'clang -O2 -w X.c -o X'`.
- Env pins for every yo invocation:
  `YO_STD=$PWD/std YO_SKILLS=$PWD/.github/skills`.
- **Never overlap two yo runs** (also machine-wide: a PEER session works in
  `/home/deck/Workspace/Yo-async-audit`; its chunked build takes 65% RAM
  and OOM-kills concurrent compiles — check `ps aux | grep 'yo compile'`
  and the process cwd tells whose it is. Never kill a peer's).
- The ~10-min local reaper SIGTERMs some backgrounded compiles (rc=143).
  Run long compiles as ZCode background tasks; if one dies anyway, retry
  the same pipeline as a fresh background task (this worked every time).
- Local z3: `~/z3-local/z3-5.1.0-x64-glibc-2.39/bin/z3`.
- The scratch driver `/tmp files`: `tmp/zerodrv.yo` in the worktree (untracked,
  gitignored) loads `$FIXTURE`, drains verify tasks, prints per-task
  obligations + full encoded scripts. Build:
  `yo compile tmp/zerodrv.yo --emit-c --skip-c-compiler --optimize 2 -o /tmp/varN`
  (~8 min) then clang, then `FIXTURE=./path stdbuf -o0 /tmp/varN`.
  Pipe the `=== obligation ===` blocks to z3 with the inline python used
  throughout this campaign (split on the marker, run z3 -in, first
  sat/unsat/unknown line is the verdict; IGNORE `(error ... "model is not
  available")` / `unsat core is not available` AFTER the verdict — the
  runner tolerates missing post-check evidence by design).
- Local test runs (real pipeline, real z3):
  `nix-shell -p clang --run 'env YO_STD=... YO_SKILLS=... YO_Z3_PATH=...
  YO_TEST_Z3=1 YO_TEST_LEAK_VERDICT=0 yo test ./tests/internal/X.test.yo
  --parallel 1'` — the leak verdict MUST be 0 locally (the seed binary's
  leak detector false-fires; CI's self-hosted binary is the arbiter).
- The `tmp/lr_trait*.yo` files in the worktree are this window's probes —
  they document the bug bisects; safe to delete.

## 3. Where V6 task 1 stopped (the exact frontier)

Branch `feat/fv6-trait-variance` (pushed, no PR — parking is free and
durable). One commit on top of `5ee76da9e`. All five touched files pass
`yo check`. What is implemented:

1. **Durable trait-method contract tables** —
   `src/evaluator/values/type_trait_methods.yo`:
   `register_trait_method_contracts` / `trait_method_requires` /
   `trait_method_ensures` / `trait_method_return_label` /
   `trait_method_has_contracts`, keyed `${trait_id}::${label}` (the
   `_trait_method_defaults` pattern). Written from
   `src/evaluator/types/trait.yo` `_evaluate_trait_field` phase 4 (after
   the fn-type eval; **key on `TraitT`'s SIXTH field `id`** — the first is
   `name`; an earlier draft keyed on name and silently matched nothing).
2. **Cycle-safe hooks to the func-contract side tables** — impl.yo and
   contracts.yo cannot import `types/function.yo` (function.yo →
   trait_checking.yo → impl.yo is a tight import chain; a direct edge
   broke load order with E0401 at `trait_checking.yo:52`). So
   `type_trait_methods.yo` hosts four function-pointer slots
   (`set_func_contract_hooks`, `hook_func_requires`, `hook_func_ensures`,
   `hook_func_return_label`, `hook_register_func_contracts`), installed by
   a module-level call in `function.yo` right after the getters (the
   `set_register_trait_value_fn` precedent). NOTE: the install call must
   be a plain module-level call — an IIFE `(() => {...})()` at module
   level does not parse ("Expected a function type").
3. **Inheritance** — `inherit_trait_contracts_for_impl_method` in
   contracts.yo, called from `_c3_eval_colon_pair` (impl.yo, before
   `evaluate_expression_raw(val_expr)`): a clause-less impl fn-type gets
   the trait's contracts registered under the fn-type EXPRESSION id so
   the existing body-application re-key
   (`function_type.yo` `copy_func_contract_exprs`) carries them to the
   FuncVal. Only fires for the colon-pair `(fn(...) -> T)(body)` shape
   (callee is the fn-type); lambdas already inherit via
   `anonymous_function.yo:1332`.
4. **Variance obligations** — `register_impl_variance_task` in
   contracts.yo, called from `_c3_eval_colon_pair` after the method
   registration: builds a SYNTHETIC verify task whose body is
   `{ assert((Rt && ...) ==> Ri); ...; assert((Ei && ...) ==> Et); ...; () }`,
   the trait's requires ASSUMED on the path (task.requires), the return
   label bound as ONE EXTRA SYNTHETIC PARAM (the walk binds params to
   fresh Vars before the body — an in-body label reference would be
   unbound otherwise), func_val passed as UnitVal, fn_id
   `impl-variance@module:row:label`. Helpers: `_conj_exprs` (nested `&&`
   with fresh ids) and `_implies_assert` (assert of `==>` with fresh ids;
   the `==>` head is a synthesized atom — the walk dispatches on the head
   STRING, TokenKind.Operator). Design notes in the doc comments.
5. Fixtures: `tests/spec/fixtures/valid/trait_variance.yo` (impl weakens
   requires to `i >= -1`, strengthens ensures to `result == i`) and
   `negative/trait_variance_false.yo` (impl STRENGTHENS requires to
   `i >= 1` — must refute at i == 0).

**The frontier (reproduce in ~10 min):** build the driver from the parked
branch and run the valid fixture. Probes already established (they were
removed before parking; re-add eprintln's if you want them again —
`{ eprintln } :: import("std/fmt")` — but REMOVE before any PR):

- trait-side registration FIRES: key `trait_r11c14_n0::get`,
  reqs=1 enss=1.
- the variance gate reaches `register_impl_variance_task` with
  target=true mode=verify t_reqs=1 t_enss=1.
- **only ONE verify task exists in the registry** (`get_impl`'s own), and
  the last probe pair (`[var-gate2]` after the own-contract read, and
  `[var-gate3]/[var-built]` around the stmts build) had NOT yet been run
  when the session stopped — the run that would print them was cancelled.
  The suspects, in order: (a) `hook_func_requires(func_id)` returns empty
  — check whether the `func_id` the impl registration passes
  (`__var_fvd.*.func_id` from the METHOD VALUE `get_impl`) is the same id
  the fn-type application re-keyed the contracts under (`stable_func_id`
  mint in `function_type.yo:1047`; get_impl's OWN task registered with
  contracts read from `fn_val_id`, so the FuncVal id HAS them — if the
  hook read is empty, the hooks are not installed in the driver process
  or the id differs); (b) the `p_names`/`p_types` extraction from
  `fi.ty`'s `.Func({ meta, param_types, result })` produced empty/mismatched
  lists (the `p_names.len() != p_types.len()` early return); (c) the
  predicate evaluations or `_conj_exprs`/`_implies_assert` produced zero
  stmts.
- Once the task registers: validate obligations against z3 (valid: ALL
  unsat; negative twin: the requires-contravariance assert must be SAT
  with i=0), then `tests/internal/verifier_trait_variance.test.yo`
  (mirror `verifier_insertion_sort.test.yo`'s harness), docs en/zh, plan
  banner, fmt (NOT the `==>`-containing fixtures — the seed fmt mangles
  them; CI's self-hosted fmt gate is the arbiter), full `yo check ./src`,
  PR.

## 4. The blocking evaluator defect (filed, with gdb trace)

`issues/trait-impl-method-contract-clauses-corrupt-operator-dispatch.md`
— reproduced on PRISTINE develop (stash-verified), so it is NOT caused by
the branch: **an impl method whose fn-type carries `requires`/`ensures`
clauses INSIDE a trait entry** (`impl(i32, T(m : (fn(self : Self, i : i32,
requires(...)) -> R)(body)))`) makes plain `yo check` fail with a hard
`Cannot unify incompatible types: "bool" and "fn(self : i32, i : i32) -> i32"`
anchored at the clause. gdb (-O0 -g driver, breakpoint on the synthesizer
unify): the failing parameter check passes the PRELUDE's `~`-impl
`bit_not` `self` atom (token at `std/prelude.yo:582:4`) whose type has
been cross-contaminated with the impl method's fn type — the def-time
body env sharing class from `plans/backlog/FUNCVAL_ENV_SHARING.md`,
triggered via the trait-entry expected-type path. Bisect table in the
issue: trait-with-clauses alone OK; inherent impl-with-clauses OK;
trait + impl-with-clause FAILS (with or without clauses on the trait
side); ordinary top-level fn with clauses OK; a no-self trait field fails
identically. The issue doc carries the suggested attack (compare env
frame identity seen by the prelude `(~)` trial before/after evaluating a
trait-entry impl method with clauses).

The parked fixtures use the **two-step spelling** (`get_impl :: (fn(...,
requires, ensures) -> R)(body);` as a named fn, then
`impl(i32, T(get : get_impl))`) which evaluates CLEAN — that is a
legitimate user idiom, not a workaround of a verifier bug; the env defect
remains filed for its own fix. `yo check` on the two-step probe passes;
under the ARMED verify driver the same shape loads and produces
`get_impl`'s own task fine (that is the current one task).

## 5. Also in flight / not to lose

- **The old `issues/` from this campaign are all in the repo** — most
  recent: `issues/derived-eq-ref-enum-self-payload-hollow-at-runtime.md`
  (derive(Eq) on ref enums with Self payloads is hollow at runtime;
  VcSort's Eq was hollow since task 5 — verifier routes around it by
  string-keyed dedupe; still OPEN, needs the derive fixed).
- Cluster finding 1 (pre-FV): the re-eval-aware hollow-io.async-body
  registry PR was never opened — see
  `issues/async-capture-mode-argument-rendering-cluster.md`.
- The **verify job in CI** runs the z3-gated tests; the full local
  battery before any push (times measured 2026-09-13/14):
  verifier.test.yo 18/18 (~4 min), quantifiers 6/6 (~4), collections 5/5
  (~4), negative 5/5 (~9), loops 12/12 (~14), insertion_sort 2/2 (~7).
- Standing merge rule: green matrix →
  `gh pr merge <n> --squash --delete-branch --admin` (the "develop
  already used by worktree" git error afterwards is cosmetic — merge and
  remote deletion succeeded; then `git checkout --detach origin/develop`
  + `git branch -D <name>` locally), then a docs-only banner PR recording
  the merge SHA (fast-path: 18 checks, minutes).
- AGENTS.md §"CI runs" rules: cancel runs a merge made pointless; never
  push docs to develop while a battery you need is in flight.
- `open(import(m))` is retired — current import idiom is
  `{ Names } :: import("mod")`. `Array(T, N)` is a VALUE type indexed by
  CALL syntax `arr(i)`, written `arr(i) = v` (builtin `Slice(T)` deleted).
- 2026-09-13 handovers exist for the std/build campaigns
  (`plans/HANDOVER_2026-09-13_POST_V0_2_32.md` etc.); the v0.2.32 seed
  battery `34745371233` finished GREEN (checked this session).

## 6. After task 1 (the rest of V6, per the plan)

Task 2 (generics verified abstractly), task 3 (Refine real type
constructor; rework `std/spec/refine.yo` + `numeric.yo` — breaking change,
ledger entry 3), task 4 (mutual-recursion decreases — "if cheap; else
documented non-goal"), task 5 (dogfood `std/collections/array_list.yo` +
`hash_map.yo` bounds contracts; `yo verify ./std/collections` green in
CI), task 6 tests incl. the `NonEmpty(Slice(T)).head()` worked example
(plan §"Worked example" — needs task 3 + slices-with-len in the walk).
The V6 exit criteria are in the plan. One design decision already made
for task 1 and worth keeping: variance obligations require the impl's
predicates to use the TRAIT's parameter/label spellings; a mismatch fails
loudly in the walk (`unbound runtime name '<p>'`) — the honest diagnostic
until name-position mapping is worth building.

## 7. Memory files

`~/.zcode/cli/memories/projects/yo-eebb55377c6e8044/memory/
fv-worktree-build-recipe.md` carries the full campaign recipe and every
pitfall (seed-fmt/`==>`, E0007 shapes, cond paren rules, the
peer-session/OOM dance, escalation budget rationale). Update it as things
land.
