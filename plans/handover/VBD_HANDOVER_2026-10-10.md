# VALUES_BY_DEFAULT handover — 2026-10-10

**Status: SUPERSEDED by [`VBD_HANDOVER_2026-10-13.md`](VBD_HANDOVER_2026-10-13.md); this was current as of 2026-10-11 after v0.2.59.** The cycle's goal is done: decision 42 Generation B deleted `imm`/`mut` and shipped in v0.2.59, which is the seed. The marker sweep part 2, the always-on E0914 (§3 step 1.i and 1.iii) and the markdown_yo v0.0.16 bump (§3 step 1.ii) all landed on `feat/vbd-marker-sweep-part2`. Verify each branch with `git log origin/<branch>` and `gh pr list` before acting on it.
- **Written:** 2026-10-10 by the agent that ran the campaign from 2026-10-08 through 2026-10-10. The maintainer's instruction (amended 2026-10-10): land what is in flight, cut v0.2.58, finish decision 42 Generation B (deleting `imm`/`mut`) and cut v0.2.59, then stop. All of that is done (§2).
- **Who it is for:** an agent on another machine.
- **What it covers:** what landed since the 2026-10-07 handover (v0.2.55 through v0.2.59), the branches in flight at hand-over time, the exact next steps in order, the open bugs, and the decisions recorded this cycle.
- **The authoritative design** is [`plans/VALUES_BY_DEFAULT.md`](../VALUES_BY_DEFAULT.md) (decisions 1–44, phases in §6). This document points into it and does not restate it. The previous handovers are [`VBD_HANDOVER_2026-10-07.md`](VBD_HANDOVER_2026-10-07.md) and [`VBD_HANDOVER_2026-10-06.md`](VBD_HANDOVER_2026-10-06.md). Their rules still apply unless §1 amends them.

Read in this order:
1. AGENTS.md;
2. this document;
3. `plans/VALUES_BY_DEFAULT.md`: §0, decisions 41–44 in §4, then §6 (V3b is the section that changed most);
4. the `.github/instructions/` file for the area you touch.

---

## 1. The standing goal and the maintainer's rules

The goal is unchanged: finish every phase in `plans/VALUES_BY_DEFAULT.md`. Rules added or confirmed 2026-10-08/10:

- **Done this cycle:** the `imm`/`mut` mode words are deleted (decision 42 Generation B, #1310) and `plans/VALUES_BY_DEFAULT.md` states only the final spelling (#1313). Keep it that way: a plan rewritten after a spelling change shows only the current spelling, never "then spelled" history or deleted-form tables.
- **Effect records and `Copy` values go by value**: `io : Io`, `exn : Exception`, `e : IoExn`, never `&` (#1312, `.github/instructions/yo-syntax.instructions.md`).
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
| v0.2.59 | **published 2026-10-11 08:48Z** (Release run 38120255733; tag on `952f24333`; develop's SEED_VERSION auto-bumped in `1e98da947`) | Decision 42 Generation B (#1310): mode words deleted (E0009), operator traits by value, `markdown_yo` ^0.0.15; effect records by value (#1312); call-site markers part 1 (#1309); the plan in final spelling (#1313). **The current seed** |

### 2.2 Landed after v0.2.58

| PR | What |
| --- | --- |
| #1310 | **Decision 42 Generation B** (`4ace3e657`): the tree in `x : &T` / `&mut T`; the mode words are E0009 naming the sigil form; arithmetic, bitwise and unary operator traits take operands by value (decision 34 amended; `Eq`/`Ord` borrow); a by-value `self` through a `Dyn` gets a payload copy (S1 fixed), with E0614 for move-only payloads; `markdown_yo` ^0.0.15 |
| #1312 | Effect records by value (`bc78989a7`): 784 `&Exception`/`&IoExn` sites became `Exception`/`IoExn` |
| #1309 | **Call-site markers part 1** (`8fe07cf9d`): `yo fix --migrate markers` (semantic); E0914 for a bare named place passed to a `&T`/`&mut T` parameter, on only under `YO_STRICT_MARKERS=1` outside std; the `io.await(&f)` ICE (S1) and two S2s fixed |
| #1313 | `plans/VALUES_BY_DEFAULT.md` in the final spelling only (`78e4f77ce`) |
| #1314 | **`Index` takes its index by value** (`52f79618f`, after v0.2.59): `index : (fn(self : &mut Self, idx : Idx) -> *Self.Output)`; the index-trait dispatch runs the normal by-value argument rule so an RC key is shared at the call site. The `Index`/`IndexMut` receiver split waits for decision 24 (V2b) |

### 2.3 Landed between v0.2.57 and v0.2.58

| PR | What |
| --- | --- |
| #1307 | Plans only: `plans/backlog/LIFETIME_REPLACEMENT_PATTERNS.md`, the inventory of every mechanism that covers a lifetime's three jobs (express/store/verify), the selection table and the four-item boundary; review fixed two section references (squash `577ed8110`, admin-merged with the maintainer's OK) |
| #1308 | **Decision 42 Generation A** (squash `8220b17e4`; pre-squash head `ae0651384`, whose last code commit is `e4a606982` = the pre-rebase `6549e5d83`). `x : &T` / `&mut T` / `-> &T` / `{ y : &y }` / `for(&mut xs, …)` parse everywhere as exact synonyms of the mode words (parse-time rewrite in `desugar_if_calls`); printer, diagnostics, docs and skills in the new spelling; `mut` reserved; `yo fix --migrate borrow-spelling`. Also fixed develop's red musl leg (the stack-sizing probe heredoc still said `inout(x)`). Local gates: suite 5,076/5,076, FIXPOINT_HOLDS, CLI corpus 0 diffs. Admin-merged with the maintainer's explicit OK |
| #1306 | Plans only: decision 44 follow-ups in `plans/VALUES_BY_DEFAULT.md` and `plans/backlog/RUST_REFERENCE_PATTERNS.md` (merged on its green CI) |
| #1305 | **Decision 26, the consuming `match`.** A by-value scrutinee moves; `match(&x, …)`/`match(&mut x, …)` borrow (`mut` place bindings write through); `yo fix --migrate match-scrutinee` (swept std 7, tests 1); exit drops for moved arm bindings; a value moved before `continue`/`break` is no longer dropped again. Filed: `issues/fixed/a-mut-match-place-binding-cannot-live-across-an-await.md` (S2) |
| #1302 | **V3b step 3.** `&x` is only a borrow marker; raw pointers are `addr_of(x)` (`yo fix --migrate addr-of`, semantic: it records each `&x` the evaluator treats as address-of). `inout`/`own` are deleted, with errors naming `mut`/`sink`. markdown_yo is bumped to ^0.0.14, the release that migrated its 181 `&x` sites |
| #1298 | A bare fn type cannot carry an opaque `Impl` (SIGBUS through `void*`). Calls through `Impl(Fn(..) -> R)` take `R` from the callee |
| #1297 | Decision 38 A escape-route audit: every route is pinned by a test. The implicit capture of a local borrow names the borrow and the capture list |
| #1293, #1294 | A cond/match tail of an `Impl(Fn)` result keeps the arms' closure type; a local fn value returning `Impl(Fn)` is typed with its concrete result (both were `void*` miscompiles found by the escape audit) |
| #1299, #1300, #1301, #1303 | Plans only: decisions 41 (RefCell), 42 (spelling), 43 (references as types), FnMut (decision 37 amended), 44 (Dyn); `NON_ESCAPABLE_TYPES.md`, `RUST_REFERENCE_PATTERNS.md` audit, `CODEGEN_PERFORMANCE.md` measured and activated |

### 2.4 In flight

| Branch | State | What is left |
| --- | --- | --- |
| `feat/vbd-marker-sweep-part2` (pushed; supersedes `feat/vbd-v3b-marker-sweep-trial`, which predates Gen B and stays in the old spelling — delete it) | Marker sweep part 2 done on develop (2026-10-11): `yo fix --migrate markers` over std/src/tests (incl. `tests/spec`, `tests/internal`, `tests/codegen-bootstrap`), the CLI fixtures (34 cases' `expected_tree` re-recorded; stdout/rc byte-identical) and the docs' ```yo fences; plus E0914 always on (`YO_STRICT_MARKERS` deleted, registry text and docs updated, E0914's `_bad_exempt` dropped) | Land the PR; the full battery (fixpoint, suite, corpus) is its verdict |
| `markdown_yo` | **Done** (2026-10-11): v0.0.16 published (https://github.com/shd101wyy/markdown_yo/releases/tag/v0.0.16, commit `84e1e2ae7af8`), and `yo.toml`/`yo.lock` on `feat/vbd-marker-sweep-part2` pin `^0.0.16` (`yo install` + `yo install --locked` both resolve clean). The ordering hazard below is resolved: `render_html.yo` now imports the migrated release | Nothing — the stale local branch `~/Workspace/Yo-wt/markdown_yo-markers` can be deleted |

## 3. The next steps, in order

0. **Install the newest seed** (`bash scripts/install.sh`; `yo --version` must say 0.2.59 or later).
1. **Marker sweep part 2, then E0914 always on.**
   1. On a fresh branch off develop, run `yo fix ./std ./src ./tests --migrate markers` (also `tests/internal`, `tests/codegen-bootstrap`, the CLI fixtures and the docs' ```yo blocks). Do not run it over files holding deliberate E0914 probes; check `git diff` for any rewritten `comptime_expect_error` body. **Done 2026-10-11 on `feat/vbd-marker-sweep-part2`** (the tree sweep, the fixtures with re-recorded `expected_tree` goldens, and the docs' fences; the migrate tool's one designed skip — the `quote(...)` place at `tests/derive.test.yo:268` — was lent by hand (`&other.(…)`) after the review showed always-on E0914 failing that file 63/63, and the same audit fixed the one other argument-passing derive template, `std/encoding/json.yo`'s `__derive_from_json` (`from_json(&__djf_j)`), whose generated call also passed a binding bare to `v : &JsonValue`; both files pass under the branch's own binary, which has E0914 unconditional). The sweep also inserted markers inside 36 `comptime_expect_error` ARGUMENTS across parameter_modes/closure_capture_list/dyn/move_only/fn_once — evaluation reaches those arguments, and the insertions are what keeps each probe firing its INTENDED error instead of E0914 under the always-on rule (expected-message strings unchanged; 35/35, 39/39, 38/38, 23/23 pass, dyn 32/3 with 3 pre-existing ASan leaks), so they stay.
   2. Do the same for `markdown_yo` and release it (pre-authorized), then bump `yo.toml`. **Done 2026-10-11**: v0.0.16 released and pinned `^0.0.16` on the same branch (§2.4).
   3. Delete `YO_STRICT_MARKERS` so E0914 is always on, and drop E0914's exemption in `tests/internal/diagnostics_registry_examples.test.yo` (`_bad_exempt`). **Done 2026-10-11 on the same branch**: the knob and the outside-std condition are gone from `check_call_site_borrow_marker`, the registry's knob sentence is deleted (en + zh), the docs/instructions/cheatsheets describe the always-on rule, and both probe cli-cases' `opts` no longer set the env (their stdout/rc goldens pin unchanged text — `explain-list` pins only E0914's title, the probe case pins the diagnostic message, neither contained the knob sentence).
   4. A std/src edit that adds markers needs a seed that accepts them. v0.2.59 does, so this can land directly.
2. **The later phases** (plan §6), in this order unless a phase's prerequisites say otherwise:
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
| `issues/fixed/an-io-async-body-disposes-a-captured-move-only-value-twice.md` | S1 | Async state machine double dispose; repro inside |
| `issues/a-generic-function-bound-with-colon-equals-is-called-through-an-undeclared-symbol.md` | S2 | |
| `issues/a-named-closure-bound-to-an-impl-fn-annotation-keeps-its-own-signature.md` | S2 | Found by the escape-route audit |
| `issues/fixed/dyn-of-a-named-function-value-emits-invalid-c.md` | S2 | Found by the escape-route audit |
| `issues/a-macro-that-duplicates-an-fnonce-call-calls-it-twice.md` | S2 | From FnOnce Gen A's review |
| `issues/fixed/a-generic-derive-cannot-clone-a-field-whose-type-is-a-generic-container-of-its-parameter.md` | S2 | |
| `issues/fixed/a-mut-match-place-binding-cannot-live-across-an-await.md` | S2 | From the consuming match (#1305) |
| `issues/the-wrapper-payload-clash-is-not-reported-inside-a-generic-body.md` | S3 | Decision 32 gap |
| `issues/derive-clone-costs-17-ms-per-type.md` | S3 | Compile time |
| `issues/tests-declared-under-src-are-never-run-by-ci.md` | S3 | |
| `issues/a-closure-parameter-written-as-a-call-is-accepted-under-the-expected-label.md` | S3 | Filed during Gen B |

Older VBD-relevant S1s still open: `issues/fixed/a-borrowing-future-can-carry-an-imm-borrow-across-an-rc-deref-with-no-mark.md` (V3 async), `issues/fixed/an-assignments-old-value-save-reads-uninitialized-memory-for-pod-types.md`, and `issues/a-write-through-a-string-copy-is-lost-when-the-string-was-empty.md`. `issues/collection-iterators-have-no-sound-post-v2b-shape.md` is input to V2b (decision 39). For the full categorized list, run `python scripts/gen-issue-triage.py` locally; the generated `issues/TRIAGE.md` is untracked.

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
- **A whole-file respelling script also rewrites text that quotes an old form on purpose** (E0009's registry example, the migrate tools' docs). When respelling during a rebase, touch only lines absent from `origin/develop`.
- **Agents die on API rate limits.** Resume them with SendMessage, and have them commit and push before every heavy step so nothing is lost.

## 6. Decisions recorded this cycle

All are in `plans/VALUES_BY_DEFAULT.md` §4:

- **41 (RefCell):** strict exclusivity only. `RefCell(T)` gets `with`/`with_mut` closures and `get`/`get_mut` projections, expression-scoped. The collector predicate stays "reaches an Rc".
- **42 (spelling):** `x : &T` / `x : &mut T`, `self : &Self`, `-> &T`, `Fn(v : &T)`, `y := &place`, `cur = &mut place`, `{ y : &y }`, `for(&mut xs, x => …)`. A plain `for` consumes. `imm` and `mut(` are deleted in Gen B, and `mut` stays reserved.
- **43 (references as types):** `&T`/`&mut T` are second-class types with elided lifetimes. Root-joining containers use a per-value borrow-set tracker, a `&mut` reached through `&` is read-only, and auto-borrow applies to `&Self` receivers only. **FnMut** is added (decision 37 amended).
- **44 (Dyn):** `Dyn` stays the owned boxed form and `&Dyn(Trait)` borrows. No DST, no `?Sized`.
- **34 (amended 2026-10-11):** arithmetic, bitwise and unary operator traits take their operands by value; `Eq`/`Ord` borrow. `Index` takes its index by value (#1314).
- **`str`** is first-class and never takes `&`.

Still parked: the plan's §9 items and the previous handover's open item on binding a projection result as a local borrow. Resolve that one before V2b.

## 7. Machine-specific notes (ignore on a new machine)

The campaign box was a Mac Mini (M4, macOS, `aarch64-apple-darwin`). Worktrees live under `~/Workspace/Yo-wt/`. `~/Workspace/Yo-wt/stack-seed/yo` was a stand-in seed built from the step-3 stack for agents that needed `addr_of` before v0.2.57's successor existed; use the released seed. Session notes and gate scripts from the last stretch are in `~/Workspace/Yo-wt/notes/` (`v0259-changes.md` is the curated v0.2.59 body). The macOS footprint noise floor is ~180 MB, so memory claims need the Linux ratchet.
