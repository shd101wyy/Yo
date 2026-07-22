# yo-self Stage-2 Handoff — #69 Campaign

_Last updated 2026-07-22 (agent handover). `git log` of this file has the full
archaeology; per-bug details live in `issues/*.md` — do not re-litigate fixed
bugs._

## Where things stand

- **#70 (`s2 test ./yo-self/tests`): DONE — 61/61.**
- **#69 (`s2 test ./tests`): 150/183 committed.** 2026-07-22 flips (all
  fully gated incl. STRICT_FIXPOINT): cycle_collector 16/16
  (OPTIMIZE_DUP_AND_DROP_PAIRS port, `eeb6e00b9`), then the async-future
  six — fs/file 13, fs/dir 12, fs/metadata 6, fs/temp 7, fs_convenience 9,
  sys/bufio 22 (wrapper-resolution chain,
  `issues/yo-self-async-future-wrapper-resolution.md`).
- Goal (session `/goal`): make all #69 tests pass; fix bugs/issues along the
  way.

## Definitions

- **s1** = TS-compiled yo-self binary:
  `./yo-cli compile yo-self/main.yo --release -o /tmp/s1` (~8-10 min).
- **stage2.c** = C that s1 emits for yo-self itself; **s2** = clang -O2 of it.
- **STRICT_FIXPOINT** = stage2.c ≡ stage3.c byte-identical (s2 re-emitting
  yo-self).
- A test file "matches" when `<bin> test <file>` rc==0 with the same pass
  count as `./yo-cli test <file>`.

## LANDED 2026-07-22 (this session)

1. **cycle_collector 16/16** (`eeb6e00b9`) — the dup/drop optimizer port
   below, STRICT_FIXPOINT verified. NOTE: stage2/stage3 emits now take
   ~50-55 min each (the "~10-12 min" estimate below is stale).
2. **async-future six** — three stacked fixes, all TS-faithful:
   - call-time return rCT stamp (function.ts:2080 → calls/function.yo
     `_with_resolved_concrete`, per-call fresh-cell rebuild);
   - def-time return rCT stamp (function-type.ts:613 →
     calls/function_type.yo, lineage cell + id-keyed registry);
   - module-namespace records excluded from
     `collect_effect_record_members` marking + module-member dot-callee
     registered REGULAR from the receiver record
     (codegen/functions/collection.yo) — yo-self FuncVal generation churn
     defeated TS's object-identity guard, so module fns were wrongly
     isEffectRecordMember → declaration-time body strip → generic
     `__yo_io_future_t*` prototypes vs concrete `_sync_fut_t*` definitions.
     Full analysis + probe ledger:
     `issues/yo-self-async-future-wrapper-resolution.md`.

## ARCHIVED — the dup/drop optimizer port write-up (landed as `eeb6e00b9`)

The working tree contains the complete **OPTIMIZE_DUP_AND_DROP_PAIRS port**
(the cycle_collector flip). Full write-up incl. both regression rounds:
`issues/yo-self-dup-drop-pair-optimizer-port.md`. Modified files (all
`fmt`-ed and `check`-clean; `src/tests/fixme.yo` is scratch — never commit
it):

- `yo-self/evaluator/exprs/begin.yo` — the real
  `collect_dup_calls_conservatively` (cross-branch conservative dup
  collection, TS begin.ts:348-636), `_optimize_dup_drop_pairs` (application,
  TS 1787-2062; runs right before `_schedule_scope_end_drops`, marks winners
  consumed so the scheduler's e5 gate skips their drop and the M3 driver
  attaches early-return-only drops), `_remove_dup_calls_from_tree`,
  macro-aware `_contains_return_for_opt`. Side tables:
  `g_early_return_dup_ids` (TS `__isEarlyReturnDup`).
- `yo-self/evaluator/utils.yo` — `g_dup_use_site_tokens` +
  `get_dup_use_site_token` (TS `__useSiteToken`), stamped in
  `set_expr_as_needs_to_call_dup`.
- `yo-self/evaluator/calls/helper.yo`, `calls/function.yo`,
  `calls/function_type.yo`, `calls/comptime_fn.yo`,
  `builtins/comptime_fn.yo`, `exprs/recur.yo`, `exprs/test.yo` — ALL 8
  `FuncOrAsyncBlockCtx` creation sites now store
  `eval_env : snapshot_env(...)`. This fixes systemic `captured_variables`
  pollution: the live env's frame count grew when the body's begin frame was
  pushed, so plain body locals looked "outer" to `track_variable_usage` and
  were tracked as captures (TS envs are persistent — frames.length frozen at
  body entry). Without this the optimizer's captured-name gate kills every
  candidate.
