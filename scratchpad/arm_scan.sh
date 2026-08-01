#!/bin/bash
# arm_scan.sh — run each single-arm subset in a directory and report
# rc + hollow + markers per arm. Sequential (batch artifacts collide).
#   BIN=/tmp/s1fam DIR=scratchpad/gd2 N=53 bash scratchpad/arm_scan.sh
set -u
cd /Users/yiyiwang/Workspace/Yo || exit 2
BIN="${BIN:-/tmp/s1fam}"
DIR="${DIR:-scratchpad/gd2}"
N="${N:-53}"
for i in $(seq 0 "$N"); do
  f="$DIR/a$i.test.yo"
  [ -f "$f" ] || continue
  rm -f "$DIR"/.yo_selftest_batch_*
  YO_KEEP_BATCH=1 timeout 300 "$BIN" test "$f" --parallel 1 > "/tmp/arm_${i}.log" 2>&1
  rc=$?
  hollow=0; markers=0
  for c in "$DIR"/.yo_selftest_batch_*.bin.c; do
    [ -f "$c" ] || continue
    m=$(grep -c 'Failed to transpile\|Unknown type:' "$c")
    markers=$((markers + m))
    if sed -n '/^void __yo_user_main() {/,/^}/p' "$c" | grep -q 'Failed to transpile'; then hollow=1; fi
  done
  echo "arm$i rc=$rc hollow=$hollow markers=$markers"
done
