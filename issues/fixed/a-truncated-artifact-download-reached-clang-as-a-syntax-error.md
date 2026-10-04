# A truncated artifact download reached clang as a syntax error

**Severity:** S3 — CI plumbing: a release leg failed with a C syntax error in a file the compiler had emitted correctly, so the failure looked like a codegen bug and blocked the release until it was traced.

**Status: FIXED** on `ci/artifact-integrity`. Found 2026-10-04 in the v0.2.51 release run 37183400572.

## Symptom

`Seed bundle (macos-x64, cross-emitted)` failed in "Compile the cross-emitted C natively (macOS)" 13 seconds in:

```text
cross/yo-macos-x64.c:1298046:44: error: expected ';' at end of declaration
 1298046 |   uint8_t* _file____home_temp_1491579497644
cross/yo-macos-x64.c:1298046:44: error: expected '}'
```

The other three seed legs built from the same emit run were green.

## Cause

The emitted C was correct. The artifact `seed-cross-macos-x64` (156,968,729 bytes, digest-listed by the server) was downloaded again afterwards: line 1298046 is complete there (`uint8_t* _file____home_temp_14915794976443162472 = __yo_v_self->__yo_v_ctrl;`), and the file ends with the runtime's last function. The file clang compiled was the same content cut off at column 44 of that line.

The job's `actions/download-artifact@v4` step logged "Starting download of artifact to: …/cross" and no completion line. It still reported success, and the next step compiled the partial file. download-artifact v4 only warns on a digest mismatch; since v8 a mismatch is an error by default.

`test.yml` has the same handoff, `suite-cross-emit` → the native `test (macos-*)`/`test (windows-*)` legs, so the same flake could fail a battery with a misleading C error.

## Fix

- Every `actions/download-artifact` in `test.yml` and `release.yml` is v8, which fails on a digest mismatch. No step downloads by artifact ID, so v5's path change does not apply.
- The cross-emitted C carries its own checksum end to end. The emitting job writes `yo-<target>.c.sha256` into the artifact, and the consuming job checks it (`sha256sum -c`, or `shasum -a 256 -c` on macOS) before compiling. A truncated or corrupted file then fails at "Verify the cross-emitted C arrived intact" and names the checksum, not a line of C.

Test: CI plumbing; the next battery and release run every new step. The v0.2.51 run itself recovered with `gh run rerun --failed`.
