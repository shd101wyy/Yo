# yo-self Stage-2 Handoff — #69/#70 Campaign

_Last updated 2026-07-19 (agent handover). This file was rewritten from
1450 lines of session logs down to the actionable map; `git log` of this
file has the full archaeology — do not re-litigate fixed bugs._

**READ THIS WHOLE FILE FIRST.** Deeper evidence (every probe, dead end, and
reverted candidate of the async/dispose/spec families) lives in
`issues/yo-self-async-emission-cluster.md` — consult it before re-deriving
anything about those families.

## SESSION UPDATE 2026-07-19 (post-round-19) — READ FIRST

- **#69 now 128/180** (was 126). Landed: `ccd90b91e` (P1 `\u` decode → str.test
  3/3), `845e4e68e` (FloatLit exponent-form → time/duration 12/12). Both fully
  gated (corpus PASS 135, std 153/153, str+duration flips, prior flips hold,
  **STRICT_FIXPOINT=HOLDS**).
- **FIXPOINT: FRAGILITY FIXED (`ebdd27ca8`).** The strict stage2≡stage3 gate is
  the s1(TS) vs s2(self) 3-stage comparison; it was marginally host-dependent
  (HashMap bucket-order emission — a fresh clean rebuild broke it, though the
  committed compiler was self-stable). The **determinism fix LANDED**: function
  emission now iterates a `function_order` insertion-order list (mirrors TS
  `for..in`) instead of `functions.keys()` bucket order. Result:
  **STRICT_FIXPOINT=HOLDS robustly**, regression-free (corpus PASS 135, std
  153/153, prior flips hold). The function half ALONE sufficed (type_order NOT
  needed — spec/type ids are assigned during now-deterministic function
  emission). Bootstrap fixpoint is now robust; future function-adding fixes
  won't destabilize it. (`issues/yo-self-emission-order-nondeterminism.md` has
  the full analysis.)
- **Full clustering of the 52 remaining red files (this session's sweeps,
  s2_r19pin/s2_p1d):**
  - _Spec type-identity_ (~14): `incompatible type __yo_tX vs __yo_tY` /
    undeclared `yo_id_N`/`**unknown**Type`/`gs_` specs — arc, imm_list/map/set/
    string, thread, error, impl, cli/arg_parser, collections/linked_list/
    ordered_map, closure_capture_rc_leak, forward_ref_self_method. Per-call
    type identity (Gap-6 family). HARD.
  - _"expected expression" codegen_ (~5): derive, dyn, flowability_comprehensive,
    forward_ref_impl_block, module_struct_unification. Emitter puts a type name
    where C wants a value (msu: `.next = __yo_t32` — closure/fn-typed struct
    field emits the struct type name). LIKELY MULTIPLE ROOTS (diverse features).
  - _Async-future_ (5): fs/dir/file/fs*convenience/walker, sys/bufio —
    forward-decl emits `\_\_yo_io_future_t*`but def emits`\*...\_sync_fut_t\*`
    ("conflicting types"). The io.async block's SM struct name (ei.
    async_state_machine_struct_name) is computed during BODY emission, too late
    for the decl phase (699/725). Needs a pre-pass. Async-arc.
  - _Dispose_ (6): sync/atomic/channel/mutex/once/rwlock/waitgroup +
    ordered_map — `undeclared yo_id_N` (Mutex=6143). collectDisposeMethods-
    FromGenericImpls, Gap-6-blocked (ledger item 8).
  - _incomplete-void_ (2): derive_clone_complex, worker (`incomplete type void`).
  - _check-error_ (2): ref_field_borrow, ref_return_ban — `Expected compile
error but evaluated successfully` (borrow check not enforced in yo-self eval).
  - _Iso port_ (3): iso, rc, iso_api_surface — get_type_string .IsoT panic +
    generate_iso_type_declarations is a NO-OP stub (P4). IN PROGRESS.
  - _behavioral_: cycle_collector (15/1 — "Garbage cycle collected while live
    objects survive"), encoding/json (24/11), http/http (7/2), sys/timer (1 —
    io.async FSM transform, dedicated arc).
  - TIMEOUT (5): collections/btree_map/priority_queue, imm_sorted_map/set,
    imm_threading — exponential re-eval (spec family).
