#!/usr/bin/env bun
/**
 * Migrate `(&(x)).clone()` to `x.clone()` in the given files.
 *
 * Phase D of plans/MEMORY_SAFETY.md: Clone trait now takes
 * `inout(self) : Self` instead of `(self : *(Self))`, so the old
 * pattern `(&(x)).clone()` (passing a `*(T)` to a `*(Self)` receiver)
 * no longer matches. The caller can just write `x.clone()` and the
 * compiler auto-wraps for the inout calling convention.
 *
 * Match: `(&(EXPR)).clone()` — handles balanced parens inside EXPR.
 * Replace with `EXPR.clone()`. Conservative: only single-line matches.
 */

import { readFileSync, writeFileSync } from "fs";
import { argv } from "process";

function matchedClose(s: string, openPos: number): number {
  // openPos is the position of `(`. Return position of matching `)`.
  let depth = 1;
  let i = openPos + 1;
  let inStr: string | null = null;
  while (i < s.length) {
    const ch = s[i]!;
    if (inStr) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === inStr) inStr = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "`") {
      inStr = ch;
      i++;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

function migrate(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    // Look for `(&(` start.
    if (src.slice(i, i + 3) === "(&(") {
      const inner_open = i + 2; // position of inner `(`
      const inner_close = matchedClose(src, inner_open);
      if (inner_close < 0) {
        out += src[i]!;
        i++;
        continue;
      }
      const outer_close = matchedClose(src, i);
      if (outer_close < 0 || outer_close !== inner_close + 1) {
        out += src[i]!;
        i++;
        continue;
      }
      // Check that the trailing chars are `.clone()`.
      const trailing = src.slice(outer_close + 1, outer_close + 9);
      if (trailing === ".clone()") {
        const inner = src.slice(inner_open + 1, inner_close);
        out += `${inner}.clone()`;
        i = outer_close + 9;
        continue;
      }
    }
    out += src[i]!;
    i++;
  }
  return out;
}

let changed = 0;
for (const file of argv.slice(2)) {
  const src = readFileSync(file, "utf8");
  const next = migrate(src);
  if (next !== src) {
    writeFileSync(file, next);
    changed++;
    console.log(`migrated: ${file}`);
  }
}
console.log(`done: ${changed} file(s) changed`);
