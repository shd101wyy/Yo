#!/usr/bin/env bash
# Type-system soundness census (plans/TYPE_SYSTEM_SOUNDNESS.md, Phase 0 step 2).
#
# Counts programs that `yo check` ACCEPTS but that later fail: an internal
# compiler error or a rejection in `yo compile`, a C compiler error, a hollow
# "Failed to transpile" body, or a runtime FATAL from a body whose
# definition-time evaluation was swallowed. That count is the plan's headline
# metric: every such program is a place where the C compiler, an ICE or a
# runtime abort is the type checker of last resort.
#
# Population (all standalone programs, i.e. files with `export(main`):
#   repro   issues/**/repros/*.yo
#   doc     ```rust blocks with `export(main` EXTRACTED from the issue docs the
#           plan cites (open or fixed), so the metric covers the audit's inline
#           repros without copying them (a copy drifts). A doc with several
#           blocks yields <name>.1.yo, <name>.2.yo, ...
#   test    tests/**/*.yo (not *.test.yo, not tests/cli-cases) with a main
#
# Classes (one per program, first failing stage wins):
#   CHECK_RED     check rejected it (sound: nothing downstream to trust)
#   ICE           compile printed "internal compiler error"
#   COMPILE_RED   compile rejected what check accepted (any other rc != 0)
#   CC_RED        the C compiler failed (compile rc != 0 with a C diagnostic)
#   RUN_FTT       the binary hit a swallowed body at runtime (yo: FATAL: reached …)
#   FTT           the run did not hit one, but the binary keeps a live hollow-body stub
#   RUN_TIMEOUT   the binary did not finish in $RUN_TIMEOUT seconds (informational)
#   RUN_SIGNAL    the binary died on a signal (informational: a panic aborts
#                 by design, but a SIGSEGV/SIGBUS from safe code is a hole too)
#   OK            check, compile and run all green (the run's rc is not judged:
#                 many repros print evidence and exit 0 either way)
#
# The headline is ICE + COMPILE_RED + CC_RED + FTT + RUN_FTT.
#
# Usage:
#   YO=<yo binary> OUT=<dir> bash scripts/soundness/census.sh [population...]
#     population: repro doc test (default: all three)
#   JOBS=4 (parallel programs)   RUN_TIMEOUT=20 (seconds per binary)
#
# Resumable: a program whose result file already exists in $OUT/results is
# skipped, so a killed run continues where it stopped. Delete $OUT to start
# over. Run from the repository root; std is pinned to this checkout's std/.

set -uo pipefail

YO=${YO:?set YO to the yo binary under test (a tree-built stage-1, not the seed)}
OUT=${OUT:?set OUT to a results directory}
JOBS=${JOBS:-4}
RUN_TIMEOUT=${RUN_TIMEOUT:-20}
ROOT=$PWD
[ -d "$ROOT/std" ] && [ -d "$ROOT/issues" ] || { echo "run from the repository root" >&2; exit 2; }
export YO_STD="$ROOT/std"
TIMEOUT=$(command -v timeout || command -v gtimeout) || { echo "need timeout(1) (coreutils)" >&2; exit 2; }
POPS=${*:-repro doc test}

mkdir -p "$OUT/results" "$OUT/src/doc" "$OUT/work"
OUT=$(cd "$OUT" && pwd)

