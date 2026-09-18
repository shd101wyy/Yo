# `yo build` reports "cached: inputs unchanged" after the compiler sources changed, and serves a stale binary

**Status:** OPEN. **Found:** 2026-09-18, during `plans/SELF_VERIFICATION.md` M0 /
Bend-plan B0 work.
**Severity:** HIGH — every local gate in this repo can silently test the wrong
binary. A contributor who rebases and re-runs `yo build` gets the pre-rebase
compiler with no warning, and the build exits 0.

## Symptom

```
$ yo build --std-path ./std
Building yo v0.2.36-24-g1b4419749 → yo-out/aarch64-apple-darwin/bin/yo
  (cached: inputs unchanged, skipping compile)
```

The version string had ALREADY updated to the new commit, so the build knew the
tree had moved — and still skipped the compile.

## Reproduction (the sequence that found it)

1. `yo build` on tree A (`cb498a572` + local edits) → binary A.
2. `git rebase --onto origin/develop cb498a572` — this changed, relative to A:
   `src/main.yo` (+372 lines), `src/lexer.yo` (+25), `src/parser.yo` (+21),
   `src/verifier/vc.yo` (+44), `std/prelude.yo` (+72), `std/spec/numeric.yo`
   (+141), `std/spec/refine.yo` (+175) — 11 files, 768 insertions.
3. `yo build` on the rebased tree B → **"(cached: inputs unchanged, skipping
   compile)"**, exit 0.
4. `touch src/main.yo; yo build` → still cached, binary byte-identical. (So the
   check is content-based, not mtime-based — touching is correctly ignored.)
5. `rm -rf yo-out && yo build` on the SAME tree B → binary **byte-different**
   from the cached one.

## The control experiment — why this is not build nondeterminism

Step 5 only proves staleness if a clean build is reproducible. It is:

```
$ rm -rf yo-out && yo build --std-path ./std   # first clean build  -> /tmp/yo-clean-1
$ rm -rf yo-out && yo build --std-path ./std   # second clean build
DETERMINISTIC: two clean builds identical
```

Two consecutive clean builds of the same tree are byte-identical, which is
consistent with the repo gating a byte-identical self-compile fixpoint in CI.
So the byte difference in step 5 is a real difference in the PRODUCT, not noise:
the cached artifact was compiled from the pre-rebase sources.

## Why it matters here

M0 and B0 were both validated with `yo build`-produced binaries. The B0 gate had
to be re-run against a clean build before it could be trusted, and the earlier
"full local gate passes" claim was, for a window, resting on a binary that
predated the rebase. Any CI job or contributor workflow that builds and then
tests inherits the same exposure.

## Analysis — not yet root-caused

Known from the reproduction:

- the freshness check is **content-based** (step 4: `touch` does not invalidate);
- it is **not** keyed on the git version string (step 3: the version changed and
  the cache still hit);
- it misses at least `src/main.yo`, which is the build's own entry module — so
  this is not merely a missing-transitive-dependency bug.

That combination points at the stamp/depfile the build writes into `yo-out/`
being compared against something other than the current sources, or being
written before the inputs it claims to cover. The artifact cache lives in
`src/build_runner.yo` (`plans/reference/INCREMENTAL_COMPILATION.md` Phase A, the
build-runner artifact cache; `plans/archive/BUILD_AND_DEPENDENCY_SYSTEM_REDESIGN.md`
describes depfile stamps). Root-causing is in progress; this doc is filed first
so the reproduction is not lost.

## Fix constraints

- **No workaround.** Disabling the cache, or having callers pass `--no-cache`,
  is not a fix — the cache is load-bearing for the incremental-compilation work.
- The fix needs an **over-invalidation canary**: the cache must still HIT when
  nothing changed, or every build pays a full compile and the incremental work
  is undone.
- Regression test: `tests/internal/build_runner.test.yo` for the stamp logic,
  and/or a `tests/cli-cases/` case that builds, edits a transitively-imported
  module, rebuilds, and asserts the artifact changed.