- Scratchpad: `clusters.md`, `red_root.txt`/`red_subdir.txt`, `diag_sweep.sh`,
  `gates_p1d.sh` (functional gate template — macOS has no `setsid`, use
  `timeout -s KILL` alone).
- **Scoped roots (this session's deep-dives — start here for these files):**
  - `ref_return_ban` (1 file): LAYER 1 FIXED (`e746531c2`) — the trait-method
    `-> inout(Self.Element)` ban was swallowed because `_evaluate_trait_field`
    (trait.yo:771) evaluated the field TYPE via the non-raw (swallowing)
    `evaluate_expression`, unlike its sibling paths (313/458) which use
    `evaluate_expression_raw`. Now uses raw + passes exn → the ban propagates to
    `comptime_expect_error`. LAYER 2 (now the blocker): with eval proceeding to
    codegen, a PRE-EXISTING `.`-vs-`->` bug surfaces — `int32_t x = p.x;` where
    `p` is an `inout(Point)` param (`__yo_t22*`, a pointer) → C error "member
    reference type '\_\_yo_tN *' is a pointer; did you mean to use '->'". Field
    access on an inout/pointer param isn't deref'd. Find the plain FIELD-access
    emitter (NOT the index-method path at generation.yo:342-395) and apply the
    param is_ref deref (`(*p).x`/`p->x`), mirroring the `(\*self)->field`
    handling. May affect other inout-param files too.
  - `module_struct_unification` + the "expected expression" cluster: NOT one
    root. msu is a closure/fn-typed struct field emitting the struct TYPE name
    (`(__yo_t32){ .next = __yo_t32 }` for `Counter(next : (() -> i32(7)))`) —
    closure-as-fn-pointer-field codegen. iso.test's "expected expression" is a
    DIFFERENT root (FTT of `.extract()` — see iso patch commit 90fd8ece1).
  - `iso`/`rc`/`iso_api_surface`: type-decl port done (patch
    `issues/iso-type-decl-port.patch`); remaining = evaluator `.extract()` →
    `__yo_iso_extract` resolution + `Array_Array_*` decl.
  - **async-future cluster (5 files — best files/cycle) PRECISE scoping:** SM
    struct name = `` `${async_block_id}_state_t` `` where async*block_id =
    `ei.variable_name` (async.yo ~1490/1914), set via `_set_async_sm_struct_name`
    (async.yo:1864 → `ei.async_state_machine_struct_name`). Forward-decl reads it
    at declarations.yo:520 (`_async_override_return_type`) but finds `.None` →
    `\_\_yo_io_future_t*`fallback (the`.None` branch, NOT a wrong name) →
"conflicting types" vs the def. CRUCIAL: the pre-pass
(`preregister_async_blocks_in_expr`, async.yo:1893, called via
`preregister_async_block_types`at codegen_c.yo:265 BEFORE declarations)
ALREADY computes`${async_block_id}\_state_t`and calls`\_set_async_sm_struct_name`(async.yo:1914-1915) — yet the forward-decl reads`.None`. So the bug is NOT "missing pre-pass"; it is either (a) the setting is
LOST — the async-block ExprInfo is REPLACED between the pre-pass and the decl
phase (the ExprInfo-table store-without-dup / UAF class — the pre-pass mutates
`ei`then`expr_info_table_set`s it, but a later eval/collect pass overwrites
the table entry), or (b) the async-block condition at async.yo:1897 is not met
for the fs/* `File.open`-delegate shape (so the pre-pass never sets it). PROBE
(one debug build): at declarations.yo:520 print `ei.async_state_machine_struct_name`    -`ast_expr_id`, and at async.yo:1915 print the same id + name — compare ids to
    see if it's a different ExprInfo (→ persistence fix) or never-set (→ path fix).
  - **async-future is likely the DELEGATE case** (declarations.yo:690-696
    comment): fs/\* `File.open` RETURNS `File.open_with(...)`'s future (no direct
    async block of its own), so the forward-decl's `find_returned_async_block`
    returns `.None`. The 2-round `_async_override_return_type` loop (699) is meant
    to resolve callee-before-caller, but iterates `functions.keys()` in HASHMAP
    order → if `File.open` sorts before `File.open_with`, round 1 can't resolve
    and 2 rounds don't cover deeper/misordered chains. **CROSS-CLUSTER LINK:**
    making the 699 loop iterate INSERTION order (callee registered before caller)
    is exactly the determinism fix's declarations.yo:699 change. **OUTCOME
    (`ebdd27ca8`):** the determinism fix DID advance all 5 fs/_ files —
    forward-decl "conflicting types" is GONE. NEXT LAYER (now the only fs/_
    blocker): the AWAIT site `future_type_name := get_type_string(future_type)`
    (await.yo:378) still returns the generic `__yo_io_future_t*` fallback, but
    the poll loop (await.yo:439) accesses the SPECIFIC SM field `->__yo_resume_fn`
    → "no member named **yo_resume_fn in struct **yo_io_future_t". FIX: at the
    await site, resolve `future_type` (a Future SomeType) to its concrete SM
    struct — TS reads the per-call SomeT's `resolvedConcreteType` (await.ts:82-95);
    yo-self lacks that (Gap-6). Lead: read the awaited future's async block's
    `async_state_machine_struct_name` (as the forward-decl now does), or register
    `type_key(future_type) → SM struct` so get_type_string resolves it. Fixes 5
    files.
  - Determinism (host-independent fixpoint): **LANDED `ebdd27ca8`** —
    STRICT_FIXPOINT=HOLDS robustly with the function_order half alone. Bootstrap
    fixpoint no longer fragile.

## TL;DR — where things stand

- **#70 (`s2 test ./yo-self/tests`): DONE — 61/61** files match the TS baseline.
- **#69 (`s2 test ./tests`): 128/180** files match. 52 remain; see SESSION
  UPDATE above for the full current clustering (supersedes the round-19 red list
  at the bottom for triage purposes).
- ~32 gated fix commits landed across the campaign.

## Definitions

- **s1** = the TS-compiled yo-self binary: `./yo-cli compile yo-self/main.yo --release -o /tmp/s1`.
- **s2** = clang -O2 of the C that s1 emits for yo-self itself (stage2.c).
- **fixpoint** = stage2.c ≡ stage3.c byte-identical (s2 re-emitting yo-self).
- **#69 / #70** = self-hosted test runner parity on `./tests` (180 files) /
  `./yo-self/tests` (61 files) vs `./yo-cli test`.
- A test FILE "matches" when `s2 test <file>` rc==0 with the same pass count
  as `./yo-cli test <file>`.

## THE METHOD (non-negotiable — proven over ~25 fix rounds)

1. **Faithful port first.** Find the TS behavior (file:line), port that shape.
   When yo-self's model genuinely differs (value semantics vs TS object
   identity, mutable env vs persistent chains), document the divergence in a
   comment AND pick the semantically equivalent mechanism — see
   `_freshen_io_builtin_callee` (calls/function.yo) and the Step-2 skip
   (calls/helper.yo) for worked examples.
2. **Full gate battery after EVERY yo-self change; revert on ANY regression.**
   Copy `scratchpad/gates_v18.sh`-style scripts (sed-rename the binary/temp
   names per iteration). The battery: corpus diff-test → `check ./std` →
   5-repro battery → SAME-BINARY DOUBLE-EMIT determinism → stage2 clang →
   `s2 check std/env.yo` → stage3 emit → fixpoint cmp → target/flip files.
   Green baseline: `PASS 135 DIFF 2 SELF-FAIL 0`, `STD_RC=0`, all `BATTERY
compile=0 run=0`, `S1E_DETERMINISTIC`, `ENV=0`, `FIXPOINT=HOLDS`, flips
   install_command 43 / effect_analysis 19 / lexer 34 / phase6_verify 3 +
   targets cache 6 / suspension_analysis 9.
3. **Probe before fixing.** Debug builds with `eprintln` instrumentation
   (~8-10 min per `./yo-cli compile yo-self/main.yo --release` cycle) beat
   speculation. Strip ALL instrumentation before the gate build (git checkout
   for pure-debug files; the commit must match the gated tree).
4. **Batch shape matters.** The runner synthesizes
   `main :: fn() -> unit { io :: __yo_builtin_io; match(env YO_TEST_INDEX) …cond arms… }`
   per ~30 tests. Many bugs ONLY reproduce there. `YO_KEEP_BATCH=1 s2 test <file>`
   keeps `<dir>/.yo_selftest_batch_N.yo` + `.bin.c`. **Batches REGENERATE per
   run — never correlate line/col positions across runs** (this misled two
   probe cycles; same-run data only).
5. **Sweeps**: pin binaries (`cp /tmp/s2vN /tmp/s2_rNpin`), python runner with
   `preexec_fn=os.setsid`, 600s timeout, `.done` files for resumability
   (`scratchpad/s2_sweep_r19.py` is the template; the 74-file divergent list
   is `/tmp/s2_r4_list.txt` — regenerate from the red list below if lost).
   Long jobs die on this machine — `nohup … & disown` + Monitor loops, never
   foreground sleeps. Don't cp over a running binary (SIGKILL). Sweep
   timeouts ≈ 10× the TS per-file time; a big overshoot IS the divergence.
6. Known noise: corpus `DIFF 2` (bench_sort timing + ptr_deref_copy_rc_struct
   RC-count print) is the accepted baseline. rc=139 right after a C-compile
   failure is the known teardown segv, not a new crash. Don't run
   `check ./yo-self` whole-dir as a gate (known ~50-min stall).

## BUILD / VERIFY COMMANDS

```bash
bun run build                                    # always before yo-cli work
./yo-cli compile yo-self/main.yo --release -o /tmp/s1   # s1 (~8-10 min)
/tmp/s1 compile yo-self/main.yo --emit-c -o /tmp/stage2 # stage2.c (~10 min)
clang -std=c11 -fno-strict-aliasing -fwrapv -w -O2 /tmp/stage2.c -o /tmp/s2
/tmp/s2 test ./tests/<file>                      # the #69 definition
YO_SELF_BIN=/tmp/s1 scripts/diff-test.sh tests/codegen-bootstrap --parallel 4
YO_MAIN_STACK_MB=4096 <bin> …                    # for deep-recursion checks
./yo-cli check yo-self/<file>.yo                 # fast type-check iteration
./yo-cli fmt yo-self/<file>.yo                   # REQUIRED before commit
```

## REMAINING #69 WORK — priorities, in detail

The 54 red files (round 19): 46 rc=1, 5 TIMEOUT, 3 rc=-6. Full list at the
bottom. Work them in this order:

### P1 — `\u` escape decode gap (quick win, 1-2 file flips)

`tests/str.test.yo` fails ONE assert: `String.from("café").raw_bytes().len == 5`
(the `é` source form). TS decodes escapes at parse (JSON.parse — the
stored value holds the real 2-byte é); yo-self's `StrLit` keeps RAW token
text and decodes at consumption — its decoder handles `\n/\t/\"/\\` (proven
by the suite) but NOT `\uXXXX`; `_c_string_literal`
(codegen/exprs/comptime_value.yo) then escapes the backslash and the C
string is the literal 9 bytes. FIX: find the shared escape decoder (grep the
`u8(92)` handling that also handles `n` — start at
`yo-self/evaluator/values/string.yo`, whose header describes the
decode-at-evaluation convention, and `yo-self/evaluator/values/char.yo:33`
which decodes char escapes) and add `\uXXXX` → UTF-8 encoding wherever the
basics are decoded (there may be more than one consumer — eval-side String
construction AND `_c_string_literal`'s C-literal rendering; TS reference:
whatever `src/lexer.ts`/JSON.parse produce, then
`comptime-value.ts:82 JSON.stringify`). Check `tests/encoding/json.test.yo`
for the same root. Verify: str + json files, then full gates.

### P2 — the behavioral single-failure tail (compile-green files)

Files that COMPILE and run with few failing tests — cheapest per-file wins.
Diagnose with `s2 test <file>` and read the failing assert. Untriaged
candidates: cycle*collector, time/duration, sync/atomic, sync/rwlock,
comptime, error, impl, module_struct_unification, ref*_ trio,
flowability*comprehensive, forward_ref*_ pair.

EXCEPTION — do NOT treat as quick wins:

- `tests/sys/timer.test.yo` (1 failure): cooperative-interleaving semantics —
  yo-self lowers awaits inside io.async closures as BLOCKING sync-await poll
  loops; TS transforms multi-await closures into resumable FSMs
  (`_yo…_resume` switch). The fix is the io.async closure FSM transform port
  (codegen/async/) — a dedicated arc.

### P3 — Gap-6: `create_specialized_function_inline` (the dominant blocker)

Blocks three sub-families:

- The `imm_*` family + linked*list/ordered_map/priority_queue (the
  `yo_id*…**unknown**Type…` undeclared-spec class — uncollected/
  mis-specialized generic-impl methods).
- The generic-impl DISPOSE family (`tests/sync/*` + imm_map + ordered_map):
  `collectDisposeMethodsFromGenericImpls` (TS collection.ts:650) was never
  ported. The port is NOT the direct-registration TS shape — yo-self's
  `find_methods_from_generic_impls` returns a GENERIC (hard-generic,
  emission-skipped) FuncVal, so the constructor's `header.dispose_fn = <fid>`
  renders an undeclared identifier (e.g. Mutex's `yo_id_6143`). The full
  three-stage fix (trace-sibling-shaped monomorphizer via
  create_specialized_function_inline + emittable-entry resolver preference in
  `get_dispose_function_for_type`) is DESIGNED AND PRESERVED in ledger item 8
  — it lands trivially once the monomorphizer handles those bodies (currently
  it soft-fails on them — the Gap-6 class).
- Most of the 5 TIMEOUT stalls (imm_sorted_map/set, btree_map,
  priority_queue, imm_threading): exponential re-evaluation through the eval
  dispatch cycle. Profile method: `sample <pid> 1` during the stall.

State: attempts #1-#6 preserved on branch `wip/resolution-time-spec`.
Attempt #6 (eager + deterministic spec fids) passed every standing gate but
broke stage2 at self-compile scale (HashMap layout collapse) — its bisect and
a 3-option salvage plan are in
`issues/yo-self-sortedset-method-call-type-void.md`. Salvage option 1 (lldb
one crashing spec in stage2, extract its C, diff against the unspecialized
original) is the designed entry point. **Cheap extra gate for all spec-port
work**: build stage2 and run `s2 check std/env.yo` before any sweep.

### P4 — Iso lowering port (tests/iso.test.yo, tests/rc.test.yo, then iso_api_surface)

iso/rc abort at `get_type_string: Iso lowering is Phase 3 — not yet ported`
(codegen/utils/index.yo `.IsoT` arm). Port TS `getTypeString`'s Iso branch +
iso type collection/runtime. A PORT work item, not a bug hunt.

### P5 — deferred/reverted items (re-land carefully)

- **helper.ts:1314 flag parity** (`is_inside_io_async_call` in the
  UnknownVal-callee arms of calls/function.yo — where builtin io.async calls
  actually land): correct per TS, REVERTED for breaking same-binary
  double-emit determinism (flag-gated capture-info registrations are
  emission-order-sensitive). To land: find which registration diverges
  between two emits of one binary, make it order-stable, then re-apply.
  Ledger item 7 has the exact edit.
- **fs/ + http/ + regex + worker/thread/arc families** (untriaged rc=1):
  likely share roots with the dispose/spec families — re-triage AFTER P3.
- `tests/prelude.test.yo`, `tests/dyn.test.yo`, `tests/derive*.yo`:
  untriaged; grep their batch errors fresh (`YO_KEEP_BATCH=1`).

### Step 3 (after #69 or when instructed): finalization

Fixpoint re-verify (full chain), move resolved `issues/*.md` to
`issues/fixed/`, update `yo-self/README.md` status, mark
`plans/BOOTSTRAPPING.md` historical, delete stale `/tmp` pins.

## HARD-WON INVARIANTS (violate these and you will re-live old sessions)

- **Per-call type identity is THE recurring theme.** TS clones callee types
  per call and mutates per-object; yo-self shares by lineage. Landed
  mechanisms (do not weaken them): `_freshen_io_builtin_callee` (per-call
  forall SomeTs for io.async, calls/function.yo), call-scoped forall rebinds +
  lineage-identity gate (types/synthesizer.yo `_bind_some_type`), the
  constraint-gated Step-2 skip (calls/helper.yo — io.async params skip the
  name-based re-evaluation ONLY when no Future-carrying expected exists;
  WITH a constraint, Step-6b's call-local pre-binds NEED Step-2 as their
  delivery — the un-annotated `(e) => e.io` bundle actions depend on it;
  `tests/codegen-bootstrap/io_async_bundle_field.yo` +
  `closure_capture_rc_dup.yo` are the canaries).
- The evaluator's `->`-handler swallow walls (`_trial_eval_anon_body` etc.)
  hide nested throws and mis-attribute them — when hunting swallowed
  failures, stash the error text into a module global from the handler
  (worked pattern in ledger item 7).
- `extern` language tags normalize to LOWERCASE ("yo"/"c") — compare "yo".
- Trait-associated type NAMES ("Output", "Item") collide with module
  bindings in name-based env walks — never resolve SomeTs by bare name
  without an allow-list (see `_subst_some_types_from_env`'s allow-list in
  evaluator/values/anonymous_function.yo).
- Emitters must agree with the PROTOTYPE renderer on void-ness: resolve
  SomeT results through `resolve_some_type_to_concrete` before
  `is_unit_type` (generate_function_body's `result_is_unit` pattern).
- Names in the captures side-table can be REAL C params (the SM bundle param
  `e`) — in-scope C names take precedence over capture-context rewrites
  (`scope_stack_contains` first; see the sync-future capture literal in
  codegen/exprs/async.yo).
- io-builtin struct fields (`Io`/`JoinHandle` literals) lower to NULL fn
  pointers via the extern-name set {**yo_io_async/await/state/spawn,
  **yo_join_handle_await} (comptime_value.yo `_is_io_builtin_fn_type`).
- `:=` bindings are immutable — reassignment needs a `(x : T) = …` declaration.
- No forward references between top-level `::` bindings — define helpers
  before their callers.
- Yo `match` does not support nested patterns (`.Some(.Struct(...))` fails) —
  flatten with nested `match`. `.None => { expr }` with a single expression
  parses as a struct literal — use `.None => expr`.
- Adding FIELDS to `Frame`/hot types can re-trigger the `_patch_self_shell`
  exponential walk — use id-keyed side-tables (the established pattern).
- fmt every touched .yo file (`./yo-cli fmt`); lint-staged reformats .md on
  commit (later Edit old_strings must match the prettier output).
- A `-O0` binary that SIGSEGVs on deep recursion is stack exhaustion —
  `--release` or `YO_MAIN_STACK_MB=4096`, don't chase ASan (see AGENTS.md).

## KEY LOCATIONS

- `issues/yo-self-async-emission-cluster.md` — the async/dispose/spec
  evidence ledger (items 1-9: the fourteen-probe async arc, every reverted
  candidate with its failure mode, the dispose port design, the `\u` gap).
- `issues/yo-self-sortedset-method-call-type-void.md` — Gap-6 attempts +
  salvage plan.
- `issues/repros/` — committed minimal repros.
  `io-async-result-t-cell-poisoning.yo` (20-line async two-task repro) must
  stay green in every async-adjacent ladder.
- `tests/codegen-bootstrap/` — the 137-file corpus. Async-arc regression
  canaries: `closure_capture_rc_dup.yo`, `io_async_bundle_field.yo`,
  `io_async_fsm_multi.yo` (the last one's pre-2026-07-19 "PASS" was a false
  pass — placeholder comments returning 42 by luck; it now emits real awaits).
- `scratchpad/gates_v18.sh`, `scratchpad/s2_sweep_r19.py` — battery + sweep
  templates (session scratchpad; if gone, rebuild from the battery
  description in THE METHOD above).
- Battery repro files referenced by the gate scripts: `/tmp/tk2.yo
/tmp/counter_check.yo /tmp/sortedset_repro.yo /tmp/ne_repro.yo
issues/repros/dyn-closure-implfn-capture-loss.yo` (the /tmp ones may be
  gone after reboot — recover from git history or drop them from the copy of
  the gate script and rely on corpus + std + fixpoint + flips).

## ROUND-19 RED LIST (54 files — the work queue)

rc=1 (46): arc, cli/arg_parser, closure_capture_rc_leak,
collections/linked_list, collections/ordered_map, comptime, cycle_collector,
derive, derive_clone_complex, dyn, encoding/json, error,
flowability_comprehensive, forward_ref_impl_block, forward_ref_self_method,
fs/dir, fs/file, fs/fs_convenience, fs/metadata, fs/temp, fs/walker,
http/http, imm_list, imm_map, imm_set, imm_string, impl,
impl_fn_field_rejection, module_struct_unification, prelude,
ref_closure_capture, ref_field_borrow, ref_return_ban, regex/regex, str,
sync/atomic, sync/channel, sync/mutex, sync/once, sync/rwlock,
sync/waitgroup, sys/bufio, sys/timer, thread, time/duration, worker.

TIMEOUT (5): collections/btree_map, collections/priority_queue,
imm_sorted_map, imm_sorted_set, imm_threading.

rc=-6 (3): iso, iso_api_surface, rc.
