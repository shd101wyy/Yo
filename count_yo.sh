#!/usr/bin/env bash
set -euo pipefail

dirs=("./std" "./src" "./tests")

for dir in "${dirs[@]}"; do
  if [ ! -d "$dir" ]; then
    echo "$dir: directory not found"
    continue
  fi
  files=$(find "$dir" -name '*.yo' -type f | sort)
  count=$(echo "$files" | grep -c '\.yo$' || true)
  if [ "$count" -eq 0 ]; then
    echo "$dir: 0 files, 0 lines"
    continue
  fi
  lines=$(echo "$files" | xargs wc -l | tail -1 | awk '{print $1}')
  echo "$dir: $count files, $lines lines"
done
