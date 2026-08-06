/**
 * Generate a report of every unsafe surface in a Yo project (Phase E
 * of plans/MEMORY_SAFETY.md).
 *
 * Walks .yo files under a path, scans for:
 *
 * - `pragma(Pragma.AllowUnsafe);` declarations (per-file privilege)
 * - `unsafe(...)` builtin calls (each gated raw-pointer operation)
 * - `asm(...)` blocks (inline assembly — implicitly unsafe)
 * - `extern(...)` declarations (FFI bindings)
 *
 * Emits one line per finding in `file:line:col` format suitable for
 * editor jumps, plus a summary. The intent is to make the unsafe
 * surface auditable by `grep`-style review.
 *
 * Scanning is regex/text-based — no parser or evaluator involvement.
 * It deliberately skips `unsafe(...)` etc. that appear inside
 * string literals or comments (rough heuristic, good enough for
 * audit purposes).
 */

import * as fs from "fs";
import * as path from "path";

/**
 * Sub-classification for `unsafe(...)` sites. Distinguishes the
 * different shapes the wrap can guard. Surfaced in
 * `plans/archive/EXTERN_UNSAFE_WRAP.md` Phase D — auditors want an inventory
 * by what the wrap is actually marking, not just "this file has 12
 * unsafe lines".
 */
export type UnsafeSubKind =
  /** `unsafe(externCallable(args))` — extern "c" call site. */
  | "extern-call"
  /** `unsafe(expr.*)` or `consume(p.* = v)` — pointer dereference. */
  | "deref"
  /** `unsafe(p &+ n)` etc. — pointer arithmetic (`&+`, `&-`, `&/`). */
  | "arith"
  /** `unsafe(&(x))` — address-of (yields a raw pointer). */
  | "addr-of"
  /** Anything else (less common shapes). */
  | "other";

export interface UnsafeFinding {
  file: string;
  line: number; // 1-based
  column: number; // 1-based
  /** What was matched: `unsafe(`, `asm(`, `extern(`, or `pragma(`. */
  kind: "unsafe" | "asm" | "extern" | "pragma";
  /**
   * For `unsafe(...)` findings, what's inside the wrap. Only set when
   * `kind === "unsafe"`.
   */
  subKind?: UnsafeSubKind;
  /**
   * For `subKind === "extern-call"`, the name of the extern function
   * being called. Lets the report group / count by callee.
   */
  calleeName?: string;
  /** The full source line where the match occurred, trimmed. */
  snippet: string;
  /** Closest preceding `// SAFETY:` comment within 3 lines, if any. */
  safetyComment?: string;
}

export interface UnsafeReport {
  privilegedFiles: string[];
  findings: UnsafeFinding[];
  totals: {
    filesScanned: number;
    privileged: number;
    unsafeSites: number;
    /** Breakdown of `unsafeSites` by sub-kind. */
    unsafeBySubKind: Record<UnsafeSubKind, number>;
    asmSites: number;
    externSites: number;
  };
  /**
   * Top extern callees by call-site count, descending. Useful audit
   * lens: "show me which C functions are most frequently called from
   * unsafe-wrapped sites across the project".
   */
  topExternCallees: Array<{ callee: string; count: number }>;
}

/**
 * Strip line comments and string literals from a line so the regex
 * matches don't fire on `"unsafe(foo)"` or `// unsafe(...) is`.
 * Returns the stripped line plus a `colShift(stripped_col)` function
 * that maps a position in the stripped line back to the original
 * column.
 */
function stripCommentsAndStrings(line: string): {
  stripped: string;
  origCol: (i: number) => number;
} {
  const out: string[] = [];
  const map: number[] = [];
  let inStr: string | null = null;
  let i = 0;
  while (i < line.length) {
    const ch = line[i]!;
    // Line comment: drop to end of line.
    if (!inStr && ch === "/" && line[i + 1] === "/") break;
    if (inStr) {
      if (ch === "\\") {
        // Keep escape pair as spaces.
        out.push(" ", " ");
        map.push(i, i + 1);
        i += 2;
        continue;
      }
      if (ch === inStr) {
        inStr = null;
        out.push(" ");
        map.push(i);
        i++;
        continue;
      }
      // Inside string: emit space.
      out.push(" ");
      map.push(i);
      i++;
      continue;
    }
    if (ch === '"' || ch === "`") {
      inStr = ch;
      out.push(" ");
      map.push(i);
      i++;
      continue;
    }
    out.push(ch);
    map.push(i);
    i++;
  }
  return {
    stripped: out.join(""),
    origCol: (col: number) => (map[col] ?? col) + 1,
  };
}

