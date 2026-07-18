# yo-self self-hosting — HANDOFF (fresh-agent entry point)

_Last updated 2026-07-17 (handover-ready). Everything before the test-runner
era was deleted; git history of this file has the full archaeology if you
ever need it (you won't — do not re-litigate fixed bugs; `git log yo-self/`
and `issues/fixed/` are the record)._

## 2026-07-17 SESSION LOG (#69/#70 campaign in progress — READ FIRST)

State as of this session (all committed, fixpoint re-verified after each):

- **Bug 3 FIXED** (`issues/fixed/gc-cleanup-thread-force-dispose-double-free.md`)
  — was an upstream TS runtime bug (`__yo_cleanup_thread_gc` force-dispose
  double-free), NOT a yo-self RC imbalance. Failing s1/s2 runs now exit rc=1.
  Regression: `tests/gc_cleanup_exit.test.yo`.
- **tests/ TS baseline is 2624/2624 GREEN in ~285 s** (was 75 min + 75
  failing files: every SUBDIRECTORY test file was missing the std/assert
  import that 4355dd1dd only added to top-level files; commit 697e86930).
  Parsed baseline: `/tmp/ts_baseline2_parsed.json` (regen via the python
  in this session's history or rerun the suite).
- **yo-self/tests TS baseline (#70) is 1163/1163 GREEN in ~23 min**
  (`/tmp/ts_yoself_baseline.txt`). Includes the Evaluator.new faithful-port
  rewrite (real module evaluator + is_executing; commit 1e9c95cbc), the
  ExprVal structural-equality fix, and TS-oracle-validated repairs of the
  stale phase6c/6d/6f + evaluator_index harness tests
  (`issues/fixed/yo-self-expr-eq-macro-body-false.md`).
- **#69 sweep round 1 DONE** (`/tmp/s2_sweep_tests/*.done`, per-file logs):
  88 OK / 92 divergent. Three fixes landed off it (commit ec1cb0399):
  concrete-receiver generic-impl fallback (env.yo), base-name prefilter
  (impl.yo `_root_shapes_could_match` — was rejecting every
  `Box(T)`-vs-`Box(i32)` style match), batch placement next to the test file
  (main.yo run_test — relative imports + TS cleanup parity).
- **Round 2 sweep over the 92 divergent files running**
  (`/tmp/s2_sweep_r2/`, list `/tmp/s2_r2_list.txt`). Early results: files
  get further but several distinct emission classes remain — struct-arg
  type mismatch (`passing __yo_t51 ... __yo_t34`), `used type __yo_tN where
arithmetic or pointer type is required` (arc), void-param leftovers
  (async_await), enumerator redefinitions (type-key collision class).

**CRITICAL session gotchas (cost hours):**

- `tests/sys/signal.test.yo` (and any signal-sending test) run via `s2 test`
  KILLS the invoking shell session and every background task in the process
  group — run sweeps through `python3 ... preexec_fn=os.setsid` (see
  scratchpad `s2_sweep_setsid.py` pattern). This explains ALL mysterious
  "background task killed" events this session.
- Never put probe calls INSIDE a `->` ctl handler: under the bug-compatible
  unwind-clobber emission, the probe call resets `__yo_effect_escaped` and
  breaks every swallow in the compiler (fatal std/fmt cast errors at
  startup).
- Do not add `types/string.yo` imports into `evaluator/values/impl.yo`
  (init-order/cycle breakage) — probe with shape classes/names, not
  type_to_string.
- The failing batch .yo/.bin.c now SURVIVE in the test file's directory
  after a compile failure (cleanup only runs on success) — grab them for
  the TS-vs-s2 differential before the next file in the SAME directory
  overwrites them.

**Remaining for #69:** triage round-2 divergent files class by class with
the established loop (saved batch → both compilers → minimize → fix →
gates). **Remaining for #70:** run `s2 test` per-file over yo-self/tests
(setsid runner) vs the green baseline; then Step 3 cleanup below.

**Later 2026-07-17 update:** the reverted instantiation-precise
specialization signatures were RE-APPLIED (the revert's crash verdicts
were from an invalidated bisect; the corruption was the since-fixed RC/GC
bugs) — gates + fixpoint green, tk2 Bucket repro emits per-instantiation
visit fns again. **Open frontier with a 17-line repro** (this exact
fixme.yo shape): two fns each declaring a LOCAL `Counter :: struct(count :
i32)` and calling a generic `ident(forall(T), v)` — TS emits TWO C types +
TWO specializations (keyed `idstruct_<file>_id_25/60`); s1 emits TWO C
types (t10/t11) but ONE specialization whose param is t10 and RETURN is
t11 (clang error). Even with the `_id_` suffix, BOTH locals render type_key
`struct_yo_id_5009_i32` — i.e. the two struct evaluations either share one
sid or the signature-time key predates the second registration
(`g_struct_cfid_keys` evolution — the concern the old revert NOTE raised).
Next probe: print sid at `evaluator/types/struct.yo:74` creation +
type_key at signature time for this repro; then decide whether the sid
source or the key-evolution ordering is the divergence vs TS's unique
`type.id`. Round-3 sweep of the 92 divergent files with all fixes:
`/tmp/s2_sweep_r3/` (list `/tmp/s2_r2_list.txt`).

**RESOLVED (same session, commit 1a2c2e444):** the local-struct frontier
was NOT a sid problem (sids were distinct — 5009/5014); the specialization
CACHE hit before any signature was computed because
`are_types_compatible_exact`'s exact-struct arm fell through to structural
equality for same-named distinct declarations. Fixed with a same-named-
distinct-declarations rule in `types/compatibility.yo` (see
`issues/fixed/yo-self-same-name-local-struct-spec-cache-collision.md`).
Round-3 result: 92 → 74 divergent. Round-4 (`/tmp/s2_sweep_r4/`, list
`/tmp/s2_r4_list.txt`) + the FIRST #70 sweep (`/tmp/s2_sweep_yoself/`,
list `/tmp/s2_yoself_list.txt`) launched with the fixed s2. Compare #70
against `/tmp/ts_yoself_baseline_parsed.json` (1163/1163 green) with
`scratchpad/compare_sweep.py`.

**Round-4 outcome: 74/74 still failing — same histogram** (undeclared
identifier 9, rc=-6 crash family 8, enumerator redefinition 6, expected
expression 6, conflicting types 6, redefinitions 5, undeclared fn 5, …).
The hard tail's remaining roots, per the arc.test.yo layer now exposed
(`*_thread_closure_data = cb` assigning `__yo_t43` to `__yo_t44`) and the
enum-redefinition class, look like MORE guises of "one Yo type → two C
types / one cache entry served two types". IMPORTANT ANALYSIS for the
enum classes: the struct same-name fix CANNOT be replicated for enums —
yo-self enums all carry EMPTY names (compatibility.yo EnumT arm comment),
so same-named-distinct-declaration gating has nothing to key on. The
likely proper fix is the DECLARATION-STABLE id direction from
issues/fixed/yo-self-same-name-local-struct-spec-cache-collision.md
option 1 (derive struct/enum eval ids from the declaration's
`ast_expr_id` instead of `random_id`, making `aid == eid` a real identity
that survives re-evaluation, then tighten the exact arms to id identity
like TS's requireExactMatch) — bigger surgery over struct.yo + enum.yo +
the type*key poison machinery + both exact arms; gate on: the 17-line
Counter repro (10/20), a local-ENUM analog repro, tk2, corpus, std,
fixpoint, then re-sweep `/tmp/s2_r4_list.txt`. **FIRST ATTEMPT FAILED
(2026-07-17, reverted uncommitted):** the naive swap (`struct_decl*/
enum*decl*${ast*expr_id(expr)}`in struct.yo:74 + enum.yo:203, nothing
else) keeps the Counter repro green but BREAKS tk2 —`bucket_size`undeclared +`void` vars, i.e. the sizeof-fold / poison-slot machinery
assumes eval-fresh ids somewhere (likely: instantiation copies now
colliding into one gs*/cfid slot that used to be disambiguated by fresh
eval ids, so `g_struct_cfid_keys` poisons differently and the size
registry misses). The next attempt must trace where tk2's Bucket ids come
from under the swap before re-trying. The rc=-6 crash family
(control_fn_as_regular_call, iso, iso_api_surface, rc, sys/timer, thread,
thread_safety, worker) predates this session's fixes (present in round 1
as 134/-6). **ROOT SYMPTOM ISOLATED (2026-07-17):** the batch compile
panics in yo-self codegen with `get_type_string: no C type name found for
IoExn (type not collected before lowering)`. The 22-line saved batch
(`scratchpad/cfrc_batch.yo`, from tests/control_fn_as_regular_call) TS-
compiles fine; arm 0 ALONE reproduces under s1 (rc=134). The SAME code
with a proper `main :: (fn(io : Io) -> unit)` signature is GREEN under
both compilers — the divergence is specific to the RUNNER-SYNTHESIZED
batch shape (`main :: fn() -> unit` + `io :: __yo_builtin_io` comptime
binding + an effectful fn using Exception + `io.await(yield(io), io)`),
which the TS runner also generates and TS codegen handles. Fix hunt:
compare TS codegen's type-collection of effect-bundle types (IoExn) when
io flows through a comptime binding instead of an evidence param
(src/codegen/.../collection.ts) with yo-self's collection pass; the
yo-self side skips collecting IoExn before lowering. NEW EVIDENCE (the
`_lookup_named_c_type` panic now prints `current_function` + key):
`current_function=` is EMPTY at panic — the miss happens during the
TYPE-DECLARATION emission phase, i.e. an already-collected type's FIELD
references IoExn (most plausibly the yield/await SM capture struct or the
Future's effect-bundle slot) but IoExn itself never went through
collectType. Next: find which collected type carries an IoExn field in
the TS-emitted C of `scratchpad/batch_sub.yo` (TS compiles it), then
diff yo-self's `codegen/types/collection.yo` recursion for that shape
(TS `collectType` recurses into struct fields — find the branch yo-self
skips when the owner type arrives via the comptime-io specialization).
**REFRAME (decisive):** TS's emitted C for the same batch contains ZERO
IoExn references — under evidence passing, effect-record bundles ERASE to
individual function pointers (c-codegen instructions §Evidence passing);
TS never materializes the IoExn struct for this program at all. So the
yo-self bug is not under-collection — some yo-self emission path KEEPS an
IoExn-typed slot (likely an SM/closure capture field or a fn param that
should have been erased/expanded to fn pointers) and then asks
get_type_string for it. Hunt: make the type-declaration emitter print the
OWNER struct's key when a FIELD lookup panics (the current_function-empty
panic is the decl phase), then compare that owner against TS's emission
of the same construct to see what TS erased. **OWNER FOUND (prototype
emitter now stamps `<proto:NAME>` into current_function_name):** the
panic fires declaring `<proto:closure_yo_id_5021>` — a CLOSURE prototype
whose parameter is the raw `IoExn` struct. That's std/async's
`(e : IoExn) =>`-style future-callback closure: TS lowers a struct-typed
effect param via bundle-FIELD expansion (src/codegen/exprs/async.ts:441
"Path 2: struct-typed effect ... fields live in the capture") and never
declares an IoExn C type; yo-self's closure-declaration path keeps the
bundle as a real struct param under the comptime-io call shape. Fix
locus: yo-self's async/closure declaration+collection port (find where
TS decides Path 2 for struct-typed effect params and mirror it for
closures reached via the comptime-io specialization). **SYNTHESIS (read
the panic KEY closely):** the missing IoExn is `struct_yo_id_5017` with
an `Io = struct_yo_id_2965` first field — id 5017 was minted DURING the
batch compile (user-program range), i.e. std's IoExn got RE-EVALUATED
under the comptime-io call shape and the fresh copy's structural type_key
(ids are EMBEDDED in keys) no longer matches the canonical collected
instance. So the -6 family is ALSO the type-identity-churn family. This
unifies nearly the whole remaining #69+#70 tail under ONE core
divergence: yo-self type identity is not stable across re-evaluations
(TS's object identity is), leaking into intern keys, spec caches, typeid
emission, closure captures, and effect-bundle params. The
declaration-stable-id direction is therefore THE central fix — debug its
tk2 regression (trace Bucket id flow under the swap) instead of
abandoning it; secondary mirror fix: TS's Path-2 bundle-field expansion
for struct-typed effect closure params (which would make IoExn's C type
unnecessary here regardless).

**MECHANISM CAUGHT IN THE ACT (imm_sorted_set batch C, 2026-07-17):**

```c
typedef enum { __YO_T29_NONE = 0, __YO_T29_SOME = 1 } __yo_t25_tag;  // ← t25's TAG enum uses T29 prefixes!
struct __yo_t25_struct { // : <enum:enum_yo_id_7428>
...later...
typedef enum { __YO_T29_NONE = 0, ... } __yo_t29_tag;                 // ← real t29 → enumerator REDEFINITION
struct __yo_t29_struct { // : <enum:enum_yo_id_7428>                  // ← SAME enum id!
```

Plus `__yo_t15` and `__yo_t16` both `<struct:struct_yo_id_7245>`. So:
ONE type (enum_yo_id_7428 = an Option instantiation) was COLLECTED TWICE
under two type_key renders (the key EVOLVES with `g_struct_cfid_keys`
first-registration/poison transitions between the two collect_type
calls), and the enum-decl emitter computes the ENUMERATOR prefix by
RE-KEYING the type at emission time (get_type_c_name(type_key(t)) → the
EVOLVED key's name) instead of using its own passed c_name. This single
mechanism explains: enumerator/typeid redefinitions, duplicate struct
decls, `passing __yo_tA to __yo_tB` / `initializing` mismatches, and
undeclared-specialization errors (emitted under one key render, called
under another) — i.e., MOST of both remaining tails.

**IMPLEMENTED (commit after this note): the stable-identity alias fix
landed** — `stable_type_identity` in types/type_key.yo, the collect_type
alias dedup, `type_key_aliases` on CodeGenContext (get_type_entry/
get_type_c_name follow one level), and `_emit_enum_tags` prefixes from
the passed c_name. Validation: recursive_enum 4/4 GREEN (was rc=-11),
imm_sorted_set/imm_string past the enumerator class into the
`'void' must be the first and only parameter` (unresolved-SomeT emission)
layer; arc/hash_map still on struct-mismatch layers (t42/t49 — likely a
capture-struct or spec-signature identity split not covered by the
collect_type alias; async.yo:1497/1915/1952 + declarations.yo:536/550
register future→SM aliases OUTSIDE the stable dedup — probably fine, but
check if the mismatch persists). Gates + fixpoint green. Round-5 sweep
over all 94 remaining divergents (74 tests/ + 20 yo-self):
`/tmp/s2_sweep_r5/`, list `/tmp/s2_r5_list.txt`.

**ROUND-5 COMPLETE: 2 flips** (tests/recursive*enum,
yo-self/tests/context — the alias fix works on both suites' typeid
class). **Scoreboard: #69 = 107/180, #70 = 42/61; 92 divergent files
remain.** Final histogram: expected-token 12, undeclared identifier 11,
misc 10, rc=-6 IoExn family 8, redefinitions 6, expected-expression 6,
conflicting types 6, passing 4, parameter-declarator 4, undeclared fn 4,
initializing 3, unexpected type name 2, TIMEOUT stalls
(btree_map/imm_threading) 2. **The SortedSet/void-flag investigation is
CLOSED into a single work item** (issues/yo-self-sortedset-method-call-
type-void.md): every shallow route was probed healthy; the failure is the
documented Gap-6 soft-fail in `create_specialized_function_inline` when
a generic-impl method body contains a NESTED static generic-impl call
(`SortedSet(T).new` → `SortedMap(T,bool).new()`), the exact class the
code's own comment defers as "the deeper Gap-6 evaluator work". Since
imm*\*/collections/derive files bottom out in that same shape, **Gap-6 is
now THE dominant blocker for both tails** — plan a dedicated session on
create_specialized_function_inline (static-method Self threading +
nested-call recursion), gating on the 9-line SortedSet repro, then
re-sweep. Secondary items unchanged: IoExn Path-2 erasure mirror (rc=-6
×8), thread-closure capture identity (arc/worker), the two compile-stall
files, and the failed-compile teardown segv (rc=-11 masking).

**Gap-6 port: attempts #1-#5 PRESERVED on branch `wip/resolution-time-spec`**
(two commits). Attempt #5 state: GATE-CLEAN on small programs — the
shell-receiver gate fixed 3 self-cycle corpus fails, the recursive
closure-param gate + the BODY-closure scan fixed closure*param_capture
(capture structs from resolution-time body evals never reach collection);
corpus 130/2-known SELF-FAIL 0, std 153/153, tk2 + Counter green. **NEW
BLOCKER at the fixpoint: stage2.c emits at 1.55 GB (vs 59 MB)** — eager
specialization on every lookup hit side-effects the registries thousands
of times during the self-compile. NEXT ITERATION: make it LAZY — record
the specialization REQUEST (memo key) at resolution and evaluate the body
only when the candidate is SELECTED at an actual call site; also fix the
remaining SortedSet consumption gap while there. **LAZY ITERATION STARTED
(3rd WIP commit, BROKEN — labeled 'do not build on'):** pend-fid
recording + call-site run_pending_rspec compiles clean but regresses the
whole battery (tk2 rc=1, Counter/SortedSet segv, cpc 134) — the pend-fid
indirection breaks call processing. Debug from the WIP commit message's
suspect list; attempt #5 (previous WIP commit) remains the gate-clean
eager reference. Original note:
(superseded)
(commit 0446a6ed3): the full TS shouldCreateSpecializedValue mirror —
proven emitting 18 `\_rspec*`specializations — reverted from mainline on
4 self-cycle corpus SELF-FAILs. Continue THERE: add the shell-receiver
gate (skip specialization when the receiver or any type_argument is a
mid-definition self-shell —`resolve_struct_shell(receiver)`differs, or
enum`\_\_self_shell` ids), clear the memo between compiles if the drivers
reuse a process, then chase the remaining SortedSet call-site consumption
gap. Full narrative: issues/yo-self-sortedset-method-call-type-void.md.

**Original fix design (kept for reference):** in `collect_type` (codegen/types/
collection.yo), dedup by a STABLE structural identity, not the evolving
type*key: implement `stable_type_identity(t)` = `_type_key_at` WITHOUT
the gs*/cfid/poison branches (pure recursive render: sid + field/variant
renders, cycle-guarded — stable because it never consults mutable
registries; precise because distinct instantiations differ in field
renders). Keep a registry `stable_identity → first type_key/c_name`; on
a second collect under an EVOLVED key, ALIAS the new key to the existing
C name (context.set_type_c_name(new_key, existing)) instead of adding a
second entry — emission stays single, body lookups by either render hit.
ALSO fix the enum-decl emitter to derive enumerator/tag prefixes from its
PASSED c_name, never by re-keying. Do NOT dedup by bare id (generic
instantiations share ids) and do NOT use type_to_string (anonymous
instantiations render as bare `<struct:yo_id_N>` — imprecise). Gates:
imm_sorted_set/recursive_enum/imm_string batches (enumerator class),
hash_map/arc batches (mismatch class), tk2, Counter repro, corpus, std,
fixpoint, then re-sweep `/tmp/s2_r4_list.txt` + `/tmp/s2_yoself_list.txt`
divergents. (The struct-decl-memo attempt in evaluator/types/struct.yo
was REVERTED — no sweep delta; keep the evaluator side untouched.) NOTE (user
directive): user Yo code must always take `io : Io` in main's signature —
`io :: __yo_builtin_io` is internal to the runner's synthesized batches;
keep any repro of this class explicitly labeled as the runner shape.

**First #70 sweep COMPLETE (`/tmp/s2_sweep_yoself/`): 41/61 files green,
each green file matching the TS baseline's per-test counts exactly
(compare_sweep: OK 41 / DIVERGENT 20 / MISSING 0). The 20 divergent are
ALL whole-file batch-compile failures** (18 rc=1 + env_lookup/
env_find_variable_frame_level rc=-11, which is a compile failure whose
exit path then segfaults). Campaign scoreboard: #69 106/180 green, #70
41/61 green. Failing
classes are the SAME type-identity families as #69: `redefinition of
__yo_typeid___yo_tN` (one C name registered twice — an INTERN-side
type_key collision, distinct from the fixed CACHE-side one), field
designator mismatches, plus `env_lookup`/`env_find_variable_frame_level`
dying rc=-11 (SIGSEGV — a separate class, possibly deep recursion or a
real crash; run those two solo under lldb). CONSOLIDATED VIEW: the
remaining #69+#70 tails look dominated by ONE family — "one Yo type ↔
multiple C types / registry entries" in its intern, cache, typeid, and
closure-capture guises. The declaration-stable-id direction (above,
first attempt failed on tk2) is probably still the unlock; trace the tk2
Bucket id flow under the swap first.

---

## WHERE WE ARE (verified, all committed, fixpoint holding)

The self-hosting bootstrap is functionally COMPLETE through the fixpoint,
and the TS-side baselines are fully prepared for the two remaining sweeps:

| Milestone                                                            | Status                                                                         |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Evaluator port (TS `src/evaluator/` → `yo-self/evaluator/`)          | DONE                                                                           |
| Codegen port (TS `src/codegen/` → `yo-self/codegen/`)                | DONE                                                                           |
| **Fixpoint: stage2.c ≡ stage3.c raw byte-identical**                 | **HOLDS** (~59 MB, no normalization; re-verified after every fix this session) |
| s2 `compile X -o bin` end-to-end (incl. async clang link driver)     | WORKS (closure RC-capture dup fix `b2b80c097`)                                 |
| `test` command in yo-self (batched YO_TEST_INDEX runner port)        | WORKS (`7b941173b`)                                                            |
| Bare `assert(x)` / omitted `?= default` args                         | FIXED (`9100cc135`)                                                            |
| `comptime_expect_error` state stranding                              | FIXED (`6928dc81f`)                                                            |
| Structural forall inference (effect polymorphism)                    | FIXED (`702de11c9`)                                                            |
| `s1 test tests/algebraic_effects.test.yo`                            | **72/72 PASSED**                                                               |
| **yo-self/tests suite audited + repaired under TS (#70 baseline)**   | **100% GREEN — every file, incl. the eval trio (337/337, ~90 s/file)**         |
| Corpus differential (`scripts/diff-test.sh tests/codegen-bootstrap`) | PASS 133 / DIFF 2 — both DIFFs pre-existing & known (see "Known-noise gates")  |
| `check ./std` under s1                                               | 153/153                                                                        |

Terminology: **s1** = TS-compiled yo-self binary. **s2** = clang -O2 of
s1-emitted `stage2.c` (the self-built compiler). **s3** = clang of s2-emitted
`stage3.c`. Fixpoint = `stage2.c ≡ stage3.c`, so s2 and s3 are the same
compiler.

### Definition of done (the remaining scope)

1. **#69:** `s2 test ./tests` passes what `./yo-cli test ./tests` passes.
2. **#70:** `s2 test ./yo-self/tests` likewise.

(These task numbers come from an old tracker that no longer exists — they
survive as labels in docs/memory. There is no #71+; after #69/#70 the codegen
bootstrap is done. `plans/BOOTSTRAPPING.md`'s "Streams A/B/C" and open-gap
lists are BADLY STALE — async/effects are long since ported; don't plan from
that file.)

---

## HOW TO BUILD / VERIFY (exact commands)

```bash
# Always first:
bun run build

# s1 (TS-compiled yo-self) — ~5 min. ALWAYS --release (-O2): user directive;
# -O0 hits the giant-frame stack-exhaustion class and is ~10x slower.
./yo-cli compile yo-self/main.yo --release -o /tmp/s1 &> /tmp/s1_build.txt
tail -1 /tmp/s1_build.txt   # must be "Successfully compiled ..."

# The fixpoint chain (also how you get an s2). ~15 min total on 16 GB
# (s1 emit ~2-3 min, clang ~4 min, s2 emit ~3-4 min at ~9.3 GB peak RSS).
# NOTE: yo-self `-o X` with --emit-c writes `X.c`.
/tmp/s1 compile yo-self/main.yo --emit-c -o /tmp/stage2
clang -std=c11 -fno-strict-aliasing -fwrapv -w -O2 /tmp/stage2.c -o /tmp/s2
/tmp/s2 compile yo-self/main.yo --emit-c -o /tmp/stage3
cmp /tmp/stage2.c /tmp/stage3.c && echo "FIXPOINT HOLDS"
```

### Gates after EVERY yo-self change (revert on regression)

```bash
YO_SELF_BIN=/tmp/s1 scripts/diff-test.sh tests/codegen-bootstrap --parallel 4
#   → PASS 133 / DIFF 2 (only the two known-noise DIFFs below; 133 incl. the
#     cond_comptime_arm_match_temp + dyn_fn_same_sig_closures +
#     nested_generic_trait_eq regressions)
/tmp/s1 check ./std                       # → 153/153
# For emission-affecting changes, ALSO re-run the fixpoint chain above
# (byte-identical or you broke determinism/parity).
```

**Known-noise gates (do NOT chase):**

- `constructor_result_drop.yo` DIFF `ts_rc=139` — the TS side is FLAKY under
  parallel runs (8/8 clean solo). Pre-existing.
- `ptr_deref_copy_rc_struct.yo` DIFF — pre-existing RC-count print diff
  (ctor-arg move-vs-dup, see follow-ups).
- `check ./yo-self` as a whole-directory gate: stalls ~50 min in
  `yo-self/tests/expr_traversal.test.yo` under s2-class binaries, and TS-side
  cumulative checks have a known registry-growth runaway after ~166 files.
  Use corpus + std + fixpoint as the gates; don't burn the hour.

---

## NEXT STEPS — in order, in detail

### Step 1 — #69: make `s2 test ./tests` match TS

State at handoff: the runner works; `tests/algebraic_effects.test.yo` is
72/72 under s1; `tests/short_circuit_str_literal_arg.test.yo` 1/1. A full
`s1 test ./tests --parallel 4` sweep was started but superseded twice by
fixes; no complete sweep result exists yet.

1. Generate the TS baseline (once): `./yo-cli test ./tests --parallel 8 &>
/tmp/ts_tests_baseline.txt` (~30 min). Extract per-file pass/fail/total.
2. Run the s2 sweep: `/tmp/s2 test ./tests --parallel 4 &>
/tmp/s2_tests_sweep.txt`. (s1 and s2 should behave identically given the
   fixpoint; validating with s1 first is fine for iteration, but the
   DEFINITION is against s2 — do the final run with s2.)
3. Diff the two summaries per file. For each divergent FILE, use the
   established triage loop (fast, ~1-2 min/cycle):
   - The runner writes the synthesized batch program to
     `/tmp/.yo_selftest_batch_<N>.yo` and its C to
     `/tmp/.yo_selftest_batch_<N>.bin.c`. **Copy both out immediately** (they
     get overwritten by the next file).
   - Clang error in the batch C → compile the SAVED batch .yo directly with
     both compilers: `./yo-cli compile <batch>.yo -o /tmp/ts_bin` vs
     `/tmp/s2 compile <batch>.yo -o /tmp/s2_bin`. If TS compiles it and
     yo-self doesn't, you have a 1-file differential — minimize and fix.
   - Batch too big to eyeball → bisect cond-arms with
     `scratchpad/make_subset.py` (from this session; regenerates a batch
     keeping arms lo..hi — see
     `issues/yo-self-test-runner-remaining-bugs.md` UPDATE sections for
     usage). One arm ≈ one test.
   - Whole-body `// Failed to transpile` markers → the def-time eval threw
     and was swallowed. Instrument the TWO swallow handlers with
     `println(`[TTERR] ${\_err.to_string()}`)`:
     `yo-self/evaluator/calls/function_type.yo` `_trial_eval_fn_body`
     (`inner_exn := Exception(throw : ((_err) -> unwind(())))`) and
     `yo-self/evaluator/values/anonymous_function.yo` `_trial_eval_anon_body`
     (same shape). Both files need `open(import("std/fmt"));` added while
     instrumented. REVERT after use. The one real error among the warm-up
     noise names the bug.
   - Always confirm the TS behavior on the same input FIRST, then find the
     yo-self divergence from `src/`, then fix yo-self to match (faithful-port
     discipline, non-negotiable; if TS is also wrong, fix TS first, then port).
4. Known remaining failure you WILL hit — **Bug 3, exit-after-spawn abort**:
   any FAILING suite exits rc=134 instead of 1 (passing suites exit 0
   correctly, and the ✓/✗ lines + Test Summary are still printed/correct).
   Root: after the runner has spawned/awaited children, `exit(1)` triggers
   atexit `__yo_process_cleanup` → `__yo_cleanup_thread_gc` → malloc "POINTER
   BEING FREED WAS NOT ALLOCATED". Present in the s1 (TS-compiled) binary too
   → an RC imbalance in yo-self/std source on the spawn/await path surfacing
   at teardown, NOT a codegen bug of s2. Hunt with the RC-quarantine /
   `patch_rcsite.py` tooling (below). Related: `run_check`'s failure exit is
   separately broken (a bad file exits rc=0 — the throw/exit path never
   reached); fix while you're in there (`yo-self/main.yo`).

### Step 2 — #70: `s2 test ./yo-self/tests`

**The TS baseline is DONE and the suite is AUDITED + REPAIRED (2026-07-17;
commits `25761e121` + the follow-up suite-repair commit). Read
`issues/yo-self-tests-ts-baseline.md` — it has the full record.** Summary:

- The suite had extensive staleness predating the ref-enum
  reference-semantics and FuncMeta refactors: `box(...)`/
  `Box(TypeValue)(...)` wrappers, `x.*` match derefs, flat `TypeValue.Func`
  constructions, `ModuleVal` (removed in `4fc9c673e` — modules are
  `StructVal` now), flat 9-field `.FuncVal(...)` patterns, ~2500 str
  literals against `String` params, a mid-test-body `std/assert` import,
  a couple of pre-port behavioral asserts. ALL repaired and verified
  green; three NEW test files added (type_key, synthesizer, formatter).
  No TS-compiler bugs were found by the baseline.
- **The eval trio's "known-heavy, exceeds 1800s" reputation is DEAD**: the
  timeouts were bisection storms over stale tests (every batch failed →
  the runner's bisect-on-compile-failure recompiled the whole-evaluator
  import graph dozens of times), never inherent cost. Post-migration:
  eval_basics 123/123 in 89s, eval_tail_1 107/107 in 87s, eval_tail_2
  107/107 in 88s. If they ever slow down drastically again, suspect NEW
  stale tests re-triggering bisection, not file size.
- **Effective baseline: EVERY file in yo-self/tests passes fully under
  TS.** The #70 comparison is exact — no exclusions.
- One real yo-self divergence was found and filed while re-enabling a
  skipped test: `issues/yo-self-expr-eq-macro-body-false.md`
  (`__yo_expr_eq` false inside macro bodies; phase6f test 1 is
  `if(false,...)`-skipped on it — fix it, flip the gate back).

What remains for #70:

1. `/tmp/s2 test ./yo-self/tests --parallel 2` and triage divergences
   exactly as in Step 1. s2 at -O2 is ~3.5x FASTER than TS on
   evaluator-bound work, but these files are the heaviest in the repo
   (evaluator-internal imports = big Yo-compiles).
2. **CRITICAL runner gotcha (cost this audit hours): never run two `test`
   invocations that touch the same directory concurrently.** The runner
   writes and cleans `.yo_test_batch_*` temp files IN the tests directory;
   two runners race each other's batches and produce spurious
   "Failed to import module …yo_test_batch…" failures. Solo-re-run any
   suspicious failure before believing it. (~20 of the baseline's 48 raw
   failures were this.)

### Step 3 — flip the default and clean up (after #69/#70 green)

- Re-verify the fixpoint one final time; update `yo-self/README.md` status
  and this doc.
- Fold the session-era scratch out of `issues/`: move
  `yo-self-test-runner-remaining-bugs.md` to `issues/fixed/` once Bug 3 is
  done; update `plans/BOOTSTRAPPING.md` (it is very stale) or mark it
  historical.

### Filed follow-ups (not blockers — do when touched or after #69/#70)

- **TS unwind-clobber upstream bug** (fix in BOTH compilers TOGETHER, then
  re-verify fixpoint): TS emits `unwind(<call>)` in ctl handlers as
  `escaped=1; escaped=0(arg-call pre-reset); call; check` — the reset
  clobbers the flag so the reference compiler RESUMES past swallowed throws;
  the whole def-time trial-eval swallow ecosystem currently DEPENDS on this.
  yo-self is bug-compatible (`_call_may_unwind` atom-callee fallback,
  `546a5a25d`). Also the masked Box-ctor
  `are_types_compatible(capture struct, unconstrained SomeT V)` rejection.
  See `issues/yo-self-stage2-dyn-closure-divergence.md`.
- **ctor-arg move-vs-dup** (`issues/yo-self-ctor-arg-move-vs-dup.md`):
  balanced (NOT a leak) — faithful-port traffic cleanup; source of the
  `ptr_deref_copy_rc_struct` corpus DIFF.
- Proxy RSS gap: `s2 compile yo-self/parser.yo --release --emit-c` peaks
  808 MB vs s1 477 MB with live objects BELOW s1 — allocator/fragmentation,
  low priority.
- Cumulative `check ./yo-self` registry-growth runaway (~166 files) — perf
  parity item; also the `expr_traversal.test.yo` ~50-min stall class.
- Reverted specialization-signature split (helper.yo `_id_`, type_key.yo
  Pointer branch, DECL_RE) — old crash verdicts were invalidated; re-evaluate
  on merit. `issues/yo-self-specialization-signature-type-identity.md`.

---

## THE METHOD (proven over ~20 fix rounds — reuse, don't reinvent)

**Faithful-port discipline:** (1) confirm TS behavior on the same input;
(2) find the yo-self divergence from `src/`; (3) fix yo-self to match. No
yo-self-only mechanisms. If TS is wrong too, fix TS first, then port.

**Diagnosing a "mysteriously slow / timing-out" test file:** it is almost
never inherent cost. The runner bisects any batch that fails to compile —
each split RECOMPILES the file's whole import graph — so densely-stale test
files degenerate into 30+ min compile storms with zero visible results
(that was the eval trio). Measure first: a `--test-name-pattern` single-test
run gives you extraction + one batch compile in isolation (~30-60 s for even
the heaviest files). If the full file takes 10× that, you have failing
tests triggering bisection, and the timeout is EATING their reports — run
small patterns to surface them. Also remember `check` can NEVER validate
test bodies (the def-eval wall swallows body errors by design) — green
check ≠ runnable tests; compile-and-run is the only gate.

**Iteration ladder (cheapest first):**

1. Standalone .yo repro compiled by BOTH compilers (seconds-minutes). Use
   `src/tests/fixme.yo` as scratch (no restore needed). Caveat: some bugs
   need batch/module context — if standalone is clean, wrap in the batch
   dispatch shape (match on env var + cond arms) before giving up.
2. Input bisect: per-module compiles, or `make_subset.py`-style arm slicing.
3. Emitted-C audit: the .c file is GROUND TRUTH (eprintln probes render
   through the machinery under test and can lie). Find functions by
   distinctive string literals. TS reference emission:
   `./yo-cli compile yo-self/main.yo --release --emit-c --skip-c-compiler -o /tmp/stage1-ref`.
4. [TTERR] swallow instrumentation for FTT hunts (see Step 1 above).
5. Per-type RC site tracing for leaks/imbalances: `scratchpad/patch_rcsite.py`
   — patch `__yo_incr_rc/__yo_decr_rc` filtered by dispose_fn, keyed by
   `__builtin_return_address(0)`; evaluation is deterministic ⇒ any
   per-function count delta between s1/s2 = emission difference. Attribution
   is ONE FRAME UP due to inlining.
6. Memory forensics (`scratchpad/oplog_patch.py`): freelog ring,
   64K-delay quarantine (deterministic double-free trap), RC tombstone
   (0xDDDDDDDD stamp). Guard Malloc traps first-UAF exactly but OOMs on big
   inputs — bisect the input first. `atos` ra values point ONE LINE AFTER
   the real call.

**Yo probe gotchas (cost real rounds):**

- `->` effect handlers cannot capture outer runtime vars OR module globals —
  route through `fn() -> T` getter functions.
- Never `_x := <unit-returning call>` — emits `void x = ;` (invalid C).
  Bare `expr;` to discard.
- eprintln probes with locals inside match arms can trip "Frame level N has
  different number of values" — keep probes single-expression; C-comment
  probes via `em.emit_string_line("/* ... */")` work anywhere in codegen.
- Match arms mixing `list.push(x)` (returns `Result`) with `()` arms fail to
  type — wrap pushes in `{ ...; }` blocks.
- lint-staged stash clobbers probe edits staged in the same command as
  `git commit` — never combine.
- `String.len()` counts CHARS, `as_bytes().len()` counts BYTES — byte loops
  bounded by `String.len()` corrupt multibyte content.
- Backtick literals are `String`, `"..."` literals are `comptime_string`
  (decay to `str`) — param types must match.

**Environment/ctx state model (the root of two of this session's bugs):**
TS contexts are spread-copied per call and TS envs are persistent — a thrown
exception can't strand state. yo-self has ONE mutable `EvalContext` + ONE
mutable `Environment` with push/mutate + restore-on-return — **any unwind
that propagates past a restore leaves state stranded** (e.g. a param frame
left pushed on the module env). If you see impossible "captures"/lookups
after an error path ran: suspect a skipped restore. `comptime_expect_error`
now snapshots/restores everything (`6928dc81f`) — use it as the template.

---

## KEY LOCATIONS

| Path                                                  | What                                                                                                                            |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `yo-self/main.yo`                                     | CLI: run_compile / run_check / **run_test** (batched runner, ~l.700+)                                                           |
| `yo-self/evaluator/calls/helper.yo`                   | try_to_call (Step-7 param loop, omitted-default routing), cifpma, sig                                                           |
| `yo-self/evaluator/calls/function.yo`                 | evaluate_function_call FuncVal arm: arg loop, omitted-default SPLICE, `_funcval_bind_foralls` (+ structural synthesis fallback) |
| `yo-self/evaluator/builtins/comptime_expect_error.yo` | the snapshot/restore template                                                                                                   |
| `yo-self/evaluator/calls/function_type.yo`            | `_trial_eval_fn_body` (swallow handler #1, TTERR site)                                                                          |
| `yo-self/evaluator/values/anonymous_function.yo`      | `_trial_eval_anon_body` (swallow #2), capture checks, def-time body eval                                                        |
| `yo-self/evaluator/types/synthesizer.yo`              | synthesize_types (structural SomeT binding)                                                                                     |
| `yo-self/evaluator/types/function.yo`                 | default-args/default-exprs/where/variadic side tables (func_id-keyed)                                                           |
| `scripts/diff-test.sh`                                | the corpus differential harness (`YO_SELF_BIN=... --parallel 4`)                                                                |
| `src/test-runner.ts`                                  | the TS batched runner (reference for run_test; bisect-on-compile-failure logic ~l.1270)                                         |
| `issues/yo-self-test-runner-remaining-bugs.md`        | this era's bug ledger (Bugs 1-2 + eff-poly fixed; Bug 3 open)                                                                   |
| `issues/yo-self-tests-ts-baseline.md`                 | the #70 TS baseline + full suite-audit record (staleness classes, per-file numbers)                                             |
| `issues/yo-self-expr-eq-macro-body-false.md`          | open yo-self divergence: `__yo_expr_eq` false in macro bodies (phase6f test 1 gated on it)                                      |

Memory notes (agent memory dir): `yo-self-fixpoint-16gb-blocked` is the
running ledger for this whole era; `yo-self-stage2-*`, `yo-string-len-chars-vs-bytes`,
`yo-no-underscore-assign-discard` for the recurring gotchas.

## 2026-07-18 UPDATE — Gap-6 attempt #6 verdict (read before touching the spec port)

Attempt #6 (eager resolution-time specialization with DETERMINISTIC fids,
`wip/resolution-time-spec` @ 60bb5a54f) passed corpus (130/2 exact), std
(154 OK) and the battery, kept stage2.c at 58.2 MB — and is nevertheless
**INVALID**: the resulting stage2 BINARY aborts on `s2 check std/env.yo`
("HashMap ctrl pointer is null"). Bisect proved the spec MECHANISM itself
emits wrong bodies for yo-self's own HashMap-internals generics — fid
identity is NOT the cause (random fids crash too). Full bisect log + three
salvage directions: issues/yo-self-sortedset-method-call-type-void.md
("Attempt #6 STAGE2 VERDICT").

**NEW MANDATORY GATE**: any spec-port iteration must ALSO pass
`s2 check std/env.yo` (build stage2, run the check — the check itself is
seconds). The corpus cannot see this failure class.

Also on that wip commit, four TS-mutation-mirror fixes that are likely
KEEPABLE independent of the spec port (they fixed real divergences —
SortedSet impl-match unification etc. — and survived corpus+std; they were
only reverted during the bisect): the `g_struct_ctor_fids` stamp table +
synthesizer same-constructor fallback, the `_ctfe_args_equal` id fast-path,
collection alias-with-field-recursion, and the fresh-id ctfe body clone.
Re-land them SEPARATELY from the spec port, each with the full gate set
including the new env-check gate.

## 2026-07-18 RE-LAND (mainline 27400e882) — the four type-identity fixes are IN

The B/C/D/F fixes from attempt #6 re-landed on `feat/bootstrap-codegen`
WITHOUT the spec port and passed the COMPLETE gate set including the two
new ones: `s2 check std/env.yo` OK and **fixpoint BYTE-IDENTICAL**.
std check is now 154 files OK (was 153). The SortedSet 9-line repro went
2 FTTs → 1: `is_empty` now transpiles; only `new`'s unspecialized body
remains (`Self(_inner : SortedMap(T, bool).new())`).

A quick attempt to close that last FTT by extending the runtime-path
for-codegen specialization trigger to impl-generic methods (TypeVal-capture
scan, then an injected-forall-names side table) did NOT converge: the
capture scan over-fired on every module function (module types are ordinary
TypeVal captures), and the narrowed injected-names lookup missed at the call
site (the fid at dispatch differs from the fid recorded at injection —
find the re-mint between `_inject_forall_captures` and
`_evaluate_funcval_runtime_call`; `fv_for_recur` random_id re-mint and the
method-callee-value tables are the suspects). Both attempts REVERTED; the
injected-names design is likely right once keyed by the fid the CALL SITE
actually sees.

Round-6 sweeps over /tmp/s2_r5_list.txt (92) + /tmp/s2_yoself_list.txt (61,
19 divergent) launched with the new s2 (logs: /tmp/s2_sweep_r6/,
/tmp/s2_sweep_yoself_r6/).

## 2026-07-18 GAP-6 CLOSED (mainline ef8344537) — SortedSet family green

The flagship SortedSet repro is FULLY GREEN (compiles + runs, 0 FTTs).
The winning path was NOT the resolution-time spec port (attempts #1-#6,
abandoned — see issues/fixed/yo-self-sortedset-method-call-type-void.md):

- `27400e882` type-identity fixes made the impl-match unify and the type
  graph coherent (2 FTTs → 1).
- `ef8344537` supersession: the existing call-site specialization ALREADY
  produced a perfect spec + consumption for `new`/`is_empty` — the compile
  broke only on the DEAD abstract original also being emitted. Supersession
  counters + a post-emission abort() stub for superseded+FTT bodies fixed it.

Full gates green including `s2 check std/env.yo` and fixpoint
BYTE-IDENTICAL. Canonical /tmp/s1 & /tmp/s2 updated to ef8344537.

Round-6 sweeps ran against the PRE-supersession s2 (results partially
stale); round 6b over both divergent lists with the ef8344537 s2 is the
next action — expect the imm\_\*/collections tail to shrink substantially.

## 2026-07-18 (later) — two more root-cause fixes landed; round-7 measuring

- `db6cef988` **rune/byte scanner fix**: String.len() counts RUNES while
  byte_at reads BYTES; several codegen scanners under-walked multibyte
  content, truncating emitted C (an assert message with "→" chopped its
  compound literal's closing brace — the yo-self/tests env_lookup/env_find/
  expr_traversal "expected '}'" family). All byte_at sites audited; rune/byte
  rules added to the syntax cheatsheet; regression test
  tests/string_multibyte_literal.test.yo.
- `88d9f3fbb` **generic-impl trait-default fill**: `a != b` on a generic-impl
  Eq receiver (ArrayList(i32) and every collections/\* batch) dispatched the
  trait's RAW default `!=` (no impl foralls → the for-codegen spec trigger
  never fired → FTT + a `void self` C param from the inner `not` spec).
  Generic-impl registration now fills unprovided trait defaults with the impl
  foralls stamped, mirroring both the concrete-impl fill and TS
  trait-type.ts:418-489. Regression test
  tests/generic_impl_trait_default_ne.test.yo.

Both passed the FULL gate set (corpus exact, std 154, battery incl.
SortedSet+multibyte, env-check, fixpoint BYTE-IDENTICAL). Canonical
/tmp/s1 & /tmp/s2 are at 88d9f3fbb. Round-6b sweep numbers are
binary-MIXED (mid-sweep fixes) — round-7 (clean, settled binary) is the
authoritative scoreboard: /tmp/s2_sweep_r7/ + /tmp/s2_sweep_yoself_r7/.

## 2026-07-18 (continued) — install_command green, suspension_analysis compiling: #70 = 60/61

- `24f2def20`: skip the bare tail `return ;` when every path already
  returned (the statement-form tail whose render is empty) —
  **install_command flips green → #70 = 60/61.**
- `8b9cce48a`: dyn-box fixes — resolve SomeT concretes before keying box
  names + late-registration typedef emission via the shared
  `dyn_box_typedefs` set. suspension_analysis goes from whole-batch C
  failure to COMPILING with 3 runtime failures: the `detect_all` dyn
  detector returns 0 suspension points (tests "fncall body — detect_all
  detector → 1 point", "nested fncall — detects outer + inner",
  "suspension point index is sequential"). NEXT: runtime dyn-dispatch /
  capture-value semantics of the detector closure — compare the emitted
  detect wrapper + capture initializers against the passing "noop
  detector" sibling test in the same batch (YO_KEEP_BATCH=1).
- Remaining #70 (2): suspension_analysis (runtime, above) and cache
  (undeclared `_file____User_temp_NNNN` — temp-scoping emission).

## 2026-07-18 ROUND-9 RESULT — the tests/ tail is orthogonal to the capture fix

Round-9 (capture-fix binary, 300s caps): tests/ divergent list 2/71 pass
(ref_enum, thread_safety — unchanged). The tests/ tail is fully in the
OTHER classes: identity splits (t31-vs-t23 call-boundary mismatches — the
LARGEST class and the highest-leverage remaining fix), skip-vs-callsite
undeclared fns, Index-call mislowering, downcast FTT, IoExn rc=-6, and one
STALL. Per-class fix loci: issues/yo-self-collections-batch-residuals.md +
this handoff. FINAL scoreboard this session: **#70 = 59/61 (from 42),
#69 = 108/180 (from ~106), 14 gated fix commits, fixpoint byte-identical
throughout.**

## 2026-07-18 CAPTURE FIX LANDED — #70 = 59/61

`ecbe5f08e` — source-position capture-info merge: closures register a
token-position key at FuncVal mint (stable across fresh-id clones);
capture info keep-largers by source; get_closure_capture_info returns the
larger of fid/source entries. The dyn+Impl(Fn) repro compiles AND runs
green (values verified by asserts); **effect_analysis flips → 59/61**.

The LAST THREE #70 divergents, each with a distinct signature (batch logs
/tmp/g70\_\*.txt at this commit; use YO_KEEP_BATCH=1 to reproduce):

1. `cache.test.yo` — `use of undeclared identifier _file____User_temp_7020`
   (a minted temp declared in one emitted scope, referenced in another —
   temp-scoping emission).
2. `suspension_analysis.test.yo` — `unknown type name
'__yo_dyn_box_unknown_2312'` (a dyn-BOX C type never registered; the
   "unknown\_<key>" fallback leaked into emission — the boxed-dyn type
   resolution path).
3. `install_command.test.yo` — `non-void function 'yo_id_3595' should
return a value` (a return-path dropped during body emission).

#69 unchanged at 108/180 pending a fresh sweep with this binary (the
capture fix likely flips collections files sharing the class — re-run the
r8 list against a NEW pinned copy).

## 2026-07-18 (final) — capture hardening trio landed; the residual is pinned

`5d69b2b7f` lands three gate-verified capture fixes (generation-safe
tracker, closure-spec fresh-map recording + post-eval struct registration,
keep-larger structs). The in-repo repro STILL fails — the residual is now
pinned to ONE eval: when the ENCLOSING fn gets specialized (its Impl(Fn)
arg forces it through create_specialized_function_inline), the closure DEF
inside its body is re-evaluated with FRESH ids (a new fid — defeating
fid-keyed keep-larger) and THAT eval's tracker map lacks the enclosing
spec's rebound params (probes: def-time evals enrich `name`/`flag` fine;
the spec-generation eval's map has only `extras`+`probe`; the emitted
closure fid belongs to the spec eval). NEXT MOVE (one of):

