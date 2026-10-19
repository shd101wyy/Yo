# VALUES_BY_DEFAULT handover — 2026-10-19

> **Status: LIVING (draft PR, updated as the session progresses; merge after v0.2.66 is cut).**
> The next agent starts AFTER v0.2.66 is out, on a DIFFERENT machine. Everything this cycle learned
> that is not derivable from the repo is in this document; it continues
> `plans/handover/VBD_HANDOVER_2026-10-17.md` (its §1 process rules, §7 release-notes format and
> §8 machine notes still apply; read it first). The plan itself is `plans/VALUES_BY_DEFAULT.md`.

## 0. Where to start

1. Read this document, then the 2026-10-17 handover, then AGENTS.md.
2. Confirm v0.2.66 is published: `gh release view v0.2.66`, `SEED_VERSION` bumped, release notes
   curated (§6 has the final state and anything left to check).
3. Your first actions are in §4.1 (land anything the release did not include) — the PENDING table in
   §2.2 is the exact list at the time of the last update.

## 1. The standing goal and this cycle's maintainer directives

The goal is unchanged: finish `plans/VALUES_BY_DEFAULT.md`. Directives given THIS cycle (2026-10-18/19)
that outlive it:

- **No agent-count cap.** "Spawn as many sub-agents as needed; the only limit is the heavy task lock
  (6 concurrent heavy tasks on the 64 GB box)." Batching worked extremely well: one agent per
  subsystem cluster, ONE PR PER ISSUE, report per PR, coordinator merges on Tier 1 + admin as each
  report lands. Agents that could not fix an issue honestly DISPOSITIONED it instead (corrected
  diagnosis, measured direction, docs-only PR) — three such cases are in §3, and forcing any of them
  would have been wrong.
- **CI sweep:** cancel every GitHub CI run except the develop battery the release needs (and the
  always-kept `Release`/`ubsan`/`fixpoint-arm64` runs). PR batteries are disposable — merges are
  Tier-1-gated and admin-merged; the develop battery scores combinations.
- **Releases of Yo AND markdown_yo are pre-authorized.** markdown_yo v0.0.19 was cut mid-cycle by an
  agent (one `{}` site at `src/inline/link.yo:658`; `()` is legal under every earlier compiler, so no
  seed-compat risk). Develop's manifest now requires `^0.0.19`.
- **Fix ALL S2/S3 issues found in the cycle, not just S1s.** This cycle: all 4 S1s fixed and merged;
  of the ~25 S2/S3 docs, all were fixed or honestly dispositioned (§2.2, §3).
