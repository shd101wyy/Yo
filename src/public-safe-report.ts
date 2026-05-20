/**
 * Lint that flags public stdlib signatures exposing raw pointers
 * (Phase D follow-up of plans/MEMORY_SAFETY.md — "yo check
 * --stdlib-public-safe").
 *
 * The goal is to keep the safe surface of the standard library
 * pointer-free. Public entry points should take and return value
 * types (or `inout(name) : T` references when in-place mutation is
 * required) so user code that depends on stdlib never has to handle
 * a `*(T)` — those stay confined to libc/ FFI bindings and a small
 * set of intentionally-named raw-pointer helpers (`*_cstr`,
 * `from_raw_parts`, `as_ptr`, etc.).
 *
 * Scope of the scan:
 *
 * - Top-level `name :: (fn(...))` declarations whose name doesn't
 *   start with `_` (i.e., the file's public surface).
 * - Both the parameter list AND the return type are inspected for
 *   `: *(...)` or `-> *(...)` occurrences.
 * - Lines inside `extern(...)` blocks are skipped (FFI is opaque to
 *   the lint by design).
 * - Whole files under directories that are FFI-by-construction
 *   (`libc/`, `linux/`, `darwin/`, `cuda/`) are skipped.
 * - Function names ending in known raw-pointer-API suffixes
 *   (`_cstr`, `from_raw_parts`, `as_ptr`, `from_raw`, `_raw`) are
 *   skipped — those names contract that they take/return a raw
 *   pointer, so the pointer in the signature is intentional and not
 *   a leak.
 *
 * Scanning is regex/text-based for the same reasons as
 * `unsafe-report`: it stays fast, runs even on broken files, and
 * doesn't drag the evaluator into a code-audit tool.
 */

import * as fs from "fs";
import * as path from "path";

export interface PublicSafeFinding {
  file: string;
  line: number; // 1-based
  column: number; // 1-based of the `*(`
  /** The exported / public top-level identifier this signature belongs to. */
  declName: string;
  /** "parameter" or "return" — which slot exposes the pointer. */
  slot: "parameter" | "return";
  /** The raw pointer type as it appears, e.g. `*(u8)`. */
  pointerType: string;
  /** The full signature text, trimmed. */
  snippet: string;
}

export interface PublicSafeReport {
  findings: PublicSafeFinding[];
  totals: {
    filesScanned: number;
    publicDeclsScanned: number;
    findings: number;
  };
}

/**
 * Directories under which every file is treated as FFI-by-design
 * and skipped wholesale. These contain raw C function bindings and
 * platform-specific syscall wrappers.
 */
const FFI_DIR_NAMES = new Set([
  "libc",
  "linux",
  "darwin",
  "cuda",
  // std/sys/ — thin syscall layer (file, udp, tcp, …). Higher-level
  // wrappers in std/fs, std/net hide the raw pointers.
  "sys",
  // std/sync/ — pthread / OS sync primitives. Exposes raw mutex_t /
  // cond_t pointers by design; safe wrappers (Mutex, Cond) build on
  // top.
  "sync",
]);

/**
 * Function-name suffixes / patterns that signal "the raw pointer in
 * my signature is part of my contract, not a leak". Names matching
 * these are exempt from the lint.
 */
const RAW_POINTER_API_PATTERNS: RegExp[] = [
  /_cstr$/, // `read_file_cstr`, `walk_cstr`, etc.
  /^from_cstr$/, // `String.from_cstr` (not top-level but matches if used)
  /^from_raw_parts$/, // explicit raw-parts constructor
  /^as_ptr$/, // standard raw-pointer accessor
  /^from_raw$/, // explicit raw constructor
  /_raw$/, // `extend_from_raw` etc.
  /^raw_/, // `raw_args` etc.
  /_ptr$/, // `extend_from_ptr` etc.
  /^argv$/, // C-style argv accessor
  /^argc$/, // sibling of argv
];

function nameIsRawPointerApi(name: string): boolean {
  return RAW_POINTER_API_PATTERNS.some((re) => re.test(name));
}

