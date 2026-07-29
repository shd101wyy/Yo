#!/bin/bash
# measure_one.sh — honest single-file measurement (same rules as hollow_sweep69.sh).
#   BIN=/tmp/xxx_s1 T=tests/comptime.test.yo TAG=cf scratchpad/measure_one.sh
# NEVER run two of these concurrently against the same directory: the batch
# artifacts (.yo_selftest_batch_*) live next to the test file and collide.
set -u
cd /Users/yiyiwang/Workspace/Yo || exit 2
BIN="${BIN:-/tmp/diag11_s1}"
T="${T:-tests/comptime.test.yo}"
TAG="${TAG:-m1}"
TIMEOUT_S="${TIMEOUT_S:-900}"
d=$(dirname "$T"); n=$(echo "$T" | tr '/' '_')
rm -f "$d"/.yo_selftest_batch_*
YO_KEEP_BATCH=1 timeout "$TIMEOUT_S" "$BIN" test "$T" --parallel 1 > "/tmp/${TAG}_${n}.log" 2>&1
rc=$?
hollow=NA; markers=NA
batch_cs=$(ls "$d"/.yo_selftest_batch_*.bin.c 2>/dev/null)
if [ -n "$batch_cs" ]; then
  markers=$(cat $batch_cs | grep -c 'Failed to transpile\|Unknown type:')
  hollow=0
  for c in $batch_cs; do
    if sed -n '/^void __yo_user_main() {/,/^}/p' "$c" | grep -q 'Failed to transpile'; then hollow=1; fi
  done
  for c in $batch_cs; do cp "$c" "/tmp/${TAG}_${n}.batch.c"; done
fi
summary=$(grep -oE '[0-9]+ (passed|failed)' "/tmp/${TAG}_${n}.log" | tail -2 | tr '\n' ' ')
echo "$T rc=$rc hollow=$hollow markers=$markers ${summary:-none}"
