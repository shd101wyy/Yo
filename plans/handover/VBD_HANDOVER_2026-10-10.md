# VALUES_BY_DEFAULT handover — 2026-10-10

**Status: ACTIVE handover, kept current as work lands (last update: 2026-10-11, v0.2.58 and markdown_yo v0.0.15 published; Gen B in final gates).** The maintainer's usage limit may stop the writing agent at any moment, so §2.3 and §3 always describe the latest state. Verify each branch's state with `git log origin/<branch>` and `gh pr list` before acting on it.
- **Written:** 2026-10-10 by the agent that ran the campaign from 2026-10-08 through 2026-10-10. The maintainer's instruction (amended 2026-10-10): land what is in flight, cut v0.2.58, finish decision 42 Generation B (deleting `imm`/`mut`) and cut v0.2.59, then stop.
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
- **Admin merges are allowed once the local gates pass** (maintainer directive for this campaign; it overrides AGENTS.md's "never `--admin`"). On 2026-10-10 Claude Code's auto-mode classifier refused `gh pr merge --admin`, so either get the maintainer's explicit OK in the session (on 2026-10-10 they gave a standing one: "I allow you to admin-merge any new open PRs and dispatch release for Yo and markdown_yo") or merge with plain `gh pr merge --squash --delete-branch` once `Merge gate (all checks)` is green. Develop's own battery must be green on the exact tip before a release is cut. Raise a red ratchet baseline (such as `scripts/bootstrap/memory-ratchet.tsv`) with a dated comment rather than disabling the gate. The compile-memory baseline was raised this cycle to `3317216` kB because the VBD migration is still under way.
- **Cut a patch release whenever a seed is needed.** Curate `## Changes` right after publishing (AGENTS.md's release-notes section). Never cancel a `Release` run.
- **No backward compatibility.** The seed gate (`SEED_VERSION`) is the only constraint.

## 2. Where everything stands

### 2.1 The releases

| Release | Published | What it carries |
| --- | --- | --- |
| v0.2.55 | 2026-10-08 17:39Z | FnOnce Gen A/B (#1266, #1273/#1274), the Box→Rc rename with the legacy Box deleted (#1267, #1273), decision 32's clash as E0616 and the Send/Sync bounds (#1268), the Copy sweep (#1269), and the derive-in-body fix (#1270) |
| v0.2.56 | 2026-10-09 11:52Z | The Copy flip (#1280), MoveOnly deleted (#1281), the snake_case builtins (#1283), the V3b parameter sweep with `yo fix --migrate params` (#1285), `yo fmt` on ```yo blocks (#1288), and std/imm deleted (#1289) |
| v0.2.57 | 2026-10-10 06:33Z | **The V3b flip (#1296).** Plain params are by value, storing APIs take values, static drop flags, immediate drop of an assignment's old value, step A (`&x` lends to an `imm` param, generic ones included), the `mut`/`sink` sweep; also #1295, #1292 (the `#`/`...#` operators deleted; `unquote(...)` only), #1290, #1291. **The current seed** (`SEED_VERSION`) |
| v0.2.58 | **published 2026-10-11** (Release run 38084246803; tag on `66c922be0`; develop's SEED_VERSION auto-bumped in `c026a2a5b`) | V3b step 3 (#1302), the escape-route fixes (#1293/#1294/#1298), the consuming match (#1305), decision 42 Generation A (#1308, merged), possibly the marker sweep part 1, and #1306 (plans, merged) |
| v0.2.59 | *planned* | Decision 42 Generation B: the mode words are deleted, and `markdown_yo` moves to ^0.0.15 |

### 2.2 Landed on develop after v0.2.57

| PR | What |
| --- | --- |
| #1307 | Plans only: `plans/backlog/LIFETIME_REPLACEMENT_PATTERNS.md`, the inventory of every mechanism that covers a lifetime's three jobs (express/store/verify), the selection table and the four-item boundary; review fixed two section references (squash `577ed8110`, admin-merged with the maintainer's OK) |
| #1308 | **Decision 42 Generation A** (squash `8220b17e4`; pre-squash head `ae0651384`, whose last code commit is `e4a606982` = the pre-rebase `6549e5d83`). `x : &T` / `&mut T` / `-> &T` / `{ y : &y }` / `for(&mut xs, …)` parse everywhere as exact synonyms of the mode words (parse-time rewrite in `desugar_if_calls`); printer, diagnostics, docs and skills in the new spelling; `mut` reserved; `yo fix --migrate borrow-spelling`. Also fixed develop's red musl leg (the stack-sizing probe heredoc still said `inout(x)`). Local gates: suite 5,076/5,076, FIXPOINT_HOLDS, CLI corpus 0 diffs. Admin-merged with the maintainer's explicit OK |
| #1306 | Plans only: decision 44 follow-ups in `plans/VALUES_BY_DEFAULT.md` and `plans/backlog/RUST_REFERENCE_PATTERNS.md` (merged on its green CI) |
| #1305 | **Decision 26, the consuming `match`.** A by-value scrutinee moves; `match(&x, …)`/`match(&mut x, …)` borrow (`mut` place bindings write through); `yo fix --migrate match-scrutinee` (swept std 7, tests 1); exit drops for moved arm bindings; a value moved before `continue`/`break` is no longer dropped again. Filed: `issues/a-mut-match-place-binding-cannot-live-across-an-await.md` (S2) |
| #1302 | **V3b step 3.** `&x` is only a borrow marker; raw pointers are `addr_of(x)` (`yo fix --migrate addr-of`, semantic: it records each `&x` the evaluator treats as address-of). `inout`/`own` are deleted, with errors naming `mut`/`sink`. markdown_yo is bumped to ^0.0.14, the release that migrated its 181 `&x` sites |
| #1298 | A bare fn type cannot carry an opaque `Impl` (SIGBUS through `void*`). Calls through `Impl(Fn(..) -> R)` take `R` from the callee |
| #1297 | Decision 38 A escape-route audit: every route is pinned by a test. The implicit capture of a local borrow names the borrow and the capture list |
| #1293, #1294 | A cond/match tail of an `Impl(Fn)` result keeps the arms' closure type; a local fn value returning `Impl(Fn)` is typed with its concrete result (both were `void*` miscompiles found by the escape audit) |
| #1299, #1300, #1301, #1303 | Plans only: decisions 41 (RefCell), 42 (spelling), 43 (references as types), FnMut (decision 37 amended), 44 (Dyn); `NON_ESCAPABLE_TYPES.md`, `RUST_REFERENCE_PATTERNS.md` audit, `CODEGEN_PERFORMANCE.md` measured and activated |

### 2.3 In flight

Every branch is pushed. `~/Workspace/Yo-wt/<name>` is the worktree on the old machine; a new machine re-creates it from the branch.

| Branch | State | What is left |
| --- | --- | --- |
| `feat/vbd-v3b-marker-sweep` (draft **#1309**) | **The call-site marker sweep, part 1.** `yo fix --migrate markers` (semantic); E0914 (a bare argument to a borrowing parameter) is on only under `YO_STRICT_MARKERS=1` outside std. Fixes `issues/fixed/io-await-of-a-marked-future-is-an-internal-compiler-error.md` (S1), `issues/fixed/ast-place-text-renames-the-callee-of-an-element-place.md` (S2), and `issues/fixed/the-mutation-summary-reads-a-call-site-marker-as-an-unknown-call.md` (S2; this one is why part 2 needs the next seed). Gates on the old base were all green (suite 5031/5031, FIXPOINT_HOLDS) | Restacked onto develop (head `ace787e15`), with E0914's text and docs respelled in `&T`; opened as **draft #1309** with its CI cancelled so it cannot supersede the v0.2.58 battery. Gates on that head were re-running at the time of writing. Merge it after v0.2.58 is released (retarget nothing; `gh pr ready 1309`, let CI run, admin-merge per the standing OK), so it lands in v0.2.59 |
| `feat/vbd-v3b-marker-sweep-trial` | Part 2: the std/src marker sweep. Needs a seed carrying part 1 (v0.2.58), plus `markdown_yo` with its 25 markers | After v0.2.58 (§3 step 4) |
| `feat/vbd-decision42-gen-b` (draft **#1310**) | **Decision 42 Generation B.** The sweep over std/src/tests (plus 548 src and 44 tests sites the consuming match added); the mode-word spelling deleted with **E0009** naming the sigil; internal desugar heads renamed `__yo_imm`/`__yo_mut`; `modern_borrow_spelling` removed; `--migrate params` writes `x : &T`; `--migrate modes` keeps only `own` → `sink`. Validated locally with the stand-in seed `~/Workspace/Yo-wt/stack-seed/yo-d42a`, a Gen A build, because v0.2.57 cannot parse `&T`. It carries a commit labeled **`TEMP: markdown_yo path override until v0.0.15 is released`**. **Maintainer directive 2026-10-11, amending decision 34:** the arithmetic, bitwise and unary operator traits (`Add` … `BitRightShift`, `Negate`, `LogicalNot`, `BitNot` and their `Comptime*` twins) take their operands **by value**, `(+) : (fn(lhs : Self, rhs : Rhs) -> Self.Output)`, as in Rust. `Eq`/`Ord` keep `&Self`/`&Rhs`, like Rust's `PartialEq`/`PartialOrd`. **Done** at head `c62b48a6d`, along with the S1 it surfaced (a by-value `self` called through a `Dyn` freed the payload; fixed with a payload copy in the vtable wrapper, plus E0614 for move-only payloads). | **Draft #1310**, head `c62b48a6d`, CI cancelled. All gates pass on that head: check std 171/171 and src 278/278, fmt clean, `gates_fast` 0 failures, FIXPOINT_HOLDS, suite 5,081/5,081, std 7/7, and the 8 touched `tests/internal` files all rc 0. On the rebase onto develop, `tests/internal/types_compound.test.yo` conflicts with #1311; keep the branch's side. After v0.2.58: release `markdown_yo` v0.0.15, replace the TEMP commit with `version = "^0.0.15"`, rebuild with the v0.2.58 seed, merge, and cut v0.2.59 |

**`markdown_yo` needs a v0.0.15 before Gen B can merge.** v0.0.14 has 26 `imm(...)` parameters across 8 files, and the Gen B compiler rejects them. The migration exists as a local commit: `~/Workspace/Yo-wt/markdown_yo-addrof`, branch `migrate-borrow-spelling` (v0.0.14 plus the borrow-spelling sweep, 26 sites; `.yo-version` still says 0.2.55 and must become 0.2.58). The marker sweep's 25 markers are a second local commit at `~/Workspace/Yo-wt/markdown_yo-markers`, branch `migrate-markers`; they are needed only for marker part 2. Both can go into one release, but the release must come after v0.2.58, because an older Yo cannot parse `&T`. The maintainer authorized pushing to and releasing `markdown_yo` without asking (2026-10-10). On a new machine, redo the sweep with `yo fix <markdown_yo>/src --migrate borrow-spelling` using a compiler that has Gen A.

## 3. The next steps, in order

1. **Install the newest seed** (`bash scripts/install.sh`; check `yo --version`).
2. **Land what is still in flight for v0.2.58** (§2.3): #1306 is merged; decision 42 Gen A is merged (#1308, `8220b17e4`); #1307 (plans) merged right after it, so develop's battery run 38063766836 on `577ed8110` is the v0.2.58 gate (run 38063532638 on `8220b17e4` has identical code and gives an early signal). **That battery went red** in one place: `tests/internal/types_compound.test.yo` (shard 3) still expected `fn(imm(x) : i32) -> bool`, but Gen A's type printer writes `fn(x : &i32) -> bool`. It was the battery's only failing file. The fix, **#1311**, was admin-merged as `c9c87cd10` (verified 33/33 locally with the Gen A binary). Develop run 38073105300 on `c9c87cd10` went **green (56/56)**, and the code diff to the tip was empty, so **v0.2.58 was dispatched: Release run 38084246803 (never cancel it)**. The curated `## Changes` draft is in the session scratchpad (`v0258-changes.md`); if it is lost, rebuild it from the code PRs #1298, #1297, #1302, #1305 and #1308. **v0.2.58 is published** with the curated notes, and develop's `SEED_VERSION` is v0.2.58 (`c026a2a5b`). **markdown_yo:** `b9c07dc` ("pin Yo 0.2.58") was pushed to its master on top of the borrow-spelling commit `de716e8`; local build, `yo build test`, `yo test ./tests` and fmt all pass under v0.2.58. Its CI went green and **markdown_yo v0.0.15 is published** (Release run 38091645827, tag commit `d7e1fc3`). **Gen B (#1310)** was rebased onto `c026a2a5b` (types_compound conflict resolved with develop's comment; the sweep's `check_str(actual : &String, …)` edit kept) and pushed. The TEMP path-override commit is dropped and `yo.toml` says `version = "^0.0.15"` (head `8fade03eb`, lock on `d7e1fc3`). Built with the v0.2.58 seed (rc 0); the `--migrate borrow-spelling` dry run reports 0 for std and src, and the 38 left in tests are deliberate (E0009 probes inside `comptime_expect_error` in parameter_modes/closure_capture_list, plus the inputs of the migrate and E0009 CLI fixtures). #1310 is marked **ready** (its CI battery runs) and the full local gate chain (`chain28.sh`: check, fmt, CLI corpus, gates_fast, fixpoint, suite, std, 8 internal files) is running. When both are green: admin-merge #1310, then cut v0.2.59 (curated notes drafted in the session scratchpad `v0259-changes.md`; rebuild from #1310 and #1309 if lost). **VALUES_BY_DEFAULT.md in the final spelling** is done on branch `plans/vbd-final-spelling` (`5d8cc6b82`, stacked on Gen B, pushed, no PR yet): 182 old-spelling lines down to 89, every survivor a deleted-form/as-built record. After #1310 merges, rebase it onto develop and open it as a plans-only PR (not while a battery you wait on is in flight). **Markers (#1309)** was rebased onto develop (head `fc712d5d9`) and marked ready, so its full CI battery runs.
3. **Cut v0.2.58.** Wait for develop's battery to be green on the exact tip (`git diff --stat <battery-head>..origin/develop -- src/ std/ tests/ .github/ scripts/ build.yo` must be empty). Dispatch the release workflow, never cancel a `Release` run, curate the notes, and wait for the `SEED_VERSION` auto-bump commit.
4. **Decision 42 Generation B, then v0.2.59:**
   1. Release `markdown_yo` v0.0.15: the borrow-spelling commit, with the marker commit if part 2 is next, and `.yo-version` set to 0.2.58 (authorized; no need to ask).
   2. On `feat/vbd-decision42-gen-b`, drop the TEMP override commit and set `markdown_yo = { …, version = "^0.0.15" }` (then `yo update markdown_yo`).
   3. Restack onto develop. Rebuild with the v0.2.58 seed and re-run `yo fix ./std ./src ./tests --migrate borrow-spelling` for anything merged since; the dry run must report 0. Then run the full gates (§5) and merge.
   4. Cut v0.2.59.
   5. **Marker sweep part 2** (on the v0.2.58 seed or later): re-run `yo fix --migrate markers` over std, src, tests, `tests/internal`, `tests/codegen-bootstrap`, the CLI fixtures and the docs' code blocks; delete `YO_STRICT_MARKERS` so E0914 is always on; drop E0914's exemption in `diagnostics_registry_examples`.
5. **Rewrite `plans/VALUES_BY_DEFAULT.md` and the plans it links in the final spelling** (§1). Remove the transitional layers and keep only decisions and current status. Do this before starting a later phase, so that agents read one spelling.
6. **The later phases** (plan §6), in this order unless a phase's prerequisites say otherwise:
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
