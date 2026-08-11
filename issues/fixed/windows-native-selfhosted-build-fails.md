## FIXED (2026-08-11, branch fix/windows-native-selfhosted)

All three classes, at their sources:

1. `F_OK` — `yo-self/evaluator/exprs/import.yo` `_file_exists_sync` now uses
   portable libc `stat` (MSVC-clean; mirrors TS `existsSync` and
   `module_manager.yo`'s `_path_exists_sync`) instead of POSIX `access`.
2. `setenv` — the self-hosted test runner (`yo-self/main.yo`) now sets
   `YO_TEST_INDEX` through `std/env`'s portable `env.set` (which branches to
   `_putenv_s` on Windows) instead of raw libc `setenv`.
3. main-wrapper returns — TS's Windows/WASM `generateMainWrapper` branch now
   emits module-level initialization into the same dedicated `void`
   `__yo_main_module_init` helper the POSIX path uses (the effectful
   initializers' bare `return;` escape checks were landing inside
   `int main`). yo-self's port already had the helper (it was AHEAD — the
   grep-yo-self-first rule) but was missing the post-init
   `__yo_effect_escaped` checks on both paths; mirrored.

Verified: full Windows cross-emit of `yo-self/main.yo` greps 0 for all
three classes (remaining 3 "Unknown type:" markers are the benign
comptime-only comment class present in working binaries); macOS suite
162/162, corpus 27/27, FIXPOINT_HOLDS at s59. Final proof is the windows
CI native-build step (lands via PR #95) going green — then flip it gating
and promote the release windows-x64 leg.

## Iteration 2 (2026-08-11): link failure past the original three

With the three classes fixed, the windows CI step reached LINKING and hit
`LNK2019: unresolved __imp_OpenProcessToken / __imp_LookupPrivilegeValueA in
_mi_thread_local_free` — mimalloc's Windows large-page support needs
`advapi32`. Added next to the existing ws2_32/bcrypt system libs in BOTH
compilers (src/codegen/index.ts, yo-self/main.yo).
