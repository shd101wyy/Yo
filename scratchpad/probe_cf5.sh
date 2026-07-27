#!/bin/bash
# cf5 probe harness: compile+run each probe, count hollow markers in the C.
# A probe is GREEN only if compile_rc=0, run_rc=0, AND markers==0.
set -u
S1="${1:-/tmp/cf5_s1}"
cd /Users/yiyiwang/Workspace/Yo || exit 2
for r in /tmp/imm_map_probe_b.yo /tmp/imm_set_probe.yo /tmp/imm_sortedmap_probe.yo issues/repros/arc-spawn-capture-split.yo issues/repros/rc-array-tuple-dup-elision.yo; do
  n=$(basename "$r" .yo)
  out="/tmp/cf5_${n}"
  timeout 900 "$S1" compile "$r" --release -o "$out" &> "${out}.log"
  rc=$?
  markers=$(grep -c "Failed to transpile\|Unknown type:" "${out}.c" 2>/dev/null || echo "?")
  runout="skip"
  [ $rc -eq 0 ] && runout=$("$out" &> /dev/null; echo "run_rc=$?")
  echo "$n compile_rc=$rc markers=$markers $runout"
done
