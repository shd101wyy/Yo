# The warm-compile selfcheck: lifting `run_compile`'s self-containment invariant (Phase 4 §7 step 1)

OPEN (2026-09-15) — the Phase-4 work list, with its gate harness landed.

`yo compile <file> --warm-selfcheck` (hidden debug flag, `src/main.yo`
`run_warm_selfcheck_compile`) compiles the input TWICE in one process: pass 1
cold, pass 2 with `--warm-reuse` — skipping `clear_module_cache()` /
`mm_clear_prelude_env()` / the fresh `ExprInfoTable`, i.e. holding exactly
the state a resident `build`/`test` evaluator would hold. The gate requires
the two emitted C files byte-identical and ZERO "Failed to transpile"
markers in the warm emission; exit 0 only when both hold.
`scripts/bootstrap/warm_compile_gate.sh` runs a fixture battery with an
explicit PASS/FAIL expectation per fixture (a ratchet: when a known-red
fixture goes green it moves columns and the script starts enforcing it).

## Measured baseline (CORRECTED 2026-09-15, seed v0.2.33 box, true warm state)

The first published numbers were measured through three harness bugs, fixed
in the same pass:

1. **`mm_reset()` at the end of pass 1** dropped the module cache, the
   prelude env AND the shared table — pass 2 was never warm. Now gated on
   `!warm_reuse`.
2. **Stale output files**: a pass that died before emitting left the
   PREVIOUS run's `.c` in place, and the comparison silently read it. The
   orchestrator now removes both outputs first (existence-guarded — an
   unwind-swallow handler for the removal silently ABORTED the whole
   orchestrator, `unwind` discards its continuation: rc=0 with no output at
   all) and fails loudly when a pass emits nothing.
3. **Occurrence-counter churn**: `g_stable_occurrence` is process-global and
   never reset, so any second in-process compile minted different ordinals —
   ids must be a function of (source, position, mint-order-WITHIN-this-
   compile). `stable_occurrence_reset()` now runs at the start of EVERY
   compile.

True-warm baseline (corrected again 2026-09-15, after fixing bug 4 below):

| fixture | verdict |
| --- | --- |
| no std imports (`main` only) | **PASSES** — byte-identical, 0 FTT |
| `std/collections/array_list` | FAILS — C diverges (63889 vs 63403 bytes): warm-minted type ids continue pass 1's ordinals, so the same types emit different `__yo_t_*` names |
| `std/string` + `std/fmt` + `array_list` | FAILS — the warm pass re-imports `std/string` and dies at `string.yo:438` (`self.substring(r.start, r.end)`): `Cannot unify incompatible struct types: "<struct:struct_r28c4_n50>" and "ArrayList(u8)"` — an UNSPECIALIZED ArrayList shell minted in the warm pass will not unify with the cached prelude's specialized `ArrayList(u8)`

**Bug 4 (found by the gate, fixed here): the occurrence reset was unsound
under warm reuse.** Resetting `g_stable_occurrence` at the start of a warm
pass replays ordinals from 0 while the cached modules SKIP their mints — the
sequence shifts, and fresh ids collide with the surviving id-keyed tables'
pass-1 entries. Measured: ArrayList's `Self(...)` constructor call answered
with another type's registry record ("Too many members provided. Expected 1
arguments, got 3"). The reset now runs on COLD passes only (a fresh-process
no-op; hygiene for multi-compile processes). The remaining two failures are
the genuine §7 step-1 work: the type intern / shell-resolution tables
(`types/intern.yo`, the recursive-shell buckets keyed by minted ids) must be
purged or generation-keyed per compile so warm-pass mints unify with — or
freshly replace — the cached identities, and byte-identical warm emission
follows from that same purge.

## UPDATE 2026-09-16 (bug 5 — the big one): pass 1's own `mm_reset` wiped the universe

The strings fixture's re-import crash had nothing to do with intern
identity: **pass 1 of the selfcheck ran its trailing `mm_reset()`** (the
gate only protected warm passes), so pass 2 started from an EMPTY module
cache and re-evaluated std/string against a half-warm evaluator. Fixed with
`--warm-first` (pass 1: cold start, NO end-reset; pass 2: --warm-reuse as
before). Measured after the fix: the strings fixture no longer throws —
both remaining reds are pure EMISSION divergence with ZERO FTT markers
(strings 107425 vs 102376 bytes; alist 63892 vs 61912). The remaining churn
is process-global EMIT-side once-only bookkeeping, catalogue:

