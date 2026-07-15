# yo-self self-hosting — HANDOFF PLAN (fresh-agent entry point)

_Last updated 2026-07-17 (memory-corruption era CLOSED: double-free rounds 1-6
all fixed; HEAD `41fdb38bb`). Corpus 125 files._

---

## ⇒ START HERE (2026-07-17): all six RC-corruption rounds are FIXED.

## The stage-2 binary now runs `check` AND compiles real modules cleanly.

## Remaining work, in order: (A) one behavioral compile ERROR on the full

## self-compile → (B) the fixpoint diff → (C) tasks #69/#70.

### Current verified state (all committed, tree clean)

| Gate                                                     | Status             |
| -------------------------------------------------------- | ------------------ |
| `s2 check tests/codegen-bootstrap/empty_main.yo` ×3      | rc=0 ✓             |
| `s2 compile yo-self/parser.yo` (emit-c)                  | rc=0 ✓             |
| `s2 compile yo-self/{token,lexer,expr}.yo`               | rc=0 ✓             |
| stage-2 self-emit clang errors                           | 0 ✓                |
| corpus regression tests (5 new this era) + dd/hmap/r4-r6 | all exact ✓        |
| rc()-battery repros (borrow, arm-tail) vs TS             | 7/7 + 3/3 match ✓  |
| **`s2 compile yo-self/main.yo`** (the fixpoint input)    | **rc=1 — see (A)** |

`s1` = TS-compiled yo-self (`./yo-cli compile yo-self/main.yo --release`).
`s2` = clang -O2 of s1's emitted `stage2.c`. Builds from the last session (in
/tmp; regenerate with the loop below if gone): `/tmp/yo-self-r6` (s1 at HEAD),
`/tmp/stage2_r6.c`, `/tmp/s2r6` (s2 at HEAD).

### The six fixed rounds (context for what "this era" was)

A clean baseline s2 used to CRASH on `check empty_main.yo` (rc 139/133/124,
allocator-layout-dependent) — a SERIES of RC divergences, each corrupting the
heap. Every round: root-caused → fixed faithfully against the TS oracle →
regression-tested → committed:

1. `dyn(payload)` consumption (dyn.yo; test dyn_throw_double_drop.yo).
2. cond BEGIN-ARM final-expr deferred dup missing in `_emit_begin_arm`
   (8377998c1; test cond_begin_arm_borrowed_tail.yo).
3. Borrowed FIELD returns — generate_return ran the dup emitter before
   declaring the arg temp (undeclared-temp gate ate the +1; port of
   return.ts:556-598) + `wrap_body_in_begin` skipped bare 2-arg `.` bodies +
   the begin-tail nrv==0 fallback (1f5c56b88; test borrowed_field_return.yo).
4. Assignment save-old-value temp dropped on ESCAPE paths in addition to the
   local's scope drop — `current_assignment_save_temp` threaded through the
   codegen context (5f1af3622; test assign_rhs_escape_double_drop.yo).
5. MATCH-arm begin-body final-expr dup missing in `generate_case_body`'s
   begin branch (extracted `_arm_value_with_dups`, applied to both branches;
   f44728cca; test match_arm_begin_tail_borrowed.yo). This was the
   `s2 compile parser.yo` UAF (`_resolve_effect_arg` returned Environments
   at net −1 per call).
6. Raw-pointer DEREF-COPY of an RC-carrying struct (`bucket := (data_ptr &+
i).*`) got scope/early-return drops but no dup — TS dups AT THE COPY
   (`Bucket___dup(temp)`). Fixed in codegen/exprs/init_assignment.yo
   (41fdb38bb; shape test ptr_deref_copy_rc_struct.yo). This was the
   `s2 compile main.yo` freelist corruption (HashMap.\_find_bucket stole the
   map's own key+value on every probe hit; the String-eq UAF in the
   closure-capture traversal).

Full forensic log of all six rounds, every dead end, and every tool:
**`issues/yo-self-dyn-throw-double-drop.md`** — read it before touching
anything RC-related.

---

## (A) RESOLVED at handoff: the "rc=1 error" was a jetsam OOM in disguise

**Round-7 outcome (2026-07-16, commit b2a3eccdb):** the post-round-6 failure
on `s2 compile yo-self/main.yo` is **NOT a bug** — it is **rc=137 = SIGKILL
= jetsam OOM** during the CODEGEN phase on this 16 GB box. The earlier
"rc=1" readings were `/usr/bin/time` and pipe artifacts masking the signal.
Established facts (do not re-derive):

- `s2 check yo-self/main.yo` PASSES rc=0 — the full EVALUATION of the
  compiler through s2 is clean.
- The top-level exn handler never ran (its eprintln writes an unconditional
  `\n` to unbuffered stderr; every captured log is 0 bytes); the emitted C
  `main` returns 0; the only reachable `exit(1)` sites are the exn handler
  and the fmt-check path. So no error path fired — the process was killed.
- s1 completes the identical compile at ~9-10 GB; s2's codegen phase grows
  past the box limit → the remaining gap is the OLD footprint class (s2
  under-frees vs s1), NOT corruption.

**What to do (two tracks, both valuable):**

1. **Unblock the fixpoint NOW (mitigation):** run the emission with bounded
   GC — `YO_MAIN_STACK_MB=4096 YO_GC_FULL_PCT=130 /tmp/s2r6 compile
yo-self/main.yo --release --emit-c --skip-c-compiler -o /tmp/stage3`
   (slower but memory-capped per the 2026-07-13 notes; expect a long run).
   OUTCOME at handoff: the `YO_GC_FULL_PCT=130` run ALSO died rc=137 after
   ~30 min — the 16 GB box cannot hold s2's codegen-phase footprint even
   GC-bounded. Remaining options, in order: (i) fix the ctor-arg leak
   (track 2 below) and retry — the structural fix, likely closes most of
   the gap; (ii) try `YO_GC_THRESHOLD=200000` (more aggressive incremental
   collection; untested here); (iii) run the emission once on any ≥32 GB
   machine (the 2026-07-13 notes confirm the chain completes there) just to
   bank the fixpoint diff while track 2 proceeds.
2. **Close the footprint gap (the real fix):** the PRIME suspect is
   **`issues/yo-self-ctor-arg-move-vs-dup.md`** — yo-self dups struct-ctor
   RC args where TS MOVES (consumes) them: +1 per construction, and the
   compiler constructs millions of ExprInfo/Variable/TypeValue nodes.
   Fast repro exists (/tmp/deref_battery.yo: TS rc=1 vs self rc=2).
   Fix = port TS's ctor-arg consumption (`setExprAsConsumed` on owning
   args; dup only for borrowed) — see the fv_p_owning block in
   evaluator/calls/function.yo (the move machinery already exists for
   SOME paths) and TS function.ts constructor arms. CAUTION: this is an
   RC-semantics change — over-drop risk; run the FULL gate cascade
   (hmap tracked=2 is the over/under oracle) and the corpus before
   trusting it. Secondary suspects if that's not enough: the historical
   under-drop notes in the OOM section far below (normal-path drop gap,
   `issues/yo-self-fixpoint-eval-phase-leak.md`).

## (B) THE FIXPOINT (task #3) — once (A) exits rc=0

`/tmp/stage3.c` exists → normalize temp identifiers in BOTH files and diff:

