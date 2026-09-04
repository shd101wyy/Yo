# walker follow_symlinks is gated off on Windows — the follow path dies with "unknown I/O error"

**Status: OPEN.** Found 2026-08-22 on PR #229's `test (windows-latest)` leg.

## Symptom

With the follow_symlinks implementation active on Windows, the walker test
file aborts at the follow test's start — no assert, no test banner, just:

```
yo: error: unknown I/O error
##[error]Process completed with exit code 1.
```

Symlink CREATION works on the same runner (`dir.test.yo`'s "symlink creates
a symbolic link" passed, `symlink ok`), so the failure is in the FOLLOW
path: `is_dir`/`canonical` (realpath) through a DIRECTORY symlink via the
Windows runtime emulation, or Windows path handling in the walker's
`_join_path` (`/`-joined paths handed to realpath). The error escaped the
test's own exception handler (exit 1, not the assert's exit 6), suggesting
it surfaced at the runtime/runner layer rather than as a caught IoError.

## Current state

- `std/fs/walker.yo` gates the descent on a comptime `_FOLLOW_SUPPORTED`
  (false on Windows): symlink ENTRIES are still reported everywhere; only
  the follow/descent is disabled on Windows. POSIX behavior unchanged.
- `tests/fs/walker.test.yo` skips the follow test on Windows and
  Emscripten (whose FS emulation cannot resolve symlinked dirs either).

## To close

1. Reproduce on a Windows box/CI with the gate lifted; identify which
   primitive fails (`is_dir` via statx-follow, `realpath`, or path shape).
2. Fix the runtime/emulation (likely `src/codegen/async/runtime_io_win*.yo`
   realpath-equivalent or the statx follow flags on directory reparse
   points).
3. Lift `_FOLLOW_SUPPORTED`, un-skip the test on Windows.
