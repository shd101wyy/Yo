# `gates_fast` is red on the WSL/nix box but green in CI: six batteries and six CLI goldens

**Severity:** S3 — local-only. Develop's CI gates are green (run 36570470718), but on this box the gate battery is red for every branch, which hides real regressions in those files.

**Status: OPEN.** Found 2026-09-30 while gating `mem/codegen-plan`. Earlier sessions recorded the same battery failures on both sides of an A/B, without filing them.

## Symptom

`S1=<any tree-built yo> P=x bash scripts/bootstrap/gates_fast.sh` on the
WSL2 / nix-shell box (Linux 6.6.87.2-microsoft-standard-WSL2, glibc 2.40,
clang from nixpkgs) reports:

```
FAIL: battery async_await rc=1
FAIL: battery file rc=1
FAIL: battery walker rc=1
FAIL: battery basic rc=1
FAIL: battery iso rc=1
FAIL: battery rc rc=1
```

The failures are identical for a develop-based baseline binary and for the
branch binary (`diff` of the two FAIL lists is empty).

They do not depend on the compiler, the std or the allocator. Reduced:

```
cd <develop checkout>
YO_STD=$PWD/std yo test tests/iso.test.yo --parallel 1      # installed v0.2.46 seed
# 4 passed, 4 failed — each "Memory leak detected:"
```

The same 4 failures appear with a tree stage-1 (glibc) and a tree stage-2
(mimalloc), and with develop's std or the branch's.

The failing tests:
- iso: "Test ^ operator for constructing Iso value", "^ answers .None when an
  object inside the value is shared", "^ isolates a uniquely owned graph and
  it crosses a thread", "^ does not descend into an atomic object";
- rc: "Test Rc with Iso";
- walker: "walk nonexistent returns error";
- async_await: "Test Future with multiple effect row spreads", "Test unwind
  in async closure", "Test a reassignment in an awaitless nested arm beside
  an awaiting arm", "abort dispose skips awaitless-match pattern bindings";
- basic and file: see `/tmp/<P>_basic.log` and `/tmp/<P>_file.log`.

`-v` on the first iso test shows a real LeakSanitizer report, not a runner
artifact:

```
Direct leak of 1024 byte(s) in 1 object(s) allocated from:
    #0 ... (.yo_selftest_batch_1_0.bin+0x126250)
    ...
SUMMARY: AddressSanitizer: 1024 byte(s) leaked in 1 allocation(s).
```

The test binary is built without symbols and deleted after the run, so the
frames are unsymbolized.

## GATE 7: six CLI goldens

The same box also fails six CLI goldens, identically on both sides:
- **`doc-html`, `doc-json`, `doc-logo-favicon`, `doc-markdown`,
  `doc-name-from-manifest`.** The goldens contain git's stderr from
  `yo doc`'s repository probe, `fatal: not a git repository (or any of the
  parent directories): .git`. The sandbox here sits on a mount boundary, so
  git words it `fatal: not a git repository (or any parent up to mount
  point /)` / `Stopping at filesystem boundary …`. The golden encodes
  another process's stderr. `yo doc` should not pass the probe's stderr
  through, and the goldens should not contain it.
- **`compile-allocator-fixed-oom-shapes`.** The run exits 1 with no stdout;
  the golden expects rc 0 and three `…: died with an allocation diagnostic`
  lines. Not yet diagnosed.

## Next step

Rebuild the iso case as a standalone program (`yo compile … --sanitize
address --allocator system` with `-g`), symbolize the 1024-byte allocation,
and find out why CI's ASan does not report it. Candidates: a per-thread
buffer released only on some libc versions, or LSan configuration differing
between the nix clang and ubuntu-latest's. Then add a failing-first test
that reproduces the leak on CI too.
