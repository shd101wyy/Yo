# yo-self Stage-2 Handoff — #69/#70 Campaign

_Last updated 2026-07-19 (agent handover). This file was rewritten from
1450 lines of session logs down to the actionable map; `git log` of this
file has the full archaeology — do not re-litigate fixed bugs._

**READ THIS WHOLE FILE FIRST.** Deeper evidence (every probe, dead end, and
reverted candidate of the async/dispose/spec families) lives in
`issues/yo-self-async-emission-cluster.md` — consult it before re-deriving
anything about those families.

## TL;DR — where things stand

- **#70 (`s2 test ./yo-self/tests`): DONE — 61/61** files match the TS baseline.
- **#69 (`s2 test ./tests`): 126/180** files match (round-19 sweep, definitive,
  under the fixpoint-verified stage-2 binary). 54 remain; every remaining
  family has a documented mechanism, repro, or ranked next step (below).
- Tree is CLEAN at `2d742bcc4`. The fixpoint holds (stage2.c ≡ stage3.c).
  ~30 gated fix commits landed across the campaign; the async arc alone
  landed 8 (see `git log --oneline` for the era).

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
