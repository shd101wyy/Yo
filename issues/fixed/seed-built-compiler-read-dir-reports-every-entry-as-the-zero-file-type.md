# A seed-built compiler's `read_dir` reports every entry as the zero `FileType`

**Status: FIXED** (2026-09-29). Found by the PR #988 re-gate. It was
also bisected independently by the session gating #975, whose `yo install`
cli-cases failed with `yo: error: is a directory`.

## Symptom

A compiler built by `yo build` from develop `b6b828772` (#989) or later, on macOS:

- `yo test ./tests --exclude tests/internal --exclude tests/cli-cases` ran
  **173 of 292** test files and exited 0. Every file below a subdirectory of
  the target was silently dropped: `tests/net/`, `tests/sys/`, `tests/fs/`, …
  (measured, `--list | cut -f1 | sort -u | wc -l`: 173 vs 292 with the
  v0.2.45 seed).
- `yo test ./std` printed `No test files found.` with rc 0. Its only test file is
  `std/collections/hash_set.test.yo`, one level down.
- A directory that holds only a subdirectory lists nothing, while the
  subdirectory itself lists its tests (measured on a copy of
  `std/collections` inside an empty directory: 0 vs 3).
- About 18 cli-cases fail under that binary, e.g. `test-list` (its fixture has
  `sub/beta.test.yo`) and `install-git-dep-semver` (`is a directory`: the
  mirror copies a directory as a file).

So every local battery run with a seed-built compiler since #989 was about half
vacuous: green, having skipped every nested test file.

## Root cause (measured)

#989 fixed the codegen bug in
`issues/fixed/async-cond-value-with-await-arm-inside-while-yields-zero.md`: a
value-position `cond` with an awaiting arm inside a `while` inside `io.async`
yields the ZERO value for every arm. In the same PR it folded `read_dir`'s
`DT_UNKNOWN` stat (`std/fs/dir.yo`, pass 2) back into that exact form:

```rust
ft := cond(
  (r.dt == DT_REG) => FileType.File,
  (r.dt == DT_DIR) => FileType.Directory,
  (r.dt == DT_LNK) => FileType.Symlink,
  (r.dt == DT_UNKNOWN) => e.io.await(_file_type_or_other(...), e.io),
  true => FileType.Other
);
```

`yo build` compiles the compiler with the SEED (v0.2.45), which does not have
the fix. So the seed-built compiler's own `read_dir` gave every entry the zero
`FileType` (`.File`), and its directory walks (`yo test`, `yo check <dir>`,
`yo fmt --check <dir>`, the `yo install` mirror) treated every subdirectory as
a file. A compiler built by that compiler (the tree's own codegen) is not
affected, which is why the defect did not show in its tests.

Standalone reproduction (`read_dir` walk of a directory holding one
subdirectory of 10 `.yo` files):

| compiler | std | files found |
| --- | --- | ---: |
| seed v0.2.45 | v0.2.45 std | 10 |
| seed v0.2.45 | develop std | **0** |
| tree-built | develop std | 10 |
| seed v0.2.45 | develop std with this fix | 10 |

## Why CI did not see it

- The macOS and Windows language-suite jobs run `yo-suite`, compiled from C
  that the Linux stage-1 cross-emits. That C comes from the tree's
  (fixed) codegen, not the seed's.
- The Linux seed-built stage 1 passes the `test-list` cli-case in
  `gates_fast.sh`, so the Linux seed build does not show the miscompile.
  **Why** Linux differs was not established.

## Fix

`read_dir` is back to the statement-form `cond` assigning `ft`, which every
compiler lowers correctly, with a comment pinning it until `SEED_VERSION`
carries the codegen fix. This is the rule in `.github/instructions/c-codegen.instructions.md`:
a landed compiler fix does not license the source form in `std/` or `src/`
until the seed has it.

## Regression coverage

`tests/cli-cases/test-list` (its fixture's `sub/beta.test.yo`) fails under a
seed-built compiler from the broken tree and passes with the fix. It is scored
by `scripts/bootstrap/gates_fast.sh`, which is the local gate that shows the
defect. A language test cannot show it: a test binary is compiled by the
tree's codegen, which lowers the value form correctly.
