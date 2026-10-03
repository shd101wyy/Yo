# `yo doc --help` omits the implemented `--version` flag

**Severity:** S3 — help-text untruth on an agent-facing surface; the flag
exists and works, the help does not list it.

**Status: FIXED 2026-10-03** (was OPEN; found 2026-10-01, agent-loop audit
CLI pass, yo 0.2.47).
`.github/instructions/documentation.instructions.md` documents
`yo doc --version v1.0.0`, the flag parses (`yo doc --version` →
`yo: error: doc: --version requires a value`), and `--help` lists
`--logo`/`--favicon` but not `--version`.

## Symptom

```
$ yo doc --help
  --logo <path>             Image shown in the sidebar header
  --favicon <path>          Site icon
  (no --version line)

$ yo doc --version v1.0.0   # works
```

## Root cause (narrowed, not fixed)

The flag was added to the option loop in `src/doc_command.yo`/`src/main.yo`
without its `--help` entry; the `help-doc` cli-case golden pins the
helpless text, so the omission is invisible to CI.

## Fix direction

Add the `--version <v> — release version (auto-detects from git if
omitted)` line to the help text (both languages via `tr(...)`) and re-record
the `help-doc` golden. Per the help-truth plan
(`plans/backlog/LLM_AUTHORING_AUDIT_2026-09-19.md` §3.5) the goldens exist
to catch exactly this drift — the review step missed it because the golden
was recorded after the flag landed without its entry.

## Fixed

The flag's arms live in `src/main.yo`'s `run_doc` option loop (`--version
<v>` / `--version=<v>`) and in the unknown-option usage string, but the
`_subcommand_help_text` "doc" entry's `tr(...)` blocks (en + zh-CN) never
got the line, and `tests/cli-cases/help-doc/expected_stdout` pinned the
helpless text, so CI could not see the drift. Fix: one line in each
language block of `src/main.yo` — `--version <v>  Release version
(auto-detects from git if omitted)` / `发布版本（省略时从 git 自动检测）`,
placed between `--title` and `--logo` — plus the matching one-line
`help-doc` golden re-record (hand-edited first, then verified
byte-identical to the harness's own `--record` output). Test evidence:
`scripts/cli-diff-test.sh help-doc` was GOLDEN-DIFF (missing line) with the
pre-fix binary and PASS after the rebuild; `help-top-level` (the only other
golden citing this help) stayed PASS; `YO_LANG=zh-CN yo doc --help` prints
the zh line. No parser change — the flag already worked. A sibling drift
found during the fix is filed separately as
`issues/yo-doc-name-flag-documented-but-the-cli-has-no-such-flag.md` (docs
invent a `--name` flag). Fixed 2026-10-03, branch `s3/batch-1-fixes`.
