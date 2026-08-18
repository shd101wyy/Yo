# RETIRED: Windows vcpkg resolution, archiver selection, runtime staging (B9)

**User decision 2026-08-18** (P2.5 blocker B9): these TS-only Windows
conveniences are retired with `src/`, not ported. This file is the documented
regression the blocker required — a decision, not a side effect.

## What is lost (was TS-only, no yo-self counterpart)

1. **vcpkg system-library resolution** (`src/pkg-config.ts:384-…`): on
   Windows, `link_system_library` fell back to `$VCPKG_ROOT/installed/<triplet>`
   for include/lib paths, including a PE parser that walked TRANSITIVE DLL
   dependencies so `yo build` could stage them next to the output binary.
   Self-hosted behavior: pkg-config only (available on Windows via e.g. msys2),
   or explicit `include_paths`/`library_paths` in `build.yo`.
2. **`selectStaticLibraryArchiver`** (`src/codegen/index.ts:33`): probed
   llvm-ar vs zig-ar for static-library artifacts on Windows. Self-hosted
   behavior: the system `ar`/`llvm-ar` on PATH.
3. **`stageRuntimeFiles`** (`src/build-runner.ts:113`): copied resolved DLLs
   beside the built executable. Self-hosted behavior: the user's PATH or
   manual staging.

## Why retirement is acceptable

- No CI leg exercises any of the three (the TS unit tests were the only
  coverage, and they retire with `src/`).
- No committed project in the repo or its examples uses vcpkg resolution.
- The native-Windows self-hosted pipeline (bundle build + smoke) is green
  without them (v0.2.9 windows-x64; seed-built as of #137).

## Reopen condition

A user report that hits one of the three on Windows. The port scope is
bounded: `pkg-config.ts`'s vcpkg block is ~120 lines plus the PE parser;
the archiver probe and staging are trivial. Reopen as a P3+ item with the
report attached.