- make the closure-def re-eval inside a spec REUSE the original closure
  fid (stop fresh-id cloning the closure DEF node specifically), so
  keep-larger merges the def-time struct in; or
- track WHY the spec-generation tracker misses the rebound params (probe
  CAPTRK inside the spec eval: are the references even reaching
  evaluate_identifier, or are param lookups short-circuited to comptime
  values by the UnknownVal rebinds?).

Scoreboard unchanged: #70 = 58/61, #69 = 108/180. Thirteen fix commits
total this session, all fixpoint-byte-identical.

## 2026-07-18 SESSION CLOSE — state and marching orders

**Scoreboard: #70 = 58/61 (from 42). #69 = 108/180 (from ~106).**
Eleven fix commits this session, every one with the full gate set
(corpus 130/2 exact, std 154, battery, `s2 check std/env.yo`, fixpoint
BYTE-IDENTICAL): type-identity quartet, supersession, rune/byte scanners,
generic-impl trait-default fill, keep-batch flag, function-registry c_name
clone, typeid name-dedup + Option label parity, dyn wrapper stubs,
stable-identity depth cap.

**SWEEP POLICY (user directive): use the TS runner's per-file time as the
reference — a yo-self run at ≫ TS time IS the divergence (STALL class).
Sweep children get ~300s caps (never 1800s); classify TIMEOUT as STALL and
triage by SAMPLING the compile** (`sample <pid>` — this session's sample of
the imm_sorted_set stall showed 100% CPU in a deep self-recursing type
walker, /tmp/stall_sample.txt; the sti depth cap landed but the stall
PERSISTS — re-identify the hot fid against the CURRENT binary: grep the fid
in the current stage2.c, match its signature/strings to a yo-self walker).

