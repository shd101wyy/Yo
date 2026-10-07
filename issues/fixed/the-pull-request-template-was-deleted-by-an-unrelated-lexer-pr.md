# The pull-request template was deleted by an unrelated lexer PR

**Severity:** S3. Every PR since #1117 had no template, while AGENTS.md still told contributors and agents to follow `.github/pull_request_template.md`.

**Status:** FIXED (2026-10-06).

## What happened

#1134 (`b19f918e2`) added `.github/pull_request_template.md`, with the Summary / Verification / LLM attribution / Deferred sections that AGENTS.md cites. #1117 (`cc7bf31f9`, "lexer+fmt: post-#1092 audit") deleted the file. #1117 is a lexer and formatter PR with no reason to touch the template. Its branch most likely predated #1134, and a stale-branch resolution dropped the file. Nothing checks that the template exists, so the loss went unnoticed until a 2026-10-06 plan review proposed adding a checklist line to it.

## Fix

The file is restored from `b19f918e2`, with two checklist changes:
- `yo check ./src` now carries `--std-path ./std`, as AGENTS.md requires;
- a new item: a PR that lands a plan phase updates that plan's Progress header in the same PR. A review found the VALUES_BY_DEFAULT header stale four times.

## Verification

`.github/pull_request_template.md` exists on the fix commit, and its sections match AGENTS.md's list. This is a repository-configuration file, so there is no language test. The guard is AGENTS.md's PR rule, which now has a file to point at again.
