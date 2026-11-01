# `cli-diff-test.sh` pins `YO_STD` for a staged binary but not `YO_SKILLS`, so every skills/init case GOLDEN-DIFFs falsely

**Severity:** S3 — false GOLDEN-DIFFs in the cli-diff gate for any `YO_SELF_BIN` staged outside its checkout; six cases (`init`, `init-cwd`, `init-existing`, `init-build-test`'s tree half, `skills-install`, `skills-install-zh`, `build-stamp-dotted-dir`) red on an otherwise green battery, with one erroring `rc=1`

**Found**: 2026-10-31, gating decision 43 step 3 N2a — a full-battery run with
`YO_SELF_BIN=<logs dir>/bin-h5` produced 6 skills-family diffs; re-running the
same 11 diffing cases with `YO_SKILLS=<checkout>/.github/skills` gave
`PASS 11 GOLDEN-DIFF 0`.
**Status:** FIXED 2026-10-31 (fix/cli-diff-skills-pin).

## Symptom

```
$ PATH=<staged-bin-dir>:$PATH YO_SELF_BIN=<staged-bin-dir>/yo bash scripts/cli-diff-test.sh
── GOLDEN-DIFF  skills-install  (rc=1; rc(golden=0,run=1) stdout tree)
    stdout diff (golden < / run >):
      > yo: error: 错误：找不到随发行版捆绑的技能文件。这通常是打包问题——请提交 bug 报告。
    project tree:
    only-in-golden: ./.agents/skills/… (every skill file)
```

## Root cause

`scripts/cli-diff-test.sh` runs each case with `HOME`/`YO_ORIGINAL_CWD`/`YO_STD`
pinned (the `YO_STD="$REPO_ROOT/std"` on the run line) but leaves `YO_SKILLS`
unset. `_find_bundled_skills_dir` (`src/skills_command.yo`) resolves the bundled
skills as: `YO_SKILLS` → the executable's ancestors → the project dir's
ancestors. A binary staged outside its checkout (`/tmp`, a logs dir — the shape
every VBD gate uses, and CI's `/tmp/yo-stage1`) has no `.github/skills`
ancestor, so `yo init`/`yo skills install` copy nothing (or error), and the
golden's `create .agents/skills/…` lines and tree entries diff. The `YO_SKILLS`
override exists exactly for this ("a binary staged OUTSIDE its checkout … so the
gate scripts pin both to the checkout" — `src/skills_command.yo`'s lookup
comment); the harness pins only `YO_STD`.

## Fix

Add `YO_SKILLS="$REPO_ROOT/.github/skills"` to the per-case `env` line in
`scripts/cli-diff-test.sh` (beside `YO_STD="$REPO_ROOT/std"`), matching the
documented contract. Verification: the re-run above (11 cases) is green with the
pin and red without it.

Landed as `fix/cli-diff-skills-pin`: the single `run_case` run line now pins
`YO_SKILLS="$REPO_ROOT/.github/skills"` beside the `YO_STD` pin, so scoring and
`--record` (both go through `run_case`) resolve the checkout's skills for a
staged binary. Reproduced on this box before the fix (tree build of the branch,
staged into a logs dir: all 7 skills-family cases GOLDEN-DIFF, `skills-install`
erroring `rc=1` with the missing-bundle diagnostic) and green after (same staged
binary, fixed harness: `PASS 7 GOLDEN-DIFF 0`, no golden re-recorded — the
goldens were always recorded against the tree's skills, CI pins `YO_SKILLS`
already).
