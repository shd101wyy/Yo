# The kebab rename left every corpus golden under its old name

**Severity:** S2. Develop's battery goes red on the v0.2.79 release candidate:
tier-1 GATE 2 (corpus golden scoring) finds no golden for any of the 150
`tests/codegen-bootstrap/*.yo` programs, so the release gate (a green battery on
the exact tip) cannot be met.

**Status: FIXED 2026-11-21.** The 150 goldens are renamed to their programs' kebab names.

## What happened

Develop run 44757876591 (cc95ab2d7, #2016), job `Self-hosted test subcommand
(yo-self tier-1 gates)`, `ci_corpus.log`:

```
  NO-GOLDEN  tests/codegen-bootstrap/argv-string-list.yo  (no golden — record with --record)
  ...
PASS 0  GOLDEN-DIFF 0  NO-GOLDEN 150  (total 150)
```

## Root cause

#2016 (Part C, kebab-case module file names) renamed the corpus programs, for
example `while_loop_io.yo` to `while-loop-io.yo`. `scripts/diff-test.sh` finds a
program's golden at `goldens/<program file name>.golden`, but the files under
`tests/codegen-bootstrap/goldens/` kept their snake_case names
(`while_loop_io.yo.golden`). The rename only touches `.yo` files and
directories, and a `.golden` is neither. The tier-1 battery the rename lane ran
locally did not include the corpus scoring in golden mode, so nothing caught it
before the merge.

## Fix

Every `goldens/<snake>.yo.golden` is renamed to `goldens/<kebab>.yo.golden`. The
mapping is one-to-one: 150 goldens and 150 programs, with no orphans and no
program left without a golden. The contents are unchanged. The test is the gate
itself: before the fix it reports `PASS 0 NO-GOLDEN 150`, and after it, scored
with the cc95ab2d7 compiler, it reports every program as PASS.
