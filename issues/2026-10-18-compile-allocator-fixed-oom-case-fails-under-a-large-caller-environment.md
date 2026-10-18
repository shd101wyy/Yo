# The `compile-allocator-fixed-oom` cli case fails when the caller's environment is large

**Severity:** S3. A cli-diff run from a shell with a large environment (about 35 KB on the box below) scores `compile-allocator-fixed-oom` as a vacuous NO-GOLDEN although nothing in the tree changed. The verdict depends on the host shell, not the code.

**Status:** OPEN. Found 2026-10-18 while gating PR #1440 (decision 47 locals) on the Linux (WSL) box.

## Symptom

```
── NO-GOLDEN  compile-allocator-fixed-oom  (stdout_keep_match matched nothing — vacuous)
```

The sandbox's `stdout.raw` shows the PARENT process dying, not the child:

```
malloc returned None (at file://<REPO>/std/collections/array_list.yo:271:20)
Error: Executable exited with code -1
Skipping run: a step it depends on failed
```

## What it depends on

The probe (`tests/cli-cases/compile-allocator-fixed-oom/fixture/src/main.yo`) is built with `--allocator fixed --heap-size 65536`, and the PARENT runs in that same 64 KiB heap. It calls `env.set("YO_FIXED_OOM_CHILD", "1")`, then `Command.new(argv(0)).output(io)`, then splits the child's stderr. Something on that path allocates in proportion to the inherited environment, and the panic is an `ArrayList` buffer allocation (`array_list.yo:271`). Which call allocates that buffer has not been pinned down yet. A large enough inherited environment exhausts the parent's heap before the child's line is printed.

The same probe binary, run by hand:

| environment | parent result |
| --- | --- |
| this shell's env (34,184 bytes, 180 vars) | rc 0, prints the child's `out of memory: …` line |
| the same env plus `PAD` of 1,500 bytes | rc 0 |
| the same env plus `PAD` of 2,000 bytes or more | rc 134, `malloc returned None` |
| `env -i PATH=…` | rc 0 |

It is not a regression of #1440. Under `env -i PATH=/usr/bin:/bin PAD=<n>`, a bisection of the largest passing `n` gives:

- 27,187 bytes for the probe built by develop (`yo-dev-5425cd7bf`, develop's std, develop's fixture);
- 27,347 bytes for #1440's tree binary, std and marked fixture.

The harness's own exports (`HOME`, `YO_ORIGINAL_CWD`, `YO_STD`, the per-case `env` keys) push a borderline shell over the edge. The same case passes with three large variables unset (`env -u DIRENV_DIFF -u __MISE_ORIG_PATH -u LS_COLORS … cli-diff-test.sh compile-allocator-fixed-oom` → PASS 1). CI's environment is small enough, so develop's battery stays green.

## Fix options

- (a) Find the environment-proportional allocation in the parent. Then either make the fixture avoid it (for example, `env_clear()` plus `.env("YO_FIXED_OOM_CHILD", "1")` if the cost is the inherited-environment walk) or fix std if the allocation is unnecessary. Either way the case should go back to pinning only the child's OOM panic.
- (b) The harness runs every case under a fixed, minimal environment (`env -i` plus an allow-list). This removes the whole class of host-dependent verdicts, but it touches every case.

Test: run the case with an inflated environment (`PAD=$(head -c 4000 /dev/zero | tr '\0' x) scripts/cli-diff-test.sh compile-allocator-fixed-oom`). It is NO-GOLDEN today and must PASS after the fix.
