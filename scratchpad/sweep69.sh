#!/bin/bash
# sweep69.sh — full #69 sweep: run <S1> test over every test file recorded in
# the baseline results list, one file at a time, resumable (skips files that
# already have a result line in $OUT/results.txt).
#
# Usage: S1=/tmp/d9_s2bin OUT=/tmp/sweep69_d9 scratchpad/sweep69.sh
# The file list comes from the previous sweep's results.txt (183 files) so
# baselines stay comparable; override LIST= to change it.

set -u
S1="${S1:-/tmp/s2}"
OUT="${OUT:-/tmp/sweep69_run}"
LIST="${LIST:-/tmp/sweep69_final/results.txt}"
TIMEOUT_S="${TIMEOUT_S:-900}"

mkdir -p "$OUT"
RESULTS="$OUT/results.txt"
touch "$RESULTS"

files=$(awk '{print $2}' "$LIST" | grep '\.test\.yo$' | sort -u)

for f in $files; do
  # resumable: skip if already recorded
  if grep -q " $f " "$RESULTS"; then continue; fi
  log="$OUT/$(echo "$f" | tr '/' '_').log"
  start=$(date +%s)
  ( cd "$(dirname "$0")/.." && exec "$S1" test "./$f" --parallel 1 ) &> "$log" &
  pid=$!
  ( sleep "$TIMEOUT_S"; kill -9 "$pid" 2>/dev/null ) &
  watchdog=$!
  wait "$pid"; rc=$?
  kill "$watchdog" 2>/dev/null; wait "$watchdog" 2>/dev/null
  dur=$(( $(date +%s) - start ))
  passed=$(grep -Eo '[0-9]+ passed' "$log" | tail -1)
  if [ "$rc" -eq 0 ]; then
    echo "GREEN $f rc=$rc $passed dur=${dur}s" >> "$RESULTS"
  else
    echo "RED   $f rc=$rc $passed dur=${dur}s" >> "$RESULTS"
  fi
done

echo "=== sweep done ==="
echo "GREEN: $(grep -c '^GREEN' "$RESULTS") / $(wc -l < "$RESULTS" | tr -d ' ')"
