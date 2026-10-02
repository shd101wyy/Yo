# `yo fmt --check <dir>` walks gitignored generated dot-files and false-reds a clean checkout

> **FIXED 2026-10-02.** `collect_yo_files` (src/formatter.yo) skips
> dot-prefixed FILES during the directory walk — every artifact the
> toolchain generates beside sources is dot-prefixed (`.yo_selftest_batch_*`,
> src/main.yo's batch writer). A dot file passed EXPLICITLY as the target is
> still collected: explicit intent wins. Pinned by "collect_yo_files skips
> dot-prefixed files in a directory walk" in `tests/internal/formatter.test.yo`
> (the committed probe `tests/internal/formatter_fixtures/.fmt_walk_ignored.yo`
> has canonical content, so only the membership check can see the skip).

**Severity:** S3 — a local false gate: `yo fmt --check ./tests` reports a
file needing formatting on a checkout whose tracked content is fully
canonical; CI is unaffected (a fresh checkout has no ignored leftovers)

Found 2026-10-02 by the post-#1092 lexer/parser/formatter audit workflow
(the workflow's own `fmt --check ./tests` gate was red on exactly one
gitignored leftover: `tests/cli-cases/build-list-steps/fixture/tests/.yo_selftest_batch_31_0.yo`).

## Root cause

The walker collects every path ending `.yo` and skips only five hardwired
DIRECTORY names (`.git`, `.yo-cache`, `node_modules`, `out`, `yo-out`);
file names were never filtered, so gitignored test-runner batch leftovers
were walked, formatted-checked and reported. Identical on seed v0.2.48
(pre-existing).
