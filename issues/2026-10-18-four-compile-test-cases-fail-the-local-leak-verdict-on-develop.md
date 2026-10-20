# Four `tests/internal/compile.test.yo` cases fail the local leak verdict on develop

**Severity:** S3 — a local `yo test tests/internal/compile.test.yo` reports 4 failed tests from LeakSanitizer leak reports of compiler allocations in the test batch; CI runs with `YO_TEST_LEAK_VERDICT=0` and cannot see them.

Filed 2026-10-18 while gating #1429 (decision 39 Generation A), whose
`compile.test.yo` run failed the same way.

## Symptom

On develop at 5425cd7bf, built as `yo-dev-5425cd7bf` and run in a clean
worktree of that commit:

```bash
yo-dev-5425cd7bf test tests/internal/compile.test.yo --parallel 1 --std-path ./std -v
```

```
  ✗ the --sanitize address probe consults the chosen --c-compiler, not the system cc
  ✗ the ASan DLL directory goes on PATH once, however many batches apply it
  ✗ a value enum's drop and dup are one function each, not a switch per site
  ✗ a specialization reached through a call gets the hashed C name, not its raw signature
4 failed
```

Each failure is `Memory leak detected:` with LeakSanitizer's report for
the batch binary. The run has 25 `Direct leak` blocks in all: eight of
40 bytes (each with two 20-byte indirect leaks), plus blocks of 448 B to
about 12 KB.

#1429's tree-built compiler (develop 4d7c15caa plus the branch) shows the
same four tests with the same 25 blocks. The eight 40-byte blocks and the
small sizes match exactly; the multi-KB sizes differ by a few hundred
bytes. So the leaks are develop's, not the branch's.

## Analysis (traced 2026-10-18; symbolized rerun)

A rerun with `ASAN_SYMBOLIZER_PATH` (nix llvm-symbolizer) and
`YO_KEEP_BATCH=1` names the classes. The four tests are the ones that drive
the compiler in process:
- the ASan probe;
- the PATH helper;
- two emit checks that compile a program and read the C.

Per-test verdict windows (the checker's totals grow per window):

```text
the ASan probe …              SUMMARY: 22669 byte(s) leaked in 340 allocation(s)
the PATH helper …             SUMMARY: 120 byte(s) leaked in 4 allocation(s)
a value enum's drop and dup … SUMMARY: 59057 byte(s) leaked in 875 allocation(s)
a specialization reached …    SUMMARY: 59569 byte(s) leaked in 883 allocation(s)
```

The PATH helper (no compile) leaks only two 40-byte `String` cells with
their buffers — module-init literals of the test module itself. Everything
else is ONE class: **64-byte `Token` Rc cells** (151 + 130 + 43 in the probe
window; hundreds more in the emit-check windows), allocated through the
lexer chain — `next_token`-with-position ← the tokenize loop ← `tokenize`
← the parse entry — reached from `run_compile` inside the test. They are
UNREACHABLE but alive (their reference counts never reach zero), so this is
NOT a process-lifetime cache: **the leak grows by roughly 59 KB per
in-process compile** — the two emit-check windows each carry their own
compile's Tokens on top of the probe's. A resident compiler (watch mode,
LSP) recompiling in one process accumulates without bound.

This is the same reference-hygiene debt the self-hosted umbrella tracks
(`issues/self-hosted-emit-leaks-remaining-classes.md`, S1, OPEN — "the map
for the next RC campaign"): compiler values whose `+1` references are taken
during evaluation and never released. Fixing it is that campaign's work —
a per-allele hunt through the evaluator's Token flows — not a one-site
patch; a targeted fix of the same shape as the warnings-stash one
(`issues/fixed/2026-10-16-the-warnings-stash-test-leaks-under-leak-verdicts.md`)
was checked for and is not what these stacks show: there is no single
early-return-shaped site, the Tokens fan out through the parse/eval of the
compiled program.

**Verdict (2026-10-18): real leaks, growing per compile, reclassified as a
measured sub-case of the self-hosted reference-hygiene debt rather than a
standalone bug with its own fix. The local leak-verdict failures of
`tests/internal/compile.test.yo` stay expected until that campaign lands;
CI stays ratcheted off for them (`YO_TEST_LEAK_VERDICT=0` in the two
self-hosted legs), which is the umbrella's interim state.**

**Re-check 2026-10-20 (darwin, the v0.2.67 prep box): not measurable
there.** On macOS 26.6 with the clang on that box's PATH (the nix
clang-wrapper 21.1.7), an AddressSanitizer build of a three-line leaking C
program spins at 90% CPU at start and never exits (a build with Apple's
`/usr/bin/clang` hangs the same way, as the review reproduced), so no binary built there
can produce a LeakSanitizer report (the compiler's `--sanitize address` probe
in `src/main.yo` guards exactly this hang with a 3-second `kill -9`). That
matches the umbrella's note that the debt is invisible on a macOS
dev box. The four failures reproduce only where LeakSanitizer arms (Linux,
as in the measurement above). Nothing in the verdict changed.

## Test

The four cases above, run locally with the default leak verdict, are the
reproducer. The symbolized evidence and the per-window totals are in the
agent logs (`~/Workspace/Yo-wt/vbd-logs/leakfix-v66/compile-diag.log`,
agent-box-local), and the kept batch binary
(`tests/internal/.yo_selftest_batch_572265_1_0.*`) maps every `yo_id_…`
frame to its source function.
