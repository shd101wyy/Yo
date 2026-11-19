#!/usr/bin/env bash
# Test 7: the soundness claim (S) on a release candidate (VERDICTS-58 decisions 7 and 8;
# plans/handover/VBD_V0279_RETIREMENTS_AND_CLAIM.md §3.6 is the procedure and the pass criteria).
#
# Four legs. This script runs (a) and (b) and prints how to run and read (c); (d) is agents:
#   (a) G-A, G-B, G-E exactly as CI's origins-corpus job runs them (scripts/check-origin-sinks.sh,
#       scripts/origins-corpus.sh today, scripts/origins-unsound.sh, check-origin-sinks.sh --totality).
#   (b) the 2026-11-11 audit's probe corpus (scripts/test7/audit-corpus.tar.gz, frozen: the ten areas'
#       probes, the audit's reproducer pairs, the re-probe's pass-2 programs) under ASan: each program is
#       rejected, accepted-clean, or accepted-and-dirty, and every dirty program is attributed to an audit
#       row (scripts/test7/attribution.tsv) and so to a cluster of the audit's §9.
#   (c) G-D: one clean origins-generator.yml run on the candidate SHA (`--gd-verdict <run-id>` reads one).
#   (d) the second adversarial pass: plans/handover/TEST7_ADVERSARIAL_BRIEF.md.
#
# Usage, from the repository root of the CANDIDATE tree (its std is the one the programs see):
#   bash scripts/test7.sh --yo <yo binary> [--phase all|gates|corpus|classify] [--out DIR] [--jobs N]
#                         [--limit N] [--std DIR]
#   bash scripts/test7.sh --gd-verdict <run-id> [--sha <candidate sha>]
#   bash scripts/test7.sh --gd-howto [--sha <candidate sha>]
#
# Heavy: the corpus is ~2,050 `yo check` calls plus ~1,000 ASan compiles (~0.5 GB per job); G-B is ~380
# programs serially and G-E's totality checks ./src; the gates run beside the corpus workers. Take the
# heavy lock and run it under systemd so a closed shell does not kill it:
#   systemd-run --user --unit=test7-run -p MemoryMax=16G --working-directory="$PWD" \
#     bash -c 'source scripts/heavy-lock.sh; heavy_take "test7: run"; bash scripts/test7.sh --yo <bin>; heavy_drop'
# The corpus leg resumes: a program with a result file in <out>/results is not run again (delete the
# directory, or pass a fresh --out, for a new candidate).
#
# Exit: 0 = (a) and (b) pass; 1 = a leg failed (the summary says which); 2 = usage / environment.

set -uo pipefail

ROOT=$PWD
T7=$ROOT/scripts/test7
[ -d src/evaluator ] && [ -d std ] && [ -f "$T7/audit-corpus.tar.gz" ] ||
  { echo "test7: run from the repository root" >&2; exit 2; }

# ------------------------------------------------------------------------------------------------
# The per-program worker (xargs re-enters the script with `__one <relative path>`).
# Verdict column: EXCLUDED-UNSAFE | REJECTED | CHECK-CRASH | COMPILE-FAIL | CLEAN | LEAK | DIRTY |
#                 RUN-FAIL | TIMEOUT
# ------------------------------------------------------------------------------------------------
one() {
  local rel=$1 src key res wd rc code line kind
  src=$T7_CORPUS/$rel
  key=$(printf '%s' "${rel%.yo}" | tr '/' '_')
  res=$T7_OUT/results/$key.tsv
  [ -s "$res" ] && return 0
  wd=$T7_OUT/work/$key
  mkdir -p "$wd"
  emit() { printf '%s\t%s\t%s\t%s\n' "$rel" "$1" "$2" "$3" >"$res.part" && mv "$res.part" "$res"; }
  # Safe code only: a file that turns the unsafe gate off is outside the claim.
  if grep -q 'Pragma\.AllowUnsafe' "$src"; then
    emit EXCLUDED-UNSAFE - "Pragma.AllowUnsafe"
    return 0
  fi
  timeout 300 "$T7_YO" check "$src" --std-path "$T7_STD" >"$wd/check.log" 2>&1
  rc=$?
  if [ $rc -ne 0 ]; then
    code=$(grep -m1 -oE '^error\[E[0-9]+\]' "$wd/check.log" | grep -oE 'E[0-9]+')
    line=$(grep -m1 -E '^error' "$wd/check.log" | cut -c1-160 | tr '\t' ' ')
    if [ -z "$code" ] && { [ $rc -ge 124 ] || ! grep -q '^error' "$wd/check.log"; }; then
      emit CHECK-CRASH "rc$rc" "$(grep -m1 -iE 'panic|segm|assert|fatal|error' "$wd/check.log" | cut -c1-160 | tr '\t' ' ')"
    else
      emit REJECTED "${code:--}" "$line"
    fi
    return 0
  fi
  if ! timeout 600 "$T7_YO" compile "$src" --std-path "$T7_STD" --optimize 1 --sanitize address \
    --allocator system --cc "$T7_CC" -o "$wd/p.bin" >"$wd/compile.log" 2>&1; then
    emit COMPILE-FAIL - "$(grep -m1 -iE 'error' "$wd/compile.log" | cut -c1-160 | tr '\t' ' ')"
    return 0
  fi
  (cd "$wd" && ASAN_OPTIONS=detect_stack_use_after_return=1:detect_leaks=1 timeout 60 ./p.bin \
    >"$wd/run.log" 2>&1)
  rc=$?
  rm -f "$wd/p.bin"
  if grep -q 'ERROR: AddressSanitizer' "$wd/run.log"; then
    kind=$(grep -m1 -oE 'ERROR: AddressSanitizer: [a-z-]+' "$wd/run.log" | sed 's/.*: //')
    emit DIRTY "$kind" "$(grep -m1 -E '^SUMMARY' "$wd/run.log" | cut -c1-160 | tr '\t' ' ')"
  elif grep -q 'ERROR: LeakSanitizer' "$wd/run.log"; then
    emit LEAK leak "$(grep -m1 -E '^SUMMARY' "$wd/run.log" | cut -c1-160 | tr '\t' ' ')"
  elif [ $rc -eq 124 ]; then
    emit TIMEOUT rc124 "-"
  elif [ $rc -ne 0 ]; then
    emit RUN-FAIL "rc$rc" "$(tail -1 "$wd/run.log" | cut -c1-160 | tr '\t' ' ')"
  else
    emit CLEAN - "$(grep -m1 OUT "$wd/run.log" | cut -c1-80 | tr '\t' ' ')"
  fi
}

