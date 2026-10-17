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

## Analysis (not yet done)

The stacks are unsymbolized (`.yo_selftest_batch_*.bin+0x…`). The four
tests are the ones that drive the compiler in process:
- the ASan probe;
- the PATH helper;
- two emit checks that compile a program and read the C.

So the leaked objects are compiler data that the in-process compile never
releases. The next step is a symbolized rerun
(`ASAN_SYMBOLIZER_PATH`, or `--keep` and `llvm-symbolizer` on the batch
binary) to name the allocation sites, and checking whether they are
expected process-lifetime caches (a suppression) or real leaks.

## Test

The four cases above, run locally with the default leak verdict, are the
reproducer.
