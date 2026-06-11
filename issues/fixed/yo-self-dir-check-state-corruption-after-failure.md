# yo-self: dir-mode `check` corrupts shared state after any failing file

## Status

✅ RESOLVED (verified 2026-06-11 triage): the fix landed with the
demand-driven loader (commit `85480c76`) — `yo-self/main.yo` now ALWAYS
unregisters the currently-loading entry on the error path. Re-tested:
dir-mode check with two mid-import-chain failures followed by a trivial
file in the same process — the trivial file passes cleanly, no hang.

## Symptom

In a directory-wide `yo-self-bin check ./std`, once ONE file fails the
evaluator, SUBSEQUENT files misbehave: they hang indefinitely (observed:
`std/libc/float.yo` — a trivial `c_include` constants file — stalling a
40-minute `timeout` after `std/imm/map.yo` failed earlier in the same
process), crash, or exit silently.

## Reproducer

```bash
# imm/map currently fails under def-eval propagation; float.yo is trivial.
/tmp/yo-self-unswallow check std/imm/map.yo std/libc/float.yo
# → map errors, then float.yo's check dies/hangs (standalone it passes in ~2s).

/tmp/yo-self-unswallow check std/imm/vec.yo std/libc/float.yo
# → both pass in ~2s (a PASSING predecessor does not corrupt state).
```

## Root cause analysis (suspected)

The demand-driven module loader (`yo-self/main.yo`
`demand_load_module`/`_load_module_at_abs` + `module_loader.yo`
`register_loading`/`loading_env`) registers a module as currently-loading
and returns partial exports from the live env during cycles. When an
evaluator error unwinds mid-load, the currently-loading registry entries
for the failed module chain are never unregistered, and the partially
populated module cache entry persists. The next file that imports any
module in that chain receives a stale/partial env, which downstream
manifests as hangs (resolution loops over partial state) or crashes.

## Consequence for validation tooling

Dir-mode `check` results are only meaningful when every file passes.
Zero-regression gating must use per-file parallel sweeps (one process per
file) for std/, yo-self/, and tests/ — see `/tmp/fastval3.sh` (session
tooling, 2026-06-07).

## Fix sketch

Unregister the currently-loading entry (and evict the partial module-cache
entry) on the error-unwind path of the loader — TS's loader does not leak
this state because each `check` file in the TS CLI gets error handling at
the module boundary (`module-manager.ts`).