**#70's remaining 3-4**: cache (undeclared temp), effect_analysis (traverse
walks an Option layout for a String field — the suspected FALSE-MERGE in
stable-identity aliasing, analysis in issues/yo-self-round7-tail.md — CHECK
THIS FIRST, it may implicate the alias premise), suspension_analysis,
install_command.

**#69's 72-file tail** — every file has one+ of the ledgered classes:
identity splits (t32-vs-t23 param mismatches), skip-vs-callsite undeclared
fns, Index-call mislowering, downcast FTT, IoExn rc=-6, STALLs. The
per-class fix loci are in issues/yo-self-collections-batch-residuals.md and
this handoff's earlier sections. Use `YO_KEEP_BATCH=1` for every triage.

## 2026-07-18 (later still) — typeid dedup, Option label parity, dyn stubs: #70 at 58/61

- `ecdee47db`: (1) typeid statics dedup by C NAME via the shared
  `type_id_static_names` set (two aliased keys emitted one static twice);
  (2) `create_option_type` labels its Some payload `value` matching prelude
  Option — a `val`-labelled synthesized rendition could win the C-type
  dedup and break the downcast/await emitters' hardcoded `.value`
  designator. lexer + evaluator_index flip green → **#70 = 58/61**.
- `(next commit)`: dyn wrappers emit an abort() stub when their impl
  method's definition was skipped — removes the "call to undeclared
  function fn*yo_id*\*" batch breaker (tests/dyn.test.yo advances to a
  downcast FTT residual).

