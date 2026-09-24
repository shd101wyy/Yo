#!/usr/bin/env bash
# Definition-time swallow census (plans/TYPE_SYSTEM_SOUNDNESS.md, Phase 0
# step 3; the metric Phase 6 drives to zero).
#
# `yo check` trial-evaluates bodies at definition time and SWALLOWS what the
# trial throws. Under YO_DEBUG_SWALLOW=1 every swallow is printed:
#   [swallow] <err>          named-fn def-eval trial (calls/function_type.yo)
#   [anon-swallow] <err>     closure-body trial (values/anonymous_function.yo)
#   [mat-default-swallow]    trait `?=` default materialization (values/impl.yo)
# This script runs `check` over each target with the knob on and counts those
# lines by channel and by error code, and lists the distinct messages, so a
# phase can say which swallows it removed.
#
# A swallow is not automatically a bug: a body that cannot be typed until a
# SomeT is resolved at a call is deferred legitimately. The classification
# below is therefore by CODE, and the per-message list is what a reader
# triages; Phase 6 replaces this with the evaluator's own classification.
#
# Usage:
#   YO=<yo binary> OUT=<dir> bash scripts/soundness/swallow-census.sh [target...]
#     target: directories or files to check (default: ./std ./src)
#
# `check ./src` peaks around 10 GB; run it on a quiet machine.

set -uo pipefail

YO=${YO:?set YO to the yo binary under test (a tree-built stage-1, not the seed)}
OUT=${OUT:?set OUT to a results directory}
TARGETS=${*:-./std ./src}
mkdir -p "$OUT"

for t in $TARGETS; do
  name=$(echo "$t" | sed 's#^\./##; s#/#_#g')
  log="$OUT/$name.log"
  YO_DEBUG_SWALLOW=1 "$YO" check "$t" --std-path ./std > "$log" 2>&1
  echo "RC=$?" >> "$log"
  # A swallowed error prints as `[<channel>] error[EXXXX]: <message>` on one
  # line; only that first line is counted (continuation lines carry the
  # source excerpt).
  grep -aE '^\[(swallow|anon-swallow|mat-default-swallow)\]' "$log" > "$OUT/$name.swallows" || true
  total=$(wc -l < "$OUT/$name.swallows" | tr -d ' ')
  echo "== $t: $total swallowed errors ($(tail -1 "$log"))"
  sed -E 's/^\[([a-z-]+)\].*/\1/' "$OUT/$name.swallows" | sort | uniq -c | sort -rn | sed 's/^/   channel /'
  sed -nE 's/^\[[a-z-]+\] (error\[(E[0-9]+)\]|error).*/\2/p' "$OUT/$name.swallows" |
    sed 's/^$/uncoded/' | sort | uniq -c | sort -rn | sed 's/^/   code /'
  sed -E 's/^\[[a-z-]+\] //' "$OUT/$name.swallows" | sort | uniq -c | sort -rn > "$OUT/$name.messages"
  echo "   distinct messages: $(wc -l < "$OUT/$name.messages" | tr -d ' ') (see $OUT/$name.messages)"
done
