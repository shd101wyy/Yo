# `yo unsafe-report` and `yo public-safe-report` take an unknown `--flag` as the path

**Severity:** S3 — a mistyped option is reported as "path does not exist: --flag" instead of "unknown option", and `--flag path` reports "one path per run" naming the flag as a path; the run still fails, so there is no false green.

**Status:** open. Filed from the Deferred section of #2088.

## Reproducer

```bash
mkdir -p tmp/p
yo unsafe-report --bogus
yo public-safe-report --json --bogus
yo unsafe-report --bogus tmp/p
```

Verbatim output (tree-built binary at `v0.2.79`, before #2088's extra-positional check landed; rc 1 each):

```text
$ yo unsafe-report --bogus
unsafe-report: path does not exist: --bogus
yo: error: unsafe-report: path does not exist
$ yo public-safe-report --json --bogus
public-safe-report: path does not exist: --bogus
yo: error: public-safe-report: path does not exist
```

On current `develop` the first two print the same. The third (`--bogus tmp/p`) fails with
`unsafe-report: one path per run, got '--bogus' and 'tmp/p'. Usage: yo unsafe-report [path] [--json]`,
which calls the flag a path as well. `yo unsafe-report tmp/p --bogus` reports the same "one path per run", with the flag as the second path.

The failure is loud in every case (rc 1), so this is never a false green: the defect is the diagnostic.

## Root cause

`run_unsafe_report_cmd` and `run_public_safe_report_cmd` in `src/main.yo` have an argument loop with only two arms: `arg == "--json"`, then a catch-all `true =>` that assigns `target = arg` (after #2088, a `target_seen` arm that throws "one path per run"). Neither loop has the arm every sibling command has, `a.starts_with("-") => exn.throw(... "unknown option ...")` (`effects`, `check`, `compile`, `test`, `verify`, `fix`). So an unrecognized `--flag` becomes the target, and the later `exists` check reports it as a missing path.

## Fix and test

Add the `arg.starts_with("-")` arm before the positional arm in both loops, throwing
`unsafe-report: unknown option '<arg>'. Usage: yo unsafe-report [path] [--json]` (and the `public-safe-report` twin). Add two cli-cases under `tests/cli-cases/` (`unsafe-report-unknown-option`, `public-safe-report-unknown-option`), each running the command with `--bogus` and with `--bogus <existing-dir>`, recording rc 1 and the "unknown option" message. They fail before the fix (the message is "path does not exist" / "one path per run") and pass after. Record them with `scripts/cli-diff-test.sh --record` and read the goldens first.
