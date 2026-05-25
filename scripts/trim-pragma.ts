#!/usr/bin/env bun
/**
 * Remove `pragma(Pragma.AllowUnsafe);` from files that don't actually
 * need it — i.e., files that don't contain any `unsafe(...)`,
 * `asm(...)`, or `extern(...)` calls.
 *
 * Phase C of plans/MEMORY_SAFETY.md added the pragma to every file
 * under `std/`, `yo-self/`, and `tests/` mechanically. Many tests
 * (and a few stdlib files) don't actually exercise raw-pointer
 * machinery; the pragma was added defensively. Removing it from
 * those files makes the test suite a better demonstration of
 * "safe user code by default" and shrinks the auditable surface.
 *
 * Safety: we only consider a file "needs pragma" if it contains a
 * direct `unsafe(`, `asm(`, or `extern(` call site (matched outside
 * comments/strings, same heuristic as `yo unsafe-report`). If the
 * file imports a stdlib module whose public API takes `*(T)`, the
 * file still compiles in safe mode (per the current Phase C
 * implementation — see "Known gaps" in plans/MEMORY_SAFETY.md).
 *
 * Usage:
 *   bun scripts/trim-pragma.ts <file.yo> [more...]
 *   bun scripts/trim-pragma.ts --dry-run <file.yo> [more...]
 */

import { readFileSync, writeFileSync, statSync } from "fs";
import { argv } from "process";

const dryRun = argv.includes("--dry-run");
const files = argv.slice(2).filter((a) => a !== "--dry-run");

const PRAGMA_LINE_RE = /^pragma\(Pragma\.AllowUnsafe\);\s*$/m;

/**
 * Strip line-comments and string literals from a line so that
 * matches inside `"unsafe(...)"` or `// asm(...)` don't count.
 */
function strip(line: string): string {
  const out: string[] = [];
  let inStr: string | null = null;
  let i = 0;
  while (i < line.length) {
    const ch = line[i]!;
    if (!inStr && ch === "/" && line[i + 1] === "/") break;
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
    out.push(ch);
    i++;
  }
  return out.join("");
}

function fileNeedsPragma(src: string): { needs: boolean; reason?: string } {
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const s = strip(lines[i]!);
    if (/\bunsafe\(/.test(s))
      return { needs: true, reason: `unsafe(...) at line ${i + 1}` };
    if (/(?:^|[^A-Za-z0-9_])asm\(/.test(s))
      return { needs: true, reason: `asm(...) at line ${i + 1}` };
    if (/(?:^|[^A-Za-z0-9_])extern\(/.test(s))
      return { needs: true, reason: `extern(...) at line ${i + 1}` };
    // Bare pointer-op sites that would fire the Phase A gate without
    // a pragma. Without these checks we'd strip pragma from files
    // like tests/ptr.test.yo that use `.*` / `&+` directly without
    // wrapping in unsafe(...) (the pragma currently bypasses the
    // gate so those work). Files like that should keep their pragma
    // until/unless the pointer ops are wrapped in unsafe(...).
    if (/\.\*(?:[^A-Za-z0-9_]|$)/.test(s))
      return { needs: true, reason: `bare .* deref at line ${i + 1}` };
    if (/(?:^|[^A-Za-z0-9_&])&\+|&-(?!=)|&\//.test(s))
      return {
        needs: true,
        reason: `bare pointer arithmetic (&+/&-/&/) at line ${i + 1}`,
      };
  }
  return { needs: false };
}

function processFile(file: string): "removed" | "kept" | "no-pragma" | "skip" {
  try {
    if (!statSync(file).isFile()) return "skip";
  } catch {
    return "skip";
  }
  const src = readFileSync(file, "utf8");
  if (!PRAGMA_LINE_RE.test(src)) return "no-pragma";

  const { needs, reason } = fileNeedsPragma(src);
  if (needs) {
    if (dryRun) console.log(`keep: ${file} (${reason})`);
    return "kept";
  }

  // Remove the pragma line. Also remove a trailing blank line if it
  // creates an awkward double-blank.
  const next = src
    .replace(/^pragma\(Pragma\.AllowUnsafe\);\n/m, "")
    .replace(/^pragma\(Pragma\.AllowUnsafe\);\s*\n/m, "");

  if (dryRun) {
    console.log(`would-remove: ${file}`);
    return "removed";
  }

  writeFileSync(file, next);
  console.log(`removed: ${file}`);
  return "removed";
}

const counts = { removed: 0, kept: 0, "no-pragma": 0, skip: 0 };
for (const file of files) {
  const r = processFile(file);
  counts[r]++;
}
console.log(
  `\nsummary: removed=${counts.removed}, kept=${counts.kept}, no-pragma=${counts["no-pragma"]}, skipped=${counts.skip}`
);