- **`()` is the unit VALUE; `unit` is the TYPE.** Never `unit;`, never `();` as a statement — either
  end the block with `()` (no semicolon) or omit the tail; an empty arm is `()`; `{}` is an empty
  STRUCT value, rejected where unit is expected (#1473, S2; user-visible break, in the release notes).
  Recorded in `.github/instructions/yo-syntax.instructions.md` "Return value rules".
- **Status pings:** light pings to long-running agents every ~40 min keep prompt caches warm; a lost
  agent report costs a verifier pass (this cycle had one: the emptyrec original died post-push
  pre-PR; a continuation agent audited its logs, found real gaps, and finished correctly).

### 1.1 Process lessons that cost real time this cycle (do not repeat)

- **Gate every cleanup step on the merge's actual result.** Two incidents: (a) a batch `git push
  --delete` removed an OPEN PR's branch → auto-closed #1454; recovery was re-PR as #1462; (b) a `;`-
  chained `worktree remove` ran after a FAILED merge (the #1421 conflict) — the remote branch
  survived by luck. Rule: verify THAT PR's state is MERGED before deleting its branch; never chain
  cleanup into the merge command.
- **Long background tasks get SIGKILLed (exit 137) on this box's harness** — mid-run AND while merely
  queued in the heavy lock. Every long step must run detached: `setsid bash -c '...' > log 2>&1 &`
  with log polling. Three agents independently converged on this.
- **Diagnostic codes must be unique at merge time.** #1421 (decision 46's "write through a plain Rc")
  and #1469 (deref-of-borrow) both minted E0919 independently; the collision surfaced only at the
  merge. When adding an error code, grep the registry for it on CURRENT develop first.
- **The overlap rule + "no rebase after the final gate" as applied:** rebase onto current develop,
  intersect `git diff --name-only <old-base>..origin/develop -- src/ std/` with the branch's src/std
  files; empty → gates carry, merge as-is; non-empty → ONE focused pass (rebuild + checks + the
  affected-area tests), then the pass's green head merges AS-IS even if develop moved again —
  GitHub's mergeable flag decides whether one more pass is textually forced. With many parallel
  agents, expect 2-3 passes per big PR; do not spiral.
- **`gh pr merge` may EOF on its confirmation call while the merge itself lands** — re-check state
  before retrying anything.

## 2. Where everything stands

### 2.1 v0.2.66 (being cut as this document is updated)

- Base content: 42 merged PRs (§2.2). The release REQUIRES markdown_yo v0.0.19 (manifest `^0.0.19`).
- User-visible breaks to say in the notes: `{}` rejected where unit is expected (#1473); the gcc
  match-statement fix (#1447) is NOT a v0.2.65 regression (v0.2.64 emits identical C; clang-only
  `-Wno-everything` vs gcc's `-Werror=return-type`) — use that framing. **The notes must NOT claim
  #1476's closure-parameter fix — #1481 reverted it pre-release (see §2.2); its issue doc is in the
  known-issues list.**
- The cut sequence (AGENTS.md): cancel all runs but the newest develop battery; battery green on the
  exact tip; `git diff --stat <battery-head>..origin/develop -- src/ std/ tests/ .github/ scripts/
  build.yo` empty; dispatch `release.yml` with `bump=patch`; NEVER cancel a Release run; `bump=none`
  resumes an interrupted one (and then fix the draft's `target_commitish`); curate `## Changes` per
  the v0.2.38 format (the session's draft with the removal map lived at
  `~/Workspace/Yo-wt/vbd-logs/release-notes-v0.2.66-draft.md` — machine-local; rebuild from
  `gh api compare/v0.2.65...v0.2.66` if lost).
- Verify at the tag: diagnostic-code uniqueness (the E0919 collision), every known-issue path in the
  notes still open, `SEED_VERSION` bumped.

### 2.2 The merge ledger (v0.2.65 tag → v0.2.66)

Fixed and merged (S1): #1445 (overload-trial specialization drops a store), #1447 (gcc
statement-position match falls off the end), #1452 (index-call assignment evaluates the place once —
was a use-after-free), #1458 (an await's result resolves its binder through an `Impl(Future)`
parameter — all five variants).

Fixed and merged (S2/S3, one line each): #1434 async Mutex strict FIFO; #1436 writes into a `&T`
parameter's value are E0908; #1414 decision 47 globals Generation B (`mut(G)`, exemption gone);
#1421 decision 46 Generation B (write through plain `Rc` is E0919); #1422 in-place collection clones
(+ `Array(T, 0)` MaybeUninit C fix); #1450 IterPeekable conditional `Clone`; #1439 V4 `Pattern` with
`Box` children; #1453 fetch-timeout 8 KiB buffer; #1459 `comptime_expect_error` restores move marks
(3 S3s, one family); #1455 `emit_warning` dedupe leak; #1462 `spawn_blocking` joins its worker;
#1456 LinkedList move-only pop/clear; #1467 OrderedMap store-each-key-once; #1470
`_spawn_with_fds` env-walk guard; #1457 expect-error-rejected impl unregisters; #1465
duplicate-impl identity keys; #1466 conditional-`Copy` container field; #1468 projection-tail
borrow mask; #1471 `match(&xs(i))` in place; #1460 closure-typed field accepts no named fn; #1473
`{}` rejected where unit expected; #1430 multi-file `yo fix` impl coherence; #1463 compile-test leak
classes diagnosed → reference-hygiene umbrella.

Docs/process: #1446 (AGENTS.md gcc/clang + nix-clang recipe), #1448/#1449/#1451 (unit-value
corrections + the `{}` issue), #1461 (module-borrow-across-macro verified fixed by #1419), #1464
doc closures, #1472 + #1475 (honest not-fixed dispositions, §3).

