/**
 * One-shot migration: convert `// @skip_*` comment directives to
 * `pragma(Pragma.Skip*);` calls.
 *
 * Only line-leading comment directives are migrated — directives
 * inside string literals or doc-comments are left alone. Each
 * matching line is replaced by the corresponding pragma call,
 * preserving any trailing "— rationale" text as a leading comment.
 *
 * Usage:
 *   bun run scripts/migrate-skip-pragmas.ts             # dry-run
 *   bun run scripts/migrate-skip-pragmas.ts --write     # apply
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";

const ROOTS = ["tests", "std", "yo-self", "src/tests"];

const MAPPING: Array<{ pattern: RegExp; variant: string }> = [
  // Order matters: longer/more-specific first so the broader
  // `@skip_wasm` doesn't shadow `@skip_wasm32-...`.
  {
    pattern: /^(\s*)\/\/\s*@skip_wasm32-emscripten\b(.*)$/,
    variant: "SkipWasm32Emscripten",
  },
  {
    pattern: /^(\s*)\/\/\s*@skip_wasm32-wasi\b(.*)$/,
    variant: "SkipWasm32Wasi",
  },
  { pattern: /^(\s*)\/\/\s*@skip_wasm\b(.*)$/, variant: "SkipWasm" },
  { pattern: /^(\s*)\/\/\s*@skip_prelude\b(.*)$/, variant: "SkipPrelude" },
];

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const fullPath = path.join(dir, entry);
    const st = statSync(fullPath);
    if (st.isDirectory()) {
      yield* walk(fullPath);
    } else if (st.isFile() && entry.endsWith(".yo")) {
      yield fullPath;
    }
  }
}

function migrateFile(
  filePath: string,
  write: boolean
): {
  changed: boolean;
  matches: number;
} {
  const original = readFileSync(filePath, "utf-8");
  const lines = original.split("\n");
  let matches = 0;
  const out: string[] = [];
  for (const line of lines) {
    let migrated: string | null = null;
    for (const { pattern, variant } of MAPPING) {
      const m = line.match(pattern);
      if (m) {
        const leading = m[1] ?? "";
        const trailing = (m[2] ?? "").trim();
        const rationale = trailing
          ? ` // ${trailing.replace(/^[—-]\s*/, "")}`
          : "";
        migrated = `${leading}pragma(Pragma.${variant});${rationale}`;
        matches++;
        break;
      }
    }
    out.push(migrated ?? line);
  }
  if (matches === 0) return { changed: false, matches: 0 };
  const result = out.join("\n");
  if (write && result !== original) {
    writeFileSync(filePath, result, "utf-8");
  }
  return { changed: result !== original, matches };
}

function main(): void {
  const write = process.argv.includes("--write");
  let totalFiles = 0;
  let totalMatches = 0;
  for (const root of ROOTS) {
    const absRoot = path.resolve(root);
    for (const filePath of walk(absRoot)) {
      const { changed, matches } = migrateFile(filePath, write);
      if (changed) {
        totalFiles++;
        totalMatches += matches;
        console.log(
          `${write ? "migrated" : "would migrate"}: ${path.relative(
            process.cwd(),
            filePath
          )} (${matches} match${matches === 1 ? "" : "es"})`
        );
      }
    }
  }
  console.log(
    `\n${write ? "Migrated" : "Would migrate"} ${totalMatches} directives across ${totalFiles} file(s).`
  );
  if (!write) console.log("(dry-run — pass --write to apply)");
}

main();
