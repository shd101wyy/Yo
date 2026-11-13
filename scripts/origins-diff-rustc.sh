#!/usr/bin/env bash
# G-C, the rustc differential corpus (plans/backlog/BORROW_CHECKER_COMPLETENESS.md §6 G-C).
#
# Every file tests/origins/rust/<kind>-<id>.rs is the Rust twin of one Yo program:
#   corpus-<id>.rs   twins tests/origins/corpus/<id>.yo      (verdict: the manifest's `today` column)
#   unsound-<id>.rs  twins tests/origins/unsound/<id>.yo     (verdict: the `// expect:` header)
# The script runs `rustc --edition 2021 --emit=metadata` on each twin and compares ACCEPT / REJECT with the Yo
# program's verdict. Every row where the two differ must be listed in tests/origins/rust/DIVERGENCES.tsv with
# its reason; an unexplained divergence FAILS the job, and so does a listed divergence that no longer diverges
# (the file is a ledger of what is still different, not of what once was).
#
# A Yo program that `yo check` rejects only because a container or cell of reference-holding elements is still
# walled ("carries an origin inside a container or a cell", decision 43 step 3) says nothing about the rule its
# twin tests: for such a row the verdict compared is the manifest's `expect` column (what the rule will say once
# the wall lifts), and the row is counted as walled. When the wall lifts the row compares for real.
#
# Rust is the oracle ONLY where the design says the models coincide: holders, lends, calls, arms, closures,
# drops. Not `Rc` handle origins, effects, async, `mut(G)` lends, `.*`-only reads (those rows have no twin).
# A twin's body is not a transliteration of the Yo text; it is the same loan shape in Rust's own spelling
# (`Vec` for `ArrayList`, a named lifetime for a spelled origin, an `if` for `cond`).
#
# DIVERGENCES.tsv columns (tab-separated, `#` lines are comments):
#   id      the twin's stem, e.g. corpus-swap-different-origins
#   yo      ACCEPT | REJECT   (what Yo says)
#   rustc   ACCEPT | REJECT   (what rustc says)
#   kind    design   a rule Yo keeps on purpose (rigid declared origins, an over-freeze Yo accepts or rejects)
#           parity   a shape Yo rejects (or accepts) pending a parity item of plans/backlog/BORROW_CHECKER_COMPLETENESS.md §7
#           polonius a shape rustc rejects only because NLL lacks Polonius' location-sensitivity
#           hole     Yo accepts what rustc rejects: an open hole (name its audit row / issue in the reason)
#   reason  one sentence
#
# Usage (from the repository root):
#   bash scripts/origins-diff-rustc.sh                        # recorded Yo verdicts; needs only rustc
#   YO=<yo binary> LIVE=1 bash scripts/origins-diff-rustc.sh  # `yo check` of every twinned Yo program
# Each rustc run takes a fraction of a second; LIVE costs one `yo check` (about five seconds) per twin.

set -uo pipefail

YO=${YO:-yo}
LIVE=${LIVE:-0}
RUSTC=${RUSTC:-rustc}
ROOT=$PWD
RUST_DIR=tests/origins/rust
MANIFEST=tests/origins/corpus.tsv
LEDGER=$RUST_DIR/DIVERGENCES.tsv
[ -d "$RUST_DIR" ] && [ -f "$MANIFEST" ] && [ -d std ] || { echo "run from the repository root" >&2; exit 2; }
command -v "$RUSTC" > /dev/null || { echo "rustc not found (set RUSTC=...)" >&2; exit 2; }

OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT
fail=0
problem() { echo "  FAIL $1"; fail=$((fail + 1)); }

WALL_TEXT='carries an origin inside a container or a cell'

