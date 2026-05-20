/**
 * Migrate the Index trait's `index` method from `(self : *(Self))`
 * to `(inout(self) : Self)`. Same shape as the earlier Iterator
 * migration.
 *
 * Walks every `index : (fn(self : *(Self), ...) -> *(Self.Output))
 * ({ body })` impl and:
 *   1. Rewrites the signature.
 *   2. Replaces `self.*` with `self` inside the method body only.
 *
 * Usage:
 *   bun run scripts/migrate-index-trait.ts          # dry-run
 *   bun run scripts/migrate-index-trait.ts --write  # apply
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";

const ROOTS = ["std", "yo-self", "tests"];

interface Stats {
  sigs: number;
  derefs: number;
}

function migrate(content: string): { result: string; stats: Stats } {
  const stats: Stats = { sigs: 0, derefs: 0 };
  const out: string[] = [];
  let i = 0;
  // Index sigs always have a trailing comma after `*(Self)` (because
  // there's always an `idx : ...` parameter): `index : (fn(self : *(Self),`
  const sigStart = /index : \(fn\(self : \*\(Self\),/g;

  while (i < content.length) {
    sigStart.lastIndex = i;
    const m = sigStart.exec(content);
    if (!m) {
      out.push(content.slice(i));
      break;
    }
    const startIdx = m.index;
    out.push(content.slice(i, startIdx));
    out.push("index : (fn(inout(self) : Self,");
    stats.sigs++;
    let j = startIdx + m[0].length;

    // The regex consumed `index : (fn(self : *(Self),` which opened
    // two more parens than it closed (the outer `(` after `:` and
    // the `(` after `fn`). We need to walk to where those *outer*
    // parens close — past `idx : ..., ...) -> *(Self.Output))`.
    let depth = 2;
    while (j < content.length) {
      const ch = content[j]!;
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) {
          j++;
          break;
        }
      }
      j++;
    }
    out.push(content.slice(startIdx + m[0].length, j));

    // Walk past whitespace then the body `(...)`.
    while (j < content.length && /\s/.test(content[j]!)) {
      out.push(content[j]!);
      j++;
    }
    if (content[j] !== "(") {
      i = j;
      continue;
    }
    const bodyStart = j;
    let bodyDepth = 0;
    while (j < content.length) {
      const ch = content[j]!;
      if (ch === "(") bodyDepth++;
      else if (ch === ")") {
        bodyDepth--;
        if (bodyDepth === 0) {
          j++;
          break;
        }
      }
      j++;
    }
    const body = content.slice(bodyStart, j);
    const newBody = body.replace(/self\.\*/g, () => {
      stats.derefs++;
      return "self";
    });
    out.push(newBody);
    i = j;
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
  let totalSigs = 0;
  let totalDerefs = 0;
  let filesTouched = 0;
  for (const root of ROOTS) {
    const absRoot = path.resolve(root);
    for (const filePath of walk(absRoot)) {
      const content = readFileSync(filePath, "utf-8");
      const { result, stats } = migrate(content);
      if (result === content) continue;
      filesTouched++;
      totalSigs += stats.sigs;
      totalDerefs += stats.derefs;
      console.log(
        `${write ? "migrated" : "would migrate"}: ${path.relative(
          process.cwd(),
          filePath
        )} (sigs=${stats.sigs}, derefs=${stats.derefs})`
      );
      if (write) writeFileSync(filePath, result, "utf-8");
    }
  }
  console.log(
    `\n${write ? "Migrated" : "Would migrate"} ${totalSigs} signatures + ${totalDerefs} self.* rewrites across ${filesTouched} file(s).`
  );
  if (!write) console.log("(dry-run — pass --write to apply)");
}

main();