```python
# normalize: map each match of these patterns to sequential per-file ids in
# first-occurrence order, then compare:
#   _file____\w*_temp_\d+     temp_dup_\w+_yo_id_\d+   __yo_sc_yo_id_\d+
#   loop_yo_id_\d+             continue_[a-z0-9]+         __yo_ref_spill_\d+
#   i_[a-z0-9]{6,}              temp_array_[a-z0-9]+       temp_dup_[a-z0-9]+
```

Byte-identical after normalization → **FIXPOINT-OK** (the mini-fixpoint on
small programs already passes byte-identically). If diffs remain: sample the
first few divergence sites and classify — iteration-order nondeterminism
(HashMap ordering feeding emission order) is the expected benign class; a
REAL divergence means s2 evaluated something differently → treat as (A)-class
bug. Two s1 emits are already byte-identical (determinism holds on s1), so
any nondeterminism is s2-specific state.

Practical notes: the emission needs ~7-10 GB and minutes at -O2; ALWAYS
`YO_MAIN_STACK_MB=4096`; never let two emits write the same .c concurrently.

## (C) AFTER THE FIXPOINT: tasks #69 / #70

1. **#69:** `/tmp/s2 test ./tests --parallel 8` should pass what
   `./yo-cli test ./tests` passes (~30 min under TS). Start with a
   representative subset (e.g. `test tests/algebraic_effects.test.yo
--parallel 1`) before the full run.
2. **#70:** `/tmp/s2 test ./yo-self/tests` likewise
   (eval_basics/eval_tail_1/eval_tail_2 are known-heavy — validate via
   check + sweeps per `yo-self/README.md`).

## Filed follow-ups (not blockers, do after A/B or when touched)

- **`issues/yo-self-ctor-arg-move-vs-dup.md`** — struct-ctor RC arg: TS
  MOVES (consumes), yo-self DUPS (+1) → a systematic leak class (inflated
  Gc counts), found via /tmp/deref_battery.yo (TS rc=1 vs self rc=2). Not a
  UAF; fix by porting TS's ctor-arg consumption.
- s1 SIGABRT compiling `(-(i32(1)))` in a match arm + `void* t = (-(self));`
  int/ptr miscompile (corner case; s1 compiles main.yo fine).
- Re-evaluate the REVERTED specialization-signature split (helper.yo `_id_`,
  type_key.yo Pointer branch, emitter DECL_RE refactor) on their own merits —
  their old crash verdicts were invalidated (baseline crashed identically);
  see issues/yo-self-specialization-signature-type-identity.md.
- Evaluator perf parity for cumulative `check ./yo-self` (runaway after
  ~166 files — registry growth; see the perf section far below).

---

## THE HUNT METHOD + TOOLING (proved out over rounds 1-6 — reuse, don't reinvent)

**Faithful-port discipline (non-negotiable):** for every bug — (1) confirm
the TypeScript compiler (`./yo-cli`) behaves correctly on the same input;
(2) find the yo-self DIVERGENCE from `src/`; (3) fix yo-self to match
`src/`. If TS is also wrong, fix TS first, then port. NO workarounds.

**The iteration ladder (cheapest first):**

1. **rc()-assertion battery** (seconds): a small .yo file exercising the
   suspect shape with `rc(x)` / `Gc.tracked_count()` prints; compile with
   BOTH `./yo-cli` and the current s1; diff outputs. Existing batteries:
   /tmp/borrow_battery.yo, /tmp/arm_tail_battery.yo (recreate from the
   corpus tests if gone). Caveat: small shapes don't always reproduce —
   marks can survive in simple contexts and only die in the multi-pass /
   specialization context of the real compiler source.
2. **Input bisect** (seconds-minutes): `s2 compile` on yo-self modules
   individually (token → lexer → expr → parser → …) or a scratch main
   importing subsets. This turned a 10-min repro into seconds twice.
3. **Emitted-C audit** (minutes): find the function in the .c via a
   distinctive string literal, read the RC ops around the suspect site, and
   compare with the TS oracle emission `/tmp/stage1-ref.c` (regenerate:
   `./yo-cli compile yo-self/main.yo --release --emit-c --skip-c-compiler
-o /tmp/stage1-ref`). The emitted C is GROUND TRUTH.
4. **Memory forensics** (only if corruption returns) — all in
   `scratchpad/oplog_patch.py` (patch a `--allocator libc` emission, clang
   -O0 -g):
   - **freelog**: append-only (freed ptr, dropper ra) ring at every RC free
     — collision-proof last-free attribution.
   - **quarantine**: ALL `__yo_free` sites wrapped; 64K-delay reuse ring +
     hash set → deterministic DOUBLE-FREE trap with both ra values.
   - **RC tombstone**: freed headers stamped 0xDDDDDDDD; incr/decr on a
     stamped object aborts with the second-toucher ra.
   - **slide-independent ra reporting**: prints `ra − &__freelog_find`;
     symbolicate as `nm binary | grep __freelog_find` + offset → `atos -o
binary <hex>`. **atos ra values point ONE LINE AFTER the real call.**
   - Guard Malloc (`DYLD_INSERT_LIBRARIES=/usr/lib/libgmalloc.dylib`, lldb
     `-k` crash commands) traps the first UAF read exactly, but OOMs on
     large inputs (page-per-alloc) — use the bisected small input.
   - oplog (per-object op-history table): direct-mapped — COLLIDES under
     real load; don't trust a 1-op dump. Prefer freelog+tombstone.
