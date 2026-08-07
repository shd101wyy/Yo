#!/bin/bash
# hollow_sweep69.sh — full 183-file sweep that scores a test file HONESTLY:
# a file counts as GREEN only if it exits 0 AND its emitted batch `main` is not
# a `// Failed to transpile` comment. See issues/retired/yo-self-hollow-test-batch-main.md
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
# `-prune` on tests/internal: those 58 files are the compiler's OWN tests (they
# were yo-self/tests until 2026-08-05, and landed under tests/ in the same move).
# Each one compiles the whole compiler — minutes and gigabytes apiece — so without
# this prune the sweep silently grows from the language corpus to ~4x the runtime.
# Run them with scripts/bootstrap/ or `test ./tests/internal` deliberately instead.
for t in $(find tests -path tests/internal -prune -o -name '*.test.yo' -print | sort); do
  grep -q "^$t " "$RESULTS" && continue
  d=$(dirname "$t"); n=$(echo "$t" | tr '/' '_')
  # Remove STALE batch artifacts from the PREVIOUS file first — the marker
  # count below globs the directory, and a leftover batch .c from another
  # test file phantom-hollowed clean files (the sweep previously read a
  # HARDCODED batch_1.bin.c, which for some files was the prior file's).
  rm -f "$d"/.yo_selftest_batch_*
  YO_KEEP_BATCH=1 timeout "$TIMEOUT_S" "$BIN" test "$t" --parallel 1 > "$OUT/$n.log" 2>&1
  rc=$?
  hollow=NA; markers=NA
  batch_cs=$(ls "$d"/.yo_selftest_batch_*.bin.c 2>/dev/null)
  if [ -n "$batch_cs" ]; then
    markers=$(cat $batch_cs | grep -c 'Failed to transpile\|Unknown type:')
    hollow=0
    for c in $batch_cs; do
      if sed -n '/^void __yo_user_main() {/,/^}/p' "$c" | grep -q 'Failed to transpile'; then hollow=1; fi
    done
  fi
  summary=$(grep -oE '[0-9]+ passed' "$OUT/$n.log" | tail -1)
  if [ "$rc" -eq 0 ] && [ "$hollow" = "0" ]; then verdict=GREEN
  elif [ "$rc" -eq 0 ] && [ "$hollow" = "1" ]; then verdict=HOLLOW
  elif [ "$rc" -eq 0 ] && [ "$hollow" = "NA" ]; then verdict=GREEN_NOBATCH
  else verdict=RED; fi
  echo "$t $verdict rc=$rc hollow=$hollow markers=$markers ${summary:-none}" >> "$RESULTS"
done
echo "SWEEP_DONE" >> "$RESULTS"
