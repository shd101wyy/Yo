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

## Measured baseline (2026-09-15, WSL2 box, develop + the harness)

| fixture | verdict |
| --- | --- |
| no std imports (`main` only) | **PASSES** — byte-identical, 0 FTT, and pass 2 = **0 ms** vs 1656 ms cold: the resident-evaluator payoff, already real for std-free inputs |
| `std/collections/array_list` | FAILS — no FTT, but the C diverges (63872 vs 63386 bytes) |
| `std/string` + `std/fmt` + `array_list` | FAILS — the warm pass THROWS in the evaluator while re-importing `std/string` |

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
3. **FTT markers**: none observed on these fixtures yet (the historical 47
   came from cached-module ASTs whose table was discarded; the harness
   KEEPS the table, so this class is already dodged — the registries and
   identities are the remaining surface).

## Why this shape

The plan's §7 gate is "two consecutive in-process run_compiles produce
cmp-identical C with zero FTT — the 47-stub experiment re-run, and it must
be zero, not fewer". The harness makes that a one-command, fixture-table
oracle instead of a bespoke experiment, and the ratchet lets each fixed
failure mode become an enforced expectation in the same PR that fixes it.
