#!/bin/bash
# hollow_sweep69.sh — full 183-file sweep that scores a test file HONESTLY:
# a file counts as GREEN only if it exits 0 AND its emitted batch `main` is not
# a `// Failed to transpile` comment. See issues/yo-self-hollow-test-batch-main.md
# (a hollow main runs no assertions, so the harness reports every test as passed).
#
# Usage: BIN=/tmp/xxx_s1 OUT=/tmp/hsweep scratchpad/hollow_sweep69.sh
# Resumable: files already in $OUT/results.txt are skipped.
set -u
BIN="${BIN:-/tmp/drop_s1}"
OUT="${OUT:-/tmp/hsweep}"
TIMEOUT_S="${TIMEOUT_S:-900}"
mkdir -p "$OUT"
RESULTS="$OUT/results.txt"
touch "$RESULTS"
for t in $(find tests -name '*.test.yo' | sort); do
  grep -q "^$t " "$RESULTS" && continue
  d=$(dirname "$t"); n=$(echo "$t" | tr '/' '_')
  YO_KEEP_BATCH=1 timeout "$TIMEOUT_S" "$BIN" test "$t" --parallel 1 > "$OUT/$n.log" 2>&1
  rc=$?
  c="$d/.yo_selftest_batch_1.bin.c"
  hollow=NA; markers=NA
  if [ -f "$c" ]; then
    markers=$(grep -c 'Failed to transpile\|Unknown type:' "$c")
    if sed -n '/^void __yo_user_main() {/,/^}/p' "$c" | grep -q 'Failed to transpile'; then hollow=1; else hollow=0; fi
  fi
  summary=$(grep -oE '[0-9]+ passed' "$OUT/$n.log" | tail -1)
  if [ "$rc" -eq 0 ] && [ "$hollow" = "0" ]; then verdict=GREEN
  elif [ "$rc" -eq 0 ] && [ "$hollow" = "1" ]; then verdict=HOLLOW
  elif [ "$rc" -eq 0 ] && [ "$hollow" = "NA" ]; then verdict=GREEN_NOBATCH
  else verdict=RED; fi
  echo "$t $verdict rc=$rc hollow=$hollow markers=$markers ${summary:-none}" >> "$RESULTS"
done
echo "SWEEP_DONE" >> "$RESULTS"
