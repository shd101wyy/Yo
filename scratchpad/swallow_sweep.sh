#!/bin/bash
# swallow_sweep.sh — run a DIAGNOSTIC s1 (built with eprintln probes at the three
# def-time swallow sites) over a list of test files and record, per file, the
# error messages that were SWALLOWED. For a HOLLOW file the batch marker is the
# whole dispatch expression and says nothing about which arm failed; the
# swallowed error names the actual root cause.
#
# The diagnostic binary must carry:
#   __DBG_W  — evaluator/exprs/_expr.yo catch-all (note_def_time_swallow site)
#   __DBG_F  — evaluator/calls/function_type.yo  _trial_eval_fn_body inner_exn
#   __DBG_A  — evaluator/values/anonymous_function.yo inner_exn (x2)
#
# Usage: BIN=/tmp/s1_swal OUT=/tmp/swal LIST=/tmp/hollow.txt scratchpad/swallow_sweep.sh
# Resumable: files already in $OUT/index.txt are skipped.
set -u
BIN="${BIN:-/tmp/s1_swal}"
OUT="${OUT:-/tmp/swal}"
LIST="${LIST:-/tmp/hollow.txt}"
TIMEOUT_S="${TIMEOUT_S:-1200}"
cd /Users/yiyiwang/Workspace/Yo || exit 2
mkdir -p "$OUT"
INDEX="$OUT/index.txt"
touch "$INDEX"

while read -r t; do
  [ -z "$t" ] && continue
  grep -q "^$t " "$INDEX" && continue
  d=$(dirname "$t"); n=$(echo "$t" | tr '/' '_')
  rm -f "$d"/.yo_selftest_batch_*
  YO_MAIN_STACK_MB=4096 timeout "$TIMEOUT_S" "$BIN" test "$t" --parallel 1 \
    > "$OUT/$n.log" 2>&1
  rc=$?
  rm -f "$d"/.yo_selftest_batch_*
  # Distinct swallowed messages, with counts, first line of each only.
  grep -hoE "__DBG_[WFA] .*" "$OUT/$n.log" 2>/dev/null | sort | uniq -c | sort -rn > "$OUT/$n.swallow"
  ndistinct=$(grep -c . "$OUT/$n.swallow" 2>/dev/null || echo 0)
  echo "$t rc=$rc distinct_swallows=$ndistinct" >> "$INDEX"
  echo "=== $t rc=$rc distinct=$ndistinct"
  head -4 "$OUT/$n.swallow" 2>/dev/null | cut -c1-190
done < "$LIST"

echo "SWALLOW_SWEEP_DONE" >> "$INDEX"
