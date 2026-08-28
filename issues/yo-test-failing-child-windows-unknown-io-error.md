# `yo test` on Windows: any FAILING test kills the run with `unknown I/O error` instead of a ✗ report

**Open (2026-08-28).** Discovered while verifying the UTF-8 BOM lexer fix
(`issues/fixed/lexer-rejects-leading-utf8-bom.md`) on a Windows 11 host.

## Symptom

On Windows, `yo test` reports PASSING tests normally, but the first FAILING
test aborts the whole run with a bare I/O error — no `✗` line, no assert
message, no failure diagnostics:

```
$ yo test ./tmp/redcheck/red.test.yo --parallel 1

./tmp/redcheck/red.test.yo
AddressSanitizer is not functional with this compiler setup (likely a version
mismatch between clang and the ASAN runtime library). Skipping sanitizer. [...]
Using system allocator
yo: error: unknown I/O error
```

rc=1. Deterministic. Observed with the v0.2.19 release binary AND with a
freshly built `yo-out/x86_64-pc-windows-msvc/bin/yo.exe`, so it is not a
regression — v0.2.19 has always behaved this way on Windows.

## Minimal reproducer

```bash
mkdir -p tmp/redcheck
printf '{ assert } :: import("std/assert");\ntest("always fails", {\n  assert(false, "boom");\n});\n' \
  > tmp/redcheck/red.test.yo
yo test ./tmp/redcheck/red.test.yo --parallel 1
```

The batch binary itself is healthy — run it directly and the failure reports
correctly:

```
$ YO_KEEP_BATCH=1 yo test ./tmp/redcheck/red.test.yo --parallel 1   # errors as above, leaves artifacts
$ YO_TEST_INDEX=0 ./tmp/redcheck/.yo_selftest_batch_0_0.bin
boom
$ echo $?
127
```

So the child prints its assert message and exits nonzero; it is the RUNNER's
handling of that nonzero-exit child that fails.

## Analysis so far

- The error string is `std/sys/errors.yo:173` — `.Other(errno) => "unknown
  I/O error"` — i.e. an `IoExn` with a Windows error code that the errno
  mapping does not know, raised from an `io.await(...)` in the runner.
- The failure fires after the batch child COMPILE succeeds (clang link
  completed, batch `.bin` exists) and at/around the spawn-and-capture of the
  first TEST child. The runner runs each test with output capture
  (`.output()`, "stdio: pipe" parity with the TS runner) around
  `src/main.yo`'s test loop (~`:2850+`, `tcmd` / `YO_TEST_INDEX`).
- Passing children never trigger it; only a nonzero-exit child does. Prime
  suspects: the pipe/output-capture teardown path for a child that exited
  nonzero on Windows, or a Windows error code from process reaping mapped to
  `Errno.Other` instead of a status.
- Not ASan-related (the host's ASan probe already skips sanitizers), not
  batch-content-related (any `assert(false)` reproduces).

## Impact and workaround

Windows developers get zero failure diagnostics from `yo test` — every red
test looks like an infrastructure error. Workaround (documented in
`.github/instructions/testing.instructions.md`): `YO_KEEP_BATCH=1`, then run
the batch binary directly with `YO_TEST_INDEX=<k>` and read its output/exit
code (127 = assert fired).