list_repro() { find issues -path '*repros*' -name '*.yo' | xargs grep -l 'export(main' | sort; }
list_test() {
  find tests -name '*.yo' ! -name '*.test.yo' -not -path 'tests/cli-cases/*' -not -path 'tests/internal/*' |
    xargs grep -l 'export(main' | sort
}
# The issue docs the plan cites, resolved to wherever each doc lives today.
plan_docs() {
  grep -oE 'issues/[a-z0-9/-]+\.md|`[a-z0-9][a-z0-9-]{12,}`' plans/TYPE_SYSTEM_SOUNDNESS.md |
    tr -d '`' | sed 's#^issues/##; s#^fixed/##; s#\.md$##' | sort -u |
    while read -r n; do
      for d in issues issues/fixed issues/retired; do
        [ -f "$d/$n.md" ] && { echo "$d/$n.md"; break; }
      done
    done
}
list_doc() {
  plan_docs | while read -r md; do
    name=$(basename "$md" .md)
    awk -v dir="$OUT/src/doc" -v name="$name" '
      /^```rust[[:space:]]*$/ { inb = 1; buf = ""; next }
      /^```[[:space:]]*$/ && inb {
        inb = 0
        # A snippet that defines `main` but omits the export is still a
        # whole program (several docs elide the last line).
        if (buf ~ /(^|\n)main :: / && buf !~ /export\(main/) buf = buf "export(main);\n"
        if (buf ~ /export\(main/) { n++; f = dir "/" name "." n ".yo"; printf "%s", buf > f; close(f); print f }
        next
      }
      inb { buf = buf $0 "\n" }
    ' "$md"
  done
}

classify() {
  local src=$1 key res w log rc
  key=$(echo "$src" | sed "s#^$OUT/src/##; s#/#__#g")
  res="$OUT/results/$key"
  [ -f "$res" ] && return 0
  w="$OUT/work/$key.d"; rm -rf "$w"; mkdir -p "$w"; log="$w/log"
  # Programs resolve relative imports against their own directory, so run
  # check/compile on the file where it lives.
  "$YO" check "$src" > "$log" 2>&1; rc=$?
  if [ $rc -ne 0 ] || grep -q 'error in' "$log"; then printf 'CHECK_RED\t%s\n' "$src" > "$res"; rm -rf "$w"; return 0; fi
  "$YO" compile "$src" --optimize 2 -o "$w/a.out" > "$log" 2>&1; rc=$?
  if grep -qi 'internal compiler error' "$log"; then printf 'ICE\t%s\n' "$src" > "$res"
  elif [ $rc -ne 0 ]; then
    if grep -qE '\.c:[0-9]+:[0-9]+: (fatal )?error:' "$log"; then printf 'CC_RED\t%s\n' "$src" > "$res"
    else printf 'COMPILE_RED\t%s\n' "$src" > "$res"; fi
  else
    (cd "$w" && "$TIMEOUT" "$RUN_TIMEOUT" ./a.out > run.log 2>&1 < /dev/null); rc=$?
    if grep -q 'failed to transpile' "$w/run.log"; then printf 'RUN_FTT\t%s\n' "$src" > "$res"
    # A hollow body is rewritten to a stub that prints "... whose body failed
    # to transpile ..." before aborting; -O2 drops dead stubs, so the literal
    # surviving in the binary means a stub is called on some path or has its
    # address taken.
    elif grep -aqs 'whose body failed to transpile' "$w/a.out"; then printf 'FTT\t%s\n' "$src" > "$res"
    elif [ $rc -eq 124 ]; then printf 'RUN_TIMEOUT\t%s\n' "$src" > "$res"
    elif [ $rc -gt 128 ]; then printf 'RUN_SIGNAL\t%s\n' "$src" > "$res"
    else printf 'OK\t%s\n' "$src" > "$res"; fi
  fi
  # Keep the log of every failure class for triage; drop the rest.
  if ! grep -qE '^(OK|RUN_TIMEOUT|CHECK_RED)	' "$res"; then mkdir -p "$OUT/logs"; cat "$log" "$w/run.log" > "$OUT/logs/$key.log" 2>/dev/null; fi
  rm -rf "$w"
}
export -f classify
export YO OUT RUN_TIMEOUT TIMEOUT

for p in $POPS; do
  case $p in
    repro) list_repro ;;
    test) list_test ;;
    doc) list_doc ;;
    *) echo "unknown population: $p" >&2; exit 2 ;;
  esac
done > "$OUT/programs.txt"

xargs -P "$JOBS" -I{} bash -c 'classify "$@" 2>/dev/null' _ {} < "$OUT/programs.txt"

cat "$OUT"/results/* | sort > "$OUT/census.tsv"
echo "== soundness census: $(wc -l < "$OUT/census.tsv" | tr -d ' ') programs"
cut -f1 "$OUT/census.tsv" | sort | uniq -c | sort -rn
headline=$(grep -cE '^(ICE|COMPILE_RED|CC_RED|FTT|RUN_FTT)	' "$OUT/census.tsv")
echo "HEADLINE check-green-then-fails: $headline"
