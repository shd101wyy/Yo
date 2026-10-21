#!/usr/bin/env bash
# Decision 43's negative-test corpus runner (plans/backlog/REFERENCES_AND_ORIGINS.md
# §8, phase N0). Each row of tests/origins/corpus.tsv names a Yo program,
# tests/origins/corpus/<id>.yo, spelled in the origin syntax decision 43 will
# land, and the same row encoded in the reference checker's toy language
# (tests/origins/model_corpus.test.yo, which the language suite runs).
#
# The programs are plain `.yo` files, never `.test.yo`, so `yo test ./tests`
# never runs them: most of them cannot pass before N1/N2. This script is their
# gate.
#
# Manifest columns (tab-separated, `#` lines are comments):
#   id      the row; the fixture is tests/origins/corpus/<id>.yo
#   anchor  the plan section the row tests
#   kind    neg (the program is unsound or ill-typed under O1–O10) | pos (a control)
#   phase   N1 | N2: the phase whose gate the row joins (N2 = first-class storage)
#   expect  the verdict once the rules land, as the reference checker returns it:
#           ACCEPT, an existing code (E0901 E0909 E0910 E0911 E0912 E0919), or a
#           rule the plan names but has not numbered yet (WF_SELF, WF_UNDECLARED,
#           ORIGIN_MISMATCH, UNION; `@spec` = inside a generic specialization)
#   today   what `yo check` does with the program now: `accept`, or
#           `<code>|<text>` where <code> is the first error's code (`-` when it
#           has none) and <text> a fixed string its output contains
#
# Modes:
#   today   (default; the N0 gate) every row behaves as its `today` column says.
#           A row that changes is either progress (re-record it) or a regression.
#   target  (the N1/N2 gates) every row whose phase is in $PHASES behaves as its
#           `expect` column says. A plan-named rule passes on any rejection until
#           N1 numbers it: add its code to RULE_CODES below then.
# Both modes first cross-check the manifest against the fixtures and against
# the model test's `verdict("<id>", …, "<expect>")` calls.
#
# Usage (from the repository root):
#   YO=<yo binary> bash scripts/origins-corpus.sh [today|target]
#   PHASES="N1" YO=... bash scripts/origins-corpus.sh target
# Each check is one `yo check` of a small program (about a second); the whole
# run is light enough to need no heavy-lock slot.

set -uo pipefail

MODE=${1:-today}
YO=${YO:-yo}
PHASES=${PHASES:-"N1 N2"}
ROOT=$PWD
MANIFEST=tests/origins/corpus.tsv
CORPUS=tests/origins/corpus
MODEL_TEST=tests/origins/model_corpus.test.yo
[ -f "$MANIFEST" ] && [ -d std ] || { echo "run from the repository root" >&2; exit 2; }
case "$MODE" in today | target) ;; *) echo "mode is today or target, got $MODE" >&2; exit 2 ;; esac

# The codes N1/N2 assign to the rules the plan names but has not numbered.
# Empty means "any rejection" (the row cannot be checked more precisely yet).
declare -A RULE_CODES=([WF_SELF]="" [WF_UNDECLARED]="" [ORIGIN_MISMATCH]="" [UNION]="")

fail=0
problem() { echo "  FAIL $1"; fail=$((fail + 1)); }

# --- cross-checks -----------------------------------------------------------
ids=$(grep -v '^#' "$MANIFEST" | awk -F'\t' 'NF { print $1 }')
for f in "$CORPUS"/*.yo; do
  id=$(basename "$f" .yo)
  grep -qx "$id" <<<"$ids" || problem "$id: fixture has no manifest row"
done
model=$(perl -0777 -ne 'while (/verdict\(\s*"([a-z0-9-]+)",.*?"([A-Za-z0-9_@]+)"\s*\)\s*;/sg) { print "$1\t$2\n" }' "$MODEL_TEST")
while IFS=$'\t' read -r id anchor kind phase expect today; do
  [ -z "$id" ] && continue
  case "$id" in \#*) continue ;; esac
  [ -f "$CORPUS/$id.yo" ] || problem "$id: no fixture $CORPUS/$id.yo"
  got=$(awk -F'\t' -v id="$id" '$1 == id { print $2 }' <<<"$model")
  [ "$got" = "$expect" ] || problem "$id: the model test expects '${got:-nothing}', the manifest '$expect'"
  case "$kind" in neg) [ "$expect" != ACCEPT ] || problem "$id: a neg row expects ACCEPT" ;; pos) [ "$expect" = ACCEPT ] || problem "$id: a pos row expects $expect" ;; *) problem "$id: kind '$kind'" ;; esac
done < <(grep -v '^#' "$MANIFEST")
mcount=$(wc -l <<<"$model" | tr -d ' ')
rcount=$(wc -l <<<"$ids" | tr -d ' ')
[ "$mcount" = "$rcount" ] || problem "the model test has $mcount verdicts, the manifest $rcount rows"

# --- the programs -----------------------------------------------------------
OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT
pass=0
while IFS=$'\t' read -r id anchor kind phase expect today; do
  [ -z "$id" ] && continue
  case "$id" in \#*) continue ;; esac
  log="$OUT/$id.log"
  "$YO" check "$CORPUS/$id.yo" --std-path "$ROOT/std" > "$log" 2>&1
  rc=$?
  first=$(grep -m1 -oE '^error(\[E[0-9]+\])?' "$log" | sed -E 's/^error\[?//; s/\]$//')
  if [ "$MODE" = today ]; then
    if [ "$today" = accept ]; then
      [ $rc -eq 0 ] && { pass=$((pass + 1)); continue; }
      problem "$id: recorded as accepted today, check rc=$rc: $(grep -m1 '^error' "$log")"
    else
      code=${today%%|*}
      text=${today#*|}
      if [ $rc -eq 0 ]; then
        problem "$id: recorded as rejected today ($today), check accepted it"
      elif [ "$code" != - ] && [ "$first" != "$code" ]; then
        problem "$id: today's first error is '${first:-uncoded}', recorded '$code': $(grep -m1 '^error' "$log")"
      elif ! grep -qF -- "$text" "$log"; then
        problem "$id: today's output no longer says '$text': $(grep -m1 '^error' "$log")"
      else
        pass=$((pass + 1))
      fi
    fi
  else
    grep -qw -- "$phase" <<<"$PHASES" || continue
    case "$expect" in
      ACCEPT)
        [ $rc -eq 0 ] && pass=$((pass + 1)) || problem "$id: expected accepted, check rc=$rc: $(grep -m1 '^error' "$log")" ;;
      E[0-9]*)
        want=${expect%@spec}
        if [ $rc -ne 0 ] && [ "$first" = "$want" ]; then pass=$((pass + 1)); else problem "$id: expected $expect, got rc=$rc first='${first:-none}'"; fi ;;
      *)
        rule=${expect%@spec}
        want=${RULE_CODES[$rule]-}
        if [ $rc -ne 0 ] && { [ -z "$want" ] || [ "$first" = "$want" ]; }; then pass=$((pass + 1)); else problem "$id: expected $expect${want:+ ($want)}, got rc=$rc first='${first:-none}'"; fi ;;
    esac
  fi
done < <(grep -v '^#' "$MANIFEST")

echo "origins corpus ($MODE): $pass passed, $fail failed"
[ $fail -eq 0 ]
