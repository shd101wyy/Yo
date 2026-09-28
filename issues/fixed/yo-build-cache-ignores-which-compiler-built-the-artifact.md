# `yo build`'s artifact cache ignored WHICH compiler built the artifact

**Status:** FIXED 2026-09-28. **Found:** 2026-09-28, building stage-2
compilers for the plan §0.19 A/B (`plans/EVALUATOR_MEMORY_REDUCTION.md`).

## Symptom

`<stage-1> build` on the tree that stage-1 was built from:

```
$ ~/Workspace/Yo-wt/bins/yo-rebased1 build
Building yo v0.2.45-6-g9dde02caf → yo-out/x86_64-unknown-linux-gnu/bin/yo
  (cached: inputs unchanged, skipping compile)
```

The "stage-2" it produced was the stage-1 binary byte for byte. Any A/B of
"stage-2 vs stage-1" through `yo build` compared a binary with itself. It cost
one wrong measurement round in §0.19 before `sha256sum` caught it.

## Root cause

The artifact stamp (`artifact_input_stamp`, `src/build_runner.yo`) covered the
child argv, `CURRENT_YO_VERSION`, every input module's bytes (from the
depfile), `yo.toml`/`yo.lock` and `build.env` reads. It did not cover the
compiler binary. A compiler built from a tree reports that tree's
`src/version.yo`, which is the same version the seed that built it reports, so
the seed's recorded stamp matched. The header comment's claim "the compiler
version + argv covers the yo side" holds only for published binaries.

Related, but a different trigger: `issues/yo-build-artifact-cache-serves-a-stale-binary.md`
(an edit landing during a compile).

## Fix

`_compiler_identity` stats the running compiler's executable (path, size, nanosecond mtime) instead of hashing it (hashing 11 MB in pure Yo cost 0.1–0.5 s per cached no-op build)
(`std/env.current_exe`, i.e. `/proc/self/exe` on Linux, not `argv[0]`, which
can be a bare PATH name) once per process. The stamp carries it as a
`yo-binary <path>:<size>:<mtime>` line. The identity is `unknown` / `unreadable` when the
executable cannot be located or read; the cache still works, keyed by version
as before. `YO_BUILD_NO_CACHE=1` remains the manual bypass.

## Test

`tests/internal/build_runner.test.yo` "artifact stamp: a different compiler
binary is a different stamp". It pins two identities
(`set_compiler_identity`), feeds the record pass the same depfile, and asserts
the two stamps differ and that the same identity reproduces the stamp. It fails
with the `yo-binary` line removed.
