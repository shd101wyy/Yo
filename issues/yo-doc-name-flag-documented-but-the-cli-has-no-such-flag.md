# `yo doc --name` is documented but the CLI has no such flag

**Severity:** S3 — docs untruth on a user-facing reference surface; every
other flag named there is real, so the one invented name erodes the block.

**Status: OPEN.** Found 2026-10-03 while fixing
`issues/fixed/yo-doc-help-omits-the-implemented---version-flag.md` (a
help-truth audit of the same command).

## Symptom

```bash
$ yo doc ./src/lib.yo --name "My Library"
yo: error: doc: unknown option '--name'. Usage: yo doc [path] [-o <dir>] [--title <t>] [--document-private] [-v] [-f html|markdown|json] [--version <v>] [--logo <path>] [--favicon <path>]
```

(rc=1, reproduced 2026-10-03 with the develop-built binary at
`C:/Users/shd10/Workspace/Yo-wt/s3-build/yo-out/x86_64-pc-windows-msvc/bin/yo.exe`.)

## Where the docs lie

`docs/en-US/BUILD_SYSTEM.md` (zh-CN twin one screen below it):

- line 1335 / `docs/zh-CN/BUILD_SYSTEM.md:1303` — the "Other options"
  example block: `yo doc --name "My Library"  # Override project name`
- line 1439 / `docs/zh-CN/BUILD_SYSTEM.md:1405` — the `yo doc` Reference
  Options table: `--name  Project name (default: inferred)`

The parser (`src/main.yo`, the `run_doc` option loop) accepts
`-o/--output`, `--title`, `--document-private`, `-v`, `-f/--format`,
`--version`, `--logo`, `--favicon`, `--std-path` and positionals — there is
no `--name` arm, and the project name comes from the nearest manifest
(`tests/cli-cases/doc-name-from-manifest`). The Reference block is drifted
more broadly than the one invented flag: it also omits `--title`,
`--version`, `--logo`, `--favicon` and `--std-path`, all of which exist.

`--name` IS a real flag of other subcommands (`yo init`, `yo add`), which is
likely how the line was written.

## Fix direction

Correct both languages' example line and Reference table to the real option
set (`--title` is the site-title flag; drop `--name`, add the five missing
flags), or implement `--name` if the name-from-manifest behavior is meant to
be overridable — that is a product call, hence an issue and not a drive-by
edit. Re-check with `yo doc --help` as the oracle once fixed.
