# A hung test binary blocks `yo test` forever: there is no run timeout

**Severity:** S3 — one test that never returns stalls the whole `yo test` run indefinitely, and nothing reports which test hung

**Status:** OPEN (found 2026-10-03).

## Symptom (measured, develop-based branch, Linux x86_64)

A fast-suite run (`yo test ./tests --exclude tests/internal --exclude tests/cli-cases`) stopped
making progress for 4 h 17 min. The child process `tests/http/.yo_selftest_batch_132_0.bin` was
alive and idle, the runner was waiting on it, and the log's last line was
`✓ fetch still refuses an unsupported scheme`. Killing the child let the suite continue. Its
batch then reported `✗ fetch over https returns a real response (mandatory under CI)`, and the
rest of the suite passed. Re-running `tests/http/http.test.yo` alone passed 51/51 in about 40 s
with two different compilers, so the hang itself was transient (a network test on a loaded
shared machine).

## Cause

`yo test` has a C-compile timeout (`--compile-timeout-ms`, forwarded to each batch compile) but
nothing bounds how long a compiled batch binary may RUN (`src/main.yo`'s test subcommand). A
test that blocks (a socket that never answers, a deadlock, an infinite loop) holds its batch,
and with it the run, forever. In CI the job's own timeout eventually kills the whole job, which
loses every later batch's result and does not name the test.

## Recommendation

Add a per-batch run deadline (`--run-timeout-ms`, with a default of several minutes and `0` for
none). When the deadline passes, kill the batch, report the test that was running as failed
("timed out after N ms"), and continue with the next batch. Its stdout already names each test
as it starts, so the runner knows which test it was.