**PENDING at the last update of this document** (update this table, then merge this PR):
| Piece | State |
| --- | --- |
| ~~develop RED~~ RESOLVED by **#1481** MERGED `736c564e9` | **#1476's scope-aware live-range scan was the sole culprit** (attribution by CI history: `f17367f98`'s battery was green on every Linux leg — its macOS shard-0 failure was a "hosted runner lost communication" infra flake; `a24343bad`'s battery failed ubuntu/arm/suite-candidate/fixpoint/self-hosted/FV all on the same E0911 @ `match.yo:1827`). Root cause measured: the tracked borrow's range-end inflated to the whole binding statement (#1476's arrow-literal skip hides the birth arm from the backward scan). One refinement round (decl-position-aware) cleared the 32 E0911s but re-opened E0919s on #1476's cursor-walk tests — undesignable statement-internal evaluation order — so **#1481 cleanly reverts #1476** (code + tests; its issue doc re-opened with the re-land plan and the measured root cause). v0.2.66 therefore ships WITHOUT the closure-parameter shadowing fix; it never shipped in any release, so no retraction — the known-issues list carries the re-opened doc. The battery then caught ONE more thing: #1480 landed two files unformatted (CI's stage-2 `fmt --check`; its local gate missed them — the seed-vs-tree-binary trap) — **#1482** MERGED `7705e766b` formats them (whitespace only; not in the release notes). Release battery: run 39261040036 on tip `7705e766b` |
| ~~#1478~~ MERGED `574e7df14` | B1 split: the two `explicit-copy` migration S2 fixes + E0916 structural-clone exemption + parked-sweeps docs with b1diag verdict; full Tier 1 + focused rebase re-gate green (full cli-diff 411 PASS/0 GOLDEN-DIFF, full internal 1419/1419) |
| ~~#1469~~ MERGED `c82f57052` | deref-of-borrow = E0920 (E0919 collision with #1421 resolved by re-code); rebase re-gate green; explain-list golden carries both E0919+E0920 |
| ~~#1479~~ MERGED `dcc9e3a0f` | evalgen issue-1 WRITE half (index-trial receiver exemption via `ctx.index_specialization_trial_recv_id`); read half open+mechanism narrowed (substitution pass never visits `Bag(K)`) |
| ~~#1474~~ MERGED `4c81aebe8` | bare-projection-tail decision-24 message (helper.yo Step-10 skip + result-position forwarding sentence; rebase `9d707291a` gate green; cli-case golden re-recorded — the rebased tree renders the suggested spelling without evaluator parens) |
| ~~#1480~~ MERGED `00ac528a3` | gi2 issue 4: match payload struct-shell — `variant_field_types` resolves every payload through `resolve_enum_shell(resolve_struct_shell(·))`; 12-line repro; parser internal 62/62; also carries the issue-1/2 measurement-round doc folds |
| gi2 issues 1+2 | **Not fixed this cycle — measured dispositions.** Issue 1 (closure at trial type): the generic-impl method-value specialization path bypasses `create_specialization_at_call`'s clfid keying entirely (fix site pinned; key-shape model = helper.yo's forwarded-closure-param precedent). Issue 2 (ArrayList same-named binder): definition-trial minting proven in emitted C (`_ptr : __yo_t…**` vs `void**`); first fix falsified (identity-keyed substitution + deep SomeT gate: green build, repro still fails); hole = a `T` binding recorded WITHOUT binder id — record `variable_set_bound_some_id` at `_inject_forall_captures`/`_build_def_time_body_env`; parked branch `fix/generic-impl-arraylist-same-named-binder` (worktree `gi4`) with fails-before regression test |
| ~~#1476~~ MERGED `a24343bad` | false-E0911 closure-parameter shadowing (scope-aware live-range scan; internal verdicts green) |
| gi2 issues 1/2/4 | generic-method closure at trial type; ArrayList same-named-param instance; self-referential ref-struct method resolution (12-line reduction done) |
| v0.2.66 cut | §2.1 sequence |

### 2.3 Parked branches (all pushed)

- `feat/v2b-genb-b1-migration` @ `e556161b0` — the explicit-copy SWEEPS (std 165 + src ~3,106
  clones), correctly parked: the swept compiler is ~80x slower and memory-bound (§3.1). Do not
  regenerate until the §4.2 prerequisites land.
- `wip/vbd-a4-std-half` @ `a83d6ac8b` — `timeout`/`select` over futures. Probed 2026-10-19: checks
  clean on develop (its 6 failures are pre-sweep staleness). Unblocked by ONE design decision (§3.2).
