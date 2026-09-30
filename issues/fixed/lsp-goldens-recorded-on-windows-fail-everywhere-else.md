# Four LSP cli-case goldens recorded on Windows fail on every other machine

**Severity:** S3 — `tests/cli-cases` fails for four LSP cases on macOS and Linux (and so `gates_fast`'s CLI scorecard), from develop `484ab2617` on

**Status:** FIXED 2026-09-30.
**Found:** the type-soundness stack's local battery on develop `5101639ad`: `lsp-lifecycle`,
`lsp-navigation`, `lsp-semantic-tokens` and `lsp-workspace` diffed. Develop's own CI had not
scored them yet (the run on `484ab2617` was cancelled when a newer push superseded it).

## Measured

| Case | Diff |
| --- | --- |
| `lsp-lifecycle`, `lsp-navigation`, `lsp-semantic-tokens`, `lsp-workspace` | project tree: `only-in-golden: ./.gitkeep` |
| `lsp-lifecycle` | HOME tree: `only-in-golden:` (an empty entry) |
| `lsp-workspace` | stdout: a diagnostic's `relatedInformation` URI is `file:///C%3A/Users/shd10/Workspace/Yo-wt/lsp-audit/std/fmt/index.yo`, where the run has `file://<REPO>/std/fmt/index.yo`, and the frame header before it is `Content-Length: 548` instead of 511 |

## Root cause

- The goldens hash a `fixture/.gitkeep` that was never committed. Git does not keep an empty
  directory, so every other checkout has no fixture file.
- The empty home tree was recorded as a lone newline; an empty tree is a 0-byte file.
- `scripts/cli-diff-test.sh` normalizes the repository root by substituting `$REPO_ROOT`
  literally. On Windows that is `C:/Users/...`, but an LSP reply spells it as a file URI with
  the colon percent-encoded, `file:///C%3A/Users/...` (the drive letter is sometimes lowercase).
  The substitution never matched, and the recorder's path went into the golden.

## Fix

- The four `fixture/.gitkeep` files are committed.
- `normalize_stream` also rewrites both URI spellings of a drive-letter root, with the path's
  leading `/`, so `file:///C%3A/...` normalizes to `file://<REPO>/...` exactly as a POSIX root
  does. The variables are empty on a POSIX root, so macOS and Linux are unchanged.
- `lsp-lifecycle` and `lsp-workspace` are re-recorded on macOS.

## Test

The four cases pass on macOS. The drive-letter rewrite was checked by hand under bash:
`C:/Users/shd10/Workspace/Yo-wt/lsp-audit` turns
`file:///C%3A/Users/shd10/Workspace/Yo-wt/lsp-audit/std/fmt/index.yo` (and its `c%3A` form)
into `file://<REPO>/std/fmt/index.yo`. It has not been run on a Windows machine.
