# G1: FnMut slots (vbd/g1-fnmut-slots), STOPPED 2026-11-06 at handover

Branch head: 620391d6a (pushed). Base: origin/develop 02c6d5f24.
Untracked: this file and tmp/ (gitignored). Audit logs are in tmp/.

## Commits (the order is deliberate: the deletion stays LAST, as the coordinator asked)
1. 5398987be: std slots switched (G1 list):
   - prelude: Iterator adapters, the `Iter*` impl bounds `F <: FnMut(...)`, and `fold`/`for_each`/`any`/`all`/`find`/`position` taking `&mut F`.
   - std/async/stream.yo: the adapters; `for_each` rebinds `mut(g) := f`.
   - ArrayList: sort_by, sort_by_key (now `{ &mut key }` capture), sort_unstable_by, binary_search_by, retain, and the `_heapsort_by`/`_merge_sort_indices`/`_stable_sort_by` helpers.
   - HashMap: retain, and_modify, update_with. update_with is rewritten over `get_entry_ptr` without `entry`, because a `{ &mut f }` closure is second-class and cannot go into entry's `sink(body)` (E0909). Its `where(K <: Clone)` is dropped.
   - mutex with_lock/try_with_lock; rwlock with_read/with_write/try_with_read/try_with_write; semaphore with_permit; async mutex with_lock (`{ &self, &mut body }`).
   - regex replace_with/replace_all_with; bench/bench_auto.
2. 620391d6a: src. Deletes `fn_slot_admits_capture_fnmut` and the `YO_AUDIT_FNMUT` knob (`g_audit_fnmut`) in src/evaluator/utils.yo, so `judge_capture_fnmut_at_fn_slot` always raises E0913. Comments are updated at the callers (anonymous_function.yo, calls/helper.yo, values/dyn.yo, utils/closure.yo, types/utils.yo).

## Verified so far
- Seed v0.2.75 carries FnMut. Before the switch, the seed's `check ./std` passed 170/170.
- tmp/probe3.yo exercises every G1 API with `&mut`-capturing literals plus a named `mut(less) : Impl(FnMut)` passed `&mut less`. With the seed it compiles and runs correctly (`36 6 3 2 0`).
- Audit BEFORE (seed, YO_AUDIT_FNMUT=1): 62 sites, all reached from tests. The list is in tmp/audit_sites_before.txt. `check ./std` and `check ./src` alone show 0 because generics are not instantiated.

## Running at handover (background, may finish on its own)
- B0 snapshot build: worktree ~/Workspace/Yo-wt/g1-snap at 86b474364 (the deletion alone, old std), log tmp/build_b0.txt. Binary: ~/Workspace/Yo-wt/g1-snap/yo-out/x86_64-unknown-linux-gnu/bin/yo. Remove the snap worktree when done (`git worktree remove --force`).
- Seed `check ./src` and `check ./std` against the switched std: logs tmp/check_src_1.txt and tmp/check_std_1.txt. These catch callers that pass `&f` where the slot is now `&mut`.

## Waiting on BRIEF-28 (the Fable consult): call-once `&Impl(Fn)` slots
The question is (A) switch only the side-effect call-once slots, (B) switch every non-escaping callback slot to `&mut Impl(FnMut)`, or (C) keep them `Fn` and rewrite the tests.
- Recommended: (B).
- Slots with a test that writes a capture, which become E0913 after the deletion:
  - Option.inspect (prelude.yo:8348) and Result.inspect/inspect_err (9269/9280)
  - log_lazy and the *_lazy family (std/log.yo:320-379)
  - Once.call (std/sync/once.yo:104) and OnceCell.get_or_init (179)
- No such caller: Option/Result map/and_then/filter/or_else/map_or/map_or_else/unwrap_or_else/is_some_and/ok_or_else, HashMap get_or_insert_with/or_insert_with, RefCell with/replace_with, waker park.
- When the verdict lands, put those slot edits plus their test fixes in a commit placed before 620391d6a, or amend the deletion commit.

## Next steps
1. Read tmp/check_src_1.txt and tmp/check_std_1.txt. Fix every caller that passes a named closure or a forwarded `&` param to a switched slot: use `mut(g)` + `&mut g`, or a `&mut` param forwarded bare.
2. With B0 or a fresh tree build, run each of these tests and fix the E0913 sites. Each fix is a `&mut Impl(FnMut)` helper parameter or a `mut`-bound FnMut closure, not a workaround:
   - closure_capture_list, iterator_combinators, closure_capture_rc_leak, closure, closure_param_forwarding, forwarded_closure_param_spec (+ tests/closure_forward/mod.yo)
   - borrow_spelling, copy_trait, mut_bindings, ref_field_borrow, type_soundness, prelude, std_export_coverage, sync/once
   - codegen-bootstrap/closure_where_clause_param.yo
   - Re-check the files that failed `check` before the audit (async_await, fn_once, index, local_borrows, unsafe, yo_cell, ...), because their sites past the first error were not audited.