- `yo-self/codegen/exprs/return.yo` —
  `generate_early_return_only_deferred_drop_expressions` now gates EVERY drop
  on `scope_stack_contains(declared_scopes, c_name)` (was: minted temps
  only). Required because the optimizer's consumption exposes the C
  decl-emission-order divergence (`x := match(...)` emits x's C decl AFTER
  the switch; source-token gates pass; TS is protected by per-return
  point-in-time env lookups that yo-self's retroactive envs defeat).
- New issue docs (untracked): `issues/yo-self-dup-drop-pair-optimizer-port.md`,
  `issues/ts-constructor-result-drop-o0-crash.md`.

**Validation status** (binary `/tmp/s1dup9`, artifacts `/tmp/d9_stage2.c` +
`/tmp/d9_s2bin` already built):

- GATE A stage2 emit + clang: **rc=0, 0 errors** (this was the round-2
  failure; fixed).
- GATE B corpus diff-test: **PASS 139 / DIFF 1** — the port RESOLVED the old
  `ptr_deref_copy_rc_struct` DIFF; the one left (`constructor_result_drop`,
  `ts_rc=139 self_rc=0`) is a PRE-EXISTING **TS-side -O0 crash** (verified
  against pre-port binaries; documented in
  `issues/ts-constructor-result-drop-o0-crash.md` — open TS bug, not yours).
- GATE C `check ./std`: 153/153.
- GATE D 21 test files incl. **cycle_collector 16/16**, regex 140/140, json
  35/35, hash_map 61/61, algebraic_effects 72/72: ALL GREEN.
- GATE E STRICT_FIXPOINT: **NOT COMPLETED** — the stage3 emit was killed
  twice by session teardown mid-run (long background jobs on this box die;
  run it in chunks or `nohup … & disown`).

**To finish (do this first):**

```bash
cd ~/Workspace/Yo
# stage3 emit with the ALREADY-BUILT stage2 binary (~10-12 min), then compare:
YO_MAIN_STACK_MB=4096 /tmp/d9_s2bin compile yo-self/main.yo --release \
  --emit-c --skip-c-compiler -o /tmp/d9_stage3
cmp /tmp/d9_stage2.c /tmp/d9_stage3.c && echo HOLDS
# (If /tmp was cleaned: rebuild s1 from the tree, re-emit stage2, clang it,
#  then stage3 — see BUILD / VERIFY below.)
```

- If HOLDS → commit everything except `src/tests/fixme.yo` (suggested
  subject: `fix(yo-self): cycle_collector GREEN 16/16 (#69 +1, 144/183) —
OPTIMIZE_DUP_AND_DROP_PAIRS port + captured-map/env-snapshot + early-drop
scope gate`), then run a fresh full 183-file sweep
  (`scratchpad/sweep69.sh`, env-overridable `S1=... OUT=...`) — this change
  activates the move optimizer EVERYWHERE, so watch for flips in both
  directions and re-baseline the red list.
- If BROKEN → diff the first divergence; the optimizer is deterministic
  (ArrayList iteration only, no HashMap-order dependence), so suspect the
  snapshot_env change first. Revert-per-file is safe; the port splits cleanly
  (begin.yo+utils.yo optimizer / snapshot_env sites / return.yo gate).
- Sanity repro any time: `/tmp/gcr.yo` (in git? no — recreate from the issue
  doc; needs `open(import("std/fmt"))`) must print `3 → 1 → 0` matching TS.

## REMAINING #69 WORK after cycle_collector lands (39 files)

Red list from the fresh 183-sweep at 142/183 (`/tmp/sweep69_final/results.txt`,
regenerate with `scratchpad/sweep69.sh`), minus regex+cycle_collector:

### A. Gap-6 spec-identity / collection core (~29 files — THE blocker)

`incompatible __yo_tX vs __yo_tY` / `initializing __yo_tX with __yo_tY` /
`undeclared yo_id_N` / `yo_id_..._unknown__Type...` — one logical generic type
gets structurally-divergent specializations (yo-self shares types by lineage;
TS clones per call and mutates by object identity).

Files: arc, cli/arg*parser, closure_capture_rc_leak, collections/{btree_map,
linked_list, ordered_map, priority_queue}, derive_clone_complex, imm_list,
imm_map, imm_set, imm_sorted_map, imm_sorted_set, imm_string, imm_threading,
imm_vec, impl, impl_fn_field_rejection, iso, prelude, rc, ref_closure_capture,
sync/{atomic, channel, mutex, once, rwlock, waitgroup}, thread, worker.
(The timeouts — btree_map/priority_queue/imm_sorted*\*/imm_threading — are the
same family: exponential re-eval through spec dispatch.)

State: attempts #1–#6 preserved on branch `wip/resolution-time-spec`; the
last near-miss (eval-side empty-cfid recovery, batch FTT 36→1) was reverted
because it exposed a CODEGEN layer (type collection + C-identity for
recursive-generic specs) — see memory + `issues/yo-self-sortedset-method-call-type-void.md`
for the salvage plan. This is a dedicated multi-session architectural arc:
budget accordingly, gate with `s2 check std/env.yo` before any sweep, and
expect the dispose family (`sync/*`, ordered_map) to land only after the
spec-identity core.

### B. async-future family (2 files left of 8)

RESOLVED 2026-07-22 for fs/{dir, file, fs_convenience, metadata, temp} +
sys/bufio (see LANDED above). Remaining:

- fs/walker — now COMPILES; 5/6 behavioral failures at runtime ("walk
  nonexistent returns error" etc.) — next-layer triage, log at
  `/tmp/rc3_test_fs_walker.log` shape.
- sys/timer — 1 assertion failure: awaits inside the io.async closure lower
  as BLOCKING sync-await poll loops; needs the multi-await resumable-FSM
  lowering port (io.async closure FSM transform, codegen/async/).

### C. Untriaged (1 file)

sys/signal (rc=138) — nobody has looked yet; triage fresh with
`YO_KEEP_BATCH=1`.

## THE METHOD (non-negotiable — proven over ~30 fix rounds)

1. **Faithful port first.** Find the TS behavior (file:line), port that
   shape. When yo-self's model genuinely differs (value semantics vs TS
   object identity, mutable shared env vs persistent chains), document the
   divergence in a comment AND pick the semantically equivalent mechanism.
   The dup/drop-port round-2 regressions are the canonical caution: being
   BROADER than TS (collector recursing into macro expansions) and NARROWER
   (return detection missing them) both broke self-compile — TS-exactness
   matters in BOTH directions.
2. **Full gate battery after EVERY yo-self change; revert on ANY
   regression.** Current template: `scratchpad/dup9_gates.sh` (order: stage2
   emit+clang FIRST — it catches self-compile breaks in ~15 min — then corpus
   diff-test, `check ./std`, ~21 flipped+spot test files, STRICT_FIXPOINT).
   Green baseline: corpus `PASS 139 DIFF 1` (the TS -O0 pre-existing), std
   153/153, all flip files at their counts, FIXPOINT HOLDS.
3. **Probe before fixing.** `eprintln` probes gated on
   `token.module_path.contains("/tmp/")` (~8-10 min per rebuild — BATCH
   probes). TS-side ground truth is cheap: add a `console.error` probe,
   `bun run build` (seconds), run, `git checkout` the file. Strip ALL probes
   before the gate build.
4. **Batch shape matters.** `YO_KEEP_BATCH=1 <bin> test <file>` keeps
   `.yo_selftest_batch_N.yo` + `.bin.c`. Batches regenerate per run — never
   correlate positions across runs.
5. **Long jobs die on this box.** Background tasks killed at ~40-70 min are
   routine — split gates into chunks, `nohup … & disown`, keep artifacts in
   /tmp so a killed run resumes from its last stage. Never run two `yo-cli
test` invocations over the same directory concurrently; never edit
   yo-self/\*.yo while a build/emission is reading the tree.
6. `./yo-cli compile` cannot take `*.test.yo` — extract a standalone repro
   with `main` + `export(main)`. Standalone repros need explicit
   `open(import("std/fmt"))` for println (it is NOT in the prelude); TS
   def-time eval hard-fails without it while s1 SWALLOWS the failure and
   emits an empty main (known acceptance divergence).

## BUILD / VERIFY COMMANDS

```bash
bun run build                                          # before any yo-cli work
./yo-cli compile yo-self/main.yo --release -o /tmp/s1  # s1 (~8-10 min)
/tmp/s1 compile yo-self/main.yo --release --emit-c --skip-c-compiler -o /tmp/stage2
clang -std=c11 -fno-strict-aliasing -fwrapv -w -O2 /tmp/stage2.c -o /tmp/s2
/tmp/s2 test ./tests/<file> --parallel 1               # the #69 definition
YO_SELF_BIN=/tmp/s1 scripts/diff-test.sh tests/codegen-bootstrap --parallel 4
YO_MAIN_STACK_MB=4096 <bin> …                          # deep-recursion checks
./yo-cli check yo-self/<file>.yo                       # fast type-check loop
./yo-cli fmt yo-self/<file>.yo                         # REQUIRED before commit
```

Always `--release` (user directive). Save verbose output to files.

## HARD-WON INVARIANTS (violate these and you will re-live old sessions)

- **Per-call type identity is THE recurring theme** (Gap-6). Do not weaken
  the landed mechanisms: `_freshen_io_builtin_callee`, call-scoped forall
  rebinds + lineage-identity gate (types/synthesizer.yo), the Step-2 skip
  (calls/helper.yo).
- **THE SHELL PATTERN (6 sites):** any walker of struct fields / enum
  variants may receive a value-copied recursive-`Self` SHELL (empty lists)
  and silently compute "nothing here". New walkers MUST
  `resolve_enum_shell(resolve_struct_shell(ty))` first (types/creators.yo).
- **`Some(UnknownVal)` ≠ a value.** Every ported TS `Boolean(value)` /
  `if (expr.$.value)` gate needs an `is_unknown_val` guard.
- **Pointer arms:** any type-shape dispatch without a `Pointer` case silently
  no-ops for pointer-receiver methods (`type_id_or_empty`,
  `_find_self_level_in_method_ty` were both bitten).
- **Chars vs bytes:** `String.len()` is CHARS; byte loops must use
  `bytes_len()`/`byte_at()`. The emitter scope scanner bug (regex flip) was
  exactly this mixing.
- **Retroactive envs:** yo-self ExprInfo envs share mutable Frames — a
  recorded env SEES later variable adds (TS point-in-time envs do not). Any
  gate that asks "was X bound at this point" must use the emitter's C
  block-scope stack (`declared_scopes` / `scope_stack_contains`), not env
  lookups or source tokens.
- `runtime_arg_exprs_in_order` has a slot per EVERY field (incl. comptime) —
  never index by runtime-field index; match by label.
- Yo syntax: `:=` bindings immutable (reassign needs `(x : T) = …`); no
  forward refs between top-level `::` bindings; no nested match patterns;
  single-expression `{ }` parses as a struct literal (add `;` or drop the
  braces); adjacent different operators need parens; `fn` definitions are
  `name :: (fn(...) -> T)({ ... })`.
- fmt every touched .yo file; lint-staged reformats .md on commit.
- rc=139 at -O0 on deep recursion = stack exhaustion (use `--release` or
  `YO_MAIN_STACK_MB=4096`), and ASan-compiled yo binaries hang at startup
  (unusable).
- Never gate FTT via `--skip-c-compiler` stdout — grep the emitted `.c` or
  use the full clang rc.

## KEY LOCATIONS

- `issues/yo-self-dup-drop-pair-optimizer-port.md` — the in-flight port:
  design, both regression rounds, debug recipe.
- `issues/ts-constructor-result-drop-o0-crash.md` — the open TS-side -O0
  crash (the accepted corpus DIFF 1).
- `issues/yo-self-async-emission-cluster.md` — async/dispose/spec evidence
  ledger (every probe and reverted candidate).
- `issues/yo-self-sortedset-method-call-type-void.md` — Gap-6 attempts +
  salvage plan; branch `wip/resolution-time-spec` preserves attempts #1-#6.
- `issues/yo-self-emitter-scope-scan-chars-vs-bytes.md` — the regex-flip
  root; the emitter scope-stack machinery explained.
- `tests/codegen-bootstrap/` — the 140-file differential corpus (this
  session added index_element_field_store, recursive_enum_arraylist_sizeof,
  recursive_enum_element_retain).
- `scratchpad/` (session-local; may be gone): `sweep69.sh` (full-sweep
  runner), `dup9_gates.sh` (current gate battery). Rebuild from THE METHOD
  if lost.
- Auto-memory (`MEMORY.md` in the agent memory dir) indexes ~90 distilled
  lessons from this campaign — recall before re-deriving anything.

## Step 3 (after #69, or when instructed): finalization

Fixpoint re-verify (full chain), move resolved `issues/*.md` to
`issues/fixed/`, update `yo-self/README.md` status, mark
`plans/BOOTSTRAPPING.md` historical, delete stale `/tmp` pins.
