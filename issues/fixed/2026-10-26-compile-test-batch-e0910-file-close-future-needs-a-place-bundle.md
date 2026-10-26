# compile.test.yo's batch fails E0910 — #1617's place-bundle sweep missed `dst.close`

**Severity:** S3 — a develop CI job goes red: the `tests/internal/compile.test.yo` batch fails
to compile, so 0 of its 6 tests run ("Compiler internal tests, self-hosted differential
shard 5" on af67fdf59, battery 40261184520). Test-file migration omission, not a compiler
defect: the rule is the intended V3 semantics.

## Symptom

```
error[E0910]: The effect bundle of this `io.await` is evaluated after its future is made,
and the future borrows `self` until the await completes: … With a borrowing future the
bundle must be a place (`io`, `self.io`) (plans/VALUES_BY_DEFAULT.md §3.13 A2).
   --> tests/internal/.yo_selftest_batch_2837_1_0.yo:31:1969
help: compute the bundle before the statement (`b := ...; io.await(f(&x, io), b)`)

yo: error: test: tests/internal/compile.test.yo — 0 of 6 tests in this batch ran:
the batch failed to compile (exit != 0).
```

Column 1969 of the generated arm is the test's LAST await:

```yo
io.await(dst.close(io), IoExn(io : io, exn : exn));
```

Not a timeout: the log line says `failed to compile (exit != 0)` with no
"exceeded the configured time limit" (unlike the 10-minute family,
`issues/2026-10-26-the-test-runners-10-minute-compile-timeout-….md`).

## Root cause

#1617 (VBD V3 std half) made resource I/O futures borrow their handle: "`File.close`'s
future borrows the file until it is awaited … with the bundle `b` a variable"
(`std/fs/file.yo`'s type doc). src call sites were migrated to the place-bundle idiom
(`src/check_watch.yo`, `src/lsp/transport.yo`, `run_compile`, `_check_code_spill`,
`_copy_code_spill_into`), but `tests/internal/compile.test.yo:331` was missed — the sweep's
test migrations covered net/http/process/io tests only. `dst` is a local `File`, so
`dst.close(io)`'s future borrows it and the inline `IoExn(io : io, exn : exn)` bundle is
rejected. The batch's other awaits (`create_dir_all`, `write_string`, `File.open`) take
`io : Io` by value and stay legal with an inline bundle, which is why exactly one site
errors and only in this test file (the only `.close(io), IoExn(…)` site under `tests/`).

## Fix

The same idiom src got:

```yo
// `File.close`'s future borrows `dst`, so its bundle must be a place (E0910).
b := IoExn(io : io, exn : exn);
io.await(dst.close(io), b);
```

## Verification

`yo test tests/internal/compile.test.yo` (tree binary, one file, `--parallel 1`): the batch
compiles and the 6 tests pass (before the fix the batch compile fails with the E0910 above).
The test file itself is the regression test.
