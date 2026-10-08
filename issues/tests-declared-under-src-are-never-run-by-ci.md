# Tests declared under `src/` are never run by CI

**Severity:** S3: a compiler test written next to a private function or field
under `src/` passes CI without ever running, so its failure would go unseen.

> Filed 2026-10-08 at the maintainer's request. No such test exists yet:
> `src/` has no in-file `test(...)` and no sibling `*.test.yo`, measured on
> develop at d7e222f0c.

## Why tests belong under `src/`

A `_`-prefixed field or method is visible only from its declaring module and
that module's same-directory siblings (E0405 elsewhere,
`plans/reference/MEMBER_VISIBILITY.md`). So `tests/internal/` can only reach
the compiler's public surface. Testing a private helper or a private field
(for example a `_`-prefixed evaluator helper, or a cache's private map) needs
one of the two shapes `.github/instructions/testing.instructions.md`
("Testing private members") already documents for std:

- a **sibling file** (`src/evaluator/foo.test.yo` beside `foo.yo`);
- an **in-file** `test("…", { … })` inside the module.

Both are allowed in `src/` and should stay allowed.

## The gap

Nothing runs them:

- CI runs `yo test ./tests --exclude tests/internal --exclude tests/cli-cases`,
  `yo test ./std`, and `tests/internal/*.test.yo` (the sharded "Compiler
  internal tests" job and the five verifier files). There is no
  `yo test ./src`.
- `yo check ./src` treats an in-file `test(...)` as a no-op, and it does not
  check sibling `*.test.yo` bodies without `--test-bodies`. A test that no
  longer even type-checks stays silent too.
- `yo build` and the bootstrap gates compile `src/main.yo`, where in-file
  tests are a no-op by design.

## What running them needs

- **Cost.** A batch built from a `src/` module compiles that module's import
  closure, which for most of `src/` is most of the compiler. That is the
  `tests/internal/` cost class (multi-GB, minutes per file; the whole
  directory takes ~78 min). The step needs `--parallel 1` and its own shard,
  like the internal-tests job, not a line in the fast suite.
- **The in-file copy limitation.** The in-file batch is a COPY of the
  module, so the module's own types exist twice whenever the original is
  loaded too: by any module in the batch's import closure that imports it
  (an import cycle). A value built by the original and handed to the copy
  then carries the other copy's type. Sibling files do not have this
  problem, because the module is imported, not copied. `src/` should prefer
  sibling files, and the instructions should say so.
- **Discovery.** `yo test ./src` must find both shapes and skip the
  compiler's `main` (the runner already drops a module's own `main` and
  `export(main)` for an in-file batch).

## Fix direction

1. Add a CI step (in the internal-tests job, or a shard of it) that runs
   `yo test ./src --parallel 1`, and add it to `merge-gate`'s `needs:` if it
   is a new job.
2. Have `yo check ./src --test-bodies`, or the step above, cover sibling test
   bodies so a stale test fails at check time.
3. Update `testing.instructions.md` and `src/README.md`: compiler tests of
   private members go in a sibling `*.test.yo` under `src/`, and the CI step
   that runs them.

Verification: a sibling test under `src/` that asserts `false` turns that CI
step red, and removing it turns it green.
