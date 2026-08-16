# yo-self never prints the C compile line ("Compiling with:"), so sanitizer/flag vacuity cannot be asserted

**Status: OPEN** (found 2026-08-15 implementing P2.5 step 21.)

## The gap

TS's compile path prints the full C compiler invocation, unconditionally:

```ts
console.log(`Compiling with: ${compiler} ${compileArgs.join(" ")}`);
```

`src/codegen/index.ts:646`. The self-hosted compiler prints **nothing** —
`grep -n "Compiling with" yo-self/*.yo` returns no hits — even though it
assembles an equivalent argv (`yo-self/main.yo`, the `cmd`/`arcmd` builders
around :1360-1500, including the sanitizer arm that appends
`-fsanitize=thread`).

Neither compiler prints it on the TEST path: the runner shells out to
`yo compile … --sanitize <choice> …` as a subprocess (`yo-self/main.yo`
~:1881), and since the subprocess prints nothing, the flag never reaches any
log.

## Why it matters (what it blocked)

P2.5 step 21 specifies gating the ThreadSanitizer job by "asserting
`-fsanitize=thread` appears in the leg's log", because **an uninstrumented run
passes exactly like a clean instrumented one** — a silent loss of the flag
turns the whole gate into a no-op that still reports green. That assertion is
unimplementable today: verified empirically that a full
`YO_TEST_SANITIZE=thread … test tests/sync --verbose` run contains **zero**
occurrences of `-fsanitize` or `tsan` anywhere in its output.

The job was therefore converted to the seed-driven form WITHOUT the assertion
(a false-red gate is worse than no gate), and the carve-out is documented in
`.github/workflows/test.yml` at the tsan step.

## Fix

1. Port the print to `yo-self/main.yo`'s compile path, at both `status()`
   sites (the `--static-library` object compile and the executable link), so
   behavior matches TS. `Command` already stores `_program` and `_args`
   (`std/process/command.yo:82-84`); there is no `join` on `ArrayList`, so
   render with the while-loop idiom used at `yo-self/doc_command.yo:76`.
2. **Re-record the CLI goldens.** This changes `yo compile` stdout, and the
   38 cli-cases were recorded from the self arm
   (`scripts/cli-diff-test.sh --record`). Expect GATE 7b to fail until they
   are re-recorded — and note the goldens will then contain absolute
   sandbox paths and the local compiler name, so check what the harness
   normalizes before recording.
3. Then re-add the step 21 assertion, and verify it RED-first by removing the
   sanitizer flag locally.

Note macOS cannot validate the TSan leg itself: local arm64 runs SIGSEGV at
TSan startup (exit code 11), which is why that job is Linux-only.
