# A Windows static-library archive spawns Unix `ar`, which does not exist there

**Severity:** S3 (Windows-only toolchain: every `build.static_library` artifact and
`yo compile --static-library` fails with a bare "file or directory not found"; the exes and DLLs are
unaffected)

Filed from the v0.2.79 README-projects sweep (markdown_yo's and markdown_it_yo's `install` steps),
2026-11-17. Present on the v0.2.78 seed and on develop `c1363dc91` alike.

## Repro

Any Windows box without a Unix `ar` on PATH (stock Windows, or scoop LLVM, which ships `llvm-ar.exe`):

```text
$ yo compile lib.yo --static-library
...
yo: error: file or directory not found
```

`_run_cc_plan`'s static-lib branch (`src/main.yo`) ends with `Command.new("ar").arg("rcs")…`. Confirmed
causally: with an `ar.exe` (a copy of `llvm-ar.exe`) first on PATH, the same command succeeds.

## Fix shape

Probe `ar`, then `llvm-ar`, then `llvm-lib` (the MSVC librarian), like the C-compiler probe
(`--cc` accepts only cc|gcc|clang|zig|emcc, but the archiver was never given a Windows story). A
cli-cases golden for the probe order rides the fix.
