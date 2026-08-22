# `yo test --std-path` is shadowed by the binary's own tree std in batch child compiles

**Status: OPEN.** Found 2026-08-22 while validating the enum-alignment fix
across worktrees; cost ~40 minutes of misdiagnosis as a miscompile.

## Symptom

Running tree A's compiler binary against tree B's tests:

```
cd /tmp/yo-s0wt   # tree B (has the dns AAAA fix in std/net/dns.yo)
/tmp/yo-fixwt/yo-out/aarch64-macos/bin/yo test tests/net/dns.test.yo --std-path ./std
```

The batch child compile resolved std to **`/tmp/yo-fixwt/std`** (tree A —
the binary-relative std), NOT the explicit `--std-path ./std`. Verified by
the mangled decl paths in the batch C
(`enum_decl_…_file____private_tmp_yo_fixwt_std_net_addr_yo`). Tree A's std
predates the AAAA fix, so the test's V6 arm didn't exist in the compiled
std and the test failed with `len=0` — indistinguishable at first sight
from a codegen regression in the compiler under test.

The same invocation with a binary that has NO adjacent source tree
(`cp` the binary to `/tmp/yo-fixbin` first) honors `--std-path` and passes.

## Where to look

Either the test runner does not forward `--std-path` to its child batch
compiles (`src/main.yo` around the `.yo_selftest_batch` spawn), or
`resolve_std_path` (`src/module_manager.yo`) ranks the binary-relative
tree std above the explicit override. Explicit `--std-path` should win
over EVERY fallback, in child processes included.

## Workaround (session knowledge, also in memory)

When testing tree B with tree A's binary, copy the binary out of its tree
first (`cp .../bin/yo /tmp/…`), or build inside tree B.
