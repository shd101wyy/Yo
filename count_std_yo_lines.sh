#!/usr/bin/env bash

# Check if std directory exists
if [ ! -d "std" ]; then
  echo "Error: 'std' directory not found"
  exit 1
fi

# Count total lines in all TypeScript files in std directory
total_lines=$(find std -name "*.yo" -type f -exec wc -l {} \; | awk '{ sum += $1 } END { print sum }')

echo "Total lines in Yo files in ./std directory: $total_lines"