- `tss/phase6-step4` (#1162) — unchanged, type-soundness track.

## 3. Verdicts recorded this cycle (the next agent's inputs)

### 3.1 The explicit-copy sweep is NOT recoverable by tool fixes alone (measured)

The B1 stop + `b1diag` investigation (artifacts: `~/Workspace/Yo-wt/vbd-logs/b1diag-v66/`, machine-
local; the numbers are in the plan's B1 section update and the question doc that rode the split PR):
- The 80x is a **population effect across ~3,100 per-operation copies and it is memory-bound** (RSS
  45–47 GB vs the seed's 136 MB). Reverting 27% of insertions — including every whole-module-source
  copy — recovered at most half the time excess and ZERO memory. 89% of hot mass is HashMap
  hash/probe/get (deep copies re-hash).
- At the cost-dominating sites **no move spelling exists**: field reads behind borrows/`Rc`/mut
  globals are copies by construction (decision 19: no partial moves; decision 47: mut-global read =
  clone). The tool's real gaps (dying temporaries cloned — the audit never applies the copy-trait
  audit's temporary-as-move rule to projection/`get()` sources; no cost model — `_copy_written_after`
  consults writes only) are worth fixing as GUARDS, but regeneration after fixing them still
  reproduces the regression.
- The >50 GB / 45 min single-file `yo fix` cost was an artifact of running under the swept compiler
  (the original sweep did all 201 src files in 384 s clean). Any regeneration must run from a
  clean-tree binary.
- **v0.2.67 prerequisite order:** intern/Rc-share `module_path` + `input_string`; share envs at the
  adopt sites and TypeValue label/type lists; redesign the read-by-clone mut-global caches
  (`synthetic_token`, `_stable_type_id_owner_memo`); THEN regenerate as a listing-heavy sweep.

### 3.2 The capture-struct S2 needs one codegen design decision (fwcarr, #1475)

The issue doc's old Direction is falsified: the concrete `T` exists at NO stamp site on the
method-dispatch route (Step 9, the mint's `spec_ret_ty`, and the spec signature all keep the declared
`Impl(Future(...))`; the concrete materializes only by unification at the use site, after the capture
struct exists). Six implemented fix routes were measured and falsified. Remaining direction: lower a
future-wrapper capture field as the GENERIC cell, or give `fw_rebind`'s rebuild a per-mint id/cell —
a codegen design decision plus an async-corpus run. Landing it unblocks `wip/vbd-a4-std-half`.

### 3.3 Recursive enums sharing instantiations need a new id primitive (evalgen, #1472)

The `g_enum_sig_keys` structural dedup merges same-shaped recursive declarations; both string-keyed
fix halves break std (oversplit module-level vs CTFE-minted renditions; `Allocator.same` rejection).
The fix needs the declaration's `stable_position_id` stamped into every instantiation at id-minting
time (`evaluator/types/enum.yo`), with both rules keyed on that. Scheduled as its own piece.

### 3.4 Smaller verdicts

- IterPeekable's conditional `Copy` derive is fixed in-tree (#1466) but STAYS PARKED until a seed
  carries it (v0.2.65 rejects the derive shape; measured both ways —
  `plans/backlog/SEED_VERSION_AUTOMATION.md` has the evidence). Same pattern for anything needing a
  compiler newer than the seed.
- The declared-`Send`-binding S2 stays open on decision 43 (function-item types); the
  closure-typed-field half landed (#1460).
- `#1463`: the `compile.test.yo` leak classes are lexer-chain `Token` Rc cells (~59 KB per in-process
  compile), a measured sub-case of the self-hosted reference-hygiene S1 umbrella. No one-site fix.
- LinkedList of managed elements forms uncollected cycles (S3) — believed a documented design
  limitation of `ref(struct)` + the collector's reachability; triage, do not auto-fix.
- The non-routable connect-test leak doc is suspected network-environment; triage before believing.

## 4. What is next, in order

### 4.1 Right after v0.2.66

1. Land every §2.2 PENDING row that did not make the cut (each already has a branch and gates).
2. **Re-land #1476's scope-aware live-range scan** (reverted by #1481): the measured root cause and the
   failed decl-position-aware round are in
   `issues/2026-10-19-borrow-liveness-rejects-the-match-switch-group-lowering.md` (S1) and the re-opened
   `issues/2026-10-18-a-closure-parameter-named-like-a-live-local-borrow-extends-the-borrow.md`; the
   un-designed piece is statement-internal evaluation order (a re-point token preceding the binding's
   last read).
3. **End-triage leftovers (triaged 2026-10-19, both stay open, neither blocks a release):** the
   non-routable connect LSan leak (`issues/2026-10-17-the-non-routable-connect-test-leaks…`, S3,
   network-env — CI's network rejects TEST-NET instantly so CI is green; the one-line fix is
   `h.abort()` on the spawned connect in `tests/net/tcp.test.yo`, or a harness drain of pending tasks);
   and the LinkedList move-only pop/clear (`issues/2026-10-16-…`, S2, pre-cycle, needs an std API shape
   that returns the whole node — no partial moves out of a `ref(struct)`).
4. B12 → B13 note (§4.4 of the 2026-10-17 handover) still governs `Dyn`; the seed is now v0.2.66.

### 4.2 V2b, reshaped by §3.1 (supersedes the plan's B-step order for src)

The borrow/share-conversion work (B3/B4 territory) comes BEFORE any src re-sweep: shared
module-path/source strings, shared envs, shared TypeValue lists, non-cloning memo reads; the
explicit-copy tool gains the temporary-as-move rule and a hot-path guard that LISTS evaluator sites
for hand edits instead of cloning. Then B1 regenerates over an already-sharing tree. B2 (tests/build
scripts/markdown_yo sweep) may proceed independently — it has no evaluator hot-path exposure.

### 4.3 The one-decision unblocks

- §3.2 (capture fields as generic cell vs per-mint ids) → A4's std half.
- §3.3 (`stable_position_id` minting) → the recursive-enum S2.

### 4.4 The rest of the 2026-10-17 plan

Decision 47 locals Generation B (§4.2 step 7 there), V2b B5–B14, decision 46 follow-up, `VcTerm` Rc
children, V2c, V4's remaining trees, decision 43 (four PRs), function-item types, V5, and the
retirement of the `yo fix` migrations — all unchanged; the plan is authoritative where this document
is silent.

## 5. Open bugs to know about (beyond §2.2 PENDING and §3)

- The declared-`Send`-binding S2 (decision 43) and `arc(named fn)` — unchanged from 2026-10-17 §5.
- The pre-cycle S1s (`a-write-through-a-string-copy-when-empty` — expect V2b to remove it; the FTT
  stub — type-soundness track).
- The reference-hygiene S1 umbrella now carries the Token-cell leak sub-case (§3.4).

## 6. v0.2.66 release-notes final state

Updated as the cut proceeds. The draft's `## Changes` sections: Language (d47 globals GenB #1414,
d46 GenB #1421, the `{}` rejection #1473); Type checking (#1436, #1460, #1466, #1457, #1465, #1430,
#1479 nested-index-write through a generic impl, #1480 match payload struct-shell, #1474 the
decision-24 forwarding message for a bare projection tail, #1469 deref-of-borrow = the NEW code
E0920 — note the E0919 collision story with #1421 resolved by re-code); Compile and codegen (#1447
with the honest gcc framing, #1452, #1445, #1439); Async runtime (#1434, #1458, #1453, #1462);
Standard library (#1422, #1456, #1467, #1450, #1470); Toolchain for agents (#1478: the two
`yo fix --migrate explicit-copy` fixes — a return of a borrowed-root place is LISTED not rewritten,
a copy inside a generic specialization left as written — plus the E0916 structural-`clone()` exemption
with the honest number: the landable half re-checks `std/string/string.yo` in 8.9 s where the parked
full sweep took 430+ s / 45 GB); Compiler performance and memory (#1455, #1463's measurement).
Known issues: rebuilt from what is open at the tag — the removal map in the machine-local draft tied
every line to its fixer; re-derive with `ls issues/` at the tag; MUST include the re-opened
`issues/2026-10-18-a-closure-parameter-named-like-a-live-local-borrow-extends-the-borrow.md`
(reverted by #1481 with a measured re-land plan). No Retracted claims this cycle (the #1476 revert
removed nothing a release ever shipped).

## 7. Machine-specific notes (this cycle's box; ignore elsewhere)

Heavy lock: 6 slots, `~/Workspace/Yo-wt/heavy-lock.conf`. Long background tasks get reaped
(exit 137) — always `setsid`. The box lost clang in a WSL update; the repo's `shell.nix` provides it
(`nix develop . --command bash -c '...'`; AGENTS.md records the recipe and the pthread-assert trap
outside the wrapper). Session logs: `~/Workspace/Yo-wt/vbd-logs/*-v66/` (not durable; the durable
record is this document + the repo).