/**
 * Find every paren-balanced top-level `name :: (fn(... ) -> R)`
 * declaration in `src` and yield each one alongside its byte
 * offsets in the original source. Multi-line signatures are
 * supported.
 *
 * Returns the declared name, the (parameter-list, return-type)
 * pair extracted as strings, and the line of the `name ::` token
 * for reporting.
 */
function* extractTopLevelFnDecls(src: string): Generator<{
  name: string;
  declLine: number;
  paramText: string;
  returnText: string;
  declColumn: number;
}> {
  // Match `name :: (fn(` at the start of a logical line (no indent —
  // top-level). The opening paren after `fn` anchors us so we can
  // do balanced-paren scanning from there.
  const re = /^([A-Za-z][A-Za-z0-9_]*) :: \(\s*fn\s*\(/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const name = m[1]!;
    const declStart = m.index;
    // Locate line / column of the name token.
    const before = src.slice(0, declStart);
    const declLine = (before.match(/\n/g)?.length ?? 0) + 1;
    const declColumn = declStart - before.lastIndexOf("\n");

    // The full signature head lives inside the outermost paren that
    // opens after the `::`. That paren wraps the entire
    // `fn(<params>) -> <return>` form. Walk from `::` to find the
    // first `(`, then balance-scan to its matching `)`.
    const colonColon = src.indexOf("::", declStart);
    let i = colonColon + 2;
    // Skip whitespace.
    while (i < src.length && /\s/.test(src[i]!)) i++;
    if (src[i] !== "(") continue;
    const sigOpenIdx = i;
    let depth = 0;
    let sigCloseIdx = -1;
    for (let k = sigOpenIdx; k < src.length; k++) {
      const c = src[k]!;
      // Skip strings and comments so a `)` in a literal doesn't
      // throw off depth tracking.
      if (c === '"' || c === "`") {
        const q = c;
        k++;
        while (k < src.length && src[k] !== q) {
          if (src[k] === "\\") k++;
          k++;
        }
        continue;
      }
      if (c === "/" && src[k + 1] === "/") {
        // Skip line comment.
        while (k < src.length && src[k] !== "\n") k++;
        continue;
      }
      if (c === "(") depth++;
      else if (c === ")") {
        depth--;
        if (depth === 0) {
          sigCloseIdx = k;
          break;
        }
      }
    }
    if (sigCloseIdx < 0) continue;

    // Inside the outer parens we have `fn(<params>) -> <return>`.
    const sigBody = src.slice(sigOpenIdx + 1, sigCloseIdx);
    // Strip the leading `fn` keyword + whitespace.
    const fnMatch = sigBody.match(/^\s*fn\s*\(/);
    if (!fnMatch) continue;
    const paramsStart = fnMatch[0].length;

    // Balance-scan to find the matching `)` of `fn(`.
    let pdepth = 1;
    let paramsEnd = -1;
    for (let k = paramsStart; k < sigBody.length; k++) {
      const c = sigBody[k]!;
      if (c === '"' || c === "`") {
        const q = c;
        k++;
        while (k < sigBody.length && sigBody[k] !== q) {
          if (sigBody[k] === "\\") k++;
          k++;
        }
        continue;
      }
      if (c === "/" && sigBody[k + 1] === "/") {
        while (k < sigBody.length && sigBody[k] !== "\n") k++;
        continue;
      }
      if (c === "(") pdepth++;
      else if (c === ")") {
        pdepth--;
        if (pdepth === 0) {
          paramsEnd = k;
          break;
        }
      }
    }
    if (paramsEnd < 0) continue;

    const paramText = sigBody.slice(paramsStart, paramsEnd);
    // Everything after the closing `)` and the `->` is the return
    // type. (Trim leading/trailing whitespace + the `->` itself.)
    const afterParams = sigBody.slice(paramsEnd + 1).trimStart();
    const returnText = afterParams.startsWith("->")
      ? afterParams.slice(2).trim()
      : "";

    yield { name, declLine, paramText, returnText, declColumn };
  }
}

/**
 * Walk `text` and find every `*(...)` pointer-type occurrence, with
 * its starting position. Skips matches inside string literals and
 * line comments. The leading `*` is what we report.
 */
function findPointerTypes(
  text: string
): Array<{ pointerType: string; offset: number }> {
  const out: Array<{ pointerType: string; offset: number }> = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"' || c === "`") {
      const q = c;
      i++;
      while (i < text.length && text[i] !== q) {
        if (text[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "*" && text[i + 1] === "(") {
      // Walk balanced parens to capture the full `*(...)` text.
      const start = i;
      let depth = 0;
      let j = i + 1;
      for (; j < text.length; j++) {
        const cc = text[j]!;
        if (cc === "(") depth++;
        else if (cc === ")") {
          depth--;
          if (depth === 0) {
            j++;
            break;
          }
        }
      }
      out.push({
        pointerType: text.slice(start, j),
        offset: start,
      });
      i = j;
      continue;
    }
    i++;
  }
  return out;
}

function offsetToLineCol(
  src: string,
  baseOffset: number,
  innerOffset: number
): { line: number; column: number } {
  const total = baseOffset + innerOffset;
  const before = src.slice(0, total);
  const newlines = (before.match(/\n/g)?.length ?? 0) + 1;
  const lastNl = before.lastIndexOf("\n");
  return { line: newlines, column: total - lastNl };
}

function shouldSkipFile(file: string): boolean {
  const segments = file.split(path.sep);
  for (const seg of segments) {
    if (FFI_DIR_NAMES.has(seg)) return true;
  }
  // Skip test files — they're not part of the public surface.
  if (file.endsWith(".test.yo")) return true;
  return false;
}

/**
 * Find spans (start, end byte offsets) inside `src` that belong to
 * an `extern(...)` declaration. We don't want to flag pointer types
 * inside extern declarations — those are FFI signatures by design.
 */
function findExternSpans(src: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const re = /\bextern\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const start = m.index;
    // Balance-scan to find the matching `)`.
    let i = m.index + m[0].length;
    let depth = 1;
    while (i < src.length) {
      const c = src[i]!;
      if (c === '"' || c === "`") {
        const q = c;
        i++;
        while (i < src.length && src[i] !== q) {
          if (src[i] === "\\") i++;
          i++;
        }
        i++;
        continue;
      }
      if (c === "/" && src[i + 1] === "/") {
        while (i < src.length && src[i] !== "\n") i++;
        continue;
      }
      if (c === "(") depth++;
      else if (c === ")") {
        depth--;
        if (depth === 0) {
          spans.push([start, i + 1]);
          break;
        }
      }
      i++;
    }
  }
  return spans;
}

