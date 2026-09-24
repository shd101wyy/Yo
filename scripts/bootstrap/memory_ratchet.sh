#!/bin/bash
# memory_ratchet.sh — the evaluator memory ratchet (plans/EVALUATOR_MEMORY_REDUCTION.md
# Phase 0.6). Runs `check src/main.yo` under GNU time and compares its maximum
# resident set size with the recorded baseline in memory-ratchet.tsv.
#
#   bash scripts/bootstrap/memory_ratchet.sh <yo binary>
#
# Fails BOTH ways (the known-failing.tsv discipline): more than TOL_PCT above the
# baseline is a regression; more than TOL_PCT below means the baseline must be
# lowered in the same PR, so a win cannot be silently given back later. A
# baseline of 0 means "not recorded yet": the run prints the measurement and fails.
#
# Measure a compiler COMPILED BY THIS TREE (CI: the bootstrap-fixpoint stage-2
# binary). A seed-built stage 1 carries the previous release's codegen — the
# 2026-09-24 argument-temp leak lived in codegen and was 3 GB of this number.
# Linux only: max RSS is honest there (no memory compressor); macOS needs
# phys_footprint instead (see the plan's §0.3).
set -u
BIN="${1:?usage: memory_ratchet.sh <yo binary>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
TSV="$HERE/memory-ratchet.tsv"
KEY="check_src_main_max_rss_kb"
TOL_PCT="${TOL_PCT:-10}"
base=$(awk -v k="$KEY" '$1 == k { print $2 }' "$TSV")
if [ -z "$base" ]; then
  echo "FAIL: no '$KEY' row in $TSV"
  exit 1
fi
log=$(mktemp)
/usr/bin/time -v "$BIN" check src/main.yo --std-path ./std > "$log.out" 2> "$log"
rc=$?
if [ $rc -ne 0 ]; then
  echo "FAIL: check src/main.yo exited $rc"
  tail -40 "$log.out" "$log"
  exit 1
fi
rss=$(awk -F': ' '/Maximum resident set size/ { print $2 }' "$log")
wall=$(awk -F': ' '/Elapsed \(wall clock\)/ { print $2 }' "$log")
echo "check src/main.yo: max RSS ${rss} kB ($(( rss / 1024 )) MB), wall ${wall}; baseline ${base} kB, tolerance ±${TOL_PCT}%"
if [ "$base" -eq 0 ]; then
  echo "FAIL: baseline not recorded yet — set '$KEY' in scripts/bootstrap/memory-ratchet.tsv to ${rss}"
  exit 1
fi
hi=$(( base * (100 + TOL_PCT) / 100 ))
lo=$(( base * (100 - TOL_PCT) / 100 ))
if [ "$rss" -gt "$hi" ]; then
  echo "FAIL: memory regression — ${rss} kB > ${hi} kB (baseline ${base} kB + ${TOL_PCT}%)."
  echo "      Find the new retention before merging (scripts/bootstrap/heap_walk_census_t.py,"
  echo "      alloc_site_census_t.py); raise the baseline only for a deliberate, explained cost."
  exit 1
fi
if [ "$rss" -lt "$lo" ]; then
  echo "FAIL: memory improved beyond the ratchet — ${rss} kB < ${lo} kB. Lower '$KEY' in"
  echo "      scripts/bootstrap/memory-ratchet.tsv to ${rss} in this PR so the win is kept."
  exit 1
fi
echo "PASS: within ±${TOL_PCT}% of the baseline"