1. a Dispose/dup method trio emitted in pass 1 is SKIPPED in pass 2 (an
   "already emitted" set shared across passes);
2. a runtime `header.type_id` ordinal continues across passes (1 vs 0);
3. temp-name occurrence suffixes continue (`...521` vs `...520`).

All three are per-EMISSION state that must reset (or generation-key) per
compile — the next PR.

NEGATIVE FINDING (2026-09-16): `should_skip_function_codegen` is NOT the
mechanism — traced with a gated verdict print: the trio's member returns
"emit" in BOTH passes. The trio never REACHES pass 2's collection list:
derive/trait-method registrations made while a module evaluated are
collected for emission only from that module's own evaluation walk; a
CACHE-HIT module's registrations are invisible to the collector. The fix
must collect derive/trait-method emissions from the type registry for all
types in the compiled set (registry-driven, not walk-driven).

FIRST MECHANISMS FOUND (2026-09-16, for the purge PR):
1. The missing Dispose trio (`yo_id_1564…`/`44648…`/`107466…` for
   ArrayList(i32)): the COLLECT phase walks evaluator registries
   (`g_specialized_originals`, spec caches — function_value.yo) that hold
   PASS-1 entries; pass 2's walk sees "already specialized/served" state
   and skips bodies whose emission only exists in PASS 1's C file. The
   emit-side once-decisions must be keyed per compile (or the collect
   inputs snapshotted per compile), not inferred from process-global
   evaluator state.
2. `header.type_id = 1` vs `0`: the ordinal comes from
   `context.dispose_type_ids` (codegen_c.yo `emit_dispose_dispatch`) —
   its population ORDER changed because the collect walk's inputs changed
   (same root as 1).
3. Temp-name occurrence suffixes: emission names draw from
   `g_stable_occurrence`, shared with evaluator-identity mints — the split
   into emission-local (reset per compile) vs identity (held) counters is
   part of the same purge. The evaluator-identity state (module cache, prelude
env, def registries) must KEEP being held — that holding is what made the
strings re-import crash disappear.

## RESOLVED 2026-09-17 — warm re-specialization bound Self to the WRONG type (ambient ctx.self_type inheritance)

With the in-process path ON (YO_BUILD_IN_PROCESS=1), a build --watch round's
artifact compile failed at `std/collections/array_list.yo:83` — `Self(...)`,
ArrayList's own constructor — with:

```
Cannot construct String outside its declaring module: field "_bytes" is private
```

The construct site is ArrayList's constructor, but the constructed type was
**String** (String's `_bytes` field): the member-visibility check
(`_reject_private_construction`) was correctly rejecting a genuinely wrong
Self — the bug was upstream, in how a STATIC generic member's specialization
finds its Self at all.

**Mechanism (proven with gated `[specself]`/`[selfatom]` traces under
YO_DEBUG_WARM, cold vs in-process runs of the same probe).** A static member
(`new : (fn() -> Self)`, no `self` parameter) gets its body's `Self` from
whichever `ctx.self_type` happens to be LIVE when something forces its
specialization — branch (c) of `create_specialized_function_inline`'s
self-binding. `ctx.self_type` is process-global ambient state: when the
forcing nests inside ANOTHER type's evaluation (string.yo's module eval holds
`Self = String` while an `ArrayList(String)` member specializes from within
it), the ArrayList constructor's `Self(` resolves to String. Cold compiles
survive the same code by evaluation-order luck — the identical forcing
inherited `ArrayList(String)` there because an ArrayList(String) receiver
evaluation was live instead. Instrumented proof: the failing spec printed
`src=c-inherited self=String prev=String`, the cold twin
`src=c-inherited self=ArrayList(String) prev=ArrayList(String)`; branch (b)
(env-`self`) never fired, and the body's `Self` atom at array_list.yo:82:4
resolved `ctx-direct` to the inherited type in both runs.

