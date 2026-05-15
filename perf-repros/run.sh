#!/bin/sh
# Compile a baseline + slow form of a perf repro back-to-back and
# print wall time + the top tryToCall callees by self-time for each.
#
# Usage: perf-repros/run.sh <repro-name>
#   e.g. perf-repros/run.sh ts-nested-tostring
set -eu

if [ "$#" -lt 1 ]; then
  echo "Usage: $0 <repro-name>" >&2
  echo "" >&2
  echo "Available repros:" >&2
  for d in perf-repros/*/; do
    [ -d "$d" ] && echo "  - $(basename "$d")" >&2
  done
  exit 64
fi

name="$1"
dir="perf-repros/$name"
if [ ! -d "$dir" ]; then
  echo "$0: no such repro: $name" >&2
  exit 64
fi

if [ ! -x ./yo-cli ]; then
  echo "$0: ./yo-cli not found; run 'bun run build' first" >&2
  exit 70
fi

run_one() {
  variant="$1"
  src="$dir/$variant.yo"
  if [ ! -f "$src" ]; then
    echo "$0: missing $src" >&2
    return 1
  fi
  out="/tmp/yo-perf-repro-${name}-${variant}.c"
  echo "=== $variant ==="
  log="/tmp/yo-perf-repro-${name}-${variant}.log"
  YO_DEBUG_CALL_PROFILE=1 /usr/bin/time -p ./yo-cli compile "$src" \
    --skip-c-compiler --emit-c -o "$out" >"$log" 2>&1
  grep -E "^real|^user" "$log" | head -2
  grep -E "Total self-time|tryToCallFunctionWithArguments:" "$log" | head -2
  grep -E "µs/call" "$log" | head -8
  echo ""
}

run_one baseline
run_one slow
