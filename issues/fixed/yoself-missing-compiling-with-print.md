# yo-self never prints the C compile line ("Compiling with:"), so sanitizer/flag vacuity cannot be asserted

**Severity:** S3 — the C compile line is never printed and `--verbose` is not propagated — the TSan leg cannot assert its flag reached the log

**Status: FIXED 2026-10-03** (found 2026-08-15 implementing P2.5 step 21.)
**Re-verified 2026-09-14** against a tree-built binary: still no print, and NOT
under `-v` either. Measurements that change the shape of the fix are at the end.

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

---

## Re-measured 2026-09-14 — three facts that change the prescribed fix

Verified against a tree-built compiler and the current `tests/cli-cases`
corpus, because the "Fix" section above was written in August and its step 2
carries a hazard worth pricing before anyone starts.

**1. Printing to stderr is NOT an escape hatch from the golden churn.**
`scripts/cli-diff-test.sh:329` runs the case as `… "$YO_SELF_BIN" "${argv[@]}"
2>&1`, so stderr is MERGED into the compared stdout. Anything printed on either
stream moves a golden. (I looked for this specifically, expecting stderr to be
uncompared — it is not.)

**2. The blast radius is the `build`/`build run` cases, not the `compile`
cases.** Of 139 cases, 20 invoke `compile`, and all but a handful pass
`--skip-c-compiler` — they never reach the C compiler, so they would not
print. The cases that WOULD print are the many `build` / `build run` ones plus
`compile-emit-chunks` and `compile-heap-size-requires-fixed`.

**3. No case passes `-v` or `--verbose`.** Checked across all 139.

### What follows

Fact 3 makes a **verbose-gated print** a real option with *zero* golden churn,
which fact 1 rules out for any unconditional print. The requirement from P2.5
step 21 is only that `-fsanitize=thread` reach the leg's LOG — parity with a
deleted compiler's unconditional `console.log` is not itself the goal. So:

- print the assembled argv when verbose, at both `status()` sites; and
- make the test runner propagate its own `--verbose` to the child
  `yo compile` subprocess — today it does not, which is why
  `test tests/sync --verbose` produced zero `-fsanitize` occurrences and is
  the other half of why the assertion was unimplementable.

That keeps all 139 goldens byte-identical and still lets the tsan job assert
the flag, with the step-3 RED-first check (remove the flag locally, watch the
assertion fail) unchanged.

The hazard the original step 2 flagged is real and is the reason to prefer
this: an unconditional print puts the **local C compiler path and absolute
sandbox paths** into 30-odd recorded goldens, which then have to survive six
CI platforms. Re-recording that is not a formality — it is how a corpus
acquires machine-specific content that passes on the machine that recorded it.
If an unconditional print is wanted anyway, check the harness's normalisation
first and re-run the FULL scorecard after recording, per
`issues/fixed/`'s cli-diff re-record guidance — a NO-GOLDEN vacuous match is a
real bug, not recording residue.

**Not implemented here.** It is a two-part change (compiler + test runner)
whose acceptance test is a full 139-case cli-diff scorecard showing zero
movement, which wants a quiet machine and no release in flight.

## Fixed

**2026-10-03, branch `s3/batch-1-fixes`.** Root cause, both halves as
re-measured above: the self-hosted compiler assembled the cc argv
(`CcPlan.argv`) but no path printed it, `run_compile` had no
`-v/--verbose` arm to gate a print behind, and `run_test` consumed its own
`--verbose` for failed-test diagnostics without forwarding it to the batch
compile — so no log could prove a flag reached cc. Fix (`src/main.yo`):
`_print_cc_argv` prints the verbose-gated `Compiling with: <cc> <argv…>`
line from inside `_run_cc_plan` at every invocation site (the static-lib
`cc -c` and its `ar rcs`, each non-cached chunk compile, the link, and the
poisoned-cache retry link); `CcPlan` gained a `verbose` field, serialized in
the `.ccplan` file so the Unix exec-handoff child (`__cc-plan`) prints too;
`run_compile` parses `-v/--verbose` (help updated, en + zh-CN); `run_test`
pushes `--verbose` onto the child-compile argv beside `--profile`; and the
P2.5 step-21 assertion is re-added in `.github/workflows/test.yml` — the TSan
step now `grep -q -- '-fsanitize=thread'`s the logged compile line under
`set -o pipefail`, so the runner's own exit code stays the gate and an
uninstrumented run can no longer report green. Test:
`tests/cli-cases/compile-verbose-prints-cc-line` pins the line's stable
prefix from BOTH `compile -v` and the propagated `test -v` batch compile
(`stdout_keep_match`, so the golden carries no host-specific paths) — RED
before the fix (`compile: unknown option '-v'`, zero "Compiling with" hits)
and PASS after; `help-compile`'s golden was re-recorded for the three new
help lines, the only intended movement — the full 358-case scorecard run with
the fixed binary on Windows shows no failure diff containing the new output
(`grep -c "Compiling with"` over the failure log = 0) and every
compile/build/test-family failure reproduces identically under the develop
baseline binary (the two pre-existing `-v` cases,
`test-debug-heap-lists-live-and-abandoned-arenas` and
`build-test-suite-flags`, keep byte-identical stdout goldens; their diffs are
a Windows-only `asan_probe.c` tree leftover, identical under develop).
RED-first per the original step 3, verified locally: with the flag absent
(`--disable-sanitize`) the same grep fails (rc=1); under
`YO_TEST_SANITIZE=thread` the printed batch-compile line carries
`-fsanitize=thread` (this Windows host cannot link TSan — the leg stays
Linux-only — but the assertion's subject, the logged line, is proven).
