# B9 STATE — CURRENT (2026-11-03 evening; read this section first)

Pushed copy: branch `probe/b9-census`, file `vbd-state/b9-STATE.md` (updated at milestones).

- B9 branch `vbd/b9-hashmap-flip` @ 83b259061 (merge of B8 150fdaff0, `-X theirs`).
  - The B9 delta survived; only verifier_loops left it (B8 carries it now). Patches: b9-delta-{pre,post}-merge-r31.patch.
  - r31 tree build running (treebuild.sh r31). Next: tier1.sh r31 all.
  - r30 Tier 1 (bin r30 9c8535312): check src 276/276, std 171/171, all 13 language tests green, fmt and refs green, cli 427 PASS / 37 GOLDEN-DIFF / 3 NO-GOLDEN.
  - r30's internal leaks (module_invalidation, type_trait_methods, verifier_loops) are fixed by tplfix (now in B8). check_watch, context and initialization_assignment are fixed by int batch 3 (in B8).
- Helps for b8:
  - tplfix: picked by B8 (6a64bf04a..602936aa1).
  - int batch 3: picked.
  - vbd/b9-helps-b8-tests (worktree ~/Workspace/Yo-wt/b9-tests):
    - 30937bf1d cell_handles: picked as 150fdaff0.
    - 023b9d0d8 N2b wall fix (an origin behind a pointer is beyond N2b; S1 doc in issues/fixed): not picked yet.
    - Binary: yo-tree-tests-023b9d0d8. borrow_spelling 27/27, ref_return_ban 4/4, model_corpus 76/76, array_list 136/136.
    - check std+src with it is running (/tmp/b9tests/v-{std,src}.out).
- Pre-existing (develop fails too): async/combinators, async_await (comptime_expect_error io text), dyn:703, circular_error_a/b. Sweep-only: derive, global_lend, loop_body_return_drops.
- module_invalidation still has 1 of 12 failing on tplfix: a 144-byte leak in "B2: memo and trait-default registries flat". Reported to b8; not chased.
- On "B8 MERGED": restack, migrate, re-gate, finalize ~/Workspace/Yo-wt/v0273/pr/b9-hashmap-flip.{title,md}, report to main.
- All work stops once v0.2.74 publishes.

---

# B9 HashMap+HashSet flip — STATE (2026-11-01, v0.2.74 window)

