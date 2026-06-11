# Test runner has no timeout on Yo / C compilation phases

> **Status update (2026-06-11 triage):** partially fixed — the C-compile
> `spawnSync` now has a 600 s timeout and parallel/isolated mode has the
> 1800 s per-file watchdog (`PER_FILE_TIMEOUT_MS`). REMAINING GAP: in
> sequential mode (`--parallel 1`) the in-process Yo→C
> `moduleManager.compileModule` call is still unbounded, so a hung
> evaluator/codegen still hangs the runner indefinitely.

## Symptom

When running `./yo-cli test <file>` (or via `./yo-cli test <dir>` with `--parallel 1`),
the test runner has no upper bound on how long Yo→C compilation or C→binary
compilation may take. If either phase hangs (infinite loop, pathological input,
linker bug, etc.), the test process spins silently with no output and the user
must `kill` it manually.

Concrete reproducer:

```bash
./yo-cli test ./yo-self/tests/eval.test.yo --target wasm-wasi --parallel 1
```

`eval.test.yo` is 1.9 MB / 36 134 lines and contains thousands of cases. Even at
the latest commit on `cad4e526` (the last commit that actually edited the file),
its Yo→C compilation does not finish in 10 minutes (verified via
`timeout 600 bun run src/yo-cli.ts compile yo-self/tests/eval.test.yo
--emit-c --skip-c-compiler --target wasm-wasi`, which exits with code 124).

The test runner just prints the file path:

```
yo-self/tests/eval.test.yo
```

and then hangs indefinitely with no further diagnostics.

## Why this matters

- CI cannot tell a "still running" job from a deadlocked one.
- Developers running tests locally lose >>10 min before noticing the hang.
- Any future evaluator regression that introduces a slow path is invisible
  until someone watches the wall clock.

## Where the gap is

`src/test-runner.ts`:

- Line 436: `moduleManager.compileModule(...)` runs synchronously in-process
  with no time budget. Cannot be interrupted because it is a JS function call,
  not a subprocess.
- Line 558: `spawnSync(cCompiler, compileArgs, ...)` has **no `timeout`**
  option. C compile (especially `emcc` with large WASM input) can take
  many minutes; this is also unbounded.
- Lines 853–857: parallel-mode `spawn(bunExecutable, args, ...)` has no
  per-file timeout either.

By contrast, the _test execution_ spawnSync calls (lines 635, 642, 672, 694)
do set `timeout: 60000`.

## Suggested fix

Two-part:

1. **Easy win** — add `timeout` to all `spawnSync`/`spawn` calls in
   `test-runner.ts` that today have none:
   - `compileResult = spawnSync(cCompiler, compileArgs, ...)` — default e.g.
     5 min, configurable via a new `--c-compile-timeout` flag.
   - Parallel `spawn(bunExecutable, ...)` — default e.g. 15 min per file,
     configurable via `--per-file-timeout`.
2. **Harder win** — wrap the in-process Yo compilation in a subprocess so it
   too can be killed on timeout. Requires moving `compileModule` into a
   helper script that the test runner spawns and monitors. Alternatively,
   add a heartbeat / progress indicator (e.g. print module being compiled
   every N seconds) so a stalled compile is at least visible.

A separate issue should track _why_ `eval.test.yo` is so slow to compile;
that file should either be split or the evaluator path it exercises should
be profiled.

## Related

- `eval.test.yo` slow-compilation issue (to be filed separately if confirmed
  to be a regression). Triage so far: not a regression from this branch's
  changes — also hangs at `cad4e526`.
- `.github/instructions/testing.instructions.md` documents `eval.test.yo`
  takes "~10 minutes WASM"; the actual time is ≥10 min and bounded only by
  human patience.
