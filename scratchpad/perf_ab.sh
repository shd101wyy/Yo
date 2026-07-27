#!/usr/bin/env bash
# A/B timing harness: alternate two yo-self binaries over the same workload so
# machine drift hits both arms equally. Reports user+real per rep.
#
# Usage: scratchpad/perf_ab.sh <binA> <binB> [reps]
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 2

A="$1"; B="$2"; REPS="${3:-3}"
WORKLOAD=(check ./std)

run_one() {
  local bin="$1" tag="$2" rep="$3"
  local of="/tmp/perf_ab_${tag}_${rep}.out" tf="/tmp/perf_ab_${tag}_${rep}.time"
  /usr/bin/time -p "$bin" "${WORKLOAD[@]}" >"$of" 2>"$tf"
  local real user summary
  real=$(awk '/^real/{print $2}' "$tf")
  user=$(awk '/^user/{print $2}' "$tf")
  summary=$(grep -o '[0-9]*/[0-9]* file(s) passed' "$of" | tail -1)
  echo "$tag rep$rep real=${real}s user=${user}s | ${summary:-NO-SUMMARY}"
  echo "$user" >>"/tmp/perf_ab_${tag}.user"
  echo "$real" >>"/tmp/perf_ab_${tag}.real"
}

rm -f /tmp/perf_ab_[AB].user /tmp/perf_ab_[AB].real
"$A" --version >/dev/null 2>&1; "$B" --version >/dev/null 2>&1

for r in $(seq 1 "$REPS"); do
  run_one "$A" A "$r"
  run_one "$B" B "$r"
done

echo "--- summary ---"
for m in user real; do
  for t in A B; do
    awk -v t="$t" -v m="$m" '{s+=$1; if(min==""||$1<min)min=$1; n++} END{printf "%s %s: n=%d min=%.2f mean=%.2f\n", t, m, n, min, s/n}' "/tmp/perf_ab_${t}.${m}"
  done
done
awk 'NR==FNR{if(a==""||$1<a)a=$1; next} {if(b==""||$1<b)b=$1} END{printf "B/A (min user) = %.4f  => %+.1f%%\n", b/a, (b/a-1)*100}' /tmp/perf_ab_A.user /tmp/perf_ab_B.user
