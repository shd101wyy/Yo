#!/bin/bash
BIN=${BIN:-/tmp/drop_s1}
OUT=${OUT:-/tmp/hollow_battery.txt}
: > "$OUT"
for t in "$@"; do
  d=$(dirname "$t"); n=$(basename "$t" .test.yo)
  YO_KEEP_BATCH=1 timeout 1200 "$BIN" test "$t" --parallel 1 > "/tmp/hs_${n//\//_}.log" 2>&1
  rc=$?
  c="$d/.yo_selftest_batch_1.bin.c"
  if [ -f "$c" ]; then
    m=$(grep -c 'Failed to transpile\|Unknown type:' "$c")
    ml=$(sed -n '/^void __yo_user_main() {/,/^}/p' "$c" | wc -l | tr -d ' ')
    mainhollow=$(sed -n '/^void __yo_user_main() {/,/^}/p' "$c" | grep -c 'Failed to transpile')
  else
    m=NA; ml=NA; mainhollow=NA
  fi
  summary=$(grep -oE '[0-9]+ passed' "/tmp/hs_${n//\//_}.log" | tail -1)
  echo "$t rc=$rc markers=$m main_lines=$ml main_hollow=$mainhollow ${summary:-no-summary}" >> "$OUT"
done
echo DONE >> "$OUT"
