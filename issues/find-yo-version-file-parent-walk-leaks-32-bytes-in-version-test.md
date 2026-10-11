# `find_yo_version_file`'s parent-directory walk leaks 32 bytes (LSan) in `tests/internal/version.test.yo`

**Severity:** S3 — two cases of `tests/internal/version.test.yo` fail under LeakSanitizer with a 32-byte direct leak; the functional assertions pass and the leak is invisible without a sanitizer, but the internal-test battery gates on it wherever LSan is available (reproduced locally under `nix develop` clang, 2026-10-11).

## Symptom

```console
$ nix develop -c bash -c "cd <checkout> && yo test ./tests/internal/version.test.yo --parallel 1"
  ✗ find_yo_version_file: finds .yo-version in parent directory
    Memory leak detected:
    ==502754==ERROR: LeakSanitizer: detected memory leaks
    Direct leak of 32 byte(s) in 1 object(s) allocated from:
        #0 ... (.yo_selftest_batch_502586_1_0.bin+0x12d0a7)
        ...
  ✗ find_yo_version_file: picks nearest .yo-version in directory hierarchy
─────────────────────────────────────────────
19 passed
2 failed
```

The two failing cases are exactly the ones whose `.yo-version` lives in a
PARENT of the start directory — i.e. the walk-up loop iterates at least once
(`tests/internal/version.test.yo:190` and `:216`). The current-directory case
(zero iterations of the `current = parent` reassignment) passes.

## Relation to the known leak-verdict family

This is another instance of the class documented in
`issues/local-leak-verdicts-fail-28-async-tests-ci-cannot-see.md`: every CI
job sets `YO_TEST_LEAK_VERDICT=0`, so these verdicts are local-only. With
the verdicts off the same run is fully green — `YO_TEST_LEAK_VERDICT=0 yo
test ./tests/internal/version.test.yo --parallel 1` passes 21/21 (measured
2026-10-11). The family's 2026-10-02 re-measure covered `./tests` excluding
`tests/internal`; this file and
`tests/internal/diagnostics_registry_examples.test.yo` (14400 bytes in 225
objects, also pre-existing on `develop`, also leak-verdict-only) extend it
into `tests/internal`.

## Attribution (measured 2026-10-11, seed v0.2.59)

Pre-existing on `develop` — NOT introduced by the effect-rows-by-value work
(fix/effect-rows-by-value). Verified three ways, each re-running the same
command:

1. full strip stashed (HEAD = sweep + flip): 2 failed;
2. strip stashed AND `std/prelude.yo` reverted to the pre-flip commit
   (`7f3d4a0b4`, borrowed rows): 2 failed;
3. strip stashed AND `src/version.yo` + `tests/internal/version.test.yo` +
   `std/prelude.yo` all checked out from the `develop` tip (`c43c6326d`):
   2 failed.

A standalone program that copies `find_yo_version_file`'s walk-up loop
(`while` + `io.await(exists(&candidate, io), io)` + `current = parent`)
into a scratch `main` and compiles with `--sanitize address` runs clean
(rc=0, no LSan report), so the leak needs the test-runner context (the
`test(...)` body, the `IoExn` bundle, or the surrounding cleanup awaits),
not just the loop shape.

## Root cause (hypothesis, not yet pinned)

The prime suspect is the `current := start; ... current = parent` reassignment
of an owned `Path` local across an await inside the async state machine
(`src/version.yo:132`–`152`): the previous value's release is missed on the
reassignment path, exactly the dup/drop-pair family. The standalone repro's
clean run says the interaction is with something the test body adds — the
loop inlining into a larger state machine, or the bundle future's own
captures.

## Fix direction

Reproduce under the test runner with `--sanitize address` + one `test(...)`
case (the two failing cases already are the failing test), then diff the
emitted dup/drop pairs for the `current` local across the reassignment in
`src/codegen/async/state_machine.yo`. The dup/drop emit-diff gate plus an
over-cancellation canary apply to any change there (AGENTS.md).
