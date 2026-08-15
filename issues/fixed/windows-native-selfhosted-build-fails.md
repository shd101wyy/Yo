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

## Iteration 3 (2026-08-11): the probe BUILT AND RAN natively — two findings

`Successfully compiled to yo-native-probe.exe` + a passing `check` — the
first native-Windows execution of the self-hosted compiler. Then its own
compile of the smoke program failed:

1. `LNK1181: cannot open input file 'm.lib'` — yo-self's link line passes
   `-lm -pthread` unconditionally (TS passes neither for native targets).
   Now gated `!is_target_windows` (kept on POSIX to avoid touching proven
   link lines).
2. **Follow-up (open)**: the step exited rc=139 — the probe appears to
   SEGV on the C-compiler-failure ERROR path natively on Windows (after
   clang's exit the driver should rc=1 via exn.throw). Only reachable when
   a child compile fails; needs a Windows box or the CI step with a
   deliberately-broken compile to chase. Same family suspicion as the
   abort-dispose/unwind class.

   **Probed on macOS 2026-08-15 — the error path itself is CLEAN there**, so
   the SEGV really is Windows-specific rather than a generally fragile path.
   Repro used (a forced LINK failure, which reaches the same
   `exn.throw` as a failed compile):

   ```
   yo compile hello.yo --std-path <repo>/std -l nosuchlibrary_zzz -o /tmp/hello
   ```

   gives rc=1 with clang's own diagnostics surfaced and
   `compile: C compiler failed (exit 1) on /tmp/hello.c`. Note `--cc /bin/false`
   does NOT work as a probe — the `--c-compiler` validator rejects unknown
   names before anything runs.

   That probe did surface a REAL diagnostic bug, now fixed: all four
   child-process failure messages printed `ExitStatus.raw` — the encoded
   waitpid status — so a child that exited 1 was reported as **"exit 256"**
   (1 << 8). `ExitStatus` carries a `code()` decoder whose own docstring says
   to prefer it over `raw`. The four messages now use `code()`; the
   `raw != 0` FAILURE CHECKS are deliberately unchanged, because a
   signal-killed child has a non-zero raw but `code() == 0`, so raw is the
   correct thing to test and the wrong thing to print. Anyone chasing the
   Windows rc=139 with the old build should know its "exit N" numbers were
   inflated by 256.