3. tests/fn_mut.test.yo:
   - Turn "the Q10 exemption admits ..." (L131) into a comptime_expect_error for E0913.
   - Add E0913 pins for a generic `F <: Fn` bound slot, an annotated `Impl(Fn)` local, and `dyn` into `Dyn(Fn)`.
   - Update the header comment (L11-13).
4. Corpus rows closure-push-capture, closure-push-capture-then-write and closure-param-into-capture: change `_each` to `f : &mut Impl(FnMut(v : &i32) -> unit)`. Then run `YO=<tree bin> bash scripts/origins-corpus.sh` and re-record the `today` column only if a row's verdict moves.
5. Docs and instructions:
   - .github/instructions/yo-syntax.instructions.md:1562 (the exemption line)
   - docs/en-US/DESIGN.md:3402 and docs/zh-CN/DESIGN.md:3240 (YO_AUDIT_FNMUT)
   - sweep docs/skills/cli-cases for `.sort_by(&`, `.for_each(&`, `with_lock(&` and similar callers.
6. Plans:
   - Mark plans/backlog/SEED_VERSION_AUTOMATION.md §"Seed-gated follow-up (2026-11-03) ... FnMut" done.
   - Add an as-built note in plans/VALUES_BY_DEFAULT.md after L3165, plus the decision-37 call-once bullet (~L3209) per the verdict.
7. Tier 1:
   - build with nix clang; check ./src and ./std
   - per-file tests for the above plus array_list/hash_map/regex/mutex/rwlock/semaphore/stream/bench tests
   - tests/origins plus the corpus script
   - ≤8 internal files
   - cli-diff (read the GOLDEN-DIFFs), check-embedded-yo, tree fmt --check, check-issue-refs
   - fixpoint (`S1=<bin> P=g1`, then `rm -rf /tmp/g1_*`)
8. Write the PR body to ~/Workspace/Yo-wt/v0273/pr/g1-fnmut-slots.{title,md}, then send `READY: ...` to main.

## Possible issue to file (not yet filed)
- In user code, a closure forwarding a `&mut Impl(FnMut)` parameter cannot capture it. `{ &mut f }` and `{ g : &mut f.* }` both give E0926 (tmp/probe2.yo, seed v0.2.75), although E0926's help suggests `&mut f.*`.
- Inside std, `{ &mut key }` works (sort_by_key).
- Re-test with the tree binary before filing it as an issue.

## 2026-11-06 resumed (successor session, after VERDICTS-28 Q1 landed)
- Commit order rebuilt: 5398987be (G1 list) -> 167623cbb (call-once switch per
  VERDICTS-28 Q1(B): prelude Option/Result family 21 slots, hash_map
  get_or_insert_with REWRITTEN over _probe/_insert_at like update_with (E0909),
  HashMapEntry.or_insert_with, RefCell with/replace_with + docs, Once.call +
  get_or_init with { &self, &mut f } captures, log *_lazy family) ->
  529d7fbbe (deletion, LAST, cherry-picked + amended with the E0913
  diagnostics_registry en/zh text updates). backup-g1-deletion holds the old one.
- check_std with seed: 170/170 (tmp/check_std_2.txt).
- KEY RULE DISCOVERED (probe4/5/6): under FnMut slots, implicit captures are
  OWNING moves — implicit capture of a borrowed place (&String/&Struct param)
  is E0901; implicit capture of an owned local moves it (later use = moved);
  Copy locals fine. Under Fn (old) implicit captures were shared borrows, so
  RefCell.with memo probes across src broke (~232 sites). Applied a scripted
  { &param } capture-list sweep (src is deref-exempt so { &p } is the spelling
  there; user code needs { k : &p.* }) + manual loop-local hoists (utils.yo
  stable_type_id/stable_position_id, types/intern.yo intern_type).
- Iterator adapter closures NEVER took implicit borrowed captures (E0901 on
  the pre-switch std too, probe6) — only RefCell.with/&-slot APIs changed.
- Tests fixed: closure_capture_list (_cl_each/run/run_copy/_cl_reentry +
  annotated locals -> mut FnMut), closure (_spill_run &mut Impl(FnMut)),
  borrow_spelling (two annotated locals), copy_trait, mut_bindings,
  ref_field_borrow (two closures to shared { &xs } captures — the freeze pin
  is the test's point), closure_param_forwarding (call_unit4/run4 FnMut; the
  { &mut cb } forwarding capture is the probe2 question — tree binary will
  arbitrate), closure_forward/mod.yo (inner/outer_* FnMut), closure_where_
  clause_param (apply_each FnMut + &mut F).
- fn_mut.test.yo: header rewritten; Q10 test -> comptime_expect_error
  ("it is an `FnMut(...)` closure, and the slot is"); new pins for a generic
  F <: Fn bound, an annotated Impl(Fn) local, dyn into Dyn(Fn); new test
  passing mut(bump) : Impl(FnMut) &mut to Option.inspect writing its capture.