function positionInsideSpans(
  offset: number,
  spans: Array<[number, number]>
): boolean {
  for (const [s, e] of spans) {
    if (offset >= s && offset < e) return true;
  }
  return false;
}

function scanFile(file: string, src: string): PublicSafeFinding[] {
  const findings: PublicSafeFinding[] = [];
  const externSpans = findExternSpans(src);

  for (const decl of extractTopLevelFnDecls(src)) {
    if (decl.name.startsWith("_")) continue;
    if (nameIsRawPointerApi(decl.name)) continue;

    // Recover the absolute byte offset where paramText starts so we
    // can map findings back to (line, column).
    // Re-locate the params block. It begins right after the `fn(`
    // following the second top-level paren.
    const nameIdx = src.indexOf(`${decl.name} :: (`);
    if (nameIdx < 0) continue;
    const fnIdx = src.indexOf("fn(", nameIdx);
    if (fnIdx < 0) continue;
    const paramsStart = fnIdx + 3;
    if (positionInsideSpans(paramsStart, externSpans)) continue;

    const paramHits = findPointerTypes(decl.paramText);
    for (const hit of paramHits) {
      const { line, column } = offsetToLineCol(src, paramsStart, hit.offset);
      findings.push({
        file,
        line,
        column,
        declName: decl.name,
        slot: "parameter",
        pointerType: hit.pointerType,
        snippet: shortSnippet(decl.paramText, hit.offset),
      });
    }

    if (decl.returnText.length > 0) {
      const returnHits = findPointerTypes(decl.returnText);
      if (returnHits.length > 0) {
        // The return text begins after `fn(<params>) -> `. We
        // approximate its absolute position by searching forward
        // from paramsStart for `->`.
        const arrowIdx = src.indexOf("->", paramsStart);
        const retStart = arrowIdx >= 0 ? arrowIdx + 2 : paramsStart;
        for (const hit of returnHits) {
          const { line, column } = offsetToLineCol(src, retStart, hit.offset);
          findings.push({
            file,
            line,
            column,
            declName: decl.name,
            slot: "return",
            pointerType: hit.pointerType,
            snippet: shortSnippet(decl.returnText, hit.offset),
          });
        }
      }
    }
  }
  return findings;
}

