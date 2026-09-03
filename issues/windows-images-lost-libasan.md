# Windows runner images lost libasan — every ASan-instrumented test link fails with "cannot find -lasan"

- **Status**: OPEN (CI workaround landed with the module-global capture PR:
  the Windows legs of the two full-suite invocations pass
  `--disable-sanitize`; restore ASan when the images ship the library again)
- **Found**: 2026-09-03, PR #396's CI — both `test (windows-latest)` and
  `test (windows-11-arm)` failed every batch link with

```
C:/mingw64/bin/../lib/gcc/x86_64-w64-mingw32/15.2.0/.../ld.exe: cannot find -lasan: No such file or directory
collect2.exe: error: ld returned 1 exit status
```

- **Not PR-specific**: the failure is uniform across every test file and
  reproduced identically on a `--failed` rerun, while develop's windows legs
  (run 33704787725, finished minutes earlier) were green — the runner image
  rolled mid-day and the mingw64 toolchain no longer carries the ASan
  runtime. `--c-compiler clang` on these images resolves through the mingw64
  driver, whose `--sanitize address` links `-lasan`.

## Restore path

When the images (or a choco/msys2 install step in the workflow) provide
libasan again, drop the two `TEST_SAN_FLAG` conditionals in
`.github/workflows/test.yml` (the `test` job's "Run tests" step and the
`test-native` job's). Until then Windows loses ASan crash detection for the
language corpus — macOS/Linux coverage is unchanged.