# The Yo verdict of a twin: prints ACCEPT or REJECT, or nothing (and reports) when the Yo program is missing.
# A walled row (see above) prints the verdict of its `expect` column and sets WALLED=1 (the caller reads it
# from $OUT/walled, since this runs in a subshell).
yo_verdict() { # <kind> <id>
  local kind=$1 id=$2 prog today expect target
  case "$kind" in
    corpus)
      prog=tests/origins/corpus/$id.yo
      [ -f "$prog" ] || { problem "$kind-$id: no Yo program $prog"; return 1; }
      today=$(awk -F'\t' -v id="$id" '$1 == id { print $6 }' "$MANIFEST")
      target=$(awk -F'\t' -v id="$id" '$1 == id { print $5 }' "$MANIFEST")
      [ -n "$today" ] || { problem "$kind-$id: no manifest row"; return 1; }
      if [ "$LIVE" = 1 ]; then
        if "$YO" check "$prog" --std-path "$ROOT/std" > "$OUT/yo.log" 2>&1; then
          echo ACCEPT
        elif grep -qF "$WALL_TEXT" "$OUT/yo.log"; then
          touch "$OUT/walled"; [ "$target" = ACCEPT ] && echo ACCEPT || echo REJECT
        else
          echo REJECT
        fi
      elif [ "$today" = accept ]; then
        echo ACCEPT
      elif [[ "$today" == *"$WALL_TEXT"* || "$today" == "-|carries an origin" ]]; then
        touch "$OUT/walled"; [ "$target" = ACCEPT ] && echo ACCEPT || echo REJECT
      else
        echo REJECT
      fi ;;
    unsound)
      prog=tests/origins/unsound/$id.yo
      [ -f "$prog" ] || { problem "$kind-$id: no Yo program $prog"; return 1; }
      expect=$(sed -n 's/^\/\/ expect: //p' "$prog" | head -1)
      [ -n "$expect" ] || { problem "$kind-$id: no '// expect:' header"; return 1; }
      if [ "$LIVE" = 1 ]; then
        "$YO" check "$prog" --std-path "$ROOT/std" > "$OUT/yo.log" 2>&1 && echo ACCEPT || echo REJECT
      else
        [ "$expect" = accept ] && echo ACCEPT || echo REJECT
      fi ;;
    *) problem "$kind-$id: the stem must start with corpus- or unsound-"; return 1 ;;
  esac
}

declare -A LEDGER_YO LEDGER_RS LEDGER_KIND
if [ -f "$LEDGER" ]; then
  while IFS=$'\t' read -r id yo rs kind reason; do
    [ -z "$id" ] && continue
    case "$id" in \#*) continue ;; esac
    LEDGER_YO[$id]=$yo
    LEDGER_RS[$id]=$rs
    LEDGER_KIND[$id]=$kind
    case "$kind" in design | parity | polonius | hole) ;; *) problem "$id: ledger kind '$kind'" ;; esac
    [ -n "$reason" ] || problem "$id: ledger row without a reason"
    [ -f "$RUST_DIR/$id.rs" ] || problem "$id: ledger row names no twin"
  done < "$LEDGER"
fi

agree=0
diverge=0
walled=0
for f in "$RUST_DIR"/*.rs; do
  stem=$(basename "$f" .rs)
  kind=${stem%%-*}
  id=${stem#*-}
  rm -f "$OUT/walled"
  yo=$(yo_verdict "$kind" "$id") || continue
  [ ! -f "$OUT/walled" ] || walled=$((walled + 1))
  if "$RUSTC" --edition 2021 --emit=metadata --crate-type bin --out-dir "$OUT" "$f" > "$OUT/rustc.log" 2>&1; then
    rs=ACCEPT
  else
    # A rustc failure that is not a borrow-check verdict is a broken twin, not a REJECT.
    if ! grep -qE 'error\[E0(499|502|503|505|506|507|515|521|597|716|382|381|373|713|594|596|384|510|712)\]|lifetime may not live long enough' "$OUT/rustc.log"; then
      problem "$stem: rustc failed without a borrow-check error: $(grep -m1 '^error' "$OUT/rustc.log")"
      continue
    fi
    rs=REJECT
  fi
  if [ "$yo" = "$rs" ]; then
    agree=$((agree + 1))
    [ -z "${LEDGER_KIND[$stem]:-}" ] || problem "$stem: listed in DIVERGENCES.tsv but Yo and rustc agree ($yo): delete the row"
  else
    diverge=$((diverge + 1))
    if [ -z "${LEDGER_KIND[$stem]:-}" ]; then
      problem "$stem: unexplained divergence (yo $yo, rustc $rs): add a row to DIVERGENCES.tsv or fix the twin"
    elif [ "${LEDGER_YO[$stem]}" != "$yo" ] || [ "${LEDGER_RS[$stem]}" != "$rs" ]; then
      problem "$stem: the ledger says yo ${LEDGER_YO[$stem]} / rustc ${LEDGER_RS[$stem]}, now yo $yo / rustc $rs"
    fi
  fi
done

echo "origins rustc diff: $agree agree, $diverge diverge (all listed unless FAIL above), $walled walled (compared on their target verdict), $fail failed"
[ $fail -eq 0 ]
