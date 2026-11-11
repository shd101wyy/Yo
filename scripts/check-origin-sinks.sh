#!/usr/bin/env bash
# G-E, the totality and sink audit (plans/backlog/BORROW_CHECKER_COMPLETENESS.md
# §6 G-E, §5's lowering table).
#
# Without arguments: the GREP GATE, which needs no binary.
#   1. The loan registrar `local_borrow_register` is called only from the
#      binding sites listed in REGISTRARS below (`bind` and the three
#      binding forms that still register their own entries).
#   2. The conflict check `_lb_raise_conflict` is called only from
#      `_local_borrow_access_live`, the one `access` (`local_borrow_access` and
#      `local_borrow_access_at` delegate to it); the loan table
#      `g_local_borrows` is written only by the registrar and the block-end
#      truncation.
#   3. Every lowering of §5's table calls its sink at least once in the file
#      that lowers it (LOWERINGS below, one line per lowering). A new lowering
#      adds a row to §5 and a line here in the same PR.
#
# With --totality: the TOTALITY AUDIT. `YO_AUDIT_ORIGIN_TOTALITY=1 yo check`
# over ./src, ./std, tests/origins/corpus and the language tests that name a
# reference; every `[origin-totality]` line is a value a sink stored without
# its origin computed, an `origin_of` recursion into an untyped node, or a
# cut at the recursion bound. The distinct lines are counted; the gate is 0.
#
# Usage (from the repository root):
#   bash scripts/check-origin-sinks.sh
#   YO=<yo binary> bash scripts/check-origin-sinks.sh --totality
# The totality run is about ten `yo check` calls; ./src dominates (a few
# minutes, a heavy step locally).

set -uo pipefail

ROOT=$PWD
[ -d src/evaluator ] && [ -d std ] || { echo "run from the repository root" >&2; exit 2; }

fail=0
problem() { echo "  FAIL $1"; fail=$((fail + 1)); }

# The enclosing top-level definition of every line matching <ERE> in <file>,
# comment lines skipped: "<file>:<line> <definition>".
callers_of() { # <ERE> <file>...
  PAT=$1 awk '
    FNR == 1 { fn = "" }
    /^[A-Za-z_][A-Za-z0-9_]* :: / { fn = $1 }
    /^[[:space:]]*\/\// { next }
    $0 ~ ENVIRON["PAT"] { print FILENAME ":" FNR " " fn }
  ' "${@:2}"
}