Branch `vbd/b9-hashmap-flip`, worktree `~/Workspace/Yo-wt/b9-flip`.
Base FROZEN at spawn: merge of `origin/develop` @ `cdcd14d3e` (#1712) + B8's
`vbd/b8-arraylist-string-flip-r3` @ `9dd7414b2` (round 13). Merge = `5c9abdf63`
(4 conflicts: THREAD_SAFETY en/zh = branch `mut(g)` + develop `AtomicI32.new`;
VBD_RELEASE_SCHEDULE = develop's Q9 row + branch's `issues/fixed/` path;
src/fetch.yo = develop's #1710 rehash conditions + branch's `__probe_name`).

## Re-census vs the b9-b11 census (THE delta the task asked for)

- b9-b11 census (B8-r2 @ dc926ea20 era): base 15 roots, 10/276 files pass;
  probe/b9-census 14 roots, 10/276, +1 new root (emitter `_flush_move_zeroes`).
- MY base (B8 r3 @ 9dd7414b2 + develop #1712): **275/276, ONE root** —
  `src/types/utils.yo:4030` (+ :4418 behind it) String element reads, B8's
  class, NOT a HashMap site. B8's rounds 8-13 swept the whole 1:5 frontier.
  Fixed on this branch in B8's canonical shape (`get_cloned`); B8's own round
  will land the same text, so the restack cherry-pick sees it already applied.
- The census's two named src roots are GONE as roots: `emitter._flush_move_zeroes`
  (:384 `self.move_zeroes.keys()`) and `expr_info.codegen_read_keys`
  (:1649 `.with(s => s)`) exist but are no longer FIRST errors (whole tree
  passes) — they become roots only once the flip is applied (census running).

## Progress

- [x] merge + push (5c9abdf63)
- [x] base census (std 171/171 rc=0; src 275/276)
- [x] utils.yo root fixed (get_cloned ×2)
- [x] b9-std-flip.patch + b9-tests-mut.patch applied clean (rc=0 both)
- [~] flip-applied census (seed check ./std --test-bodies + check ./src)

## Rules I run under

Heavy via census.sh (lock + systemd-run 16G + rc lines in status.txt);
poll ≤9 min; ≤2 heavy slots; B8's probe has machine priority.

## Coordinator note for the restack (2026-11-01)

- develop carries #1719 (mut-bindings tool gap fixed): at restack, the
  "writes through iterator/closure bodies" hand-edit class is deletable
  except documented `sink(acc)`-style param rebinds; one `yo fix --migrate
  mut-bindings` run should regenerate my mut edits byte-for-byte
  (scratch binaries under ~/Workspace/Yo-wt/vbd-logs/mutbind-gap/).

## Session 3 (2026-11-02, fresh B9 agent after the coordinator stop)

- Rounds 2-11 committed by the previous agent (r10 census: 150/276, roots impl.yo [89 files] +
  numeric_type, c_include, extern, test). Round 12 (those 5 roots) committed as WIP 4686ca38e.
- **B8 integration policy**: B8 is canonical for the ArrayList/String class. Merged B8's tip
  2b600aef1 (rounds 14-22) with `-X theirs` (conflict hunks take B8's side; 136 hunks in 7 files:
  contracts, context, module_loader, utils, anonymous_module, expr_info, flowability) → bd27d5603.
  Any B9 HashMap fix lost in a B8-side hunk reappears as an error and is re-fixed on top.
  Repeat on every B8 push (`git fetch; git merge -X theirs origin/vbd/b8-arraylist-string-flip-r3`).
- B9-only edits from here: HashMap/HashSet-class sites. B8-class roots (get_cloned on lists,
  String element reads) in files B8 has not reached are left for B8 unless they block the probe.
- Restack plan (after B8 squash-merges): `git diff <B8-final-tip> <B9-tip>` applied onto
  develop (B9 will have merged B8's final tip), then `yo fix --migrate mut-bindings` (#1719)
  over the tree to regenerate mut edits; drop hand mut edits it reproduces.
- Tools: census.sh (whole-src, seed), filecheck.sh <tag> <files> (per-file, seed).

### 2026-11-02 ~12:00 — restacked onto B8 -r4 (coordinator ping "-r4 READY 6adce8401")
- New tip 544376c6b on `vbd/b9-hashmap-flip` (force-pushed); old stack backup
  `vbd/b9-hashmap-flip-r3base` @ bd27d5603. Own-delta patch: `b9-own-delta-r12.patch`
  (diff 5c9abdf63..4686ca38e), applied `git apply -3`; 148 conflict hunks in 8 files → -r4 side
  (`scripts/take_ours.py`, worktree-guarded).
- mut-bindings migration (#1719 binary, `~/Workspace/Yo-wt/mutbind-gap/yo-out/.../yo`) over the
  B9 std/tests files: +2 markers (generic `from` bodies); HashSet from_iter_add sink rebind.
- The census r12 (old base) result is VOID (tree changed under it). r13 = first census on -r4 base.
- Future B8 pushes: B8 now works on `-r4`; merge `origin/vbd/b8-arraylist-string-flip-r4` with
  `-X theirs` when it advances.

### 2026-11-02 ~12:50 — round 13 on the -r4 base
- Commits: 075a36619 (expr_info keys snapshot, mutation_summary get_cloned), doc_comment_lookup
  clone + borrowed readers, 2af73c999 (B8-cleared files keep only HashMap-class edits; two
  MERGE ARTIFACTS fixed: flowability take_deferred_sibling_rules lost `ri += 1` and got a
  stray `pgo = false`; record_spec_instantiation re-inserted unconditionally), 9e8334088
  (VERDICTS-13 §9: std HashMap.keys_cloned/values_cloned, HashSet.items_cloned + tests;
  20 src sites swept by scripts/sweep_cloned.py — re-run it after any unmask round, it turns
  unmask's `.clone().keys()` into `.keys_cloned().into_iter()`).
- LESSON: a clean 3-way merge of B9's delta over B8's rewrite can still be semantically wrong
  (non-overlapping halves of two different rewrites of one loop). Review every hunk of a file
  both sides rewrote.
- types/utils.yo's two get_cloned (dyn_vtable_slot_result_is_ref, closure_fn_trait_of) ARE
  still needed on -r4 (reverting them re-raises E0901) — B8 class but kept.
- Semantics note for the PR: copy_eval_context now CLONES captured_variables /
  own_consumed_captures / captures_owned_by_body (were shared HashMap refs). Only 2 callers,
  both module-walk ctx save/restore where captured_variables is .None in practice.
- Tools: umseq.sh <tag> <files> (sequential guarded unmask, b8's unmask.py copied to scripts/).
- census r14 (seed, whole src) launched 12:50 on 9e8334088.

### 2026-11-02 ~13:10 — ownership split with B8 + merge of B8 r4 sweeps
- B8 OWNS src/evaluator/utils.yo and src/evaluator/values/impl.yo (B8 asked B9 to stop; done).
  B9 reverted its B8-class utils hunks (ce51e60b5); keeps captured_variables borrows,
  dyn_copy keys_cloned, 5 Clone derives.
- Merged B8 -r4 tip 1d0e879d8 (round 23 cont. + Rc-arg-list clone sweep + get_cloned sweep)
  with -X theirs → b1cef6270. B9 src delta vs B8 tip: 50 files (was 71).
- Round 14 fixes: captured_variables scrutinee borrows (begin, utils), index_trait save=clone
  (trial re-evaluates; records repeat the dispatch's), helper spec snapshot clone,
  anonymous_function take(); all remaining borrowed-map keys()/values() → keys_cloned
  (closure.yo, anonymous_function, module_manager, vc.yo, build_runner, mutation_summary);
  mutation_summary registries take-out/store-back; main.yo pos_keys remove; vc.yo reach index.
- census r15 (std --test-bodies + src) launched ~13:10.

### 2026-11-02 ~14:45 — helping B8 (coordinator directive)
- b8-helper holds: pkg_config, lsp/symbols, values/tuple, types/record, exprs/test,
  identifer_and_operator, trait_type, numeric_type, pattern.yo, destructuring_assignment,
  ptr_fns, asm, comptime_expect_error. B8 holds impl.yo, evaluator/utils.yo, types/utils.yo,
  builtins/*, types/function.yo.
- B9 ported B8-class hunks (HashMap-class stripped, scripts/port_hunks.py) to branch
  `vbd/b9-helps-b8` (worktree ~/Workspace/Yo-wt/b9-helps-b8), 18 one-file commits off B8 -r4
  5e971450b (c1b3a32fd..16bda56dc). Shas sent to b8. Per-file seed checks: helpcheck/summary.txt.
- Census r16 (B9 tip b7cbf9dd6) running: still impl.yo-gated (5425 forall_names, B8).
- PR body draft written: ~/Workspace/Yo-wt/v0273/pr/b9-hashmap-flip.{title,md} (placeholders
  <N_KEYS> etc. and Verification TO FILL).
- Coordinator directive (2): when B8 announces 276/276 + tree binary, build B9's tip tree binary
  at once and run full Tier 1 concurrently; don't wait for "B8 MERGED".

### Tier-1 selection (prepared 2026-11-02 ~14:45; run one file per call with TREE binary first on PATH)
- language/std: tests/collections/hash_map.test.yo, tests/collections/hash_set.test.yo,
  std/collections/hash_set.test.yo, tests/send_sync.test.yo, tests/move_only_collections.test.yo,
  tests/for_read_walk.test.yo, tests/index.test.yo, tests/copy_trait.test.yo,
  tests/collection_constructors.test.yo, tests/collection_clone_through_borrow.test.yo,
  tests/thread.test.yo, tests/comptime.test.yo, tests/closure_capture_list.test.yo
- internal (≤8): module_invalidation (owned_id_log_entry_count, finished_walk_*, def deps),
  check_watch (type_trait_methods_entry_count), mutation_summary, type_trait_methods, context,
  initialization_assignment, identifier_and_operator, verifier_loops
- cli-diff full (std changed). fmt --check with tree binary over changed .yo. check-issue-refs.
- 14:50: B9 delta vs B8 -r4 tip = 27 src files; env.yo clean w/ values_cloned (r17).

### 2026-11-02 ~16:30 — B9 test sweep (tests import only std → probeable now)
- B8 asked: tests n–z on B8 tree (seed --test-bodies): 118/121 clean, 3 = seed artifacts
  (#1690/#1700 expectations; Result.map by-value self payload move — tree binary passes per B8).
  No commits needed on vbd/b9-helps-b8.
- B9 tree full tests census (331 files tests/** + std/**/*.test.yo; tcensus9/): 34 failing →
  after fixes all B9-class cleared:
  - mut-bindings (#1719 binary) over 18 test files: 50 markers (HashMap/HashSet locals).
  - mutable-globals → then E0916 (mut global can't be lent): module_globals/global_a.yo map →
    RefCell; safe_code_structural_gates positive HashMap block → test(...) body.
  - REAL std bug from the flip: std/encoding/json.yo HashMap ToJson used `self.keys()` on &self
    (+ `get` copy) → borrowed for; FromJson's out map mut. Fixed (std check didn't instantiate).
  - mut-bindings over all of ./std: 0 further markers.
  - Remaining failures = baseline (fail identically on B8 tree): move_only:3320, dyn:508,
    borrow_spelling:147; seed artifacts: async/combinators, async_await, handle_constructors,
    rc_binding_gives_way, static_argument_inference, option_result_combinators, E0910 texts
    (array_list, ref_cell_lend_overlap, string/string), ref_return_ban.

### 2026-11-02 ~17:45
- B9 tip 8c72f5e2e+merges (docs en/zh THREAD_SAFETY/PARALLELISM/DESIGN, cheatsheets, send_sync
  B9 row). B8 at census r4f 162/276; B8 holds await_analysis + types/function.
- Helped B8: field.yo CLEAN → 2e0649a3f on vbd/b9-helps-b8 (scoped UNMASK_WATCH loop; watch
  re-checks take ~2-3 s per site after the first ~200 s).
- PR-finalize TODO: plans/VALUES_BY_DEFAULT.md "Landed" line for B9; cli-diff --record cheatsheet
  hash goldens (syntax-cheatsheet + core-patterns changed); fill PR body census numbers.
- BUG SEEN (to file): seed `yo check <file> --watch` after an edit to an impl block's file
  reported E0612 "Method `walk` is already defined for this type (first definition 361:3)" at
  362:3 — a cold check of the same tree has no E0612 (mutation_summary.yo, ~17:50). Watch
  re-force of an inherent impl registers the methods twice. Needs a develop-binary repro +
  issues/ doc + test (tests/internal/check_watch?).

## 2026-11-02 ~20:00 (post-compaction)
- Merged B8 -r4 27a94af53 into vbd/b9-hashmap-flip (-X theirs); the merge dropped B9's `&ctx.doc_comment_lookup`
  scrutinees in types/field.yo (adjacent-hunk conflict resolved to B8) → restored, 8a3c3675a pushed.
- B8 cherry-picked effect_analysis (051738b1c) and doc/builder (3dce888bc).
- helps2 vc.yo loop: fixed saved_names (&mut through _arm_ir_bind), loop_for_idx scrutinees cloned, the
  tool's handle-copy `impl(VcObligation, Clone)` replaced by `replace(&mut ctx.obligations, …)`; reached CLEAN
  once before that last edit, re-verifying. Tool also added derive(ForFrame, Clone), derive(BreakSite, Clone).
- helps-b8 mutation_summary loop: labels .items.clone() (1592, 3984), _gr_settle_pending owned captures,
  d1_record_global_write owned key/loc, _gr_note_read/_gr_note_callee owned captures. TODO after CLEAN: rename
  the tool's fid_owned__…_____ locals.
- WATCH E0612 BUG FIXED on its own branch fix/watch-inherent-method-sites (worktree ~/Workspace/Yo-wt/watch-e0612,
  off develop b1cd95385): inherent-method sites get an OwnedKeys log + purge_inherent_method_sites_owned_by in
  mm_invalidate_document. Doc issues/fixed/2026-11-02-a-watch-round-that-moves-an-impl-member-reports-it-as-a-duplicate-method.md,
  test in tests/internal/check_watch.test.yo. Develop-binary repro (s1-base b02a4c908) confirmed. Gate script
  vbd-logs/b9-flip/watchfix-gate.sh (before = develop module_manager; after = full file).
- heavy-lock: source it from bash (`bash -c`), the main checkout's copy fails under zsh (pre-#1721).

## 2026-11-02 ~22:00
- B8 picked: vc.yo (734e56f4c), mutation_summary (319c5ac6a, cdc40f5a7), ParamMutationMask derive (39c604e67→in 1737cb135).
  Pending pick: runtime.yo 0a0a3d86a, closure.yo 18b6ba051 (vbd/b9-helps-b8 on 1737cb135).
- B9 merged -r4 734e56f4c (1e49a1c3b): fixed duplicate fid_own bindings left by the merge.
- Trial pre-PR rebase for B8: vbd/b8-rebase-trial (worktree ~/Workspace/Yo-wt/b8-rebase-trial) = merge d4232b18b
  + fixup 575467685; 4 conflicts (generation.yo combine, utils.yo combine, bufio ours, schedule doc theirs+path fix).
- New develop bug filed: issue/impl-method-recursive-borrow-arg (5d3f345c7) — `&x` arg to an impl method's own
  recursive call / sibling-forced call rejected. Open; not fixed. Tell main.
- unmask.py sink-hoist patched: inline `{ x : x.clone() }(m) =>` instead of hoisted x_owned___ lines.
- Watch fix branch fix/watch-inherent-method-sites: before FAILS with the exact E0612, after 13/13; Tier 1 (tree
  build, check src/std, inherent_first_resolution, 4 cli-cases) green; internal files running.
  PR body at ~/Workspace/Yo-wt/v0273/pr/watch-inherent-method-sites.{title,md} (Verification TO FILL).

## 2026-11-03 ~00:30
- Watch fix merged as #1732; worktrees watch-e0612, b9-devbase, issue-impl-recborrow removed. The impl-recursion
  borrow-arg issue (5d3f345c7) is owned by s1-async (root cause: static `T.m(&x, …)` to an in-flight member took
  the receiver path).
- Helped B8 (all one-file commits on vbd/b9-helps-b8): runtime.yo, closure.yo, codegen/types/generation.yo,
  and_or.yo, state_machine.yo, calls/helper.yo (WIP 0e7daaf34, WIP2 3bc7ce859, CLEAN 3160fb1d0).
- B9 merged -r4 again (cd27a2318), B9 delta verified per file.
- unmask: UNMASK_NO_GENERIC_STOP=1 needed for compiler files whose String clones sit in generic-ish bodies.

## 2026-11-03 (r17–r23)
- B9 rounds r17–r22: function_type where-clause snapshot (`.clone()`), closure.yo:1113 `m.clone()`, vc.yo
  get_cloned/clone sites, `_clone_captured_variables` at helper:4753/index_trait:1118, the 29-site `&context.<opt map>`
  sweep (/tmp/b9-ctxsweep.py), generation.yo index-projection dependency reads, state_machine conflicts take-out,
  async.yo cross-boundary borrows + evidence shallow copy (EvidenceParameter has no Clone). Merged -r4 bb050fecd.
- std: HashMapIter.next always moves the entry out (shared-map copy branch gone) + test "into_iter - move-only String
  entries move out". r23 (82ba8ba4c): HashMapKeys/HashMapValues.next move out + vacate, K/V Clone bounds dropped
  (B8 -r4 had them cloning); hash_map 98/98 under the seed with --std-path ./std.
- Census r23: 267/276 src + std 171/171; remaining = markdown-yo (needs 0.0.26 pin from mdyo2) + lsp/server.yo (B8).
- markdown-yo 0.0.25 port done: worktree ~/Workspace/Yo-wt/b9-mdyo, branch b9/value-hashmap-env @ 007b798, patch
  markdown-yo-0.0.25-b9-env-ptr.patch; mdyo2 releases v0.0.26 + Yo branch chore/markdown-yo-0.0.26 → fold its sha.
- PR notes for B8: ~/Workspace/Yo-wt/vbd-logs/b8/pr-notes-b9.md.
- 8ab9a3edf: cherry-picked chore/markdown-yo-0.0.26 (e93bac324; yo.toml ^0.0.26 + lock), `yo install --locked` → v0.0.26.
- 443d89c63 (r24): build_runner async bodies (unmasked by the pin) no longer capture borrowed value maps:
  _evaluate_dependency_build_file / _evaluate_dependency_builds / evaluate_build_file copy `defines` before io.async;
  _execute_batch reads the per-node blocked flags from `results` before the task.
- Census r25: src 275/276. Only main.yo:476 `visited.get(iv - 1)` (ArrayList(String) element read, B8-class;
  B8 is fixing main.yo element reads now) — pick it up via the next -r4 merge.
- 55dbd1970: merged B8 -r4 fcb1444fa (main.yo element reads); census r26 src 276/276 (seed).
- build-r26 (seed, --std-path ./std) FAILED in C: the same 7 errors as B8's build-r4 (6 duplicate labels
  __yo_m*_a0/_end + 1 incompatible-pointer: unwind "Drop consumed variables" drops usize `k` with the String
  drop in match.yo _lookthrough_switch_cell — name collision with the later String `k`). b8 drives the fix;
  told b8 the diagnosis. Fold b8's fix when pushed, then rebuild (treebuild.sh <tag>).
- 10:00–10:40: B8 Tier 1 (b) run for b8 (worktree ~/Workspace/Yo-wt/b9-b8tier1 @ cbfe72efc, logs vbd-logs/b8/tier1/):
  34/37 pass; move_only (anon-record get_cloned, fixed by B8 94c344c7d), http+server (nested deferred async
  blocks never defined: snapshot of context.deferred_async_blocks; B8 fixed as 6f6c190b0). Exec argv fix =
  B8 a1196b7c9. My duplicates reverted in B9. Develop-baseline binary: vbd-logs/b9-flip/yo-s1labels-4af1ebd87
  + worktree ~/Workspace/Yo-wt/b9-devbase @ ce827ae52.
- Filed issues/2026-11-03-two-spellings-of-one-anonymous-record-type-emit-two-c-structs.md (S3, pre-existing) + repro (7c438c333).
- B9 Tier 1 r28 (binary 5bea0a6de): check src 276/276, std 171/171, 13 language tests all pass. Internal stage
  aborted: tests/internal need mut-bindings migration — b8-helper owns it (vbd/b8-helper-t1), cherry-pick its sha.
- a5e3350bc: merged B8 c2c31dca8. build-r29 (fusion on) started 10:43.

## 2026-11-03 (post-compaction)
- Leak root cause: template `.`/`to_string`/`format` tokens at char 0 (make_syn_tok) -> arm-drop UndoneMove window from file start swallows early-return exit drop. Fix on vbd/b9-helps-b8-tplfix 97eaae7e9 (worktree ~/Workspace/Yo-wt/b9-tplfix), parser.test.yo test + issues/fixed doc. Build log /tmp/b9leak/build-tplfix.out.
- int files: c3 3/10 OK; round-2 fixes applied in ~/Workspace/Yo-wt/b9-int (uncommitted), recheck c4 -> /tmp/b9anon/int-c4.out.
