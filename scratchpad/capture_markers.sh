#!/bin/bash
# capture_markers.sh — for each failing test file, run it under $BIN with
# YO_KEEP_BATCH=1 and SAVE the emitted batch .c files into $OUT so that many
# root-cause agents can read the evidence concurrently WITHOUT re-running
# anything (batch artifacts land in the test file's own directory, so parallel
# runs in one directory clobber each other — hence this serial capture).
#
# Usage: BIN=/tmp/s1_beginfix OUT=/tmp/markers LIST=/tmp/failing.txt scratchpad/capture_markers.sh
# Resumable: files already recorded in $OUT/index.txt are skipped.
set -u
BIN="${BIN:-/tmp/s1_beginfix}"
OUT="${OUT:-/tmp/markers}"
LIST="${LIST:-/tmp/failing.txt}"
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
  YO_MAIN_STACK_MB=4096 YO_KEEP_BATCH=1 timeout "$TIMEOUT_S" "$BIN" test "$t" --parallel 1 \
    > "$OUT/$n.log" 2>&1
  rc=$?
  markers=0; hollow=NA; saved=0
  for c in "$d"/.yo_selftest_batch_*.bin.c; do
    [ -e "$c" ] || continue
    cp "$c" "$OUT/$n.$(basename "$c")"
    saved=$((saved + 1))
    markers=$((markers + $(grep -c 'Failed to transpile\|Unknown type:' "$c")))
    if [ "$hollow" = "NA" ]; then hollow=0; fi
    if sed -n '/^void __yo_user_main() {/,/^}/p' "$c" | grep -q 'Failed to transpile'; then hollow=1; fi
  done
  rm -f "$d"/.yo_selftest_batch_*
  echo "$t rc=$rc hollow=$hollow markers=$markers saved=$saved" >> "$INDEX"
  echo "$t rc=$rc hollow=$hollow markers=$markers saved=$saved"
done < "$LIST"

echo "CAPTURE_DONE" >> "$INDEX"
