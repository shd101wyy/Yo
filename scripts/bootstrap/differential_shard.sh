#!/usr/bin/env bash
# Assign tests/internal/*.test.yo to the self-hosted differential shards
# (`compiler-internal-tests-selfhosted` in .github/workflows/test.yml) by
# measured duration, so every shard gets about the same predicted time.
#
#   scripts/bootstrap/differential_shard.sh <shard> <count>   # that shard's files, one per line
#   scripts/bootstrap/differential_shard.sh --table <count>   # every shard: predicted minutes + files
#
# Longest-processing-time first: files sorted by weight (heaviest first, ties
# by path), each placed on the shard with the least predicted time so far
# (ties to the lowest shard). Weights come from differential-shard-weights.tsv
# beside this script; a file missing there gets DEFAULT_MINUTES and a
# `::warning::` on stderr. Within a shard, files run in sorted path order.
#
# The result depends only on the file list and the table, so it is the same
# on every machine. Like any assignment, adding one file can move others.
set -euo pipefail

DEFAULT_MINUTES=10

usage() {
  echo "usage: $0 <shard> <count> | $0 --table <count>" >&2
  exit 2
}

[ $# -eq 2 ] || usage
mode=files
if [ "$1" = "--table" ]; then
  mode=table
  shard=-1
else
  shard=$1
fi
count=$2
case "$count" in '' | *[!0-9]*) usage ;; esac
[ "$count" -ge 1 ] || usage
if [ "$mode" = files ]; then
  case "$shard" in '' | *[!0-9]*) usage ;; esac
  [ "$shard" -lt "$count" ] || usage
fi

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
weights=scripts/bootstrap/differential-shard-weights.tsv

# path -> weight in tenths of a minute (integers keep the sums exact).
assignment=$(
  for f in tests/internal/*.test.yo; do echo "$f"; done |
    awk -v def="$DEFAULT_MINUTES" '
      FNR == NR {
        if ($0 ~ /^[[:space:]]*(#|$)/) next
        w[$1] = int($2 * 10 + 0.5)
        next
      }
      {
        if ($1 in w) { print w[$1] "\t" $1 }
        else {
          print "::warning file=" $1 "::no measured weight in scripts/bootstrap/differential-shard-weights.tsv; assuming " def " min" > "/dev/stderr"
          print int(def * 10) "\t" $1
        }
      }
    ' "$weights" - |
    LC_ALL=C sort -t "$(printf '\t')" -k1,1nr -k2,2 |
    awk -v n="$count" -F '\t' '
      BEGIN { for (s = 0; s < n; s++) load[s] = 0 }
      {
        best = 0
        for (s = 1; s < n; s++) if (load[s] < load[best]) best = s
        load[best] += $1
        print best "\t" $2 "\t" $1
      }
    '
)

if [ "$mode" = files ]; then
  printf '%s\n' "$assignment" | awk -F '\t' -v s="$shard" '$1 == s { print $2 }' | LC_ALL=C sort
  exit 0
fi

for ((s = 0; s < count; s++)); do
  printf '%s\n' "$assignment" | awk -F '\t' -v s="$s" '
    $1 == s { t += $3; n++; files[n] = $2; mins[$2] = $3 }
    END {
      printf "== shard %d: %.1f min predicted, %d files\n", s, t / 10, n
      # sorted path order, matching the run order
      for (i = 1; i <= n; i++) for (j = i + 1; j <= n; j++) if (files[j] < files[i]) { x = files[i]; files[i] = files[j]; files[j] = x }
      for (i = 1; i <= n; i++) printf "  %5.1f  %s\n", mins[files[i]] / 10, files[i]
    }
  '
done
