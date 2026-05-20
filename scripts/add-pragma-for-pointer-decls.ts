#!/usr/bin/env bun
/**
 * Re-add `pragma(Pragma.AllowUnsafe);` to files that mention raw
 * pointer types in their declarations (e.g. `*(u8)` in a parameter,
 * field, or return slot, or `&(x)` to take an address).
 *
 * Phase C tightened the structural gate so that `*(T)` and `&(...)`
 * are themselves rejected in safe code — not just `unsafe(...)`-
 * wrapped ops like `.* ` and `&+`. The previous trim pass
 * (scripts/trim-pragma.ts) removed the pragma from files that used
 * only declarations, which now need it back.
 *
 * Detection: file contains `*(<word>` or `&(<word>` outside string
 * literals / comments. The heuristic is loose on purpose — better
 * to over-add the pragma than to leave a file failing to compile.
 *
 * Usage:
 *   bun scripts/add-pragma-for-pointer-decls.ts <root-dir>
 */

import { readFileSync, writeFileSync, statSync, readdirSync } from "fs";
import { join } from "path";
import { argv, exit } from "process";

const PRAGMA_LINE = "pragma(Pragma.AllowUnsafe);";

function stripCommentsAndStrings(src: string): string {
  const out: string[] = [];
  let inStr: string | null = null;
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (!inStr && ch === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (inStr) {
      if (ch === "\\") {
        out.push(" ", " ");
        i += 2;
        continue;
      }
      if (ch === inStr) {
        inStr = null;
        out.push(" ");
        i++;
        continue;
      }
      out.push(" ");
      i++;
      continue;
    }
    if (ch === '"' || ch === "`") {
      inStr = ch;
      out.push(" ");
      i++;
      continue;
    }
    out.push(ch);
    i++;
  }
  return out.join("");
}

const POINTER_TYPE_RE = /\*\(/;
const ADDRESS_OF_RE = /(?:^|[^A-Za-z0-9_])&\(/;

function fileNeedsPragma(src: string): boolean {
  const cleaned = stripCommentsAndStrings(src);
  return POINTER_TYPE_RE.test(cleaned) || ADDRESS_OF_RE.test(cleaned);
}

function fileHasPragma(src: string): boolean {
  return src.includes("pragma(Pragma.AllowUnsafe)");
}

/**
 * Insert the pragma after any leading `//!` module-doc lines and
 * before the first code declaration. Empty files get the pragma at
 * the top.
 */
function insertPragma(src: string): string {
  const lines = src.split("\n");
  let insertAt = 0;
  // Skip leading shebang / module-doc / blank / line-comment.
  while (insertAt < lines.length) {
    const trimmed = lines[insertAt]!.trim();
    if (
      trimmed === "" ||
      trimmed.startsWith("#!") ||
      trimmed.startsWith("//!") ||
      trimmed.startsWith("//")
    ) {
      insertAt++;
      continue;
    }
    break;
  }
  lines.splice(insertAt, 0, PRAGMA_LINE);
  return lines.join("\n");
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      walk(p, out);
    } else if (s.isFile() && p.endsWith(".yo")) {
      out.push(p);
    }
  }
}

const root = argv[2];
if (!root) {
  console.error(`usage: bun ${argv[1]} <root-dir>`);
  exit(1);
}

const files: string[] = [];
walk(root, files);

let added = 0;
for (const file of files) {
  const src = readFileSync(file, "utf8");
  if (fileHasPragma(src)) continue;
  if (!fileNeedsPragma(src)) continue;
  writeFileSync(file, insertPragma(src));
  added++;
  console.log(`added pragma: ${file}`);
}
console.log(`---\nadded pragma to ${added} file(s).`);
