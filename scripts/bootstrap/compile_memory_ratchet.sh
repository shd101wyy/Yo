#!/bin/bash
# compile_memory_ratchet.sh — the "builds on an 8 GB machine" claim, tested and
# ratcheted (plans/archive/BUILD_ON_8GB_MACHINES.md Phase 4).
#
#   bash scripts/bootstrap/compile_memory_ratchet.sh <yo binary>
#
# Compiles src/main.yo the way `yo build` does, C compiler included, inside a
# systemd scope capped at LIMIT (default 8G) with swap forbidden, and reads the
# scope's cgroup `memory.peak`. That figure is every process in the tree
# together. GNU time's "maximum resident set size" cannot stand in for it: on
# Linux `wait4` reports the largest SINGLE image or descendant, so the pre-fix
# layout (a 6.6 GB `yo compile` waiting on a 3.1 GB clang) measured as 6.6 GB
# while the machine needed 9.7.
#
# Two verdicts:
#   * the build must finish inside LIMIT (an OOM kill fails the job, whatever
#     the baseline says);
#   * the peak is compared with `compile_src_main_peak_kb` in
#     memory-ratchet.tsv, failing BOTH ways at TOL_PCT (the check-row
#     discipline: an unrecorded win fails too, so it cannot be given back).
#
# Linux only (cgroup v2 + systemd); needs passwordless sudo for
# `systemd-run --scope`. Measure a compiler COMPILED BY THIS TREE (CI: the
# bootstrap-fixpoint stage-2 binary), for the reason memory_ratchet.sh gives.
set -u
BIN="${1:?usage: compile_memory_ratchet.sh <yo binary>}"
BIN="$(cd "$(dirname "$BIN")" && pwd)/$(basename "$BIN")"
HERE="$(cd "$(dirname "$0")" && pwd)"
TSV="$HERE/memory-ratchet.tsv"
KEY="compile_src_main_peak_kb"
TOL_PCT="${TOL_PCT:-10}"
LIMIT="${LIMIT:-8G}"
base=$(awk -v k="$KEY" '$1 == k { print $2 }' "$TSV")
if [ -z "$base" ]; then
  echo "FAIL: no '$KEY' row in $TSV"
  exit 1
fi
out=$(mktemp -d)
chmod 777 "$out"
start=$(date +%s)
# The inner shell reads its OWN cgroup's counters before it exits, while the
# scope still exists. HOME is forwarded for the dependency store.
sudo systemd-run --scope --quiet -p MemoryMax="$LIMIT" -p MemorySwapMax=0 \
  env HOME="$HOME" YO_MAIN_STACK_MB=4096 sh -c '
    "$1" compile src/main.yo --std-path ./std --optimize 2 -o "$2/yo-built" > "$2/log" 2>&1
    rc=$?
    cg=$(cut -d: -f3 /proc/self/cgroup)
    cat "/sys/fs/cgroup$cg/memory.peak" > "$2/peak"
    awk "\$1 == \"oom_kill\" { print \$2 }" "/sys/fs/cgroup$cg/memory.events" > "$2/oom"
    exit $rc
  ' sh "$BIN" "$out"
rc=$?
wall=$(( $(date +%s) - start ))
peak_b=$(cat "$out/peak" 2>/dev/null || echo 0)
peak=$(( peak_b / 1024 ))
oom=$(cat "$out/oom" 2>/dev/null || echo "?")
echo "compile src/main.yo (C compiler included) under a ${LIMIT} no-swap cgroup: rc=${rc}, peak ${peak} kB ($(( peak / 1024 )) MB), oom_kill=${oom}, wall ${wall}s; baseline ${base} kB, tolerance ±${TOL_PCT}%"
if [ "$rc" -ne 0 ] || [ "$oom" != "0" ]; then
  echo "FAIL: the build did not finish inside ${LIMIT} without swap"
  tail -40 "$out/log"
  exit 1
fi
if ! "$out/yo-built" --version > /dev/null 2>&1; then
  echo "FAIL: the compiler built under the limit does not run"
  exit 1
fi
if [ "$base" -eq 0 ]; then
  echo "FAIL: baseline not recorded yet — set '$KEY' in scripts/bootstrap/memory-ratchet.tsv to ${peak}"
  exit 1
fi
hi=$(( base * (100 + TOL_PCT) / 100 ))
lo=$(( base * (100 - TOL_PCT) / 100 ))
if [ "$peak" -gt "$hi" ]; then
  echo "FAIL: build memory regression — ${peak} kB > ${hi} kB (baseline ${base} kB + ${TOL_PCT}%)."
  echo "      Find it before merging; raise the baseline only for a deliberate, explained cost."
  exit 1
fi
if [ "$peak" -lt "$lo" ]; then
  echo "FAIL: build memory improved beyond the ratchet — ${peak} kB < ${lo} kB. Lower '$KEY' in"
  echo "      scripts/bootstrap/memory-ratchet.tsv to ${peak} in this PR so the win is kept."
  exit 1
fi
echo "PASS: within ±${TOL_PCT}% of the baseline, and inside ${LIMIT}"
