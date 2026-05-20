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

export interface UnsafeFinding {
  file: string;
  line: number; // 1-based
  column: number; // 1-based
  /** What was matched: `unsafe(`, `asm(`, `extern(`, or `pragma(`. */
  kind: "unsafe" | "asm" | "extern" | "pragma";
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
    asmSites: number;
    externSites: number;
  };
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

function scanLine(
  file: string,
  lineNo: number,
  rawLine: string,
  prevLines: string[]
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
      }
      findings.push({
        file,
        line: lineNo,
        column: origCol(start),
        kind,
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

  for (const file of yoFiles) {
    const src = fs.readFileSync(file, "utf8");
    const lines = src.split("\n");
    const prev: string[] = [];
    let hasPragma = false;
    for (let i = 0; i < lines.length; i++) {
      const lineNo = i + 1;
      const lineFindings = scanLine(file, lineNo, lines[i]!, prev);
      for (const f of lineFindings) {
        if (f.kind === "pragma") hasPragma = true;
        else findings.push(f);
      }
      prev.push(lines[i]!);
      if (prev.length > 3) prev.shift();
    }
    if (hasPragma) privilegedFiles.push(file);
  }

  const totals = {
    filesScanned: yoFiles.length,
    privileged: privilegedFiles.length,
    unsafeSites: findings.filter((f) => f.kind === "unsafe").length,
    asmSites: findings.filter((f) => f.kind === "asm").length,
    externSites: findings.filter((f) => f.kind === "extern").length,
  };

  return { privilegedFiles, findings, totals };
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
  lines.push(`  asm(...) sites:    ${report.totals.asmSites}`);
  lines.push(`  extern(...) sites: ${report.totals.externSites}`);
  lines.push("");

  if (report.findings.length > 0) {
    lines.push(`Findings (file:line:col):`);
    for (const f of report.findings) {
      lines.push(
        `  ${f.file}:${f.line}:${f.column}: ${f.kind}() — ${f.snippet}`
      );
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
