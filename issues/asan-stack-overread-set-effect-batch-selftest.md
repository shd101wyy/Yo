# ASan stack-buffer-overflow in set_effect's bundle copy — develop CI red since #363 (blocks the v0.2.21 release gate)

**Status: OPEN — develop HEAD CI fails on every native leg; NOT reproducible on this
macOS host (its clang has a broken ASan runtime, so the local runner silently skips
the sanitizer).**

Found 2026-08-30 continuing the std audit handover. `test (ubuntu-latest)`,
`test (ubuntu-24.04-arm)`, `test (macos-latest)`, `test (macos-26-intel)`,
"Self-hosted `test` subcommand", and the "Full-corpus hollow sweep" all fail the
SAME single test of `tests/async_await.test.yo`:

```
✗ a top-level await returns as soon as its future completes, despite unrelated pending I/O
  Test failed with exit code 256
  ==4428==ERROR: AddressSanitizer: stack-buffer-overflow ... READ of size 40
      #0 __asan_memcpy
      #1 _file____home_temp_14412_set_effect
      #2 _file____home_temp_14417_resume
      #3 __yo_user_main
  Address ... is located in stack of thread T1 at offset 64 in frame #2:
    This frame has 1 object(s):
      [32, 64) '__yo_eff_bundle_yo_id_15516' <== Memory access at offset 64 overflows this variable
```

## What is known

- The failing test body itself passes UNSANITIZED and on wasm/windows legs; only
  the ASan-instrumented native legs die. PR #365's red legs are this same failure
  (the branch is not at fault).
- The read starts at offset 64 — exactly one-past the 32-byte `__yo_eff_bundle_*`
  temp — so the `value` POINTER handed to `set_effect` is one object off (or the
  copy is from a slot the temp no longer occupies), not merely a wider copy of the
  temp itself.
- The injection is C56/#354-era codegen: `emit_effect_injection_for_sm` in
  `src/codegen/async/state_machine.yo` materializes the bundle named at the await
  into a stack temp and passes `&temp`. #362 (C60) rewrote how the bundle
  expression is chosen; the regression window is #361–#363 (v0.2.20 cut was green).
- Static cross-check of EVERY `__yo_set_effect_fn(..., &__yo_eff_bundle_*)` site in
  the locally-emitted batch C (`.yo_selftest_batch_1_1.bin.c`, 119 sites + 53
  inside resume fns, temp type vs the receiver set_effect's copy type) found ZERO
  type mismatches on macOS — the local artifact is clean, so the defect is
  platform- or composition-dependent (CI's batch 14_1 has a site mine lacks, or
  Linux stack layout exposes it).
- This host cannot runtime-reproduce: the local test runner prints
  "AddressSanitizer is not functional with this compiler setup" and silently skips
  the sanitizer (worth its own follow-up: a silent ASan skip should be loud, or a
  `--sanitize-required` mode for exactly this debugging).

## Suggested attack

The proven Windows debug-loop pattern (temp workflow on a branch, build + run one
thing on the target runner, upload logs): a workflow that builds the compiler on
ubuntu-latest, generates the async_await batch (`YO_KEEP_BATCH=1 yo test
./tests/async_await.test.yo`), compiles the batch WITH `-fsanitize=address`, runs
the failing index, and uploads BOTH the ASan report and the batch `.c` — then read
the emitted C at `_14412`/`_14417`/`__yo_eff_bundle_15516` and walk back to the
`emit_effect_injection_for_sm` path that emitted it. Alternatively reproduce on
any Linux box with working ASan before touching codegen.

## Impact

Blocks the release pipeline: v0.2.21's gate requires a completed green Test run
on develop HEAD. Everything else queued behind it (§2a version-install fixes, the
fs-watch PR #365 merge) lands on red develop otherwise.