#70 remaining (4): cache (undeclared temp), effect_analysis (undeclared
effect_parameter_name), suspension_analysis, install_command.

## 2026-07-18 (latest) — registry-mutation fix: #70 at 55/61

`1d6e782cc`: get_function_entry now returns a c_name CLONE (the function-
registry twin of the type-registry get_type_c_name hardening). Inside the
stage-2 binary, the index-call emitter's `${e.c_name}(recv, idx)` template
had been mutating the canonical C name in place — one Index-method
DEFINITION emitted with call-arg text fused into its name, failing the
whole phase6 batch ("expected parameter declarator"). All four phase6
files flip green: **#70 = 55/61**. Remaining six: lexer (typeid
redefinition), cache (undeclared temp), effect_analysis (undeclared
effect_parameter_name), suspension_analysis, evaluator_index,
install_command.

Verified NOT the same root: collections' `call to undeclared function
'yo_id_3230'` persists under the fixed s2 (plus a t32-vs-t25 param type
mismatch — the identity-split family). See
issues/yo-self-collections-batch-residuals.md.

Versioned binaries: /tmp/s1_v2 and /tmp/s2_v2 (1d6e782cc). Do NOT cp over
/tmp/s1//tmp/s2 while sweeps run.

## 2026-07-18 ROUND-7 FINAL SCOREBOARD

**#70 (yo-self/tests): 51/61 files** (from 42). **#69 (tests/): 108/180
files** (from ~106) — the day's fixes landed mostly on the yo-self side
(their strings/multibyte + trait-default shapes); the tests/ divergents are
BIG batches (50–300 tests each) where per-file residuals keep rc=1:

- collections/\*: undeclared-fn (skip-vs-callsite) + Index-call mislowering
  - unresolved-SomeT specs (issues/yo-self-collections-batch-residuals.md).
- imm_sorted_set / imm_sorted_map / btree_map: batch compile TIMEOUT (the
  compile-stall class) — NOTE the SortedSet 9-line repro itself is green;
  the stall is a different layer exposed behind it.
- control_fn_as_regular_call: rc=-6 (the IoExn effect-bundle erasure
  family, analysis in this handoff).
- derive_clone_complex: rc=-11 segv; fs/\* + async/effects + derive/dyn:
  rc=1 untriaged batches.

tests/ flips today: ref*enum, thread_safety. The yo-self flips: the whole
types*_ family + value/unwind/typeof/synthesizer/runtime/pkg*config/target/
version/lock_file/doc*_ (the rune/byte fix).

## (superseded in-flight notes)

**#70 (yo-self/tests): 51/61 files green** — up from 42/61 before today.
The rune/byte fix flipped the whole types\_\*/value/unwind/typeof/synthesizer
tail. The 10 remaining divergents:

- `phase6_verify`, `phase6c_macro`, `phase6d_reflection`,
  `phase6f_macro_helpers` — the macro/reflection family (likely one cause).
- `suspension_analysis`, `evaluator_index`, `install_command`, `lexer`,
  `cache`, `effect_analysis` — assorted (cache = undeclared temp
  identifier; effect_analysis = undeclared `effect_parameter_name`;
  others untriaged).

tests/ round-7 still sweeping (imm region at last check). Collections
residual signatures ledgered in
issues/yo-self-collections-batch-residuals.md (skip-vs-callsite undeclared
fn; Index-call mislowering; unresolved-SomeT specs consumed).

## 2026-07-18 (night) — cache + suspension_analysis ROOT-CAUSED AND FIXED

Two independent root causes, both in the "TS per-object identity vs yo-self
shared-id" family, both with 30-line deterministic corpus repros:

1. **cache.test.yo (undeclared `_file____User_temp_NNNN`)** — NOT a decl-gate
   bug (a begin.yo gate widening was tried and reverted; no effect). The
   missing temp is the COND's result temp on the comptime-degenerate path:
   in `cond(comptime-false => ..., true => match(<runtime Option>...))` as a
   match-arm body (cache.yo:44-62 `get_global_cache_dir` exactly), the cond
   ADOPTS its body's temp (evaluator cond.yo, TS cond.ts:269-276), but
   yo-self's begin finale then stamped a FRESH out_info + minted a FRESH temp
   onto the SHARED node id (begin.yo shared-id single-expression case),
   destroying the adopted binding. TS mints onto the SEPARATE begin wrapper
   node (begin.ts:1016-1045 rewrite+clone) so the inner's variableName always
   survives wrapping. Probe-verified stamp order ([ATTACH]/[COND-ADOPT]).
   FIX (consumer-side): cond codegen's collapse-to-direct path emits a TYPED
   declaration-assignment when the body's result name differs from the
   adopted temp (only the broken-invariant case; the healthy TS-identical
   self-assign is byte-unchanged). An eval-side variable_name CARRY across
   the shared-id begin finale was tried FIRST and REVERTED: it passed every
   behavior gate (corpus/std/battery/cache/flips) but broke the fixpoint —
   and the double-emit test showed SAME-BINARY NONDETERMINISM (the attach
   `.Some`-branch var bookkeeping makes downstream comptime decisions
   sensitive to per-run-random variable ids; ~1.4M-line \_\_yo_tN renumber
   cascade + differing Option-instantiation populations). **NEW GATE RULE:
   any eval-side change touching attach_temp_variable_to_expr / env var
   bookkeeping needs a same-binary DOUBLE-EMIT determinism check, not just
   one fixpoint compare.**
   Corpus repro: tests/codegen-bootstrap/cond_comptime_arm_match_temp.yo
   (fails on pre-fix s2 with the exact 2 undeclared errors).
2. **suspension_analysis 3 runtime failures (detect_all → 0 points)** — the
   dyn impl KEY was derived from the UNRESOLVED `Impl(Fn)` SomeT (one shape
   id per SIGNATURE): both same-signature detector closures registered under
   ONE key → one wrapper → every dyn box dispatched the first-emitted
   closure's body with its own capture data. TS resolves
   `resolvedConcreteType` BEFORE the key (dyn.ts:70-74) → per-closure
   capture-struct keys (verified in TS emission of the same batch source).
   FIX: resolve_some_type_to_concrete for the impl KEY in generate_dyn_call
   (entry still stores the raw type, like TS). Corpus repro:
   tests/codegen-bootstrap/dyn_fn_same_sig_closures.yo (pre-fix prints 714 —
   shared wrapper × own captures; fixed prints 814). suspension_analysis:
   **9/9 green** under the fixed s1.

Corpus baseline is now **133 PASS / DIFF 2** (three new regression files).
Full gates re-run for both fixes (corpus, std 153/153, battery ×5, fixpoint
chain + env-check, cache + suspension under the new s2, prior-flip holds).

## 2026-07-18 (round 10) — #70 = 61/61; recursion-guard fix lands; #69 next

- **#70 COMPLETE: 61/61** `s2 test` green over yo-self/tests (round-10 sweep
  under the committed binary). phase6_verify flaked rc=1 ONCE in the sweep
  and then passed 5/5 across two gate batteries + a 3x probe with
  byte-identical batch C — environmental flake under peak RAM pressure, not
  compiler logic (issues/yo-self-round7-tail.md, PROBE VERDICT). The eval
  trio runs fine under the 1800s cap.
- `85f44b843`: the specialization recursion guards now compare
  `impl_bindings_sig` (the impl forall bindings injected as TypeVal captures)
  alongside the func_id — a generic-impl trait method specializing and
  calling ITSELF at a SMALLER instantiation (nested ArrayList equality) was
  misread as self-recursion and emitted the bare generic fid (the collections
  "call to undeclared 'yo_id_3230'" residual). TS-parity via impl.ts:1551's
  per-instantiation funcIds. Corpus regression: nested_generic_trait_eq.yo.
  Full gates green incl. fixpoint + double-emit determinism.
- **#69 marching orders:** re-sweep the r4 divergent list with the r11 pin
  (all of today's fixes). The next root-caused class is the WRONG-SPEC PICK:
  `Option(String).is_some()` cache-hits the `Option(i32)` spec — hypothesis
  - probe site in issues/yo-self-collections-batch-residuals.md (receiver
    arg*type unresolved `Option(T)` at the cache compare while the mint-time
    signature resolves T from callee_env). Round-10 tests/ partials (39 files,
    OLD pin — the "before" column): /tmp/s2_sweep_r10/tests*\*.done.

## 2026-07-19 — enum exact-compare fix: array_list flips whole-file green

- `21e9fc71a`: the WRONG-SPEC PICK root cause was NOT the receiver arg_type
  (probe showed `rt=[Option(String)] cached=[Option(i32)]` and the compare
  HIT anyway): the enum exact arm's `aid == eid → true` fast-ACCEPT declared
  same-declaration instantiations exact-equal (yo-self generic-enum
  instantiations SHARE the declaration eval id — both Option(i32) and
  Option(String) carry enum_yo_id_3135). TS only id-compares as an early
  REJECT; acceptance always structurally compares variant field types
  (compatibility.ts:354-389). Fix: drop the fast-accept. Combined with the
  `85f44b843` recursion-guard fix, tests/collections/array_list.test.yo goes
  0 → 87 passed (whole file). Corpus regression:
  option_spec_per_payload.yo (corpus baseline now **134 PASS / DIFF 2**).
- **Round-12 sweep** launched over the r4 list under /tmp/s2_r12pin
  (= post-21e9fc71a s2, full gates green incl. fixpoint + determinism).
  Results land in /tmp/s2_sweep_r12/.
- **The remaining collections class is the identity SPLIT** (inverse of the
  fixed false-HIT): deque fails `passing __yo_t33 to __yo_t30` where BOTH
  render `gs_yo_id_5031_i32` but carry DIFFERENT sids (7146 vs 7237) — one
  Yo type minted TWICE (CTFE/instantiation cache false-MISS), the spec
  emitted against one sid while call sites hold the other. hash_map/imm_map
  same shape. This is the declaration-stable-id surgery (see the earlier
  FIRST-ATTEMPT-FAILED note before re-attempting the naive swap; the fix
  must make the instantiation CACHE hit, or make sids declaration-derived).
  Evidence + batches: issues/yo-self-collections-batch-residuals.md.

## 2026-07-19 ROUND-12 SCOREBOARD — #69 = 112/180

Round-12 sweep (all 74 r4-list divergents, /tmp/s2_r12pin, 600s caps)
COMPLETED: **6 flips** — array_list (87/87 through the SELF-COMPILED stage),
recursive_enum, ref_enum, string/string, thread_safety, url/url. **#69 =
112/180** (was 108). The 68-file tail histogram (grep of
/tmp/s2_sweep_r12/\*.done):

- 8x `use of undeclared identifier` + 3x `call to undeclared function`
- 8x `expected expression`
- 7x `conflicting types` + 2x `redefinition` + 2x `unexpected type name`
- 7x rc=-6 (the IoExn effect-bundle erasure family, analysis in this doc)
- 5x TIMEOUT (compile-stall class: btree_map, imm_sorted_map/set, threading)
- 5x yo-self-level errors (no clang stage)
- 4x `initializing` mismatch + 3x `passing` mismatch (identity-SPLIT family)
- 4x `X must be the first and only parameter if specified` (NEW signature —
  untriaged; likely one emitter bug across 4 files)

## 2026-07-19 (cont.) — degenerate-spec refusal: env.test.yo green, the void-param family defused

`894641e10`: create_specialized_function_inline refuses to mint when a
runtime arg's type collapsed to UNIT against a concrete non-unit declared
param (degenerate analysis pass; the good pass re-stamps the call site), and
prefers the resolved DECLARED param type when building the registered spec
type. The bisect chain (arm-deletion -> keep-only -> feature/import whittle
over the saved env batch) pinned the trigger to `open(import("std/env"))`.
tests/env.test.yo flips green (13 passed). RESIDUAL (open): when the
degenerate pass is the ONLY pass (8-line repro
issues/repros/void-param-assert-open-env.yo), the open-member resolution
itself returns non-Func under analysis (try_to_call soft fallback -> t_unit)
— fix locus is the identifier/member resolution through `open`s.
async_await/sync_mutex/prelude stay red on OTHER families. Round-13 sweep
launched under /tmp/s2_r13pin.

## 2026-07-19 (cont. 2) — cfid nominal rule: the identity-split family falls

The collections identity-split was NOT a one-type-two-sids CTFE miss after
all: ddmin (38 arms -> 2) + C decoding showed TWO DIFFERENT declarations
with IDENTICAL layouts (DequeIter vs DequeIterPtr) comparing exact-EQUAL
(empty names, fresh sids, equal type_arguments), so the shared
Iterator-trait DEFAULT `into_iter : Self -> Self` served ONE spec for both
receivers. FIX: the exact struct compare gains the missing NOMINAL rule —
different non-empty constructor_func_ids => DISTINCT (TS's
functionValue.funcId check; the non-exact arm already used it). Whole files
flip: deque 38/38, hash_map 61/61, hash_set 63/63. imm_map/linked_list
advance from compile-fail to a runtime layer (rc=138/139 — next). Corpus
regression: iter_structs_identical_layout.yo (pre-fix red, TS+fixed green).

## 2026-07-19 (cont. 3) — loader error channel: circular_import green

`8eff2c24e`: a module whose top-level eval failed unwound the STASHED driver
exn from \_load_module_at_abs, aborting the whole check even when the import
sat inside `comptime_expect_error(import(...))` (the circular_error fixture
EXPECTS the cycle error). Now the capturing handler stashes the message via
a module-level fn, \_load_module_at_abs RETURNS Option(String), and
demand_load_module surfaces it as LoadModuleResult.module_error — which
evaluate_import rethrows through the IMPORT SITE's exn, where the expect
catches it (TS parity). tests/circular_import.test.yo flips green (6
passed). Full gates green (corpus 135/2-known incl. the new
iter_structs_identical_layout regression, fixpoint + determinism hold).
Round-15 sweep running under /tmp/s2_r15pin (8 fixes).

**Compile-stall class PROFILED (2026-07-19, sample of the live btree_map
stall — /tmp/btree_sample.txt):** the hot stack is a deep RECURSIVE
EVALUATION cycle, not a tight loop: evaluate_expression (yo_id_227751/
298926/298088 in the r15 pin) -> per-node handlers (match yo_id_271410 /
cond yo_id_269273 / call yo_id_237117) -> evaluate_begin_expression
(yo_id_254050, identified by its (expr, env, ctx, variables_to_add,
is_fn_body, exn) signature) -> recurse. The evaluator grinds an enormous
derivation — the exponential re-evaluation class (specialization cache not
hitting for btree's deeply generic recursive bodies). Same class expected
for imm_sorted_map/set/threading TIMEOUTs. Entry point: instrument the spec
cache hit/miss ratio per fid during a btree batch compile and find the
missing key dimension.

**MECHANICAL BISECTION PLAYBOOK (proved decisive 3x on 2026-07-19 — use it
before hand-crafting repros):** batch failures rarely reproduce hand-rolled
(analysis-mode arm evaluation is part of the trigger). Instead: (1) run the
failing file with YO_KEEP_BATCH=1 and SAVE the batch .yo; (2) arm-deletion
pass (minus-arm-k) — if one arm's removal clears it, that arm is the
producer; (3) keep-only-arm-k — single sufficient arms shrink the repro to
~15 lines; (4) if no single arm suffices, ddmin over arm subsets (the deque
split needed exactly 2 of 38 arms; ~9 compiles); (5) feature/import whittle
on the reduced file (the void-param trigger was ONE import form:
open(std/env) vs destructure). Scripts: scratchpad
bisect_void.py / bisect_void2.py / ddmin_deque.py / whittle\*.py — copy and
retarget (oracle = a grep over the emitted C or the compile stderr).

## 2026-07-19 ROUND-15 FINAL — #69 = 116/180

Round-15 (74-file r4 list, /tmp/s2_r15pin = all 8 fixes): **10 green** —
array_list, deque, hash_map, hash_set, env, circular_import, ref_enum,
string/string, thread_safety, url/url. **#69 = 116/180** (106 base + 10).
ONE regression inside the round: recursive_enum (green in r12) — the cfid
rule made Range/RangeInclusive nominally distinct (CORRECT; identical
{start,end} layouts) and a consumer relying on their structural unification
now misses (runtime wrong-sum in the ArrayList(Self) test; full decode +
next probe in issues/yo-self-collections-batch-residuals.md). Remaining
64-file tail families unchanged from the round-12 histogram (identity-split
cfid-drop variant, rc=-6 IoExn, stalls [now profiled], expected-expression,
conflicting-types, open-member residual).

Priorities for the next session: (1) the identity-split surgery (biggest
combined family: conflicting-types/initializing/passing/redefinition ≈ 16
files all point at one-type-two-sids); (2) the rc=-6 IoExn family (7 files,
analysis already in this doc); (3) the new "first and only parameter"
signature (4 files, probably shallow); (4) stalls last (profile with
sample(1) per the TS-timing policy).

**OPERATIONAL: never `cp` over /tmp/s1 / /tmp/s2 while a sweep runs** —
macOS SIGKILLs children whose backing binary is replaced (an rc=-9 block
mid-sweep = invalid results, re-run those files). Pin sweeps to a versioned
copy (e.g. /tmp/s2_r7pin) instead.

## Recent commits (this era, newest first)

```
2ad3fba4a test(yo-self): migrate the eval trio — 337/337 green in ~90s/file (was 3× 1800s timeouts)
a91ee6230 test(yo-self): repair all remaining stale tests — full suite green under TS
25761e121 test(yo-self): audit + refresh the yo-self/tests suite
702de11c9 fix(yo-self): infer forall params structurally from composite arg types
6928dc81f fix(yo-self): comptime_expect_error restores env/ctx stranded by the expected throw
9100cc135 fix(yo-self): omitted default args flow through calls like supplied args
7b941173b feat(yo-self): implement the `test` command (port of the batched test runner)
b2b80c097 fix(yo-self): dup RC-typed closure captures into the capture struct
1017e7ffd fix(yo-self): module-level bare-atom reassignment collection + emission  ← FIXPOINT REACHED here
546a5a25d fix(yo-self): TS callMayUnwind atom-callee fallback (unwind-resume parity)
de6cdd4bd fix(yo-self): preserve first initialized_at_token on reassignment (the 1.6M-Variable leak)
```

## TL;DR for the fresh agent

Start with Step 1 (#69): build s1 + s2 (commands above), generate the TS
baseline of `tests/`, run the s2 sweep, and triage per-file divergences with
the triage loop — you will hit Bug 3 (exit-after-spawn rc=134) early; fix it
via the RC tooling. Then Step 2 (#70): the TS baseline is exact and 100%
green — run `s2 test ./yo-self/tests` and close the divergences the same
way. Never run two test invocations on one directory concurrently. Fixpoint

- corpus + std are your gates after every change; revert on regression.
  When both sweeps match TS, the codegen bootstrap is DONE — do Step 3's
  cleanup and declare victory.
