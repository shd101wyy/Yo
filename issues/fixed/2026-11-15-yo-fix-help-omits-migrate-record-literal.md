# `yo fix --help` does not list `--migrate record-literal`, the one migration v0.2.78 users need

**Severity:** S3 — a user hit by brace Gen B's E0007 who reads `yo fix --help` finds no `record-literal` mode and is told "the other migrations were retired".

Found by the expref pass-4-pre sweep (develop c187fd16a, 2026-11-15).

## Observed

`yo fix --help` (src/main.yo, the `"fix"` help entry near line 10570) lists only
`--migrate deref` and `--migrate unsized`, and the `deref` paragraph says "The other
migrations were retired; the last release that ships each is listed in
docs/en-US/ERROR_DIAGNOSTICS.md". Yet the argument parser accepts
`deref|record-literal|unsized` (src/main.yo ~2094, and the usage string at ~2069/2110
spells all three), E0007's registry text points users at
`yo fix <path> --migrate record-literal`, and ERROR_DIAGNOSTICS.md line ~258 says
deref and record-literal "are the two modes this release ships".

```bash
yo fix --help | grep -c record-literal   # 0
cd raylib-yo && yo fix build.yo --migrate record-literal --dry-run
# fix: would rewrite 6 record literal(s) to `.{ ... }`; 0 file(s) did not parse
```

## Expected

A `--migrate record-literal` entry in the en and zh-CN help text (e.g. "write every
expression-position bare `{ … }` record as `.{ … }` (brace Gen B, E0007)"), and the
"other migrations were retired" sentence moved so it does not read as covering it.

## Test

A cli-diff case (`tests/cli-cases/fix-help`, `fix-help-zh`) that
`yo fix --help` names every value the `--migrate` parser accepts.

## Fix

`yo fix --help` (`src/main.yo`, the `"fix"` help entry, en and zh-CN) lists
`--migrate record-literal` with a one-line description, and the "retired
migrations" sentence is now its own paragraph after the last mode, so it does not
read as covering a live mode. The listed modes (`deref`, `record-literal`,
`unsized`) are exactly the three the `--migrate` parser accepts; nothing retired
is listed. The same stale count in `docs/{en-US,zh-CN}/ERROR_DIAGNOSTICS.md`
("the two modes this release ships") now says three.

The tests are the cli cases `tests/cli-cases/fix-help` and `fix-help-zh`
(`yo fix --help`, English and `YO_LANG=zh-CN`), whose goldens name every mode.
