#!/usr/bin/env bash
# What std's single-await I/O wrappers cost over the raw runtime ops under them
# (plans/backlog/ASYNC_AWAIT_SITE_FUSION.md, F0): an 8-connection TCP ping-pong
# awaiting IO_tcp.recv/send directly vs TcpStream.read/write, and a loop of
# one-byte sends that all complete inline. Runs REPS interleaved rounds and
# prints the medians and std/raw (1.00: the wrapper costs nothing). Wall clock:
# informational on a shared machine, not a CI gate.
#
# Usage: YO=<yo-binary> YO_STD=<std-dir> [REPS=7] scripts/bench-std-vs-raw.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
YO="${YO:?set YO to the yo binary}"
: "${YO_STD:?set YO_STD to the std directory}"
REPS="${REPS:-7}"
OUT="$(mktemp -d)"
trap 'rm -rf "${OUT}"' EXIT
"${YO}" compile "${HERE}/bench/async-vs-libuv/std_vs_raw.yo" --optimize 2 -o "${OUT}/bench" >/dev/null
MODES="pp_raw pp_std wr_raw wr_std"
for r in $(seq "${REPS}"); do
  for m in ${MODES}; do
    MODE="${m}" "${OUT}/bench" >> "${OUT}/${m}"
  done
done
median() { # <mode>: median of its `<mode>_ns N` lines
  sed -n "s/^${1}_ns \([0-9]*\).*/\1/p" "${OUT}/${1}" | sort -n |
    awk '{ a[NR] = $1 } END { print a[int((NR + 1) / 2)] }'
}
printf '%-26s %10s %10s %8s\n' workload raw std std/raw
for w in pp wr; do
  raw=$(median "${w}_raw"); std=$(median "${w}_std")
  label=$([ "${w}" = pp ] && echo "8-conn ping-pong (ns/rt)" || echo "inline send (ns/op)")
  printf '%-26s %10s %10s %8.2f\n' "${label}" "${raw}" "${std}" "$(awk "BEGIN{print ${std}/${raw}}")"
done
