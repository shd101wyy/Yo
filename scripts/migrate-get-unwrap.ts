/**
 * Replace `X.get(IDX).unwrap()` with `X(IDX)`.
 *
 * `X.get(idx)` on an indexable type (ArrayList, Deque, HashMap,
 * BTreeMap, String, Array, imm Vec, etc.) returns `Option(T)`.
 * Calling `.unwrap()` panics on a missing element. Yo's Index-trait
 * call-syntax `X(idx)` returns `T` directly and panics identically
 * (via the trait's bounds assertion).
 *
 * The substitution is safe whenever:
 *   1. `X.get(...)` has exactly ONE argument.
 *   2. `X` is followed by `.get(...)` then immediately `.unwrap()`.
 *   3. The receiver type implements Index — for which we have no
 *      type info here, but it covers the vast majority of cases
 *      since Option/Result don't have `.get(IDX)` shape (Option has
 *      no `.get` at all; Result.ok() returns Option).
 *
 * Skipped:
 *   - `X.get(K, V).unwrap()` — multi-arg get (not Index trait).
 *   - `X.get().unwrap()` — zero-arg get.
 *   - Bare `.get(...)` without `.unwrap()`.
 *   - Anything followed by another `.method(...)` chain after
 *     `.unwrap()` — we leave the result chain alone (still works
 *     since `X(i)` returns the same type as `X.get(i).unwrap()`).
 *
 * Usage:
 *   bun run scripts/migrate-get-unwrap.ts         # dry-run
 *   bun run scripts/migrate-get-unwrap.ts --write # apply
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";

const ROOTS = ["std", "yo-self", "tests"];

/**
 * Walk a balanced parenthesized group starting at `start` (where
 * `content[start]` is `(`). Returns the inner content and the index
 * just after the closing `)`. Returns null on unbalanced input.
 */
function matchBalancedParens(
  content: string,
  start: number
): { inner: string; end: number } | null {
  if (content[start] !== "(") return null;
  let depth = 1;
  let i = start + 1;
  const innerStart = i;
  while (i < content.length) {
    const ch = content[i]!;
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) {
        return { inner: content.slice(innerStart, i), end: i + 1 };
      }
    }
    i++;
  }
  return null;
}

/**
 * Count top-level commas in `s` — useful for detecting multi-arg
 * function calls. Skips commas inside nested parens / brackets / braces.
 */
function topLevelCommaCount(s: string): number {
  let count = 0;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) count++;
  }
  return count;
}

function migrate(content: string): { result: string; rewrites: number } {
  let rewrites = 0;
  // We scan for the literal `.get(`, then walk:
  //   ... `.get(` BALANCED `)` `.unwrap()`
  // and rewrite the entire span back to `(` BALANCED `)`.
  //
  // The receiver `X` is whatever precedes `.get(`. We DO NOT rewrite
  // the receiver — just leave it in place and append `(args)` after
  // it. That way `foo.bar.get(i).unwrap()` becomes `foo.bar(i)`.
  const out: string[] = [];
  let i = 0;
  while (i < content.length) {
    const idx = content.indexOf(".get(", i);
    if (idx === -1) {
      out.push(content.slice(i));
      break;
    }
    out.push(content.slice(i, idx));
    const argStart = idx + 4;
    const args = matchBalancedParens(content, argStart);
    if (!args) {
      out.push(content[i]!);
      i++;
      continue;
    }
    // Check for `.unwrap()` immediately after.
    if (content.slice(args.end, args.end + 9) !== ".unwrap()") {
      // Not a `.get(IDX).unwrap()` pair — leave alone.
      out.push(content.slice(idx, args.end));
      i = args.end;
      continue;
    }
    // Require exactly one top-level arg (skip empty-arg get, skip
    // 2+arg get). Allow whitespace-only emptiness check.
    if (args.inner.trim().length === 0 || topLevelCommaCount(args.inner) > 0) {
      out.push(content.slice(idx, args.end + 9));
      i = args.end + 9;
      continue;
    }
    // Rewrite: `.get(IDX).unwrap()` → `(IDX)`.
    out.push(`(${args.inner})`);
    rewrites++;
    i = args.end + 9; // skip past `.unwrap()`
  }
  return { result: out.join(""), rewrites };
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
  let totalRewrites = 0;
  let filesTouched = 0;
  for (const root of ROOTS) {
    const absRoot = path.resolve(root);
    for (const filePath of walk(absRoot)) {
      const content = readFileSync(filePath, "utf-8");
      const { result, rewrites } = migrate(content);
      if (result === content) continue;
      filesTouched++;
      totalRewrites += rewrites;
      console.log(
        `${write ? "migrated" : "would migrate"}: ${path.relative(
          process.cwd(),
          filePath
        )} (${rewrites})`
      );
      if (write) writeFileSync(filePath, result, "utf-8");
    }
  }
  console.log(
    `\n${write ? "Migrated" : "Would migrate"} ${totalRewrites} rewrites across ${filesTouched} file(s).`
  );
  if (!write) console.log("(dry-run — pass --write to apply)");
}

main();
