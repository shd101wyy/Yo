# VALUES_BY_DEFAULT handover — 2026-10-10

**Status: ACTIVE handover (draft; finalized when v0.2.58 is published).**
- **Written:** 2026-10-10 by the agent that ran the campaign from 2026-10-08 through 2026-10-10. The maintainer's instruction was to land what is in flight, cut v0.2.58, stop, and hand over.
- **Who it is for:** an agent on another machine.
- **What it covers:** what landed since the 2026-10-07 handover (v0.2.55, v0.2.56, v0.2.57, and v0.2.58 once it ships), the branches in flight at hand-over time, the exact next steps in order, the open bugs, and the decisions recorded this cycle.
- **The authoritative design** is [`plans/VALUES_BY_DEFAULT.md`](../VALUES_BY_DEFAULT.md) (decisions 1–44, phases in §6). This document points into it and does not restate it. The previous handovers are [`VBD_HANDOVER_2026-10-07.md`](VBD_HANDOVER_2026-10-07.md) and [`VBD_HANDOVER_2026-10-06.md`](VBD_HANDOVER_2026-10-06.md). Their rules still apply unless §1 amends them.

Read in this order:
1. AGENTS.md;
2. this document;
3. `plans/VALUES_BY_DEFAULT.md`: §0, decisions 41–44 in §4, then §6 (V3b is the section that changed most);
4. the `.github/instructions/` file for the area you touch.

---

## 1. The standing goal and the maintainer's rules

The goal is unchanged: finish every phase in `plans/VALUES_BY_DEFAULT.md`. Rules added or confirmed 2026-10-08/10:

