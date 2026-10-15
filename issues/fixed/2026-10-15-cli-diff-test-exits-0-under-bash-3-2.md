# cli-diff-test.sh exits 0 under bash 3.2 having run nothing

**Severity:** S3 — a Tier 1 gate run with macOS's `/bin/bash` reported `cli-diff rc=0` though no case ran: a false green.

**Found:** 2026-10-15, gating #1388 with Apple clang first on `PATH` (for a live ASan). That `PATH` also puts `/bin/bash` 3.2 first.
**Status:** FIXED 2026-10-15.

## Symptom

```text
$ /bin/bash scripts/cli-diff-test.sh; echo $?
scripts/cli-diff-test.sh: line 504: PASS: unbound variable
0
```

## Root cause

The scorecard is an associative array (`declare -A COUNT=( [PASS]=0 … )`),
which bash 3.2 does not have. The `declare` fails and the script stops, but
its last status is 0, so the caller sees success.

## Fix

The script checks `BASH_VERSINFO` right after `set -uo pipefail` and exits 2
with a message under bash 3. `/bin/bash scripts/cli-diff-test.sh` now exits 2,
and the nix bash 5.3 run scores the full suite (PASS 393, SKIP 1).

## Verification

A script check, not a `.yo` test: `/bin/bash scripts/cli-diff-test.sh --help;
echo $?` prints 2 (it printed 0 before), and bash 5 `--help` prints 0.
`testing.instructions.md` ("A use-after-free check on macOS") says to run
`scripts/*.sh` with the nix bash under that `PATH`.
