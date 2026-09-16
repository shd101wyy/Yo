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
