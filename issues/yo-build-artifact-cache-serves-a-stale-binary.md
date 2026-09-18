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

## Root cause — CONFIRMED

`compile_artifact` (`src/build_runner.yo`) computes the artifact's input stamp
**twice**:

1. **Before** launching the child compile, as the cache decision (the
   comparison that prints `(cached: inputs unchanged, skipping compile)`).
2. **After** the child exits — `post_stamp` — and it is *that* one that is
   written to `<output>.inputs-sha256`.

`_artifact_input_stamp` builds its digest by **re-reading each input from disk
and hashing its current contents**. So the recorded stamp describes the tree as
it is **when the compile ends**, not the bytes the compile actually consumed.
Any write to an input between the child reading it and that post-compile
re-hash is recorded as "this is what the artifact was built from"; every later
build's decision stamp then matches it, and the stale artifact is served
forever.

The window is the whole compile — measured at ~8 minutes for the compiler's own
build in this worktree.

The post-compile choice is deliberate and commented in the source (§4.9):
recording the *pre*-compile stamp would cost one guaranteed extra compile per
artifact, because a first build has no depfile and stamps the whole-tree walk
while the next build stamps the much smaller depfile set. The comment simply
never considers a write arriving *during* the compile.

Two observations in the reproduction are red herrings, and are kept here so
nobody re-chases them: `touch` is inert because the stamp is content-keyed
(correct behavior), and the `v0.2.36-24-g<sha>` string comes from `git describe`
for the *printed line only* — the key's version component is the hardcoded
`CURRENT_YO_VERSION`. **Ordinary edits between builds do invalidate correctly.
Only mid-compile writes are absorbed.**

### Correction to step 5 of the reproduction

The byte comparison in step 5 is **confounded** and does not by itself prove
staleness: `src/main.yo` was edited again (a help-text addition) between the
cached build and the clean rebuild, so the two binaries would differ anyway.
What the control experiment *does* establish is that clean builds are
reproducible, which rules out nondeterminism as an explanation for a difference.
The proof of the defect is the code path above, not that comparison.

### What actually triggered it here

The cached build's predecessor was still compiling while its own inputs were
being edited — `src/main.yo`'s help text was changed during that compile. The
predecessor's post-compile stamp therefore recorded the edited file, and the
next build compared the edited tree against that stamp and matched. This is the
mechanism behind the repo's existing rule of thumb that editing sources during
a background build yields an untrustworthy binary; this issue is *why*.

## Adjacent holes found while root-causing

Filed here so they are not lost; each deserves its own fix:

1. **Warm in-process compiles under-record.** Both module-read record sites sit
   *after* a module-cache early return, so a warm artifact compile
   (`build --watch`) writes a depfile naming only the modules it re-read. That
   under-invalidates today, and would under-invalidate *permanently* once the
   recorded stamp becomes authoritative.
2. **The compiling binary's identity is absent from the key.** Two different
   builds of the same release number cache-hit each other.

## Fix constraints

- **No workaround.** Disabling the cache, or having callers pass `--no-cache`,
  is not a fix — the cache is load-bearing for the incremental-compilation work.
- The fix needs an **over-invalidation canary**: the cache must still HIT when
  nothing changed, or every build pays a full compile and the incremental work
  is undone.
- Regression test: `tests/internal/build_runner.test.yo` for the stamp logic,
  and/or a `tests/cli-cases/` case that builds, edits a transitively-imported
  module, rebuilds, and asserts the artifact changed.
