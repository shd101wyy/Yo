# What does `yo fix --migrate unsized` do under the binary that flips `Dyn`?

**Raised:** 2026-11-15, d49-flip lane (decision 49 S2 flip A, VERDICTS-58/-61).

## The question

`tests/cli-cases/fix-migrate-unsized` was recorded with a pre-flip binary. Its fixture is
v0.2.77-spelled user code: by-value `Dyn(...)` fields, `Option(Dyn(...))`, `Rc(Dyn(T)).new(box)`,
`impl(Dyn(...), ...)`. With the flip binary (stage 1 of `vbd/d49-flip`):

- The syntactic pass still rewrites all 18 type spellings.
- The evaluation pass cannot evaluate the old file. Every bare by-value `Dyn` is E0619 now
  (`main.yo:24`, `Zoo :: struct(pet : Dyn(Speak), ...)`; `multi.yo:5`, `Option(Dyn(...))`).
  So no `dyn(v)` is rewritten in the first run, and both files are reported as not evaluating
  (rc 1).
- A second run evaluates further (3 `dyn` rewrites) but still stops on the listed sites, which are
  hard errors after the flip.

So under v0.2.78 the mode migrates type spellings but not `dyn` sites in code that has not been
migrated yet. The golden cannot pass with a stage-2 binary as it stands, and that is an A gate
(stage-2 cli-diff).

## Options

1. **Two phases in one run.** Apply the syntactic rewrites, then evaluate the REWRITTEN text to
   record the `dyn` sites (in memory, or by writing and re-reading). This gets every site the old
   alias still accepts. Listed sites (`Rc(Dyn).new(box)`, `impl(Dyn)`, multi-line spellings) still
   stop a file's evaluation, so a user still needs v0.2.77 for a file that has them. Re-record the
   golden.
2. **A legacy reading while recording.** Under `--migrate unsized`, read a bare by-value `Dyn(X)`
   as `Box(Dyn(X))` (the pre-flip intercept, kept only for the recorder). This is the full
   migration on v0.2.78, but it re-introduces the intercept S2 deletes, in a mode that retires in
   v0.2.80.
3. **Document v0.2.77 as the migrating release.** The README stage and the release notes say:
   run `yo fix --migrate unsized` with v0.2.77 before upgrading. The flip PR rewrites this
   fixture into what v0.2.78 accepts, or pins the case to the seed.

## Recommendation

Option 3 for the flip PR: it is the smallest, and v0.2.77 is published and carries the mode. The
README projects already ran it on v0.2.77 (VBD_RELEASE_SCHEDULE v0.2.77 row). The fixture moves to
the post-flip spelling and keeps the parts v0.2.78 still evaluates (type spellings, `dyn(v)` alias
sites, the views). Option 1 can follow in v0.2.79 if user reports show it is needed. Option 2 costs
a deleted intercept for one release, so not that.
