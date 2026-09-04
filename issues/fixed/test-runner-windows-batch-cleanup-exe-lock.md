# `yo test` aborts the whole suite when Windows still holds a just-exited batch `.exe`

**Status: FIXED** — tolerant removal (`_remove_batch_artifact`, retry + warn) in
`src/main.yo`'s batch cleanup.

## Symptom

First `suite-cross-targets.yml` run (32402145272), **windows-arm64** native
suite leg (job 96539243685): every test in `arc.test.yo` passed, then

```
yo: error: permission denied
```

and the entire run aborted — two files into a ~190-file corpus. Timestamps
show the error at `18:44:28.2878`, ~40 ms after the last test child exited
(`18:44:28.2473`). The windows-x64 leg of the same run passed the full corpus,
so the failure is a timing race, not an arm64 semantic difference.

## Root cause

The test runner compiles each batch into a temp executable, runs it as a child
process per test, then deletes the artifacts:

```rust
// src/main.yo batch cleanup (before the fix)
io.await(remove_file(Path.new(tmp_yo.clone()), io), IoExn(io : io, exn : exn));
io.await(remove_file(Path.new(tmp_bin.clone()), io), IoExn(io : io, exn : exn));
io.await(remove_file(Path.new(tmp_c.clone()), io), IoExn(io : io, exn : exn));
```

On Windows, deleting an executable milliseconds after its process exits can
transiently return `ERROR_ACCESS_DENIED`: the process object may not be fully
reaped, and Windows Defender's real-time scan commonly opens a just-exited
binary. The raw `remove_file` failure threw through `IoExn` into the suite's
top-level handler, aborting the run.

The retired TS runner (`src-attic-final:src/test-runner.ts:485-499`) used bare
`fs.unlinkSync` with no Windows handling — it never ran the suite on Windows,
so there are no reference semantics to mirror.

## Fix

`_remove_batch_artifact` in `src/main.yo`: up to 8 attempts, each under a
swallowing handler (`_try_remove_once`, same fn-boundary pattern as
`_probe_liburing`), with exponential backoff (25 ms doubling, ~3.2 s total
budget). A final failure prints a warning naming the leaked path and
continues — a leaked temp artifact must never abort a test run. This is
correct semantics, not a workaround: cleanup is best-effort by nature.

Applied to all four batch artifacts (`tmp_yo`, `tmp_bin`, `tmp_c`, and the
emcc sibling `.wasm`).

## Validation

- Retry/warn semantics verified in isolation: a standalone program using the
  helper against a nonexistent path retries, warns, and exits 0 (never
  throws).
- `yo test ./tests/arc.test.yo` with the fixed binary: 15/15 passed, no
  leftover artifacts, no warnings (the happy path still removes on the first
  attempt).
- End-to-end proof: re-dispatch `suite-cross-targets.yml` after merge — the
  windows-arm64 leg is the reproducer.
