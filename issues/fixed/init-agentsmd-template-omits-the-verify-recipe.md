# The `yo init` AGENTS.md template omits the verification recipe

**Severity:** S3 — every scaffolded project teaches its agent five commands
and not the one that gates proofs; the recipe was designed twice (BEND B3
task 3, YO_CONTEXT C6 task 1) and landed zero times.

**Status: FIXED 2026-10-04** (see Fix below). Originally: **OPEN.** Found
2026-10-01 by the agent-loop audit's `git log -S`:
the `yo verify --strict ./spec` line has never existed in `src/init.yo`'s
template, though `plans/reference/YO_CONTEXT.md` C6's banner reads as if the
recipe landed (corrected in that doc alongside this issue).

## Symptom

```
$ yo init demo && cat demo/AGENTS.md
```bash
yo context       # the language pack + API index — read this first
yo build run     # build and run the app
yo build test    # run the test suite
yo check ./src   # type-check after every edit
yo fmt           # format the source
```
```

No `yo verify` line, no `spec/` convention — an agent working in a
scaffolded project never learns the strict gate exists.

## Root cause (narrowed, not fixed)

`src/init.yo` ~L196 builds the fenced block as a hardcoded string; the C6
sweep rewrote it around `yo context` and dropped the verify line from the
planned four-command recipe (BEND D3: "keep laws in `spec/`, run
`yo verify --strict ./spec` before committing").

## Fix direction

Add to the block (post-release — it re-records the `init-*` cli-case
goldens and rides a seed window):

```bash
yo verify ./spec --strict   # prove the laws in spec/ (fails on assumed)
```

and scaffold `spec/README.md` stating the claims/proofs wall in two
paragraphs (BEND D3). Note: the `spec/`-directory convention itself is
blocked by
[`law-over-an-imported-callee-cannot-verify.md`](./law-over-an-imported-callee-cannot-verify.md) (fixed 2026-10-03)
— land that fix first or the recipe teaches a gate that cannot go green.

## Fixed

**2026-10-04, branch `s3/batch-0-fixes`.** Root cause: `generate_agents_md`'s
`fence` in `src/init.yo` was a hardcoded five-command string that had never
carried the verify line (the BEND B3 task 3 / YO_CONTEXT C6 recipe half
landed zero times), and nothing scaffolded a `spec/` for the line to point at
— `yo verify ./spec --strict` on a fresh project errored
`no .yo files found` (rc 1). The fix, all in `src/init.yo`: the fence gains
`yo verify ./spec --strict   # prove the laws in spec/ (fails on assumed)`
between `check` and `fmt`; `init_project` scaffolds `spec/` (skip-if-exists,
like every scaffolded file) with two new generators —
`generate_spec_readme`, the BEND D3 claims/proofs wall in two paragraphs
plus the CODEOWNERS line to add, and `generate_spec_example_law`, a seed law
over a contracted callee (the repo's own `law_abs_nonneg` shape, i32) that
keeps the taught gate GREEN out of the box instead of erroring on an empty
`spec/`. Verified end-to-end in a fresh scaffold under the rebuilt tree
binary: the recipe carries the line, and `yo verify ./spec --strict` inside
the new project prints `2 ok, 0 assumed, 0 outside-subset, 0 unproven` with
`harness OK`, rc 0, 382 ms; the scaffolded `.yo` files are `yo fmt`-clean.
Tests: `tests/internal/init.test.yo` gained four cases (the recipe names the
gate; the README names the gate, the CODEOWNERS line and the seed law; the
law file carries `Pragma.Verify`, `law(` and `requires(`) — red before the
fix (E0403 `No member "generate_spec_readme"`, 0 of 31 tests ran, rc 1) and
green after (31 passed, rc 0); `init-build-test`'s
`fmt --check build.yo src tests` line now also covers `spec`; and the seven
cli-cases whose cmd runs `yo init` (init, init-cwd, init-existing,
init-build-test, init-no-skills, build-stamp-dotted-dir,
build-depfile-scoped-stamp) were re-recorded — the golden diff is exactly
the new AGENTS.md hash, the two `spec/` tree lines and the two `Created:`
stdout lines per case. Docs updated together: `docs/en-US/BUILD_SYSTEM.md` +
`docs/zh-CN/BUILD_SYSTEM.md` (project-structure tree, `yo init` reference
file list, AGENTS.md description), the root `README.md` quick-start tree,
and the four plan pointers (`plans/reference/INIT_AGENT_SCAFFOLD.md`'s open
item, `plans/reference/YO_CONTEXT.md`'s C6 correction, BEND B3's status
note, `plans/backlog/AGENT_LOOP_NEXT.md`'s fix-first list). Found on the way
and fixed in the same commit: the cli-diff harness could neither score nor
record these goldens on Windows —
[`cli-diff-goldens-cannot-score-or-record-on-windows.md`](./cli-diff-goldens-cannot-score-or-record-on-windows.md).
