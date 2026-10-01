# The `yo init` AGENTS.md template omits the verification recipe

**Severity:** S3 — every scaffolded project teaches its agent five commands
and not the one that gates proofs; the recipe was designed twice (BEND B3
task 3, YO_CONTEXT C6 task 1) and landed zero times.

**Status: OPEN.** Found 2026-10-01 by the agent-loop audit's `git log -S`:
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
[`law-over-an-imported-callee-cannot-verify.md`](law-over-an-imported-callee-cannot-verify.md)
— land that fix first or the recipe teaches a gate that cannot go green.
