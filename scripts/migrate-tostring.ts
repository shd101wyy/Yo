/**
 * One-shot migration: ToString trait impls from `(self : *(Self))` to
 * `(inout(self) : Self)`. Phase D continuation of plans/MEMORY_SAFETY.md.
 *
 * Two pattern rewrites:
 *
 * 1. The impl signature:
 *      to_string : (fn(self : *(Self)) -> String)({ ... self.* ... })
 *    →
 *      to_string : (fn(inout(self) : Self) -> String)({ ... self ... })
 *
 *    Replaces `self.*` inside ToString impl bodies with `self`. Outside
 *    ToString impls (or in any other context), `self.*` is left alone.
 *
 * 2. Explicit caller patterns `(&(x)).to_string()` → `x.to_string()`.
 *
 * Usage:
 *   bun run scripts/migrate-tostring.ts             # dry-run
 *   bun run scripts/migrate-tostring.ts --write     # apply
 */

import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";

const FILES = [
  "std/log.yo",
  "std/fmt/to_string.yo",
  "std/time/datetime.yo",
  "std/time/duration.yo",
  "std/testing/bench.yo",
  "std/string/string_builder.yo",
  "yo-self/parser.yo",
  "yo-self/lexer.yo",
  "yo-self/error.yo",
];

/**
 * Find all to_string impl bodies in the file and rewrite each from
 * `(self : *(Self)) -> String)({ ...body... })` to `(inout(self) :
 * Self) -> String)({ ...body... })`, where `body` has `self.*`
 * replaced by `self`. Only rewrites bodies that begin with the exact
 * to_string signature we care about; everything else is preserved
 * byte-for-byte.
 */
function migrateContent(content: string): { result: string; changed: boolean } {
  let changed = false;
  // Pattern: `to_string : (fn(self : *(Self)) -> String)` followed by a
  // body. We need to find the balanced `(...)` of the body and rewrite
  // `self.*` → `self` inside it.
  const signature = "to_string : (fn(self : *(Self)) -> String)";
  const newSignature = "to_string : (fn(inout(self) : Self) -> String)";
  const out: string[] = [];
  let i = 0;
  while (i < content.length) {
    const idx = content.indexOf(signature, i);
    if (idx === -1) {
      out.push(content.slice(i));
      break;
    }
    // Push everything before the match
    out.push(content.slice(i, idx));
    out.push(newSignature);
    let j = idx + signature.length;
    // Find the body — could be `({...})` or `(expr)` immediately after.
    // Skip whitespace.
    while (j < content.length && /\s/.test(content[j]!)) {
      out.push(content[j]!);
      j++;
    }
    if (content[j] !== "(") {
      // Unexpected shape; bail out for this match — preserve the rest verbatim.
      out.push(content.slice(j));
      changed = true;
      break;
    }
    // Walk matching parens; rewrite self.* → self inside the body.
    let depth = 0;
    const bodyStart = j;
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
    const body = content.slice(bodyStart, j);
    // Replace `self.*` with `self` in the impl body. Be careful: do
    // not replace `self.*.field` patterns incorrectly. Just replace
    // every occurrence — for trait impls the surrounding code has
    // already been audited.
    const rewrittenBody = body.replace(/self\.\*/g, "self");
    out.push(rewrittenBody);
    i = j;
    changed = true;
  }

  let result = out.join("");

  // Pattern 2: `(&(x)).to_string()` → `x.to_string()`. Conservative —
  // only matches when `x` is a single identifier (possibly chained
  // via `.`).
  const callerPattern = /\(&\(([^()]+)\)\)\.to_string\(\)/g;
  const before = result;
  result = result.replace(callerPattern, "$1.to_string()");
  if (result !== before) changed = true;

  return { result, changed };
}

function main(): void {
  const write = process.argv.includes("--write");
  let totalChanged = 0;
  for (const rel of FILES) {
    const abs = path.resolve(rel);
    const content = readFileSync(abs, "utf-8");
    const { result, changed } = migrateContent(content);
    if (changed && result !== content) {
      totalChanged++;
      console.log(`${write ? "migrated" : "would migrate"}: ${rel}`);
      if (write) writeFileSync(abs, result, "utf-8");
    }
  }
  console.log(
    `\n${write ? "Migrated" : "Would migrate"} ${totalChanged} file(s).`
  );
  if (!write) console.log("(dry-run — pass --write to apply)");
}

main();