- **Delete the `imm`/`mut` mode words as early as possible.** Decision 42's `x : &T` / `x : &mut T` spelling replaces them. Generation B (§3, step 2) is the next piece of language work and comes before every later phase.
- **After Generation B, rewrite `plans/VALUES_BY_DEFAULT.md`, and the plans it links, in the final spelling only.** Drop every `imm`/`mut`/`inout`/`own` mention and the transitional "as built, Generation A" layers, and keep only the latest information. The maintainer finds the mixed spellings confusing.
- **Design calls are delegated.** Decide VBD questions yourself: strict, explicit and sound, as Rust would. Record each one in the plan as a numbered decision and prove it with tests. Ask only when a choice changes the user-visible language in a way the plan does not already imply.
- **Admin merges are allowed once the local gates pass** (maintainer directive for this campaign; it overrides AGENTS.md's "never `--admin`"). Develop's own battery must be green on the exact tip before a release is cut. Raise a red ratchet baseline (such as `scripts/bootstrap/memory-ratchet.tsv`) with a dated comment rather than disabling the gate. The compile-memory baseline was raised this cycle to `3317216` kB because the VBD migration is still under way.
- **At most 4 subagents at a time.** No Workflow-tool orchestration unless the maintainer asks for it.
- **Cut a patch release whenever a seed is needed.** Curate `## Changes` right after publishing (AGENTS.md's release-notes section). Never cancel a `Release` run.
- **No backward compatibility.** The seed gate (`SEED_VERSION`) is the only constraint.

## 2. Where everything stands

### 2.1 The releases

| Release | Published | What it carries |
| --- | --- | --- |
| v0.2.55 | 2026-10-08 17:39Z | FnOnce Gen A/B (#1266, #1273/#1274), the Box→Rc rename with the legacy Box deleted (#1267, #1273), decision 32's clash as E0616 and the Send/Sync bounds (#1268), the Copy sweep (#1269), and the derive-in-body fix (#1270) |
| v0.2.56 | 2026-10-09 11:52Z | The Copy flip (#1280), MoveOnly deleted (#1281), the snake_case builtins (#1283), the V3b parameter sweep with `yo fix --migrate params` (#1285), `yo fmt` on ```yo blocks (#1288), and std/imm deleted (#1289) |
| v0.2.57 | 2026-10-10 06:33Z | **The V3b flip (#1296).** Plain params are by value, storing APIs take values, static drop flags, immediate drop of an assignment's old value, step A (`&x` lends to an `imm` param, generic ones included), the `mut`/`sink` sweep; also #1295, #1292 (the `#`/`...#` operators deleted; `unquote(...)` only), #1290, #1291. **This is the current seed** (`SEED_VERSION`) |
| v0.2.58 | *pending at writing* | V3b step 3 (#1302), the escape-route fixes (#1293/#1294/#1298), and whichever in-flight branch of §2.3 lands before the cut. This document's final revision records the outcome |

### 2.2 Landed on develop after v0.2.57

| PR | What |
| --- | --- |
| #1302 | **V3b step 3.** `&x` is only a borrow marker; raw pointers are `addr_of(x)` (`yo fix --migrate addr-of`, semantic: it records each `&x` the evaluator treats as address-of). `inout`/`own` are deleted, with errors naming `mut`/`sink`. markdown_yo is bumped to ^0.0.14, the release that migrated its 181 `&x` sites |
| #1298 | A bare fn type cannot carry an opaque `Impl` (SIGBUS through `void*`). Calls through `Impl(Fn(..) -> R)` take `R` from the callee |
| #1297 | Decision 38 A escape-route audit: every route is pinned by a test. The implicit capture of a local borrow names the borrow and the capture list |
| #1293, #1294 | A cond/match tail of an `Impl(Fn)` result keeps the arms' closure type; a local fn value returning `Impl(Fn)` is typed with its concrete result (both were `void*` miscompiles found by the escape audit) |
| #1299, #1300, #1301, #1303 | Plans only: decisions 41 (RefCell), 42 (spelling), 43 (references as types), FnMut (decision 37 amended), 44 (Dyn); `NON_ESCAPABLE_TYPES.md`, `RUST_REFERENCE_PATTERNS.md` audit, `CODEGEN_PERFORMANCE.md` measured and activated |

### 2.3 In flight at hand-over time

Each branch is pushed. `~/Workspace/Yo-wt/<name>` is the worktree on the old machine; a new machine re-creates it from the branch.

| Branch | Worktree | State |
| --- | --- | --- |
| `feat/vbd-consuming-match` | `cmatch` | **Decision 26, the consuming `match`.** A by-value scrutinee moves; `match(&x, …)`/`match(&mut x, …)` borrow (`mut` place bindings write through); `yo fix --migrate match-scrutinee` (swept std 7, tests 1); exit drops for moved arm bindings. Rebased onto develop `ae78a6178`. Passed: build, check src/std, fmt, the CLI corpus, targeted tests, `gates_fast`, `fixpoint_only` (FIXPOINT_HOLDS). The full suite and `yo test ./std` were rerunning at writing. Filed on the branch: `issues/a-mut-match-place-binding-cannot-live-across-an-await.md` (S2) |
| `feat/vbd-decision42-gen-a` | `d42a` | **Decision 42 Generation A.** A parse-time rewrite (`desugar_if_calls`, `src/expr.yo`) makes `x : &T` / `x : &mut T` / `-> &T` / `y := &place` / `{ y : &y }` / `for(&mut xs, x => …)` exact synonyms of the mode-word forms. The printer, diagnostics, registry, docs, skills and context pack use the new spelling; `mut` is reserved; `yo fix --migrate borrow-spelling` is syntactic. std/src stay in the mode words (the v0.2.57 seed cannot parse `&T`). **Its plan entry still holds two placeholders** (`COUNTS_PLACEHOLDER`, `GATES_PLACEHOLDER` in `plans/VALUES_BY_DEFAULT.md`); fill them before merging. Base: the old step-3 branch, so restack with `git rebase --onto origin/develop <old-step3-tip>` |
| `feat/vbd-v3b-marker-sweep` | `markers` | **The call-site marker sweep plus E0914** (decision 33's bare-argument error, behind `YO_STRICT_MARKERS` until the sweep is complete). `yo fix --migrate markers`; the io builtins read their arguments through markers (an `io.await(&f)` ICE fixed). Docs part 1 and the CLI goldens are done; the full suite was rerunning. Same old base: restack the same way |

If a branch is not merged by the time you read this, finish its gates and land it first. The consuming match and the marker sweep merge whenever they are green; they do not gate a release.

## 3. The next steps, in order

1. **Install the newest seed** (`bash scripts/install.sh`; check `yo --version`). Generation B below needs the release that carries decision 42 Generation A (v0.2.58, or the next one if Gen A missed the cut).
2. **Decision 42 Generation B: delete `imm`/`mut`.** The plan's "Generation B" list under decision 42's as-built entry is the checklist:
   1. Run `yo fix ./std ./src ./tests --migrate borrow-spelling`. Then do by hand the mode words in comments and doc comments, the code strings the compiler synthesizes (`src/codegen/functions/collection.yo`), and the prelude `for` macro's templates.
   2. Delete the old spelling: a source-level `imm(` / `mut(` / `inout(` in a slot becomes an error naming the sigil and the tool. Make the internal desugar heads unspellable (`__yo_imm`/`__yo_mut`), or replace them with decision 43's reference type. Remove `modern_borrow_spelling` and the formatter's acceptance of the old forms. Keep `mut` reserved and free `imm`.
   3. Re-record goldens and update docs (en + zh), skills and instruction files. Run the full gates (§5) and land.
   4. The consuming bare `for(xs, …)` rides decision 26's sweep: a source used after the loop becomes `for(&xs, …)` first.
3. **Optionally cut a patch release** so the next phase's seed has no mode words.
4. **Rewrite `plans/VALUES_BY_DEFAULT.md` and the plans it links in the final spelling** (§1). Remove the transitional layers and keep only decisions and current status. Do this before starting a later phase, so that agents read one spelling.
5. **The later phases** (plan §6), in this order unless a phase's prerequisites say otherwise:
   1. **V3, async (§3.13):** A1/A2/A4/A6. A3's `async-handle-gena` branch is noted in §3.13.
   2. **V1 step 2:** the unique `Box`, explicit-copy from its first commit. **V3's std half** follows: resources become move-only values whose cells are the unique `Box`.
   3. **V2b:** projections, unique buffers, and the explicit-copy kind for `String`, the collections and `Dyn`. Test both the allowed parameter-yield case and the rejected local-yield case. `CODEGEN_PERFORMANCE.md` items 3–5 are levers to adopt here. **V2c:** decision 17's explicit `Rc`/`Arc` clones, with decision 27's lint landing with the first clone sweep.
   4. **Decision 41, `RefCell(T)`:** strict exclusivity only. Gen A runs the census and keeps the runtime assert for case (c); Gen B sweeps and turns on the error. `ref(struct)` keeps its entry assert until V5.
   5. **Decision 43, references as second-class types, plus `FnMut`** (`Fn <: FnMut <: FnOnce`). This is its own phase after decision 42's Gen B and V2b. Its sizing notes include prelude blanket operator impls over references and the per-value borrow-set tracker for root-joining containers. `plans/backlog/NON_ESCAPABLE_TYPES.md` N0–N3 ride it: closures may capture `&`/`&mut` and are second-class, and only escaping or a cell is E0909.
   6. **Decision 44:** `&Dyn(Trait)` is the borrowed trait object, landing with decision 43. `Dyn` stays the owned boxed form; an `Rc(Dyn)` single allocation is a later codegen lever.
   7. **V4** (the compiler's own trees). Do `CODEGEN_PERFORMANCE.md` CP2e first, collector tracking by construction-time acyclicity, because V4 multiplies `Rc` traffic.
   8. **V5:** remove `ref(...)`/`atomic(...)`. Delete the `sink` keyword here, once nothing needs a by-value marker beyond the plain parameter.

## 4. Open bugs to know about

Filed this cycle and still open:

| Issue | Severity | Note |
| --- | --- | --- |
| `issues/an-io-async-body-disposes-a-captured-move-only-value-twice.md` | S1 | Async state machine double dispose; repro inside |
| `issues/a-generic-function-bound-with-colon-equals-is-called-through-an-undeclared-symbol.md` | S2 | |
| `issues/a-named-closure-bound-to-an-impl-fn-annotation-keeps-its-own-signature.md` | S2 | Found by the escape-route audit |
| `issues/dyn-of-a-named-function-value-emits-invalid-c.md` | S2 | Found by the escape-route audit |
| `issues/a-macro-that-duplicates-an-fnonce-call-calls-it-twice.md` | S2 | From FnOnce Gen A's review |
| `issues/a-generic-derive-cannot-clone-a-field-whose-type-is-a-generic-container-of-its-parameter.md` | S2 | |
| `issues/a-mut-match-place-binding-cannot-live-across-an-await.md` | S2 | On `feat/vbd-consuming-match` until it lands |
| `issues/the-wrapper-payload-clash-is-not-reported-inside-a-generic-body.md` | S3 | Decision 32 gap |
| `issues/derive-clone-costs-17-ms-per-type.md` | S3 | Compile time |
| `issues/tests-declared-under-src-are-never-run-by-ci.md` | S3 | |

Older VBD-relevant S1s still open: `issues/a-borrowing-future-can-carry-an-imm-borrow-across-an-rc-deref-with-no-mark.md` (V3 async), `issues/an-assignments-old-value-save-reads-uninitialized-memory-for-pod-types.md`, and `issues/a-write-through-a-string-copy-is-lost-when-the-string-was-empty.md`. `issues/collection-iterators-have-no-sound-post-v2b-shape.md` is input to V2b (decision 39). For the full categorized list, run `python scripts/gen-issue-triage.py` locally; the generated `issues/TRIAGE.md` is untracked.

## 5. How to work in this repository (portable)

The previous handovers' §5 still applies. The local gates every VBD PR passed this cycle, in order:

1. `yo build --std-path ./std` (build with the seed; `--std-path` is load-bearing).
2. `$B check ./src --std-path ./std` and `$B check ./std --std-path ./std`, with `B=yo-out/<target>/bin/yo`.
3. `$B fmt --check` over the repo. Always use the tree-built binary, never the seed.
4. The CLI corpus with the in-tree binary path: `YO_SELF_BIN=$PWD/yo-out/<target>/bin/yo bash scripts/cli-diff-test.sh`. A copied binary lacks the bundled skills and fakes golden diffs. Re-record with `--record <cases>` when a cheatsheet or skill hash moves.
5. `S1=$B P=<unique> bash scripts/bootstrap/gates_fast.sh` and `fixpoint_only.sh`. Use a distinct `P` per branch: the scripts write `/tmp/${P}_*`.
6. The full suite: `$B test ./tests --exclude tests/internal --exclude tests/cli-cases` (~5,050 tests, ~30 min on an M4).
7. `$B test ./std`.
8. The `tests/internal/` files the change touches, one file at a time (`parser`, `formatter`, `diagnostics_registry_examples` and `typeof` are the usual ones for a syntax change).

Traps from this cycle:

- **The seed gate decides the order of every syntax change.** New syntax in std/src must be parseable by `SEED_VERSION`. That is why Gen A only accepts `&T` and Gen B sweeps.
- **A branch based on another branch that was squash-merged** restacks with `git rebase --onto origin/develop <old-parent-tip> <branch>`. A plain rebase replays the parent's commits and conflicts.
- **Rebases conflict in `src/main.yo`'s migrate options**, the instruction cheatsheets, and the skill-tree golden hashes. Take the union of options, keep both cheatsheet rows, and re-record the goldens.
- **A worktree needs its `vendor/` submodules** (`git -c protocol.file.allow=always submodule update --init`). A missing mimalloc produced a false CLI diff once.
- **Agents die on API rate limits.** Resume them with SendMessage, and have them commit and push before every heavy step so nothing is lost.

## 6. Decisions recorded this cycle

All are in `plans/VALUES_BY_DEFAULT.md` §4:

- **41 (RefCell):** strict exclusivity only. `RefCell(T)` gets `with`/`with_mut` closures and `get`/`get_mut` projections, expression-scoped. The collector predicate stays "reaches an Rc".
- **42 (spelling):** `x : &T` / `x : &mut T`, `self : &Self`, `-> &T`, `Fn(v : &T)`, `y := &place`, `cur = &mut place`, `{ y : &y }`, `for(&mut xs, x => …)`. A plain `for` consumes. `imm` and `mut(` are deleted in Gen B, and `mut` stays reserved.
- **43 (references as types):** `&T`/`&mut T` are second-class types with elided lifetimes. Root-joining containers use a per-value borrow-set tracker, a `&mut` reached through `&` is read-only, and auto-borrow applies to `&Self` receivers only. **FnMut** is added (decision 37 amended).
- **44 (Dyn):** `Dyn` stays the owned boxed form and `&Dyn(Trait)` borrows. No DST, no `?Sized`.
- **`str`** is first-class and never takes `&`.

Still parked: the plan's §9 items and the previous handover's open item on binding a projection result as a local borrow. Resolve that one before V2b.

## 7. Machine-specific notes (ignore on a new machine)

The campaign box was a Mac Mini (M4, macOS, `aarch64-apple-darwin`). Worktrees live under `~/Workspace/Yo-wt/`. `~/Workspace/Yo-wt/stack-seed/yo` was a stand-in seed built from the step-3 stack for agents that needed `addr_of` before v0.2.57's successor existed; with v0.2.58 out, use the released seed. The macOS footprint noise floor is ~180 MB, so memory claims need the Linux ratchet.
