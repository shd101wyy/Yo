/**
 * plans/archive/EXTERN_UNSAFE_WRAP.md Phase C — apply `unsafe(...)` wraps at
 * every extern "c" call site collected by the evaluator's dump mode.
 *
 * Workflow:
 *   1. YO_EXTERN_WRAP_DUMP_FILE=/tmp/extern_wraps.json ./yo-cli check ./std
 *      (the evaluator records each unwrapped call site as JSON)
 *   2. bun run scripts/wrap-extern-calls.ts /tmp/extern_wraps.json --write
 *      (this script reads the JSON and applies precise wraps)
 *
 * Dry-run by default. Pass `--write` to apply changes.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type Site = {
  modulePath: string;
  characterOffset: number;
  calleeName: string;
};

function findMatchingClose(src: string, openIdx: number): number {
  if (src[openIdx] !== "(") {
    throw new Error(`expected '(' at offset ${openIdx}, got '${src[openIdx]}'`);
  }
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error(`unmatched '(' at offset ${openIdx}`);
}

function alreadyWrapped(src: string, callStart: number): boolean {
  // Look back from callStart past whitespace; check for `unsafe(` immediately
  // before.
  let j = callStart - 1;
  while (j >= 0 && (src[j] === " " || src[j] === "\t" || src[j] === "\n")) {
    j--;
  }
  if (j < 6) return false;
  return src.slice(j - 6, j + 1) === "unsafe(";
}

function findCallOpenParen(src: string, nameStart: number): number {
  // Scan forward from `nameStart` past the function name to find the `(`.
  // The function name is a sequence of identifier chars; the `(` follows
  // (optionally with whitespace).
  let i = nameStart;
  while (i < src.length && /[A-Za-z0-9_]/.test(src[i]!)) i++;
  while (i < src.length && /\s/.test(src[i]!)) i++;
  if (src[i] !== "(") {
    throw new Error(
      `expected '(' after identifier starting at ${nameStart}, got '${src[i]}' at ${i}`
    );
  }
  return i;
}

async function main() {
  const args = process.argv.slice(2);
  const jsonPath = args[0];
  const write = args.includes("--write");
  if (!jsonPath) {
    console.error(
      "usage: bun run scripts/wrap-extern-calls.ts <json-path> [--write]"
    );
    process.exit(1);
  }
  const sites: Site[] = JSON.parse(readFileSync(jsonPath, "utf8"));

  // Dedupe by (modulePath, characterOffset)
  const seen = new Set<string>();
  const unique: Site[] = [];
  for (const s of sites) {
    const k = `${s.modulePath}@${s.characterOffset}`;
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(s);
  }

  // Group by file, sort offsets descending so edits don't shift later
  // offsets in the same file.
  const byFile = new Map<string, Site[]>();
  for (const s of unique) {
    const filePath = fileURLToPath(s.modulePath);
    if (!byFile.has(filePath)) byFile.set(filePath, []);
    byFile.get(filePath)!.push(s);
  }
  for (const list of byFile.values()) {
    list.sort((a, b) => b.characterOffset - a.characterOffset);
  }

  let totalWraps = 0;
  let totalSkipped = 0;
  const fileStats: { file: string; wraps: number; skipped: number }[] = [];
  for (const [filePath, list] of byFile) {
    let src = readFileSync(filePath, "utf8");
    let wraps = 0;
    let skipped = 0;
    for (const s of list) {
      if (alreadyWrapped(src, s.characterOffset)) {
        skipped++;
        continue;
      }
      let openParen: number;
      try {
        openParen = findCallOpenParen(src, s.characterOffset);
      } catch (e) {
        console.warn(
          `skip ${filePath}@${s.characterOffset} (${s.calleeName}): ${(e as Error).message}`
        );
        skipped++;
        continue;
      }
      let close: number;
      try {
        close = findMatchingClose(src, openParen);
      } catch (e) {
        console.warn(
          `skip ${filePath}@${s.characterOffset} (${s.calleeName}): ${(e as Error).message}`
        );
        skipped++;
        continue;
      }
      src =
        src.slice(0, s.characterOffset) +
        "unsafe(" +
        src.slice(s.characterOffset, close + 1) +
        ")" +
        src.slice(close + 1);
      wraps++;
    }
    if (wraps > 0 && write) {
      writeFileSync(filePath, src);
    }
    if (wraps + skipped > 0) {
      fileStats.push({ file: filePath, wraps, skipped });
      totalWraps += wraps;
      totalSkipped += skipped;
    }
  }

  fileStats.sort((a, b) => b.wraps - a.wraps);
  for (const s of fileStats) {
    console.log(
      `${s.file}: ${s.wraps} wrap${s.wraps === 1 ? "" : "s"}` +
        (s.skipped ? `, ${s.skipped} skipped` : "")
    );
  }
  console.log(
    `\n${write ? "Applied" : "Would apply"} ${totalWraps} wrap(s) across ${fileStats.length} file(s); ${totalSkipped} skipped.`
  );
  if (!write) console.log("Re-run with --write to apply.");
}

main();