totality() {
  YO=${YO:-yo}
  local out
  out=$(mktemp -d)
  trap 'rm -rf "$out"' RETURN
  local targets=(./src ./std tests/origins/corpus)
  local t
  for t in tests/ref_*.test.yo tests/local_borrows*.test.yo tests/impl_ref*.test.yo \
           tests/origin_*.test.yo tests/for_macro_borrow*.test.yo tests/async_await.test.yo \
           tests/origins/*.test.yo; do
    [ -f "$t" ] && targets+=("$t")
  done
  local i=0 rc
  for t in "${targets[@]}"; do
    i=$((i + 1))
    YO_MAIN_STACK_MB=${YO_MAIN_STACK_MB:-4096} YO_AUDIT_ORIGIN_TOTALITY=1 \
      "$YO" check "$t" --std-path "$ROOT/std" >"$out/$i.log" 2>&1
    rc=$?
    grep -h '^\[origin-totality\]' "$out/$i.log" >>"$out/all.txt"
    echo "  $t: rc=$rc, $(grep -c '^\[origin-totality\]' "$out/$i.log") line(s)"
  done
  touch "$out/all.txt"
  local n
  n=$(sort -u "$out/all.txt" | wc -l)
  if [ "$n" -gt 0 ]; then
    sort -u "$out/all.txt" | sed 's/^/  /'
    echo "origin totality: $n distinct finding(s); the gate is 0"
    return 1
  fi
  echo "origin totality: 0"
  return 0
}

if [ "${1:-}" = --totality ]; then
  totality
  exit $?
fi

EV=src/evaluator

# --- 1. the registrar -------------------------------------------------------
# `bind` registers a holder's loans (`:=`, destructuring, the hidden `for`
# locals); the three others are binding forms §5 names that register their
# own entry: a `y := &x` / `y := &mut x` local borrow with its decision-25
# re-point pins, a projection's result binding (decision 24), and a `match`
# arm binding of a borrowed scrutinee (decision 26).
REGISTRARS="bind _evaluate_inout_local_binding _bind_projection_result local_borrow_register_match_place"
while read -r site fn; do
  case " $REGISTRARS " in
    *" $fn "*) ;;
    *) problem "$site: \`local_borrow_register\` called from \`$fn\`, not a binding site (add it to \`bind\`)" ;;
  esac
done < <(callers_of 'local_borrow_register\(' $(grep -rlE 'local_borrow_register\(' src --include='*.yo') |
  grep -v ' local_borrow_register$')

# --- 2. the one access check --------------------------------------------------
while read -r site fn; do
  [ "$fn" = _local_borrow_access_live ] || problem "$site: \`_lb_raise_conflict\` called from \`$fn\`, not \`_local_borrow_access_live\`"
done < <(callers_of '_lb_raise_conflict\(' $(grep -rlE '_lb_raise_conflict\(' src --include='*.yo') |
  grep -v ' _lb_raise_conflict$')
while read -r site fn; do
  case "$fn" in
    local_borrow_register | local_borrows_truncate) ;;
    *) problem "$site: the loan table \`g_local_borrows\` is written from \`$fn\`" ;;
  esac
done < <(callers_of 'g_local_borrows\.with_mut' $(grep -rlE 'g_local_borrows\.with_mut' src --include='*.yo'))

# --- 3. every lowering calls its sink ------------------------------------------
# lowering | file | the sink call it must contain (ERE)
LOWERINGS="
identifier read of a reference binding|$EV/exprs/identifer_and_operator.yo|local_borrow_access\(
a lend as a call argument (decision 28)|$EV/calls/function.yo|_check_call_value_root_overlap\(
:= binding|$EV/exprs/initialization_assignment.yo|[^_]bind\(
destructuring|$EV/exprs/initialization_assignment.yo|runtime_destructurings
y := &x local borrow|$EV/exprs/initialization_assignment.yo|local_borrow_register\(
= whole-holder join|$EV/exprs/assignment.yo|bind_join\(
place write|$EV/exprs/assignment.yo|place_write_join\(
place write access|$EV/exprs/assignment.yo|local_borrow_access\(
call, method call, operator pair (lend_through)|$EV/calls/function.yo|lend_through\(
call result origin (R-CALL)|$EV/utils.yo|projection_call_root_args\(
match arm bindings of a borrowed scrutinee|$EV/exprs/match.yo|local_borrow_register_match_place\(
match reference payload bindings|$EV/exprs/match.yo|origin_held_by\(
return and body tail|$EV/exprs/begin.yo|return_check\(
closure literal capture stores|$EV/values/anonymous_function.yo|apply_capture_store_joins\(
io.async captures (R-ASYNC)|$EV/calls/function.yo|note_future_roots\(
macro expansion in the caller's coordinates|$EV/calls/function.yo|local_borrow_enter_macro_site\(
temporaries (R-TEMP)|$EV/utils.yo|origin_temporary_entry\(
projection bodies (decision 24)|$EV/calls/helper.yo|projection_body_mismatch_message\(
"
while IFS='|' read -r what file pat; do
  [ -z "$what" ] && continue
  if [ ! -f "$file" ]; then
    problem "$what: $file does not exist (update LOWERINGS)"
  elif [ "$(grep -v '^[[:space:]]*//' "$file" | grep -cE "$pat")" -eq 0 ]; then
    problem "$what: $file never calls /$pat/"
  fi
done <<<"$LOWERINGS"

# --- 4. every sink is audited --------------------------------------------------
# The totality audit sees only the sinks that call `audit_origin_totality`.
AUDITED="
:=|$EV/exprs/initialization_assignment.yo|audit_origin_totality\(\":=\"
destructuring|$EV/exprs/initialization_assignment.yo|audit_origin_totality\(\"destructuring\"
=|$EV/exprs/assignment.yo|audit_origin_totality\(\"=\"
typed declaration|$EV/exprs/assignment.yo|audit_origin_totality_elided\(\"typed-declaration\"
place write|$EV/exprs/assignment.yo|audit_origin_totality\(\"place-write\"
return|$EV/exprs/begin.yo|audit_origin_totality\(\"return\"
body tail|$EV/exprs/begin.yo|audit_origin_totality\(\"result\"
match binding|$EV/exprs/match.yo|audit_origin_totality(_elided)?\(\"match-binding\"
call argument|$EV/calls/function.yo|audit_origin_totality(_elided)?\(\"call-argument\"
"
while IFS='|' read -r what file pat; do
  [ -z "$what" ] && continue
  [ "$(grep -cE "$pat" "$file")" -gt 0 ] || problem "the $what sink is not audited in $file"
done <<<"$AUDITED"

if [ "$fail" -gt 0 ]; then
  echo "origin sinks: $fail problem(s)"
  exit 1
fi
echo "origin sinks: ok"