if [ "${1:-}" = __one ]; then
  one "$2"
  exit 0
fi

# ------------------------------------------------------------------------------------------------
# Arguments
# ------------------------------------------------------------------------------------------------
YO=
PHASE=all
OUT=
JOBS=8
LIMIT=0
STD=$ROOT/std
GD_RUN=
GD_HOWTO=0
SHA=
while [ $# -gt 0 ]; do
  case $1 in
  --yo) YO=$2; shift 2 ;;
  --phase) PHASE=$2; shift 2 ;;
  --out) OUT=$2; shift 2 ;;
  --jobs) JOBS=$2; shift 2 ;;
  --limit) LIMIT=$2; shift 2 ;;
  --std) STD=$2; shift 2 ;;
  --gd-verdict) GD_RUN=$2; shift 2 ;;
  --gd-howto) GD_HOWTO=1; shift ;;
  --sha) SHA=$2; shift 2 ;;
  -h | --help) sed -n '2,32p' "$0"; exit 0 ;;
  *) echo "test7: unknown argument $1" >&2; exit 2 ;;
  esac
done
[ -n "$SHA" ] || SHA=$(git rev-parse HEAD)

# ------------------------------------------------------------------------------------------------
# (c) G-D: how to run it on the candidate, and how to read a run
# ------------------------------------------------------------------------------------------------
gd_howto() {
  cat <<EOF
(c) G-D on the candidate $SHA
  origins-generator.yml checks out \`develop\` itself (not the dispatch ref), so dispatch it while the
  candidate IS develop's tip, and confirm the run's head SHA afterwards:
    git fetch origin && test "\$(git rev-parse origin/develop)" = $SHA
    gh workflow run origins-generator.yml --ref develop -f count=300
    gh run list --workflow origins-generator.yml --limit 1 --json databaseId,headSha,status
  A nightly (03:17 UTC) whose headSha is the candidate counts as well. Read the verdict with
    bash scripts/test7.sh --gd-verdict <run-id> --sha $SHA
  Clean = the run's headSha is the candidate, the job succeeded, the generator printed
  "0 new" (rc 0: no finding outside tests/origins/gen-known.tsv), and every gen-known.tsv row is a
  listable known issue (today: the two A6 rows, rule G — decide at the cut whether rule G is closed).
  A dispatch also runs --verify-known: a FIXED pattern's row is deleted in a follow-up PR.
EOF
}

gd_verdict() {
  local run=$1 log head concl gen new distinct
  log=$(mktemp)
  gh run view "$run" --log >"$log" 2>/dev/null || { echo "test7: cannot read run $run" >&2; rm -f "$log"; return 2; }
  head=$(gh run view "$run" --json headSha --jq .headSha)
  concl=$(gh run view "$run" --json conclusion --jq .conclusion)
  gen=$(grep -oE 'classes: [^ ].*' "$log" | head -1)
  distinct=$(grep -oE '[0-9]+ distinct findings after minimization, [0-9]+ new' "$log" | head -1)
  new=$(printf '%s' "$distinct" | grep -oE '[0-9]+ new' | grep -oE '[0-9]+')
  echo "G-D run $run: headSha=$head conclusion=$concl"
  echo "  generator: ${gen:-<no classes line>}"
  echo "  findings:  ${distinct:-<no findings line>}"
  grep -oE 'valid programs: .*|[0-9]+ programs written' "$log" | head -2 | sed 's/^/  /'
  grep -E 'STILL-OPEN|FIXED' "$log" | sed 's/^.*Z //' | head -20 | sed 's/^/  known: /'
  rm -f "$log"
  if [ "$head" = "$SHA" ] && [ "$concl" = success ] && [ "${new:-x}" = 0 ]; then
    echo "G-D: CLEAN on $SHA"
    return 0
  fi
  [ "$head" = "$SHA" ] || echo "G-D: NOT ON THE CANDIDATE (head $head, candidate $SHA)"
  echo "G-D: NOT CLEAN"
  return 1
}

if [ -n "$GD_RUN" ]; then
  gd_verdict "$GD_RUN"
  exit $?
fi
if [ $GD_HOWTO = 1 ]; then
  gd_howto
  exit 0
fi

[ -n "$YO" ] || { echo "test7: --yo <binary> is required" >&2; exit 2; }
YO=$(cd "$(dirname "$YO")" && pwd)/$(basename "$YO")
[ -x "$YO" ] || { echo "test7: $YO is not executable" >&2; exit 2; }
STD=$(cd "$STD" && pwd)
[ -n "$OUT" ] || OUT=$ROOT/tmp/test7-$(git rev-parse --short=9 HEAD)
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
case $PHASE in all | gates | corpus | classify) ;; *) echo "test7: --phase all|gates|corpus|classify" >&2; exit 2 ;; esac
command -v "${YO_CC:-clang}" >/dev/null || { echo "test7: ${YO_CC:-clang} is not on PATH (use the nix shell)" >&2; exit 2; }

{
  echo "candidate: $SHA ($(git log -1 --format=%s | cut -c1-80))"
  echo "binary:    $YO ($("$YO" --version 2>/dev/null | head -1))"
  echo "std:       $STD"
  echo "date:      $(date -u +%Y-%m-%dT%H:%MZ)"
} | tee "$OUT/meta.txt"

# ------------------------------------------------------------------------------------------------
# (a) G-A, G-B, G-E, as test.yml's origins-corpus job
# ------------------------------------------------------------------------------------------------
gates() {
  local g=$OUT/gates
  mkdir -p "$g"
  if [ -s "$g/ge-sinks.rc" ] && [ -s "$g/ga.rc" ] && [ -s "$g/gb.rc" ] && [ -s "$g/ge-totality.rc" ]; then
    echo "(a) gates: already run in $g (delete it to re-run)"
    return 0
  fi
  echo "(a) gates: logs in $g"
  bash scripts/check-origin-sinks.sh >"$g/ge-sinks.log" 2>&1
  echo "$?" >"$g/ge-sinks.rc"
  # The three binary gates are independent: run them side by side (G-B dominates).
  (YO=$YO bash scripts/origins-corpus.sh today >"$g/ga.log" 2>&1; echo "$?" >"$g/ga.rc") &
  (YO=$YO YO_CC=${YO_CC:-clang} bash scripts/origins-unsound.sh >"$g/gb.log" 2>&1; echo "$?" >"$g/gb.rc") &
  (YO=$YO bash scripts/check-origin-sinks.sh --totality >"$g/ge-totality.log" 2>&1; echo "$?" >"$g/ge-totality.rc") &
  wait
}

# ------------------------------------------------------------------------------------------------
# (b) the audit corpus
# ------------------------------------------------------------------------------------------------
corpus() {
  local c=$OUT/corpus list
  if [ ! -d "$c/audit-corpus" ]; then
    mkdir -p "$c"
    tar -xzf "$T7/audit-corpus.tar.gz" -C "$c"
    # The corpus was written against the 2026-11-11 std. A std module renamed since (kebab-case
    # module names) is followed: an import path that resolves to neither <p>.yo nor <p>/index.yo in the
    # candidate's std is rewritten to its kebab spelling when THAT resolves. Never hardcoded.
    python3 -I "$T7/respell_imports.py" "$c/audit-corpus" "$STD" | tee "$OUT/respell.txt"
  fi
  list=$OUT/programs.list
  (cd "$c/audit-corpus" && find . -name '*.yo' | sed 's#^\./##' | LC_ALL=C sort) >"$list"
  [ "$LIMIT" -gt 0 ] && { head -n "$LIMIT" "$list" >"$list.lim" && mv "$list.lim" "$list"; }
  mkdir -p "$OUT/results" "$OUT/work"
  echo "(b) corpus: $(wc -l <"$list") programs, --jobs $JOBS, results in $OUT/results"
  export T7_YO=$YO T7_STD=$STD T7_OUT=$OUT T7_CORPUS=$c/audit-corpus T7_CC=${YO_CC:-clang}
  xargs -a "$list" -d '\n' -P "$JOBS" -n 1 bash "$ROOT/scripts/test7.sh" __one
}

case $PHASE in
all)
  # The gates (three serial processes) run beside the corpus's --jobs workers.
  gates &
  corpus
  wait
  ;;
gates) gates ;;
corpus) corpus ;;
classify) ;;
esac

python3 -I "$T7/classify.py" --out "$OUT" --repo "$ROOT" --sha "$SHA"
rc=$?
gd_howto
echo "(d) the adversarial pass: plans/handover/TEST7_ADVERSARIAL_BRIEF.md"
exit $rc
