# The "Install wasmtime" CI step passes when the download fails

**Found:** 2026-09-26, on develop run 36206559953 (the first full battery over #902 and #930).
**Status:** FIXED 2026-09-26. **Class:** gate defect (an infrastructure failure reported as a
test failure).

## Symptom

`test-wasm32_wasi` failed right after compiling its first batch
(`tests/algebraic_effects.test.yo`) with:

```
yo: error: file or directory not found
```

The step that failed was "Run WASI tests", and "Install wasmtime" was green. Its log said:

```
curl: (35) Recv failure: Connection reset by peer
```

## Cause

The step ran `curl https://wasmtime.dev/install.sh -sSf | bash -s -- --version v47.0.3`. A
pipeline's status is its last command's, so the reset connection gave `bash` an empty script,
`bash` exited 0 and the step passed with no wasmtime installed. The runner's first
`wasmtime` spawn then failed with the generic "file or directory not found", which reads like a
compiler bug.

## Fix

`.github/workflows/test.yml`: the installer is downloaded to a file with
`curl -fsSL --retry 5 --retry-all-errors`, then run, then `wasmtime --version` is called. A failed
download now fails "Install wasmtime" itself, after five retries.

## Regression test

The `test-wasm32_wasi` job: its "Install wasmtime" step now fails on a download failure instead of
passing.