**Fix (the port of TS `substitutions.insert("Self", concreteType)`,
impl.ts:2474).** `_inject_forall_captures` (evaluator/values/impl.yo) now
appends a `Self` capture carrying the CONCRETE receiver the match resolved,
and the spec path gained branch (b1): when the FuncVal carries that capture,
the ambient `ctx.self_type` is CLEARED so the body's `Self` resolves through
the callee env (the capture) — self-contained, order-independent. Clearing is
conditional on the capture's presence: an unconditional clear was tried first
and broke every plain generic's body with E0401 `Variable "Self" not found`
(the def-time env of a plain generic has no `Self` variable) — cold builds
included, which also proved the inheritance was load-bearing for fns WITHOUT
captures. Bisect: with (b1) disabled the original error returns; with it on,
the round advances past std/string entirely.

**The next blocker this exposed** (previously unreachable — every earlier
round died at the ArrayList error first): the SAME watch round then failed at
`std/string/string_builder.yo:182` — `Array(u8, usize(20)).fill(u8(0))` →
"No matching call found". RESOLVED the same day, and its root cause was not
fill at all: the #728 in-process slot never passed `--compile-watch-mode`, so
every in-process artifact compile ran as a plain COLD compile and its hygiene
block (`clear_module_cache` + `mm_clear_prelude_env` +
`stable_occurrence_reset`) wiped the universe the build-file evaluation had
just populated — every std module re-evaluated a second time (26 loads for 16
modules), and the re-evaluation degraded the fill callee to valueless.
Full mechanism + the three fixes (flag passing, reset gating + shared
ExprInfoTable under watch_mode, failed-step exit gating so the watch loop
survives) in issues/fixed/warm-in-process-array-fill-call-stops-matching.md.
With those, the in-process path reached the ORIGINAL warm blocker — item 1
below ("Cannot unify incompatible struct types … struct_r28c4_n50 and
ArrayList(u8)") — which ALSO fell the same day, and NOT to intern-table
surgery: `run_build` itself called `mm_reset()` BETWEEN the build-file
evaluation and the artifact compiles (build_runner.yo, the once-per-build
hygiene for child-process rounds), so every in-process compile started from
an EMPTY module cache and re-evaluated the whole std closure — fresh struct
shells minted against the surviving evaluator registries' instances, which
is what the unify rejected. Gating that reset on `!(options.
watch_in_process)` (same PR family) fixes it: the exe compile's import walk
is all cache HITS (`[warmload] MISS` probes, YO_DEBUG_WARM — 28 misses → 19,
all of them first-loads), the evaluation completes, and the round reaches
the C compiler.

**CURRENT blocker (measured 2026-09-17, post all of the above):** the exe
compile's C fails with FTT stubs — specializations MINTED BY THE BUILD-FILE
EVALUATION (an evaluation-only phase: `len` for ArrayList(u8),
Option-payload methods, … — fids visible in the earlier [specself] traces)
that the warm compile's collect phase finds in the shared registries and
tries to emit, but whose emission planning never ran in ANY codegen pass.
No `[swallow]` fires during the compile itself (YO_DEBUG_SWALLOW=1) — the
def-eval did not fail in THIS compile; the stub is the collect/emission
side missing per-compile planning for registry entries minted by a
non-codegen evaluation. This is failure-modes item 3 escalated to the front
of the queue. Repro: `/home/yiyiwang/Workspace/yo-watch-probe` with
YO_BUILD_IN_PROCESS=1, `yo build --watch --poll-ms 300`.

## RESOLVED 2026-09-17 (later the same day) — §7 STEP 2 CLOSED: the FTTs were the build eval's missing shared table; `build --watch` is warm by default

The `[fttmark]` probe (hooked at the marker emitters, codegen/exprs/
generation.yo — the stub rewrite had been TRUNCATING the evidence) named
the failing expressions: `return(self._length)`, `Self(_ptr : .None, …)`,
string.yo:207's match — the SPECIALIZED CLONES minted during the build-file
evaluation. Their `ExprInfo` was written to SCRATCH tables: the build-file
evaluation ran with NO shared ExprInfoTable set, so the demand loader gave
every module its own per-ctx table, and the artifact compile — which
REUSES the cached ModuleVals instead of re-evaluating — found no infos for
those clones. (One real marker in the SHARED static-inline emitter buffer
then cascaded: every subsequent inline function's marker scan found it and
was truncated into a stub — why six functions fell to one missing info.)

Fix: `_build_round_watch` sets mm's shared ExprInfoTable before evaluating
the build file (create-if-absent), so the build eval's specializations land
in the very table the in-process artifact compiles emit from.

Measured end-to-end on the probe (NO env var): round 1 builds the exe and
lib in-process and the exe RUNS; an edit to src/main.yo triggers round 2,
which recompiles with ZERO new module loads (19 misses total, all round-1
first-loads) and the rebuilt binary prints the new message. The env-var
gate is REMOVED — `yo build --watch` compiles in-process by default
(non-watch builds keep the child-process spawn). §7 steps 1+2 of
plans/INCREMENTAL_COMPILATION_ZIG_LESSONS.md are closed; what remains of
§7 is step 3 (test batching) and step 4 (the --max-rss-mb valve).

## RESOLVED 2026-09-16 — the warm pass emits byte-identical C for the whole gate battery

The three fixes below closed the battery: trivial, alist AND strings all
pass `--warm-selfcheck` (byte-identical, 0 FTT) on seed v0.2.35. The
fixtures moved to the gate's must_pass column and are enforced green.

1. **Dispose-trio re-insertion** (`_synthesize_and_register_dispose` +
   the enum twin, codegen/functions/collection.yo): the dedup path
   ("___dispose already registered for this type_key") skipped BOTH the
   registration AND the per-compile emission insert. The registered
   FuncVal is now re-inserted into the fresh compile's emit list via
   `base.register_function` + `find_function_calls_in_expr`.
2. **Emission/identity counter split** (utils.yo): temp variables and
   labels now draw from `g_emission_occurrence`, reset at the start of
   EVERY compile (they are per-artifact names); identity ids keep the
   persistent `g_stable_occurrence` (cold-only reset — #702).
3. **Codegen counter resets** (`ref_spill_counter_reset`,
   `fresh_local_counts_reset`, `closure_capture_counter_reset`): the
   remaining once-only emission counters reset per compile.

What REMAINS warm-specific (the honest residue): a warm pass holds pass 1's
evaluator universe, so identity-side state (module cache, prelude env,
def/spec registries, ExprInfoTable) is shared — any new once-only EMIT
decision added by future codegen must reset per compile or the gate will
catch it (that is what the ratchet is for).

## The failure modes to fix (in order)

1. **Warm evaluator throw (blocking)**: with the caches held, pass 2 dies
   re-importing `std/string` — `Cannot unify incompatible struct types:
   "<struct:struct_r28c4_n50>" and "ArrayList(u8)"`. The fresh evaluation
   mints struct identities that no longer unify with the cached prelude's.
   Prime suspect: the type-intern / SomeT identity tables outliving the
   compile they were minted in (`types/intern.yo`), i.e. the same
   type-identity staleness Phase 3 §6 step 5 predicted.
2. **Warm emission divergence**: for `array_list`, pass 2 emits different
   TYPE IDS for the same types (`__yo_t_11603…` vs `__yo_t_17992…`),
   drops a stale FORWARD SHELL that pass 1 carried
   (`<struct:struct_decl_collections__array_list_r28c4>` with `void** _ptr`
   — an unspecialized ArrayList shell that the COLD pass emits and the warm
   pass correctly resolves to `ArrayList(i32)` with `int32_t* _ptr`), and
   omits an Option enum union pass 1 declared. Note the cold emission is
   the one carrying the artifact here — warm state changes SHELL
   RESOLUTION ordering. Fixing this needs per-definition ExprInfo/function
   registry ownership (§7 step 1's owner-tagged purges) so both passes emit
   from the same resolved identities.
3. **FTT markers**: `ftt_pass2=1` on the array_list fixture under true warm
   state — exactly the historical class (codegen finding no/broken info for
   a node), now reproducible on demand by the gate. The failure-modes order
   stands: identity first (it blocks half the battery), then the
   owner-tagged purge work this FTT belongs to.

## Why this shape

The plan's §7 gate is "two consecutive in-process run_compiles produce
cmp-identical C with zero FTT — the 47-stub experiment re-run, and it must
be zero, not fewer". The harness makes that a one-command, fixture-table
oracle instead of a bespoke experiment, and the ratchet lets each fixed
failure mode become an enforced expectation in the same PR that fixes it.
