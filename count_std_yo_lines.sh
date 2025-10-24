#!/usr/bin/env bash

# Check if std directory exists
if [ ! -d "std" ]; then
  echo "Error: 'std' directory not found"
  exit 1
fi

# Count total lines in all TypeScript files in src directory
total_lines=$(find src -name "*.yo" -type f -exec wc -l {} \; | awk '{ sum += $1 } END { print sum }')

echo "Total lines in Yo files in src directory: $total_lines"
