/**
 * Rewrite `(&(X)).METHOD(...)` → `X.METHOD(...)` for methods that
 * have been migrated from `(self : *(Self))` to `(inout(self) :
 * Self)`. Inout method dispatch auto-wraps the receiver with
 * `&(...)`, so the explicit `&(X)` at the call site now produces
 * `&(&(X))` = `*(*(T))`, which doesn't match the expected `*(T)`.
 *
 * The script takes a method-name allow-list (passed via env var
 * `METHODS` or a hardcoded default list). Receivers `X` can be any
 * balanced expression; we don't touch the receiver, only strip the
 * `&(...)` wrap.
 *
 * Usage:
 *   bun run scripts/migrate-amp-method-calls.ts         # dry-run
 *   bun run scripts/migrate-amp-method-calls.ts --write # apply
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";

const ROOTS = ["std", "yo-self", "tests"];

// Methods migrated to inout(self) : Self in this session, plus the
// emitter/Clone/Hash/ToString migrations from earlier. If a method
// here was actually NOT migrated, no harm — dispatch only changes
// for the migrated ones, and the rewrite stays semantically
// correct (`X.method()` already worked for `*(Self)`-style methods
// via Yo's auto-deref).
const METHODS = [
  // Array / Slice
  "iter",
  "len",
  // String mutators
  "push_str",
  "push_string",
  "push_byte",
  "reserve",
  "clear",
  // StringBuilder
  "is_empty",
  "write_str",
  "write_string",
  "write_byte",
  "write_rune",
  "write_line",
  // Time
  "as_secs",
  "as_millis",
  "as_micros",
  "as_nanos",
  "to_string",
  "duration_since",
  "elapsed",
  // Sync / process / thread
  "lock",
  "unlock",
  "signal",
  "broadcast",
  "wait",
  "spawn",
  "join",
  // Collections inherent (the few that got migrated)
  "trim_to_fit",
  // Existing migrated (Hash, Clone, ToString) — safe no-op if not
  // explicitly wrapped at the call site
  "hash",
  "clone",
];

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
  if (content[i + 1] !== ")") return null;
  return { x, end: i + 2 };
}

function migrate(
  content: string,
  methodSet: Set<string>
): { result: string; rewrites: number } {
  const out: string[] = [];
  let i = 0;
  let rewrites = 0;
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
    // After `(&(X))`, look for `.METHOD(`.
    if (content[wrap.end] !== ".") {
      out.push(content[i]!);
      i++;
      continue;
    }
    // Extract method name.
    const methodMatch = content
      .slice(wrap.end + 1)
      .match(/^([A-Za-z_][A-Za-z0-9_]*)\(/);
    if (!methodMatch) {
      out.push(content[i]!);
      i++;
      continue;
    }
    const method = methodMatch[1]!;
    if (!methodSet.has(method)) {
      out.push(content[i]!);
      i++;
      continue;
    }
    // Rewrite: `(&(X))` → `X`. Keep `.method(` as-is.
    out.push(wrap.x);
    i = wrap.end;
    rewrites++;
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
  const methodsFromEnv = process.env.METHODS;
  const methodList = methodsFromEnv ? methodsFromEnv.split(",") : METHODS;
  const methodSet = new Set(methodList);
  let total = 0;
  let filesTouched = 0;
  for (const root of ROOTS) {
    const absRoot = path.resolve(root);
    for (const filePath of walk(absRoot)) {
      const content = readFileSync(filePath, "utf-8");
      const { result, rewrites } = migrate(content, methodSet);
      if (result === content) continue;
      filesTouched++;
      total += rewrites;
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
    `\n${write ? "Migrated" : "Would migrate"} ${total} call sites across ${filesTouched} file(s).`
  );
  if (!write) console.log("(dry-run — pass --write to apply)");
}

main();