function shortSnippet(text: string, offset: number): string {
  const start = Math.max(0, offset - 20);
  const end = Math.min(text.length, offset + 40);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

export function generatePublicSafeReport(rootPath: string): PublicSafeReport {
  const files: string[] = [];
  walkYoFiles(rootPath, files);

  const findings: PublicSafeFinding[] = [];
  let publicDeclsScanned = 0;
  let filesScanned = 0;

  for (const file of files) {
    if (shouldSkipFile(file)) continue;
    filesScanned++;
    const src = fs.readFileSync(file, "utf8");
    // Count public decls so the totals line is informative even
    // when no findings fire.
    for (const decl of extractTopLevelFnDecls(src)) {
      if (decl.name.startsWith("_")) continue;
      if (nameIsRawPointerApi(decl.name)) continue;
      publicDeclsScanned++;
    }
    findings.push(...scanFile(file, src));
  }

  return {
    findings,
    totals: {
      filesScanned,
      publicDeclsScanned,
      findings: findings.length,
    },
  };
}

function walkYoFiles(dir: string, out: string[]): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dir);
  } catch {
    return;
  }
  if (stat.isFile()) {
    if (dir.endsWith(".yo")) out.push(dir);
    return;
  }
  if (!stat.isDirectory()) return;
  const base = path.basename(dir);
  if (
    base !== "." &&
    base !== ".." &&
    (base === "node_modules" ||
      base === ".git" ||
      base === "dist" ||
      base === "yo-out" ||
      base === "build" ||
      base.startsWith("."))
  ) {
    return;
  }
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    walkYoFiles(path.join(dir, e), out);
  }
}

export function formatPublicSafeReport(report: PublicSafeReport): string {
  const lines: string[] = [];
  lines.push(`Public stdlib safety report`);
  lines.push(`===========================`);
  lines.push("");
  lines.push(
    `Scanned ${report.totals.filesScanned} .yo file(s); ` +
      `${report.totals.publicDeclsScanned} public top-level fn declaration(s) inspected.`
  );
  lines.push(`  raw-pointer leaks: ${report.totals.findings}`);
  lines.push("");

  if (report.findings.length === 0) {
    lines.push(`No raw-pointer leaks found in public stdlib signatures.`);
    return lines.join("\n");
  }

  lines.push(`Findings (file:line:col):`);
  for (const f of report.findings) {
    lines.push(
      `  ${f.file}:${f.line}:${f.column}: ` +
        `${f.declName} ${f.slot} exposes ${f.pointerType} — ${f.snippet}`
    );
  }
  lines.push("");
  lines.push(
    `These public signatures expose raw pointer types. Migrate to ` +
      `value types (e.g. Slice(u8), inout(name) : T) where the raw ` +
      `pointer is not part of the API contract. Names ending in ` +
      `_cstr, _ptr, _raw, or from_raw_parts / as_ptr are exempt — ` +
      `they signal raw-pointer use by contract.`
  );

  return lines.join("\n");
}