- Corpus fixtures switched (_each -> &mut Impl(FnMut(v : &i32) -> unit));
  today column re-record pending the tree binary.
- Docs done: yo-syntax.instructions.md (exemption line + the with/FnMut
  sentence + a new implicit-captures bullet), DESIGN.md en/zh (exemption
  paragraph rewritten). No old-style callers found in docs/skills/cli-cases.
- Plans done: SEED_VERSION_AUTOMATION.md FnMut section marked DONE;
  VALUES_BY_DEFAULT.md as-built N3 note + the call-once bullet replaced with
  VERDICTS-28 Q1's rule.
- check ./src rounds: 1 (38/274) -> fixed token/input_record/utils/value/
  definitions; 2 (43/274) -> utils 438/456/513/1015, string.yo:43,
  hierarchy.yo:101; 3 (45/274, after the sweep) -> utils loops + intern.yo
  fixed; round 4 running (tmp/check_src_5.txt).

## 2026-11-06 evening — src GREEN, tree building
- After 31 seed check rounds: `yo check ./src --std-path ./std` = 274/274
  (tmp/check_src_32.txt). Total ~260 RefCell.with callers fixed across src
  (capture lists { &p }; loop-local hoists in utils/intern/collection/
  expr_info; two E0914 marker fixes in mutation_summary that woke when
  capture lists reached their module).
- Commit order now: 5398987be (G1 list) -> 167623cbb (call-once) ->
  9edac7aa6 (callers+tests+docs+plans) -> afa05f9f8 (deletion, LAST).
  Trees identical to the pre-reorder 2664a7efe (verified empty diff).
- nix clang tree build started (tmp/build_tree.txt).
- Remaining: run/fix the listed test files with the tree binary; corpus
  re-record; probe2 re-test + issue if it reproduces; fmt --check; cli-diff;
  embedded; issue-refs; fixpoint S1=<bin> P=g1; PR body; push.

## 2026-11-06 late — resumed after WSL restart (2nd successor session)
- Restart killed both background builds (g1-snap B0 and the g1-fnmut tree build in
  tmp/build_tree.txt; g1-snap yo-out has only yo.deps/yo.imports, no binary).
- Branch was clean at afa05f9f8, unpushed. Pushed: origin/vbd/g1-fnmut-slots = afa05f9f8
  (force, replacing the pre-reorder 620391d6a; trees identical per predecessor's diff check).
- Seed verdicts stand (clean tree): check ./src 274/274 (tmp/check_src_32.txt),
  check ./std 170/170 (tmp/check_std_2.txt).
- Restarted the nix clang tree build in THIS worktree (tmp/build_tree.txt) under a plain
  heavy-lock slot. g1-snap is now dead weight; will tell the coordinator to remove it.
- Next after the binary: listed test files, corpus re-record, probe2 re-test (+issue if it
  reproduces), fmt --check, cli-diff, check-embedded-yo, fixpoint S1 P=g1, PR body.

## 2026-11-06 night — BUILD BLOCKER found + fixed: void* ref-spill (S1)
- First tree build FAILED at clang: 22 errors shown, 282 `void*
  __yo_ref_spill_N = (__yo_t_X){};` sites in yo.c (develop base: 0 — all new
  with the FnMut std).
- ROOT CAUSE (pre-existing, latent): a capture-free closure LITERAL at an
  `&mut Impl(FnMut(...))` slot whose trait sig mentions an open type var
  (with's R, Option.map's B) keeps an abstract Impl ExprInfo type; the
  caller-side ref-spill (_apply_ref_amp) types the temp from it -> void*.
  Non-generic slots fine (sort_by/retain/replace_with); capturing literals
  fine (addressable temp). 5-line repro on the seed (tmp/p10.yo).
- FIX in tree codegen: _closure_ref_spill_c_type in other_fn_call.yo
  (capture_type -> get_closure_capture_info(fid), mirroring the emitter's
  own capture-free branch). Fixes user code on the tree binary.
- BOOTSTRAP: the seed can't fix itself -> src/std's ~300 empty-env reads at
  those slots now spell NAMED fn values: cell_* family exported from
  std/sync/refcell.yo, _ch_* in async/channel.yo, file-local concrete
  helpers where a generic filler's K-bounds broke a chained .into_iter()
  (13 sites). One expression rewrite (context.yo map-len > 0). Scanner +
  exact-string rewrites; 254 scripted + ~50 hand.
- issues/2026-11-06-a-closure-literal-at-a-generic-fnmut-ref-slot-spills-void.md
  (S1) + regression test in tests/fn_mut.test.yo (generic-slot literal).
- SEED_VERSION_AUTOMATION.md gains the seed-gated residue note (delete the
  fillers once a seed carries the spill fix).
- check ./src round 33 after rewrites: into_iter chain errors (fixed with
  concrete helpers); round 34 running.
