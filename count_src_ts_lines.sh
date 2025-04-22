#!/usr/bin/env bash

# Check if src directory exists
if [ ! -d "src" ]; then
  echo "Error: 'src' directory not found"
  exit 1
fi

# Count total lines in all TypeScript files in src directory
total_lines=$(find src -name "*.ts" -type f -exec wc -l {} \; | awk '{ sum += $1 } END { print sum }')

echo "Total lines in TypeScript files in src directory: $total_lines"
