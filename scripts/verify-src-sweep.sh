#!/usr/bin/env bash
# The self-verification sweep (plans/SELF_VERIFICATION.md, M0).
#
# Runs `yo verify` over a tree, writes a deterministic `outcomes.tsv`, prints
# the outcome and blocker tables, and — unless --no-ratchet — fails when the
# per-module count of functions that discharged at least one obligation DROPS
# below the recorded baseline, or when anything is refuted.
#
# The ratchet direction matters: this measures the compiler becoming more
# verified over time. A RISE prints the new numbers and tells you to re-record
# deliberately (the known-failing.tsv pattern) rather than moving the baseline
# silently.
#
#   scripts/verify-src-sweep.sh                     # sweep ./src, ratchet on
#   scripts/verify-src-sweep.sh --record            # re-record the baseline
#   scripts/verify-src-sweep.sh --path ./std/spec   # sweep something else
#   YO=/tmp/yo-s1/bin/yo scripts/verify-src-sweep.sh
#
# Env: YO (the binary, default `yo`), OUT (output dir, default
# `yo-out/verify-sweep`), YO_Z3_PATH (passed through to the solver harness).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 2

YO="${YO:-yo}"
OUT="${OUT:-yo-out/verify-sweep}"
BASELINE="${BASELINE:-scripts/bootstrap/verify-src-baseline.tsv}"
TARGET="./src"
RECORD=0
RATCHET=1

while [ $# -gt 0 ]; do
  case "$1" in
    --record) RECORD=1; shift ;;
    --no-ratchet) RATCHET=0; shift ;;
    --path) TARGET="$2"; shift 2 ;;
    --baseline) BASELINE="$2"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "verify-src-sweep: unknown option '$1'" >&2; exit 2 ;;
  esac
done

mkdir -p "$OUT"
RAW="$OUT/report.json"
TSV="$OUT/outcomes.tsv"

echo "verify-src-sweep: $YO verify $TARGET  (out: $OUT)"
START=$(date +%s)
# `yo verify` prints check progress on stdout before the JSON object; the
# extractor below takes the report from the first `{"solver"` onward.
"$YO" verify "$TARGET" --format json --std-path ./std > "$RAW" 2>"$OUT/stderr.log"
RC=$?
ELAPSED=$(( $(date +%s) - START ))

if ! grep -q '{"solver"' "$RAW"; then
  echo "verify-src-sweep: FAILED — no JSON report in $RAW (rc=$RC)" >&2
  tail -20 "$OUT/stderr.log" >&2
  exit 2
fi

python3 scripts/verify_sweep_report.py \
  --report "$RAW" --tsv "$TSV" --baseline "$BASELINE" \
  --elapsed "$ELAPSED" --record "$RECORD" --ratchet "$RATCHET"
exit $?