/**
 * Find the index of the matching `)` for the `(` at `openIdx`. Returns
 * -1 if unmatched. Skips over content inside string literals to avoid
 * paren-counting on `"x("` etc.
 */
function findMatchingClose(src: string, openIdx: number): number {
  if (src[openIdx] !== "(") return -1;
  let depth = 0;
  let inStr: string | null = null;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i]!;
    if (inStr) {
      if (c === "\\") {
        i++; // skip next char
        continue;
      }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "`") {
      inStr = c;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * First-pass harvest of every `extern "c"` function name declared in
 * the project. Walks each file looking for `c_include(...)` and
 * `extern("c", ...)` blocks, then scans inside for `name : ... fn(`
 * patterns (the type-only fields like `libc_FILE : Type` are ignored
 * because their RHS doesn't start with `fn(`).
 *
 * Used by `scanLine` to classify `unsafe(callee(args))` as
 * `subKind: "extern-call"` when `callee` is one of the harvested
 * names.
 */
function harvestExternCFunctionNames(srcs: Map<string, string>): Set<string> {
  const names = new Set<string>();
  const blockHeader = /(?:^|[^A-Za-z0-9_])(c_include\(|extern\(\s*"c"\s*,)/g;
  // After the block header, find each `name :\s*(\n\s*)?fn\(` pattern.
  // The field body may span multiple lines; we walk inside the block
  // contents with paren matching to bound the search.
  // Optional `(` before `fn(` covers both `name : fn(...)` and the
  // parenthesised form `name : (fn(...) -> ...)` used in libc decls.
  const fieldRe =
    /\b([A-Za-z_][A-Za-z0-9_]*)\s*:\s*\(?\s*(?:\n\s*)?\(?\s*fn\(/g;
  for (const src of srcs.values()) {
    blockHeader.lastIndex = 0;
    let h: RegExpExecArray | null;
    while ((h = blockHeader.exec(src)) !== null) {
      // The captured group ends with `(` (for c_include) or `,`
      // (for `extern("c", ...`). In both cases the block's opening
      // `(` is the FIRST `(` inside the captured group.
      const groupStart = h.index + (h[0]!.length - h[1]!.length);
      const openParen = src.indexOf("(", groupStart);
      if (openParen < 0 || openParen >= groupStart + h[1]!.length) continue;
      const close = findMatchingClose(src, openParen);
      if (close < 0) continue;
      const block = src.slice(openParen + 1, close);
      fieldRe.lastIndex = 0;
      let f: RegExpExecArray | null;
      while ((f = fieldRe.exec(block)) !== null) {
        names.add(f[1]!);
      }
      blockHeader.lastIndex = close + 1;
    }
  }
  return names;
}

/**
 * Classify the body of an `unsafe(...)` wrap into one of the sub-kinds
 * defined by `UnsafeSubKind`. The classifier looks at the source text
 * starting just after the `(` of `unsafe(`.
 *
 * Heuristics (in priority order):
 *
 *  1. If the body starts with `<ident>(` AND `<ident>` is in
 *     `externCFns` → `extern-call`, with `<ident>` as the callee.
 *  2. If the body contains `.*` (followed by anything that isn't an
 *     identifier char) → `deref`. Also catches `consume(p.* = v)`
 *     because the deref still appears inside.
 *  3. If the body contains `&+`, `&-`, or `&/` → `arith`.
 *  4. Otherwise → `other`.
 */
function classifyUnsafeBody(
  src: string,
  bodyStart: number,
  bodyEnd: number,
  externCFns: Set<string>
): { subKind: UnsafeSubKind; calleeName?: string } {
  const body = src.slice(bodyStart, bodyEnd);
  const callMatch = body.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
  if (callMatch) {
    const name = callMatch[1]!;
    if (externCFns.has(name)) {
      return { subKind: "extern-call", calleeName: name };
    }
  }
  if (/\.\*(?![A-Za-z0-9_])/.test(body)) return { subKind: "deref" };
  if (/&[+\-/]/.test(body)) return { subKind: "arith" };
  if (/&\(/.test(body)) return { subKind: "addr-of" };
  return { subKind: "other" };
}

function scanLine(
  file: string,
  lineNo: number,
  rawLine: string,
  prevLines: string[],
  externCFns: Set<string>,
  fullSrc: string,
  lineStartOffset: number
): UnsafeFinding[] {
  const { stripped, origCol } = stripCommentsAndStrings(rawLine);
  const findings: UnsafeFinding[] = [];

  const patterns: Array<{ re: RegExp; kind: UnsafeFinding["kind"] }> = [
    // `unsafe(` followed by anything, but not part of `unsafe_fn`.
    { re: /\bunsafe\(/g, kind: "unsafe" },
    // `asm(` — but not `__yo_thread_set_maximum_threads` etc.; we want top-level `asm(`.
    { re: /(?:^|[^A-Za-z0-9_])asm\(/g, kind: "asm" },
    { re: /(?:^|[^A-Za-z0-9_])extern\(/g, kind: "extern" },
    { re: /(?:^|[^A-Za-z0-9_])pragma\(Pragma\.AllowUnsafe\)/g, kind: "pragma" },
  ];

  for (const { re, kind } of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(stripped)) !== null) {
      // Find the actual keyword start within the match.
      const keyword =
        kind === "unsafe"
          ? "unsafe"
          : kind === "asm"
            ? "asm"
            : kind === "extern"
              ? "extern"
              : "pragma";
      const start = stripped.indexOf(keyword, m.index);
      if (start < 0) continue;
      let safetyComment: string | undefined;
      let subKind: UnsafeSubKind | undefined;
      let calleeName: string | undefined;
      if (kind === "unsafe") {
        // Look for a `// SAFETY:` comment in the previous 3 lines.
        for (let k = prevLines.length - 1; k >= 0; k--) {
          const prev = prevLines[k]!.trim();
          if (prev.startsWith("// SAFETY:") || prev.startsWith("//SAFETY:")) {
            safetyComment = prev.replace(/^\/\/\s*/, "");
            break;
          }
          // Stop scanning back at the first non-comment line.
          if (prev !== "" && !prev.startsWith("//")) break;
        }
        // Classify what's inside the wrap. The body spans from just
        // after the `(` to the matching `)`. We work in the full
        // source so multi-line bodies still classify correctly.
        const unsafeOpenInFile = lineStartOffset + origCol(start) - 1 + 6; // past "unsafe"
        // unsafeOpenInFile points at "unsafe"+6 which lands on the "("
        // (since origCol returned the 1-based col of `u`).
        const closeIdx = findMatchingClose(fullSrc, unsafeOpenInFile);
        if (closeIdx > unsafeOpenInFile) {
          const c = classifyUnsafeBody(
            fullSrc,
            unsafeOpenInFile + 1,
            closeIdx,
            externCFns
          );
          subKind = c.subKind;
          calleeName = c.calleeName;
        } else {
          subKind = "other";
        }
      }
      findings.push({
        file,
        line: lineNo,
        column: origCol(start),
        kind,
        subKind,
        calleeName,
        snippet: rawLine.trim(),
        safetyComment,
      });
    }
  }
  return findings;
}

export function generateUnsafeReport(rootPath: string): UnsafeReport {
  const yoFiles: string[] = [];
  walkYoFiles(rootPath, yoFiles);

  const privilegedFiles: string[] = [];
  const findings: UnsafeFinding[] = [];

  // First pass: read every file's source once and harvest extern "c"
  // function names. We keep the source content cached so the per-line
  // scanner can read full-file context for multi-line wraps.
  const fileSrcs = new Map<string, string>();
  for (const file of yoFiles) {
    fileSrcs.set(file, fs.readFileSync(file, "utf8"));
  }
  const externCFns = harvestExternCFunctionNames(fileSrcs);

  for (const file of yoFiles) {
    const src = fileSrcs.get(file)!;
    const lines = src.split("\n");
    // Pre-compute each line's start offset in the full source so the
    // classifier can locate the `(` of `unsafe(` in `src` from the
    // line + column. +1 for the newline between lines.
    const lineStarts: number[] = [0];
    for (let i = 0; i < lines.length - 1; i++) {
      lineStarts.push(lineStarts[i]! + lines[i]!.length + 1);
    }
    const prev: string[] = [];
    let hasPragma = false;
    for (let i = 0; i < lines.length; i++) {
      const lineNo = i + 1;
      const lineFindings = scanLine(
        file,
        lineNo,
        lines[i]!,
        prev,
        externCFns,
        src,
        lineStarts[i]!
      );
      for (const f of lineFindings) {
        if (f.kind === "pragma") hasPragma = true;
        else findings.push(f);
      }
      prev.push(lines[i]!);
      // Keep enough previous lines that the SAFETY: scan-back can
      // walk past several `//` continuation lines without losing
      // the anchor. Most SAFETY: comments are 1-4 lines; 8 covers
      // the long form comfortably.
      if (prev.length > 8) prev.shift();
    }
    if (hasPragma) privilegedFiles.push(file);
  }

  const unsafeBySubKind: Record<UnsafeSubKind, number> = {
    "extern-call": 0,
    deref: 0,
    arith: 0,
    "addr-of": 0,
    other: 0,
  };
  const calleeCounts = new Map<string, number>();
  for (const f of findings) {
    if (f.kind !== "unsafe") continue;
    if (f.subKind) unsafeBySubKind[f.subKind]++;
    if (f.subKind === "extern-call" && f.calleeName) {
      calleeCounts.set(f.calleeName, (calleeCounts.get(f.calleeName) ?? 0) + 1);
    }
  }
  const topExternCallees = Array.from(calleeCounts.entries())
    .map(([callee, count]) => ({ callee, count }))
    .sort((a, b) => b.count - a.count);

  const totals = {
    filesScanned: yoFiles.length,
    privileged: privilegedFiles.length,
    unsafeSites: findings.filter((f) => f.kind === "unsafe").length,
    unsafeBySubKind,
    asmSites: findings.filter((f) => f.kind === "asm").length,
    externSites: findings.filter((f) => f.kind === "extern").length,
  };

  return { privilegedFiles, findings, totals, topExternCallees };
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
  // Skip common irrelevant dirs — but only filter on `base` for
  // subdirectories. When the caller passes `.` (or any other path
  // whose basename is `.`), we still want to walk it.
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

/** Format a report for human consumption. */
export function formatUnsafeReport(report: UnsafeReport): string {
  const lines: string[] = [];
  lines.push(`Unsafe surface report`);
  lines.push(`=====================`);
  lines.push("");
  lines.push(
    `Scanned ${report.totals.filesScanned} .yo file(s); ` +
      `${report.totals.privileged} declare pragma(Pragma.AllowUnsafe);.`
  );
  lines.push(`  unsafe(...) sites: ${report.totals.unsafeSites}`);
  const {
    "extern-call": ext,
    deref,
    arith,
    "addr-of": addrOf,
    other,
  } = report.totals.unsafeBySubKind;
  lines.push(`    extern-call: ${ext}`);
  lines.push(`    deref:       ${deref}`);
  lines.push(`    arith:       ${arith}`);
  lines.push(`    addr-of:     ${addrOf}`);
  lines.push(`    other:       ${other}`);
  lines.push(`  asm(...) sites:    ${report.totals.asmSites}`);
  lines.push(`  extern(...) sites: ${report.totals.externSites}`);
  lines.push("");

  if (report.topExternCallees.length > 0) {
    const top = report.topExternCallees.slice(0, 15);
    lines.push(`Top extern callees (by unsafe-wrapped call-site count):`);
    for (const { callee, count } of top) {
      lines.push(`  ${count.toString().padStart(4)}  ${callee}`);
    }
    if (report.topExternCallees.length > top.length) {
      lines.push(
        `  ... and ${report.topExternCallees.length - top.length} more callee(s)`
      );
    }
    lines.push("");
  }

  if (report.findings.length > 0) {
    lines.push(`Findings (file:line:col):`);
    for (const f of report.findings) {
      const label =
        f.kind === "unsafe"
          ? f.subKind === "extern-call" && f.calleeName
            ? `unsafe(extern-call:${f.calleeName})`
            : `unsafe(${f.subKind ?? "other"})`
          : `${f.kind}()`;
      lines.push(`  ${f.file}:${f.line}:${f.column}: ${label} — ${f.snippet}`);
      if (f.safetyComment) {
        lines.push(`    ${f.safetyComment}`);
      }
    }
    lines.push("");
  }

  if (report.privilegedFiles.length > 0) {
    lines.push(`Privileged files (declare pragma):`);
    for (const f of report.privilegedFiles) {
      lines.push(`  ${f}`);
    }
  }

  return lines.join("\n");
}
