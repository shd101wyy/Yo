#!/usr/bin/env bash
# Yo's async runtime against libuv on the same box, same workloads:
# scripts/bench/io_bench.yo and its libuv twin
# scripts/bench/async-vs-libuv/io_bench_uv.c — a socketpair echo, loopback-TCP
# echo over 1 and 64 connections, zero-delay timer churn, a 16 KiB file
# write+read cycle. Runs REPS alternating rounds, optionally pinned to one CPU,
# and prints the median ops/s per workload with Yo/libuv ratios (> 1: Yo is
# faster). Informational — wall clock on a shared machine is not a CI gate;
# scripts/io-budget-check.sh is. The std-API-level comparison (TcpStream,
# Channel) is scripts/bench/async-vs-libuv/bench.yo; see its README.
#
# Usage: YO=<yo-binary> YO_STD=<std-dir> [REPS=7] [CPU=<n>] scripts/bench-vs-libuv.sh
# libuv comes from pkg-config (Homebrew: its prefix), or LIBUV_CFLAGS / LIBUV_LIBS. POSIX only (the
# Windows flow is manual: README.md).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
YO="${YO:?set YO to the yo binary}"
: "${YO_STD:?set YO_STD to the std directory}"
REPS="${REPS:-7}"
PIN=()
if [ -n "${CPU:-}" ]; then PIN=(taskset -c "${CPU}"); fi
OUT="$(mktemp -d)"
trap 'rm -rf "${OUT}"' EXIT

# Homebrew's libuv ships no pkg-config file: fall back to its prefix.
UV_PREFIX=""
if ! pkg-config --exists libuv 2>/dev/null && command -v brew >/dev/null 2>&1; then
  UV_PREFIX="$(brew --prefix libuv)"
fi
if [ -n "${UV_PREFIX}" ]; then
  UV_CFLAGS="${LIBUV_CFLAGS:--I${UV_PREFIX}/include}"
  UV_LIBS="${LIBUV_LIBS:--L${UV_PREFIX}/lib -luv}"
else
  UV_CFLAGS="${LIBUV_CFLAGS:-$(pkg-config --cflags libuv)}"
  UV_LIBS="${LIBUV_LIBS:-$(pkg-config --libs libuv)}"
fi
# The epoll-fallback column is Linux's; elsewhere YO_IO_BACKEND means nothing.
LINUX=0
if [ "$(uname -s)" = "Linux" ]; then LINUX=1; fi
# shellcheck disable=SC2086
${CC:-cc} -O2 ${UV_CFLAGS} "${HERE}/bench/async-vs-libuv/io_bench_uv.c" -o "${OUT}/libuv_bench" ${UV_LIBS}
"${YO}" compile "${HERE}/bench/io_bench.yo" --optimize 2 -o "${OUT}/yo_bench" >/dev/null

for r in $(seq "${REPS}"); do
  YO_BENCH_DIR="${OUT}" "${PIN[@]}" "${OUT}/yo_bench" > "${OUT}/yo.${r}"
  if [ "${LINUX}" = 1 ]; then
    YO_IO_BACKEND=epoll YO_BENCH_DIR="${OUT}" "${PIN[@]}" "${OUT}/yo_bench" > "${OUT}/yoe.${r}"
  fi
  YO_BENCH_DIR="${OUT}" "${PIN[@]}" "${OUT}/libuv_bench" > "${OUT}/uv.${r}"
done

median() { # <prefix> <key>: median ops/s of that key over the rounds
  for r in $(seq "${REPS}"); do
    sed -n "s/^${2}_us \([0-9]*\) ops \([0-9]*\).*/\2 \1/p" "${OUT}/${1}.${r}" |
      awk '{ printf "%.0f\n", $1 * 1000000 / $2 }'
  done | sort -n | awk '{ a[NR] = $1 } END { print a[int((NR + 1) / 2)] }'
}

if [ "${LINUX}" != 1 ]; then
  printf '%-10s %14s %14s %9s\n' workload yo libuv yo/uv
  for key in uecho_1 echo_1 echo_conc timer file; do
    y=$(median yo "${key}"); u=$(median uv "${key}")
    printf '%-10s %14s %14s %9.2f\n' "${key}" "${y}" "${u}" "$(awk "BEGIN{print ${y}/${u}}")"
  done
  exit 0
fi
printf '%-10s %14s %14s %14s %9s %9s\n' workload yo-uring yo-epoll libuv uring/uv epoll/uv
for key in uecho_1 echo_1 echo_conc timer file; do
  y=$(median yo "${key}"); e=$(median yoe "${key}"); u=$(median uv "${key}")
  printf '%-10s %14s %14s %14s %9.2f %9.2f\n' "${key}" "${y}" "${e}" "${u}" \
    "$(awk "BEGIN{print ${y}/${u}}")" "$(awk "BEGIN{print ${e}/${u}}")"
done
