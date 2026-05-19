#!/usr/bin/env bun
/**
 * Add `pragma(Pragma.AllowUnsafe);` at the top of every .yo file
 * passed on the command line, unless it already has one.
 *
 * Phase C of plans/MEMORY_SAFETY.md: explicit per-file pragma replaces
 * the path-based MVP heuristic. Run this once over `std/`, `yo-self/`,
 * and `tests/` during the migration.
 *
 * Heuristics:
 * - Skip the prelude itself (it defines `Pragma`; the pragma in the
 *   prelude is placed by hand, mid-file, after `Pragma :: enum(...)`).
 * - Skip files that already contain `pragma(Pragma.AllowUnsafe);`.
 * - Insert after any leading `//` line comments at the top of the file
 *   so the docstring stays visually at the top.
 */

import { readFileSync, writeFileSync, statSync } from "fs";
import { argv } from "process";

const PRAGMA_LINE = "pragma(Pragma.AllowUnsafe);";

function processFile(file: string): "added" | "already" | "skip" {
  const src = readFileSync(file, "utf8");
  if (file.endsWith("/std/prelude.yo")) return "skip";
  if (src.includes(PRAGMA_LINE)) return "already";

  const lines = src.split("\n");
  // Find first non-comment, non-blank line; insert pragma above it.
  let insertAt = 0;
  while (insertAt < lines.length) {
    const ln = lines[insertAt]!.trim();
    if (ln === "" || ln.startsWith("//") || ln.startsWith("/*")) {
      insertAt++;
    } else {
      break;
    }
  }
  lines.splice(insertAt, 0, PRAGMA_LINE);
  writeFileSync(file, lines.join("\n"));
  return "added";
}

let added = 0;
let already = 0;
let skip = 0;
for (const file of argv.slice(2)) {
  try {
    if (!statSync(file).isFile()) continue;
  } catch {
    continue;
  }
  const r = processFile(file);
  if (r === "added") added++;
  else if (r === "already") already++;
  else skip++;
}
console.log(`added: ${added}, already: ${already}, skipped: ${skip}`);
