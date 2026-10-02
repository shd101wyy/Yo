#!/usr/bin/env bash
# Definition-time swallow census (plans/TYPE_SYSTEM_SOUNDNESS.md, Phase 0
# step 3; the metric Phase 6 drives to zero).
#
# `yo check` trial-evaluates bodies at definition time and SWALLOWS what the
# trial throws. Under YO_DEBUG_SWALLOW=1 every swallow is printed:
#   [swallow] <err>          named-fn def-eval trial (calls/function_type.yo)
#   [anon-swallow] <err>     closure-body trial (values/anonymous_function.yo)
#   [mat-default-swallow]    trait `?=` default materialization (values/impl.yo)
#   [reeval-swallow] <err>   specialization-time closure re-evaluation (calls/helper.yo)
# This script runs `check` over each target with the knob on and counts those
# lines by channel and by error code, and lists the distinct messages, so a
# phase can say which swallows it removed.
#
# A swallow is not automatically a bug: a body that cannot be typed until a
# SomeT is resolved at a call is deferred legitimately. The evaluator says
# which swallows it KEPT (did not re-raise) and why, one line each
# (Phase 6 step 3):
#   [kept] site=dg            a generic fn's definition-time trial (recorded
#                             against the body for codegen's hollow-spec report)
#   [kept] site=dgc           a generic closure's trial (recorded the same way)
#   [kept] site=anon-abstract a closure forced with type-variable parameters
#   [kept] site=anon-ct       a closure with a `comptime(x)` value parameter
#   [kept] site=fn-fwd        a concrete fn waiting for a forward comptime fn
#   [kept] site=reeval-*      a closure re-evaluated at a specialization
#   [kept] site=mat-default   a trait default for a still-generic impl
# Each `[kept]` follows the swallow line it keeps; the `.kept` file pairs them.
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
  grep -aE '^\[(swallow|anon-swallow|mat-default-swallow|reeval-swallow)\]' "$log" > "$OUT/$name.swallows" || true
  total=$(wc -l < "$OUT/$name.swallows" | tr -d ' ')
  echo "== $t: $total swallowed errors ($(tail -1 "$log"))"
  sed -E 's/^\[([a-z-]+)\].*/\1/' "$OUT/$name.swallows" | sort | uniq -c | sort -rn | sed 's/^/   channel /'
  sed -nE 's/^\[[a-z-]+\] (error\[(E[0-9]+)\]|error).*/\2/p' "$OUT/$name.swallows" |
    sed 's/^$/uncoded/' | sort | uniq -c | sort -rn | sed 's/^/   code /'
  sed -E 's/^\[[a-z-]+\] //' "$OUT/$name.swallows" | sort | uniq -c | sort -rn > "$OUT/$name.messages"
  echo "   distinct messages: $(wc -l < "$OUT/$name.messages" | tr -d ' ') (see $OUT/$name.messages)"
  # Pair each [kept] with the swallowed error above it: site, message, owner.
  awk '/^\[(swallow|anon-swallow|reeval-swallow|mat-default-swallow)\]/ { last=$0; sub(/^\[[a-z-]+\] /,"",last); next }
       /^\[kept\]/ { site=$0; sub(/.*site=/,"",site); sub(/ .*/,"",site); owner=$0; sub(/.*owner=/,"",owner);
                     print site "\t" last "\t" owner }' "$log" > "$OUT/$name.kept"
  echo "   kept (not re-raised): $(wc -l < "$OUT/$name.kept" | tr -d ' ') (see $OUT/$name.kept)"
  cut -f1 "$OUT/$name.kept" | sort | uniq -c | sort -rn | sed 's/^/   site /'
done
