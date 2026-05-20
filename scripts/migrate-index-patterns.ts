/**
 * Replace verbose `(&(X)).index(i).*` patterns with the Rust-like
 * `X(i)` indexing syntax that Yo natively supports.
 *
 * Patterns rewritten (most → least common):
 *
 *   1. WRITE:   `(&(X)).index(I).* = V;`          →  `X(I) = V;`
 *   2. READ.X:  `(&(X)).index(I).*.PROP`          →  `X(I).PROP`
 *   3. READ:    `(&(X)).index(I).*`               →  `X(I)`
 *      (anywhere `X(I)` would parse the same way — i.e. used as a
 *      value, not as a pointer target for another `.*` op.)
 *
 * Patterns deliberately NOT touched:
 *
 *   - `ptr := (&(X)).index(I)`  — author wanted the pointer; leave
 *     it. Rewriting would change the semantics (you'd get `T` not
 *     `*(T)`).
 *   - `(&(X)).index(I)` followed by anything else (e.g. another
 *     method call on the pointer). Conservative — only the three
 *     shapes above are touched.
 *
 * For `X`: any balanced expression (handles nesting like
 * `(&(frame.variables))`, `(&(a.b.c))`, etc).
 *
 * Usage:
 *   bun run scripts/migrate-index-patterns.ts         # dry-run
 *   bun run scripts/migrate-index-patterns.ts --write # apply
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";

const ROOTS = ["std", "yo-self", "tests"];

interface Stats {
  writes: number;
  readDotProp: number;
  readStandalone: number;
}

/**
 * Match `(&(X))` at `start` and return the index just after the
 * closing `))`, or null if no match. Returns the balanced inner `X`
 * (paren-balanced).
 */
function matchAmpersandWrap(
  content: string,
  start: number
): { x: string; end: number } | null {
  if (content.slice(start, start + 3) !== "(&(") return null;
  let depth = 1;
  let i = start + 3;
  const xStart = i;
  while (i < content.length) {
    const ch = content[i]!;
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) break;
    }
    i++;
  }
  if (i >= content.length) return null;
  const x = content.slice(xStart, i);
  // i points at the closing `)` of the inner. Next char should be
  // the outer closing `)`.
  if (content[i + 1] !== ")") return null;
  return { x, end: i + 2 };
}

/**
 * Match `.index(I)` starting at `start`. Returns the index argument
 * and the position just after the closing `)`.
 */
function matchIndexCall(
  content: string,
  start: number
): { idx: string; end: number } | null {
  if (content.slice(start, start + 7) !== ".index(") return null;
  let depth = 1;
  let i = start + 7;
  const idxStart = i;
  while (i < content.length) {
    const ch = content[i]!;
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) break;
    }
    i++;
  }
  if (i >= content.length) return null;
  const idx = content.slice(idxStart, i);
  return { idx, end: i + 1 };
}

function migrate(content: string): { result: string; stats: Stats } {
  const stats: Stats = { writes: 0, readDotProp: 0, readStandalone: 0 };
  const out: string[] = [];
  let i = 0;
  while (i < content.length) {
    if (content.slice(i, i + 3) !== "(&(") {
      out.push(content[i]!);
      i++;
      continue;
    }
    const wrap = matchAmpersandWrap(content, i);
    if (!wrap) {
      out.push(content[i]!);
      i++;
      continue;
    }
    const idxCall = matchIndexCall(content, wrap.end);
    if (!idxCall) {
      out.push(content[i]!);
      i++;
      continue;
    }
    // Now check what follows .index(I).
    if (content.slice(idxCall.end, idxCall.end + 2) !== ".*") {
      // `(&(X)).index(I)` not followed by `.*` — leave alone (author
      // wanted the raw pointer).
      out.push(content[i]!);
      i++;
      continue;
    }
    // After `.*`, decide which variant.
    const afterStar = idxCall.end + 2;
    const trailing = content.slice(afterStar);

    // WRITE: `(&(X)).index(I).* = V` — match ` = ` (with whitespace).
    const writeMatch = trailing.match(/^\s*=\s*/);
    // READ.X: `(&(X)).index(I).*.PROP` — match `.`
    const readDotMatch = trailing.match(/^\.([A-Za-z_])/);

    if (writeMatch) {
      out.push(`${wrap.x}(${idxCall.idx})${writeMatch[0]}`);
      i = afterStar + writeMatch[0].length;
      stats.writes++;
      continue;
    }
    if (readDotMatch) {
      out.push(`${wrap.x}(${idxCall.idx})`);
      // Skip the `.*` but keep the trailing `.` and identifier.
      i = afterStar;
      stats.readDotProp++;
      continue;
    }
    // Standalone read — `.*` is the end. Yo's `X(i)` returns T (same
    // as `.*` of the pointer). Safe to rewrite when the next char
    // is a separator (newline, `,`, `)`, `;`, etc.).
    const nextCh = trailing[0] ?? "";
    if (/[\s,);}\]]/.test(nextCh) || nextCh === "") {
      out.push(`${wrap.x}(${idxCall.idx})`);
      i = afterStar;
      stats.readStandalone++;
      continue;
    }
    // Anything else following `.*` (e.g. another operator like `&+`)
    // — leave alone to be safe.
    out.push(content[i]!);
    i++;
  }
  return { result: out.join(""), stats };
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".")) continue;
    const fullPath = path.join(dir, entry);
    const st = statSync(fullPath);
    if (st.isDirectory()) {
      yield* walk(fullPath);
    } else if (st.isFile() && entry.endsWith(".yo")) {
      yield fullPath;
    }
  }
}

function main(): void {
  const write = process.argv.includes("--write");
  const totals: Stats = { writes: 0, readDotProp: 0, readStandalone: 0 };
  let filesTouched = 0;
  for (const root of ROOTS) {
    const absRoot = path.resolve(root);
    for (const filePath of walk(absRoot)) {
      const content = readFileSync(filePath, "utf-8");
      const { result, stats } = migrate(content);
      if (result === content) continue;
      filesTouched++;
      totals.writes += stats.writes;
      totals.readDotProp += stats.readDotProp;
      totals.readStandalone += stats.readStandalone;
      console.log(
        `${write ? "migrated" : "would migrate"}: ${path.relative(
          process.cwd(),
          filePath
        )} (writes=${stats.writes}, read.prop=${stats.readDotProp}, read=${stats.readStandalone})`
      );
      if (write) writeFileSync(filePath, result, "utf-8");
    }
  }
  console.log(
    `\n${write ? "Migrated" : "Would migrate"} ${filesTouched} file(s): ` +
      `${totals.writes} writes, ${totals.readDotProp} read-then-prop, ${totals.readStandalone} standalone reads.`
  );
  if (!write) console.log("(dry-run — pass --write to apply)");
}

main();
