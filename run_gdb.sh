#!/bin/bash
for i in {1..10}; do
  echo "=== Attempt $i ==="
  gdb -batch -ex "run" -ex "bt" -ex "quit" ./test_fixme_debug 2>&1 | grep -A20 "SIGSEGV\|segmentation fault" && break
  if [ $? -eq 0 ]; then
    echo "No crash on attempt $i, trying again..."
  fi
done