5. **Probe placement rules** (the "Frame level N has different number of
   values for different cases" evaluator quirk kills builds):
   - eprintln probes build ONLY in `evaluator/utils.yo` — inline
     `if(gate, eprintln((A + B)))` chains, no new decls in match arms.
   - A helper FN defined in utils.yo and CALLED from begin.yo works.
   - Direct eprintln in begin.yo / property_access.yo / drop_dup.yo TRIPS
     the quirk.
   - C-comment probes via `em.emit_string_line("/* ... */")` work ANYWHERE
     in codegen and land exactly at the emission site — often the best tool.
   - Tag probes with `ast_expr_token(e).value` + `.row` (0-indexed) to
     identify AST nodes across eval passes.
6. **lldb one-shot recipes**: `lldb -b -o "env ..." -o run -k "bt 12" -k
"expr (void)__freelog_find(ptr)" -k quit BIN -- args…`; read struct
   fields at the trap with `p ((__yo_t59*)ptr)->env` etc. (print fields
   INDIVIDUALLY — full dumps truncate). ExprInfo=**yo_t59, Environment=
   **yo_t60, AstExpr=**yo_t26, String=**yo_t2 in recent emissions (verify
   per emission).

**Known pitfalls that cost rounds (don't repeat):**

- A 40-line-window grep audit of "dups near returns" produced a FALSE
  verdict (round-2 detour) — long drop blocks push the dup out of any fixed
  window; audit per-function with brace-aware extraction instead.
- Eval marks (`deferred_dup_expressions`, `variable_name`) are PASS-FRAGILE:
  later passes `expr_info_table_set` fresh ExprInfos and can lose marks.
  Codegen paths must tolerate mark-less shapes (see round 6's fix pattern).
- yo-self's TWO liveness proxies — the recorded END-of-scope env and the
  C-declaration-order set (`declared_c_var_names` + emitter scope stack) —
  each fail for specific shapes (declared-early/eval-late, eval-early/
  declared-late). TS needs neither: its per-expr point-in-time envs are the
  gold standard. When they disagree, mirror TS's OBSERVABLE emission.
- `/usr/bin/time` + output redirection can swallow the program's own stderr
  tail on abnormal exit; rerun plainly to capture error messages.
- The `hmap` leak oracle (`/tmp/hmap.yo`, recipe in the OOM section below)
  must stay `tracked=2`; dd stays `tracked=0`; any drift = over/under-count
  regression.

---

## Previous session notes (2026-07-15 evening)

**What landed this session (all deterministic gates green — hmap `tracked=2`,
stage-2 self-emit clang 0, corpus PASS/DIFF 0, checks 303+153, double-emit
byte-identical):**

1. **The OOM leak fix** (commit `993b4162c` + follow-ups): scalar `:=`
   registration one-liner + scope-stack drop gates (loop-exit `atom.yo`,
   early-return env path `return.yo`) — the 84 out-of-scope-drop clang errors
   fixed; `HashMap._find_bucket` overwrite leak `101→2` (== TS).
2. **GcTracer visit body/signature consistency** (`codegen/exprs/gc.yo`): the
   3 `.key.tag on size_t` clang errors fixed deterministically (walk the type
   the enclosing fn's C signature resolves to). Full analysis:
   `issues/yo-self-specialization-signature-type-identity.md` (incl. why the
   instantiation-precise specialization split was REVERTED — helper.yo /
   type_key.yo — and what to re-evaluate later).
3. **Round-1 double-free fix** (`evaluator/values/dyn.yo`): `dyn(payload)`
   must consume its payload — port of TS `setExprAsNeedsToCallDup`
   (dyn.ts:321). Repro `tests/codegen-bootstrap/dyn_throw_double_drop.yo`.
   Full analysis + THE HUNT METHOD: `issues/yo-self-dyn-throw-double-drop.md`.

**THE BIG DISCOVERY (read `issues/yo-self-dyn-throw-double-drop.md` first):**
the old premise "s2 runs but OOMs" is FALSE today — a clean `7d6b0385a`
baseline s2 CRASHES on `s2 check tests/codegen-bootstrap/empty_main.yo`
(rc 139/133/124, allocator-layout-dependent). The cause is a SERIES of
pre-existing RC divergences (missing consumption/dup marks) that corrupt the
heap during prelude eval; they present as heisenbugs where any emission change
appears to "cause" the crash. Round 1 (dyn payload) is fixed; **round 2 is
open**: Guard Malloc traps `__yo_incr_rc` on a freed page in
`ArrayList.get` ← `evaluate_function_parameter` ← param loop ←
`synthesize_function_type_from_tokens`. Use the documented hunt method
(Guard Malloc bt → TS oracle diff at the same site → seconds-fast standalone
repro → evaluator fix). `s2 check empty_main.yo` health ×3 is the round gate;
the fixpoint (below) is the finish line.

---

## (HISTORICAL — superseded by the section above) 2026-07-15 morning entry point

Everything up to the byte-exact fixpoint (`diff stage2.c stage3.c`) is done EXCEPT
that `s2` (the self-compiled yo-self binary) uses too much memory compiling
`yo-self/main.yo` to complete on this 16 GB box. This session **root-caused that OOM
to a single, precisely-located leak with a PROVEN one-line fix** — but that fix
unmasks a latent codegen-liveness bug that must be fixed alongside it. Read
**"REMAINING WORK — the OOM, in full detail"** below; it is the whole job. Tasks
**#69/#70** are gated on it.

**Committed green this session (both self-emit clang-clean, corpus 119/DIFF 0, check ./yo-self 303/303):**

- `875f99e21` — struct/enum/union **constructor result materialization**: the three
  constructor arms of `evaluate_function_call` (`yo-self/evaluator/calls/function.yo`
  — `.Struct`/`.EnumT`/`.Union`) now call `attach_temp_variable_to_expr(expr,true,ctx)`
  like TS (`src/evaluator/calls/function.ts:2461/2527/2567`), so a DISCARDED constructor
  result (`Foo(x:1);`, a ref arg to a borrowed param) is dropped. Repro 82 MB→1.5 MB.
  Added regression `tests/codegen-bootstrap/constructor_result_drop.yo`.
- `7d6b0385a` — **cond/if arm scope-end drops on fall-through**: `_emit_begin_arm`
  (`yo-self/codegen/exprs/cond.yo`) now emits the arm begin-block's
  `deferred_drop_expressions` at normal completion (faithful to TS cond.ts:401-403).
  Owning locals in a cond/if arm are dropped on the fall-through path.

Neither of those, alone, is enough to make the full-`main.yo` emit fit in 16 GB — see below.

---

**Goal:** make yo-self compile itself **correctly**:

1. ~~Stage-2 emit: 0 clang errors~~ — **DONE, deterministic** (re-verified
   2026-07-10 after regressing to 416 during the assert refactor; the four
   fixes are in issues/fixed/yo-self-stage2-clang-errors.md).
2. ~~Fix the stage-2 BINARY runtime (parser + fmt divergences)~~ — **DONE
   2026-07-11.** Both named divergences were ONE bug class: token-String
   use-after-free from `ArrayList(ref-struct).get()` emitting no element
   dup (the "paren-less" error, the empty module path, AND the fmt
   HashSet-null panic were all downstream corruption). Fixed by the
   4-layer RC chain (commit 6e2313264) + unwind coverage / borrowed-tail
   return dup (5a5d28d15); `fmt --check` and sandbox/real-prelude checks
   now match stage-1 (rc=0). Frontend fidelity audit also landed
   (66326af85 — 8 lexer/parser divergences incl. the `:=` operator-guard
   workarounds).
   **← YOU ARE HERE: one residual stage-2 UAF blocks the full
   self-compile** — `expr_info_table_get` returns a freed ExprInfo during
   `evaluate_initialization_assignment` on any nontrivial module
   (5-second repro + guard-malloc pin + verified-clean components in
   issues/yo-self-stage2-unwind-check-coverage.md).
   The residual UAF (`evaluated_callee` double-drop) was fixed 2026-07-12
   (commits 6b5c0ceb0, 4b3fc4043 — `set_expr_as_needs_to_call_dup` env store
   - `___dup(evaluated_callee)`). Corpus diff-test PASS / DIFF 0, `check ./std`
     clean.
3. Verify the **self-hosting fixpoint** (required, see below).
   **← STATE (2026-07-15, LATEST — OOM ROOT-CAUSED; one-line fix proven but blocked
   by a liveness-tracking bug. This supersedes all older sub-states in this item.):**
   See **"REMAINING WORK — the OOM, in full detail"** immediately after the
   faithful-port note. Short version: the full-`main.yo` fixpoint is blocked ONLY by
   s2's memory. The dominant leak is `HashMap.set` same-key overwrite leaking the
   replaced value (proven with a 10-line repro: TS `tracked=2`, yo-self `tracked=101`);
   root = `_find_bucket`'s `bucket := (data_ptr &+ i).*` value-struct local not dropped
   on its early-`return` path, because the scalar `:=` codegen didn't register its C
   name. The one-line fix (`init_assignment.yo`: `get_type_string` →
   `get_variable_type_string`) makes the repro `101→2` (== TS) but unmasks ~20
   out-of-scope `__yo_decr_rc` clang errors on self-emit (a branch-blind liveness
   signal). Fixing BOTH together is the job.

   **(older 2026-07-13 state — escape-path leak FIXED, commit `b73ddfcc7`):**
   The ~60GB eval-phase RC leak that OOM-killed s2 compiling `main.yo` is FIXED.
   s2's memory is now **bounded** (1.3GB at the default GC threshold; ~8GB at
   `YO_GC_THRESHOLD=5000000`) — no more 56-73GB jetsam kill. Root+fix: on the
   `__yo_effect_escaped` escape path, yo-self kept/skipped pending deferred drops
   using an unreliable heuristic; the correct signal is a **block-scope stack
   maintained by the emitter** tracking EVERY C brace (string/char/comment-aware
   char scan; `_emitter_track_scope`, emitter.yo), against which the escape gate
   (`return.yo _keep_pending_drop`) keeps a drop iff its target is still in an
   open C scope. Verified: `stage2.c` self-emit 0 clang errors (was 20 with a
   begin-block-marker-only tracker); `check ./yo-self` 303/303; corpus PASS 118 /
   DIFF 0. Full analysis: **`issues/yo-self-fixpoint-eval-phase-leak.md`**.

   **REMAINING blocker to a byte-exact `diff stage2.c stage3.c` (the separate
   #78/#65 evaluator-perf task, NOT a leak):** s2 emits stage3.c very slowly
   because the cycle-GC (`__yo_gc_collect`) thrashes — many RC drops are still
   missing on the NORMAL (non-escape) paths, so the collector does the reclaim
   RC should. GC-disabled (`YO_GC_THRESHOLD=0`) OOMs on compressed memory;
   GC-enabled bounds memory but runs long. Closing the normal-path drop gap to
   TS parity is what remains to make the full-`main.yo` fixpoint complete in
   practical time. (The mini-fixpoint on small programs is already byte-identical.)

   **(older 2026-07-13 state — superseded by the above):** the self-compiled
   binary LEAKS ~60GB compiling `main.yo`. Prior "needs a 32GB box" (task
   #21) is a MIS-DIAGNOSIS: the control binary s1 (TS-compiled yo-self) does
   the identical compile in 76s / 9.2GB peak and COMPLETES; s2 (self-compiled)
   balloons to 56-73GB (compressed — RSS lies, watch `top -stats mem,cmprs`)
   and is jetsam-killed (rc=137). It is an **eval-phase RC leak**, dominated by
   callee-environment Variables (`new_variable`, 2.7M+ live at 15s) never
   dropped on the `__yo_effect_escaped` throw-propagation paths that fire
   millions of times during def-time trial-eval. This is a yo-self codegen
   drop-emission divergence from TS (which reclaims the dead state via its
   tracing GC).

   **STATE (2026-07-13, LATEST) — leak ROOT-CAUSED + FIXED (TS fully, yo-self
   partially); the earlier "node-attached ExprInfo ~750-site" plan below is
   SUPERSEDED.** The real bug was NOT the never-pruned table per se — it was the
   `declaredCVarNames` drop-skip gate (commit 68f5cb49c) skipping ~88,000 live-RC
   temp drops: `declaredCVarNames` was grown only via `getVariableTypeString`, but
   ~30 result/argument temp-declaration paths build the declaration via
   `getTypeString` → untracked → the gate wrongly skipped their drops → the 6x
   leak (invisible to corpus — a leak, not a double-free, leaves output unchanged).
   FIX = centralize declaration tracking in the Emitter (record every codegen temp
   DECLARED in an emitted code line, in C-emission order):

   - **TS codegen — FULLY FIXED (commit 0b9928b95):** s1's `main.yo` emission
     **56G → 9.2G and COMPLETES** (produces stage2.c). temp-drops 20021 → 107960
     of 108281 (the 321 remaining = the one genuine phantom). corpus PASS 118/DIFF 0.
   - **yo-self codegen — PARTIAL (commit 2e329eeee):** ported the Emitter capture
     (manual parse, no regex). s2 (built from yo-self-codegen-emitted stage2.c)
     **56G → 26G**, builds, s2 RUNS, corpus PASS 118/DIFF 0.
   - **Fixpoint chain run:** s1→stage2.c @9G ✓ → build s2 ✓ → s2→stage3.c reaches a
     26G plateau but OOM-kills on this **16GB** box → `diff` not produced HERE.
     **RUNNABLE NOW on a 32GB box** with these commits (26G < 32GB).
   - **Residual (26G→9G on 16GB):** temps declared UNINITIALIZED then branch-assigned;
     their valid post-init drops are still skipped (init-decl-only recording misses
     them). Three recording-broadening shortcuts were tried + reverted (blind→clang
     errors; uninit-`;`-decl→s2 startup crash; init-assignment→s2 startup crash) —
     a flat `declared_c_var_names` set cannot model cross-branch init state.
     TRUE FIX = strengthen yo-self's pre-init-drop guard
     (`_variable_initialized_after_cleanup_point`/`initialized_at_token`, return.yo)
     to TS parity (per-branch init tracking); a separate control-flow-correctness
     effort that must be validated with the full s1→s2→stage3 chain (corpus cannot
     catch the crash). Full analysis: `issues/yo-self-fixpoint-eval-phase-leak.md`.

   ***

   **(SUPERSEDED — historical) root cause was the unported M3 milestone; codegen half
   LANDED, evaluator half is an architecture task:**

   - The leak = yo-self's `_schedule_scope_end_drops` (begin.yo) big-hammer
     SKIPS scope-end drops for every control-flow-bearing block (`skip_block`),
     so `callee_env` + per-call env Variables are never dropped. TS has the M3
     early-return-drop machinery (begin.ts:2064-2140) and does not leak.
   - **DONE + committed (`68f5cb49c`):** the TS-codegen `declaredCVarNames`
     drop-emission gate — removing `skip_block` otherwise trips a latent
     undeclared-C-temp cascade (20 clang errors); with the gate, s1 builds M3
     with **0 errors**. Gate alone is regression-free (s1 clean, `check ./std`
     153/153, corpus PASS 118 / DIFF 0 / SELF-FAIL 0).
   - **BLOCKER (do NOT just re-apply `skip_block` removal):** M3 as a faithful
     port explodes s1's _compile-time_ memory to 56GB (rc=137) — it eagerly
     builds+pins a `___drop` AST node per owning-RC local per block per
     specialization on ExprInfo (via `generate_expr_from_code`), and the
     compiler's giant control-flow fns × specializations make it unbounded.
     RULED OUT (commit `8bac1ddbf`): aggressive GC (`YO_GC_THRESHOLD=64`, nodes
     are pinned not cyclic) and direct AST-build (cost is node COUNT).
   - **ROOT CAUSE PINNED (2026-07-13):** the leak is NOT drop-node-specific — it is
     the never-pruned global `expr_info_table` (`expr_info.yo:456`,
     `HashMap<ExprId,ExprInfo>`), where every `ExprInfo` holds an `env` snapshot
     (`expr_info.yo:317,410`). TS stores this on the node (`expr.$`,
     `src/expr.ts:495,510`), so V8 GC reclaims a specialization's `$` (incl its `env`)
     once its cloned AST is unreachable → bounded. yo-self keeps every entry forever →
     ~60GB compiling main.yo; removing `skip_block` (M3) adds an env-carrying `___drop`
     node per owning-RC local per (ubiquitous) control-flow block → +56GB. See the full
     analysis in `issues/yo-self-fixpoint-eval-phase-leak.md`.
   - **ALL cheap shortcuts RULED OUT (each committed as evidence this session):**
     null-`env`-post-eval (codegen READS `info.env` — 216 TS / 73 yo-self sites, incl
     `get_variables_from_env`); per-specialization table pruning (no safe reclaim
     boundary — specialization is interleaved/lazy and each body is re-walked by
     multiple later codegen passes, frames shared across functions); `is_executing`
     mode-gate (corpus **DIFF 6** — drops are needed in non-executing mode too).
   - **THE FIX (task #21) — node-attached ExprInfo, faithful 1:1 with TS `expr.$`:**
     add `info : ref(Option(ExprInfo))` to `AstExpr.Atom`/`FnCall` (`expr.yo:283-284`);
     rewrite the ~635 `expr_info_table_get/set` call sites (all have the node in scope —
     627 inline `ast_expr_id(node)`, 8 via node-in-scope id locals) to read/write
     `node.info.*`; init the cell in the ~119 `AstExpr` constructors + parser + the
     `Clone` impl (shares the cell = today's same-id semantics) + `clone_expr_fresh_ids`
     (fresh `ref(None)` = TS `$: undefined`) + `make_err_expr`. Then a dropped
     specialized body reclaims its nodes' ExprInfos+env snapshots = TS GC → bounded.
     Must land **atomically** (cannot stage green: a node written via table but read via
     cell returns `None` → breakage). After it lands: re-apply `skip_block` removal on
     the landed `declaredCVarNames` gate (`68f5cb49c`), validate corpus+std, rebuild s2,
     confirm `s2 emit main.yo` footprint bounded (~≤10GB), then run the fixpoint. This is
     a ~750-site mechanical-but-atomic refactor scoped for a dedicated multi-hour
     effort — it is NOT bounded-turn-safe (cannot be landed AND fully validated within a
     single turn without risking the verified-green compiler).

4. Tasks **#69** (`stage-2-binary test ./tests` passes) and **#70**
   (`test ./yo-self/tests` passes) — gated on item 3's leak fix.

**Faithful-port discipline (non-negotiable):** for every bug — (1) confirm the
TypeScript compiler (`./yo-cli`) behaves correctly on the same input; (2) find
the yo-self DIVERGENCE from `src/`; (3) fix yo-self to match `src/`. If TS is
also wrong, fix TS first, then port. NO workarounds, NO stubs.

---

## REMAINING WORK — the OOM, in full detail (2026-07-15) ⇐ THE WHOLE JOB

**Definition of done:** `s2` (self-compiled yo-self) emits `stage3.c` from
`yo-self/main.yo` within ~10 GB, `diff stage2.c stage3.c` is byte-identical
(after temp-id normalization) = FIXPOINT-OK, corpus stays 118/DIFF 0, `check
./yo-self` 303/303, and the self-emitted `stage2.c` clang-compiles with 0 errors.
Then do tasks #69/#70.

### What the OOM actually is (verified this session, don't re-derive)

- `s1` = yo-self compiled by TS (`./yo-cli compile yo-self/main.yo --release`).
  `s2` = clang(`s1`-emitted `stage2.c`). BOTH are native RC binaries — the only
  difference is which CODEGEN emitted their C (TS vs yo-self). So `s1`-vs-`s2`
  differences isolate **yo-self codegen bugs**, never RC-vs-GC.
- `s1` compiles `main.yo` in ~80 s / ~10 GB and COMPLETES. `s2` balloons (≥97 GB
  footprint) and jetsam-kills on this 16 GB box. Measured freed-fraction (patch
  `__yo_gc_register` to print cumulative allocs at each GC scan — see
  `scratchpad/patch_alloc.py`): at 524 K live objects, `s1` had already freed ~90 %
  of allocations, `s2` only ~12 %. So `s2` under-frees ~9×.
- **Dominant leaked type = `Variable`** (histogram by `dispose_fn` at matched
  alloc count: `scratchpad/patch_alloc_hist.py`), then `Environment`, `ExprInfo`
  (an ExprInfo pins an env → frames → Variables). These are the compiler's
  per-eval structures.
- **Reduced to a 10-line behavioral repro** (`/tmp/hmap.yo`):
  ```rust
  { println } :: import("std/fmt");
  Gc :: import("std/gc");
  { HashMap } :: import("std/collections/hash_map");
  Node :: ref(struct(x : i32, next : Option(Self)));   // cyclable → tracked_count sees it
  main :: (fn() -> unit)({
    m := HashMap(i32, Node).new();
    (j : i32) = i32(0);
    while(j < i32(100), { m.set(i32(7), Node(x : j, next :.None)); j = (j + i32(1)); });
    println(`same-key-overwrite tracked=${Gc.tracked_count()}`);
  });
  export(main);
  ```
  **TS-compiled → `tracked=2`. yo-self-compiled → `tracked=101`** (every overwrite
  leaks the replaced Node). NOTE: `Node` must be cyclable (the `Option(Self)`) —
  `Gc.tracked_count()` is BLIND to acyclic types, and the GC also masks the leak
  once the count crosses its auto-collect threshold, so keep the count small.
  `main.yo` hits this via `expr_info_table_set` → `HashMap.set` overwriting the same
  expr-ids millions of times during def-time re-eval.

### The exact root (verified via per-Node RC trace + emitted-C reading)

Runtime trace (`scratchpad/patch_node_rc.py` patches incr/decr on the Node's
dispose_fn; run the 3-iteration `/tmp/hm3.yo`): the replaced Node gets **4 incr /
4 decr → stays rc=1** (should reach 0); TS does **2 incr / 3 decr → 0**.

Source: `std/collections/hash_map.yo` `_find_bucket` (L171-197):
`bucket := (data_ptr &+ probe_index).*` reads the whole `Bucket` value-struct
(which holds the RC `Node`), uses only `bucket.key`, then
`(bucket.key == key) => return(.Some(probe_index))`. **yo-self never drops
`bucket`** — not on the early `return` (key match, the hmap case), not on
loop-continuation fall-through. TS emits `bucket = ___dup(...)` AND
`___drop(bucket)` before the early return.

There are TWO independent codegen gaps behind this:

1. **Fall-through drop — FIXED & COMMITTED (`7d6b0385a`).** `_emit_begin_arm`
   didn't emit an arm's own `deferred_drop_expressions` at normal completion.
   Fixed. `_find_bucket` now drops `bucket` on the fall-through path. (Doesn't fix
   the hmap repro, which always takes the key-MATCH early-return.)

2. **Early-return drop — ROOT FOUND, one-line fix PROVEN, NOT landable alone.**
   Debug-traced `_keep_pending_drop` (return.yo): at the `return .Some(idx)`,
   `bucket` was in the env, not consumed, but
   `declared_c_var_names.contains("bucket") == false` → the C-emission-order guard
   (return.yo:265) rejected the drop. Cause: the **non-array scalar `:=` codegen
   path** (`yo-self/codegen/exprs/init_assignment.yo`, ~L258) built its C
   declaration with `get_type_string(ty)` + manual name append instead of
   `get_variable_type_string(ty, name, ctx)` — and only `get_variable_type_string`
   REGISTERS the C name in `declared_c_var_names` (`codegen/utils/index.yo`, the
   `add` at ~L881). This diverges from TS (`generateInitializationAssignment` uses
   `getVariableTypeString`). **The one-line fix** (use `get_variable_type_string`,
   matching the array path a few lines up at ~L219) → `declared_c=true` → drop
   emitted → **hmap repro `101→2`, hm3 `2,3,4 → 2,3,3`, both == TS. THE LEAK IS
   GONE.** Verified this session.

### Why the one-liner isn't committed yet (the part that needs solving)

Registering the scalar `:=` C names unmasks a LATENT return/escape-path bug:
**~20 `__yo_decr_rc((void*)(X))` for undeclared identifiers** on self-emit
(`base`, `arg0`, `t`, `exp` [collides with libc `exp`], `ft`, `pt`, `res`, `gt`,
`et`, `giv`, `exp_id`, …). These are pending scope-end drops for scalar `:=`
locals that are **not in C scope at that return/escape site** — the drop is
emitted for a var whose C block already closed. Corpus is BLIND to this (small
programs miss it; a leak/undeclared-drop needs specific control-flow shapes only
`main.yo` has), so **the gate for this fix is: self-emit `stage2.c` clang errors == 0.**

Root of the cascade: yo-self does NOT have TS's point-in-time per-expr `env`
snapshot (TS: `expr.$.env`, where a not-yet-completed binding's
`initializedAtToken` is unset). yo-self records an END-of-scope env and
approximates "is this var live here" with:

- `declared_c_var_names` — a **monotonic per-function** name set (never shrinks;
  can't tell a still-open local from a closed-block one), and
- `_emitter_track_scope` (`yo-self/emitter.yo`) — a **flat `ArrayList(String)`
  scope-stack** with `"{"` sentinels, char-scanning each emitted line, pushing
  decls and popping on `}`.

The scope-stack is **branch-blind / brace-imperfect** for yo-self's emitted
`switch`/`case` + inline-enum-drop structure: a var declared in a prior sibling
loop/arm that already closed still reads as "in an open block". Confirmed by
reading the emitted C (e.g. `exp` declared in a `gj < n_giv` loop, dropped in a
later `eei < n_exp_effects` loop where it's out of scope).

**Three fixes were tried this session and REVERTED (all fail the clang-0 gate — do
not simply repeat them):**

- (a) Add `_scope_stack_contains` to `_keep_pending_drop`'s use_env path → fixed
  `base`/`arg0` (use_env drops) but NOT the escape-path drops (`t`/`exp`/…), which
  already use the scope-stack → **the scope-stack itself is wrong for them.**
- (b) `_emitter_track_scope`: change the `//`-comment skip from `i=n` (end of
  string) to skip-to-next-newline → **no change** (emit_string_line lines are
  effectively single-line; multi-line-`//` wasn't the miscount cause).
- (c) The value-struct-dup-result capture in `emit_deferred_dup_or_code`
  (`drop_dup.yo` ~L865, the note's old drafted fix) → made `bucket` own the dup
  but the leak stayed 101 (the missing DROP, not the dup, is the issue).

### The task: land the one-liner + a branch-accurate liveness signal

Two viable strategies (prefer the more faithful one you can validate):

- **Strategy A (bounded, recommended first): make the liveness signal
  branch/brace-accurate.** Land the `init_assignment.yo` one-liner, then fix
  `_emitter_track_scope` + `_keep_pending_drop` so a pending drop is emitted
  **iff** its target's C declaration was emitted AND its enclosing C block is still
  open at this exact emission point. Ideas: track per-Variable "C-decl-emitted &
  block-open" state keyed by the decl's exact site (not a flat name set); or make
  the scope-stack robustly model `switch`/`case`/`if`/`else` + inline-drop braces.
  The clang-0 self-emit gate + the corpus catch regressions; `main.yo`'s own
  self-emit is the only test that exercises the failing shapes.
- **Strategy B (most faithful, larger): give each `AstExpr` a point-in-time `env`
  snapshot like TS `expr.$`.** This is the node-attached-ExprInfo refactor
  described in the (historical) item-3 notes below — it also fixes the never-pruned
  `expr_info_table` memory. Bigger and must land atomically; only do this if
  Strategy A proves intractable.

### Reproduce / validate (fast loop, ~4 min/iteration)

```bash
# rebuild s1 with your yo-self edit (ALWAYS --release):
./yo-cli compile yo-self/main.yo --release -o /tmp/yo-self-bin
# 1) leak gone?  (built /tmp/hmap.yo above)
/tmp/yo-self-bin compile /tmp/hmap.yo --release -o /tmp/hm && /tmp/hm     # want tracked=2
# 2) self-emit clang-clean?  (THE gate for the cascade)
/tmp/yo-self-bin compile yo-self/main.yo --release --emit-c --skip-c-compiler -o /tmp/stage2
clang -std=c11 -fno-strict-aliasing -fwrapv -w -O2 /tmp/stage2.c -o /tmp/s2 2>&1 | grep -c 'error:'   # want 0
# 3) corpus + check (non-negotiable):
YO_SELF_BIN=/tmp/yo-self-bin scripts/diff-test.sh tests/codegen-bootstrap --parallel 4 --release   # 119 PASS, DIFF 0
./yo-cli check ./yo-self          # 303/303
# 4) when 1+2+3 all pass, run the full fixpoint (needs the emit to fit in RAM):
clang -std=c11 -fno-strict-aliasing -fwrapv -w -O2 /tmp/stage2.c -o /tmp/s2
YO_MAIN_STACK_MB=4096 /tmp/s2 compile yo-self/main.yo --release --emit-c --skip-c-compiler -o /tmp/stage3
diff /tmp/stage2.c /tmp/stage3.c && echo FIXPOINT-OK   # (temp-id-normalize if only _temp_/yo_id_ numbers differ)
```

Tooling left in place: `/tmp/hmap.yo`, `/tmp/hm3.yo` (3-iter),
`scratchpad/patch_node_rc.py` (per-Node RC trace), `scratchpad/patch_alloc.py`
(freed-fraction), `scratchpad/patch_alloc_hist.py` (leaked-type histogram).
Full analysis + the ruled-out attempts: agent memory note
`yo-self-fixpoint-gen2-frontier` and `issues/yo-self-fixpoint-eval-phase-leak.md`.

---

## PREVIOUS ENTRY POINT (SURPASSED 2026-07-10 — kept for the repro recipe)

```bash
# Reproduce in ~10 min from a clean tree:
./yo-cli compile yo-self/main.yo -o /tmp/s1                       # stage-1 (~5 min)
/tmp/s1 compile yo-self/main.yo --emit-c --skip-c-compiler -o /tmp/stage2   # (~3 min)
clang -std=c11 -ferror-limit=0 -c /tmp/stage2.c -o /dev/null -I.  # expect 0 errors
clang -std=c11 -w -O0 /tmp/stage2.c -o /tmp/s2                    # stage-2 binary
YO_MAIN_STACK_MB=16384 /tmp/s2 check tests/codegen-bootstrap/template_multibyte.yo
# → prints "parsed 0 top-level exprs" for EVERY file (prelude AND user files)
```

**Everything else cascades from parse-0**: empty codegen types table (~2
structs instead of dozens), NO user functions emitted (its "successful"
compiles produce a runtime-only skeleton — `clang` on its output fails with
undefined `_main`), wrong `needs_cycle_gc` verdict (Lightweight vs cycle-GC
preamble), vacuous "evaluator OK". The stage-2 binary's LEXER or PARSER
yields zero expressions from valid source. 4 rounds of C-diffing proved the
downstream analysis functions (`compute_needs_cycle_gc`,
`can_type_form_rc_cycle`, `buffer_element_type`, `_type_refs_back_to_cyclic`)
are compiled FAITHFULLY — they run on missing data.

### Debug strategy (in order)

1. Find where `"parsed N top-level exprs"` is printed (main.yo check path)
   and what feeds N. Determine WHICH stage fails: file-read (empty String?),
   lexer (0 tokens?), or parser (tokens in, 0 exprs out).
2. **Instrumentation caveat**: eprintln/probe code added near the codegen
   analysis region CRASHED every instrumented stage-2 build (139/138) while
   probe-less builds ran — the binary is fragile to source perturbation.
   Probes in the LEXER/PARSER region are untested and may be fine; if they
   also crash, use **lldb breakpoints on the stage-2 binary directly**
   (function names findable in `/tmp/stage2.c` by grepping distinctive
   string constants, e.g. `"unterminated template string"` → the lexer fn)
   and inspect counts in the debugger WITHOUT rebuilding.
3. The corpus programs (107 tests) emitted by stage-1 all run correctly —
   so the miscompiled construct is something the COMPILER binary uses that
   small programs don't: candidates = module-level mutable globals, the
   file-read path (`read file → String`), very large functions, cross-module
   global maps. A cheap test: point `/tmp/s2` at a NONEXISTENT file — does
   the error path differ from a real file (i.e. is the read returning
   empty)?
4. Once parse-0 is fixed, re-run the mini-fixpoint (below), then the chain.

### Known stage-2-binary environment facts

- `-O0` binaries need `YO_MAIN_STACK_MB=16384` for compile paths (8192
  suffices for `check`); rc 138/139 with an empty log = stack, not logic.
- ~~Bug #2c (`-O1` hang)~~ — SUPERSEDED 2026-07-11: stage-2 binaries are
  now built at `-O2` (clang -std=c11 -w -O2) and run correctly (sandbox,
  real-prelude check, fmt). No hang observed at -O2.
- `sample <pid> 5` on a hung process names the looping fn in one shot
  (worked twice this session). Bad-address values decode as ASCII — e.g.
  `0x2e6c746e63663c20` = `" <fcntl."` = string bytes dereferenced as a
  pointer.

---

## Fixpoint requirement (BEFORE tasks #69/#70 — user requirement)

1. **Stage-2 ≡ Stage-3 (required).** Build the stage-2 binary from stage-2 C,
   have IT emit yo-self again, require byte-identical:

   ```bash
   clang -std=c11 -w -O0 /tmp/stage2.c -o /tmp/s2
   YO_MAIN_STACK_MB=16384 /tmp/s2 compile yo-self/main.yo --emit-c --skip-c-compiler -o /tmp/stage3
   diff /tmp/stage2.c /tmp/stage3.c && echo FIXPOINT-OK
   ```

   Prereq (emission determinism) is DONE — stage-1-emitted stage-2 C is
   byte-identical across runs.

   **STATUS 2026-07-13:** Items 1 & 2 CONFIRMED (stage2.c clang-compiles 0
   errors; UAF fixed). The M3 drop-fix is committed green (corpus 118/0/0);
   it cut the s2 leak 56-73GB→~26GB. **Mini-fixpoint now PASSES** — s1 and s2
   emit BYTE-IDENTICAL C (after `_temp_[0-9]+`/`yo_id_[0-9]+` normalization,
   the only difference being temp-ID numbering) for `empty_main`,
   `fn_body_arith`, `extern_c_puts` (parse-0 cascade is long gone). So the
   yo-self codegen IS a deterministic fixpoint on real inputs.

   **The full-main.yo byte-exact diff (line 202-205) is BLOCKED by perf**, not
   correctness: s2 emits main.yo at ~26GB and the full-heap cycle GC goes
   near-quadratic over that tracked set, so the emit does not complete in a
   reasonable time on a 16GB box (>58min, no completion). `YO_GC_THRESHOLD=0`
   runs fast (~226s) but OOMs at 98GB (the extra heap is reclaimable cyclic
   garbage); `YO_GC_FULL_PCT=130` bounds memory but is slower still. The fix is
   to reduce s2's tracked set to ≈ s1's 10GB by closing the drop-SCHEDULING gap
   (yo-self emits ~7x fewer owned-local drops than TS → cycles survive to the
   GC). See issues/yo-self-fixpoint-eval-phase-leak.md and (BLOCKER, fix first)
   issues/yo-self-gc-traverse-value-struct-field.md.

2. **Stage-1 ≡ Stage-2 (aspirational port-fidelity metric).** Track
   `diff stage1.c stage2.c | wc -l` and drive it down; do NOT block #69/#70
   on byte-equality here — corpus diff-test + level 1 are the correctness
   gates.

---

## Iteration loop + validation gates (EVERY change)

```bash
# Stage-1 rebuild after any yo-self/*.yo edit — ALWAYS -O2 (user directive
# 2026-07-10: -O2 everywhere; kills the -O0 stack-exhaustion class and runs
# the evaluator ~4-10x faster; clang takes a few extra minutes):
./yo-cli compile yo-self/main.yo --release -o /tmp/yo-self-bin &> /tmp/build.txt
tail -1 /tmp/build.txt    # must be "Successfully compiled ..."

# Gates (non-negotiable; REVERT on any regression):
YO_SELF_BIN=/tmp/yo-self-bin bash scripts/diff-test.sh tests/codegen-bootstrap/ --parallel 4 --release
#   → must be 119/119, DIFF 0 (this is also the RC double-free/leak oracle)
./yo-cli check ./yo-self              # → must be 303/303
./yo-cli check ./std                  # → must be 153/153
# For any change touching drop/liveness emission, ALSO gate on self-emit clang 0:
/tmp/yo-self-bin compile yo-self/main.yo --release --emit-c --skip-c-compiler -o /tmp/stage2
clang -std=c11 -fno-strict-aliasing -fwrapv -w -O2 /tmp/stage2.c -o /dev/null 2>&1 | grep -c 'error:'  # expect 0

# Stage-2 chain when relevant (~5 min):
/tmp/yo-self-bin compile yo-self/main.yo --emit-c --skip-c-compiler -o /tmp/stage2
clang -std=c11 -ferror-limit=0 -c /tmp/stage2.c -o /dev/null -I. 2>&1 | grep -c "error:"  # expect 0
```

- Run TWO stage-2 emits and `diff` when touching type identity — emission
  must STAY byte-identical.
- Never run clang on a stage-2 .c while another emit writes it.
- `./yo-cli fmt <file.yo>` on every touched file before committing; never
  put probe edits in the same Bash command as `git commit` (lint-staged
  stash clobbers them).
- Commit convention: `Co-Authored-By:` line naming the agent, message
  citing the gates run.

## Debugging lessons that will save you rounds

- **GROUND TRUTH = the emitted .c file.** eprintln `${}` probes in either
  binary render through the very string machinery under test and can lie;
  prefer emitting C comments via `context.emitter.emit_declaration_string_line`
  or byte dumps (decimal `byte_at` loops).
- **`String.len()` counts CHARACTERS** (std skips UTF-8 continuation
  bytes); `as_bytes().len()` and builtin `str.len` count BYTES;
  `substring()` is CHAR-indexed; `byte_at()` is BYTE-indexed. Byte loops
  bounded by `String.len()` silently corrupt multibyte content (this root
  caused runtime bug #1). A same-class audit remains OPEN in: formatter.yo,
  token.yo, codegen/utils/index.yo, codegen/exprs/{match,init_assignment,cond}.yo.
- Yo probe gotchas: probes with locals inside match arms can trip "Frame
  level N has different number of values"; keep probes single-expression.
  Module-level globals can't be reassigned cross-module — use setter fns.
  `export` needs the call form: `export main;` fails to parse — write
  `export(main);`.
- Extracting a fn from a 15-50MB .c: find the DEFINITION line
  (`grep -n 'static.*<name>(' file`, take the one ending `) {`), then
  brace-match with a **string-literal-aware** scanner (naive matching
  breaks on braces inside strings).
- Minimal repros in `src/tests/fixme.yo` (scratch, no restore needed) give
  seconds-fast loops vs ~10-min stage-2 rounds. TS-side probes (edit
  `src/`, `bun run build`, seconds) beat yo-self probe builds for
  which-mechanism questions.

---

## Resolved this session (do NOT re-litigate; git log has full details)

| Fix                                                                                                            | Commit theme                                       |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `(*self)->` member-ref: exact-binding `is_ref` + removed env-wide spec marking                                 | fix(yo-self): io.async closure self-capture family |
| io.async closure FTT: Step-10 adopt-expected-return + Step-6b `T` pre-bind                                     | same commit                                        |
| argv if-arm Index FTT: begin-block single-expr clobber carries index-trait ExprInfo fields                     | fix(yo-self): carry index-trait ExprInfo…          |
| undeclared `get_info`: FuncVal-valued args bind runtime (capturable), not comptime                             | fix(yo-self): FuncVal-valued args…                 |
| …plus capture-in-capture struct emission order + box-of-closure collection carve-out                           | fix(yo-self): closure-valued capture…              |
| undeclared RC-temps: undeclared-minted-temp gate at all THREE deferred-drop emitters                           | fix(yo-self): gate undeclared minted-temp…         |
| flaky GC-tracer cluster: type_key depth-cap removal + poison-slot structural keys + trace registry by type_key | fix(yo-self): instantiation-precise type identity  |
| poison sentinel ("!AMBIG") leaking via cycle guard (3310 C-identity collisions)                                | fix(yo-self): poison sentinel must not leak        |
| **Runtime bug #1**: multibyte template corruption — byte loops bounded by char-counting `String.len()`         | fix(yo-self): byte-counted bounds…                 |
| 35 latent `substring(1, len()-1)` unquote sites → byte-exact `str_lit_unquote_bytes` (utils.yo)                | fix(yo-self): byte-exact StrLit unquote…           |

New corpus tests: `tests/codegen-bootstrap/template_multibyte.yo`,
`if_arm_index_call.yo`, `closure_param_capture.yo`, `dyn_fn_field.yo`
(corpus now 107).

Related issue docs: `issues/fixed/yo-self-close-self-capture.md`,
`issues/fixed/yo-self-closure-capture-followons.md`,
`issues/fixed/yo-self-dyn-fn-field.md`.

---

## Evaluator performance parity (user requirement, 2026-07-10)

`check ./yo-self` must be in the same league as TS. Measured (Mac mini M4):

| run                                                                 | time                          |
| ------------------------------------------------------------------- | ----------------------------- |
| TS `./yo-cli check ./yo-self` (303 files, one shared ModuleManager) | 78 s                          |
| yo-self -O2, `check yo-self/tests/expr_traversal.test.yo` ALONE     | 26.7 s                        |
| TS, same single file alone                                          | 20.4 s                        |
| yo-self -O2, `check ./yo-self` cumulative                           | RUNAWAY at file 167 (>36 min) |

Single-file parity is already fine (~1.3x). The blocker is CUMULATIVE
directory checks: after ~166 files of accumulated GLOBAL registry state the
same file's own top-level eval recurses unboundedly
(evaluate_recur → create_specialized_function_inline → begin, stack depth
1421+ and growing; `sample <pid>` confirms). PRE-EXISTING — the pre-fix
binary shows identical single-file times, and the -O0 gate crash at file
167 (rc=139, 4 GiB stack) is the same phenomenon. NOT caused by the
2026-07-10 RC/frontend fixes. Prime suspects: per-name registry growth
(get_type_trait_methods_by_name candidate lists accumulate across files →
overload trial-matching explosion), NOT the module cache (demand loader
caches across files like TS).

## Definition of done (tasks #69, #70)

Once the stage-2 binary works and the fixpoint holds:

1. **#69:** `/tmp/s2 test ./tests --parallel 8` passes what
   `./yo-cli test ./tests` passes (~30 min under TS; the -O0 stage-2 binary
   is ~10× slower — consider building stage-2 at `-O1`/`-O2` once bug #2c is
   fixed, or run a representative subset first, e.g.
   `test tests/algebraic_effects.test.yo --parallel 1`).
2. **#70:** `/tmp/s2 test ./yo-self/tests` likewise (eval_basics/eval_tail_1/
   eval_tail_2 exceed the runner's 1800s limit — known-heavy, validate those
   via check + sweeps per `yo-self/README.md`).

---

## Key artifacts from the last session (in /tmp, regenerate if gone)

| Path                     | What                                                       |
| ------------------------ | ---------------------------------------------------------- |
| `/tmp/stage1-ref.c`      | TS-emitted reference C of yo-self (52MB)                   |
| `/tmp/stage2Q1.c`        | clean stage-2 C (probe-less, sentinel-fixed)               |
| `/tmp/s2g-out.c`         | the SKELETON emit the stage-2 binary produced (1342 lines) |
| `/tmp/s1j.c`             | stage-1's emit of the same small file (2499 lines)         |
| `/tmp/fn-s1.c`,`fn-s2.c` | extracted compute_needs_cycle_gc bodies (both faithful)    |

## Key code locations

| File                                      | Purpose                                                  |
| ----------------------------------------- | -------------------------------------------------------- |
| `yo-self/main.yo` (check path)            | prints "parsed N top-level exprs" — the parse-0 entry    |
| `yo-self/lexer.yo`                        | template scan :316-425; token creation :424              |
| `yo-self/parser.yo`                       | parse_template_string :325                               |
| `yo-self/types/type_key.yo`               | identity: cfid keys, poison slot, cycle guard            |
| `yo-self/types/utils.yo`                  | can_type_form_rc_cycle :737, str_lit_unquote_bytes       |
| `yo-self/codegen/codegen_c.yo`            | compute_needs_cycle_gc :76, run pipeline                 |
| `yo-self/codegen/exprs/comptime_value.yo` | \_strip_str_delims / \_c_string_literal (byte-len fixed) |
| `yo-self/codegen/functions/collection.yo` | function/type collection, trace specialization           |
| `src/` mirrors                            | the TS reference for every file above                    |

Memory notes for future sessions: `yo-self-stage2-endgame`,
`yo-string-len-chars-vs-bytes` (in the agent memory directory).
