/**
 * Tests for the sub-kind classification added by Phase D of
 * `plans/archive/EXTERN_UNSAFE_WRAP.md` to `yo unsafe-report`.
 *
 * Each `unsafe(...)` site gets one of:
 *   - extern-call: body starts with a name harvested from an
 *     `extern("c", ...)` or `c_include(...)` declaration.
 *   - deref:       body contains `.*`.
 *   - arith:       body contains `&+`, `&-`, or `&/`.
 *   - addr-of:     body contains `&(`.
 *   - other:       anything else.
 *
 * Tests build a tiny temp-dir project, run the scanner, and assert
 * the sub-kind + callee name on each finding.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { generateUnsafeReport } from "../unsafe-report";

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yo-unsafe-report-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeFile(dir: string, rel: string, contents: string): string {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
  return full;
}

describe("unsafe-report sub-kind classification", () => {
  test("classifies an extern-call wrap and records the callee name", () => {
    withTempDir((dir) => {
      writeFile(
        dir,
        "libc.yo",
        `pragma(Pragma.AllowUnsafe);
c_include(
  "<string.h>",
  strlen :
    fn(s : *(u8)) -> usize
);
`
      );
      writeFile(
        dir,
        "wrapper.yo",
        `pragma(Pragma.AllowUnsafe);
{ strlen } :: import("./libc");
yo_strlen :: (fn(s : *(u8)) -> usize)(unsafe(strlen(s)));
`
      );
      const report = generateUnsafeReport(dir);
      const finding = report.findings.find(
        (f) => f.kind === "unsafe" && f.file.endsWith("wrapper.yo")
      );
      expect(finding?.subKind).toBe("extern-call");
      expect(finding?.calleeName).toBe("strlen");
      expect(report.totals.unsafeBySubKind["extern-call"]).toBe(1);
      expect(report.topExternCallees).toEqual([{ callee: "strlen", count: 1 }]);
    });
  });

  test("classifies a deref wrap", () => {
    withTempDir((dir) => {
      writeFile(
        dir,
        "deref.yo",
        `pragma(Pragma.AllowUnsafe);
load :: (fn(p : *(i32)) -> i32)(unsafe(p.*));
`
      );
      const report = generateUnsafeReport(dir);
      const f = report.findings[0]!;
      expect(f.subKind).toBe("deref");
      expect(report.totals.unsafeBySubKind.deref).toBe(1);
    });
  });

  test("classifies an arith wrap (&+, &-, &/)", () => {
    withTempDir((dir) => {
      writeFile(
        dir,
        "arith.yo",
        `pragma(Pragma.AllowUnsafe);
advance :: (fn(p : *(i32), n : usize) -> *(i32))(unsafe(p &+ n));
`
      );
      const report = generateUnsafeReport(dir);
      const f = report.findings[0]!;
      expect(f.subKind).toBe("arith");
      expect(report.totals.unsafeBySubKind.arith).toBe(1);
    });
  });

  test("classifies an addr-of wrap", () => {
    withTempDir((dir) => {
      writeFile(
        dir,
        "addr.yo",
        `pragma(Pragma.AllowUnsafe);
Point :: struct(x : i32, y : i32);
get_x :: (fn(ref(p) : Point) -> *(i32))(unsafe(&(p.x)));
`
      );
      const report = generateUnsafeReport(dir);
      const f = report.findings[0]!;
      expect(f.subKind).toBe("addr-of");
      expect(report.totals.unsafeBySubKind["addr-of"]).toBe(1);
    });
  });

  test("classifies a call to a non-extern function as 'other'", () => {
    withTempDir((dir) => {
      writeFile(
        dir,
        "other.yo",
        `pragma(Pragma.AllowUnsafe);
helper :: (fn(n : i32) -> i32)(n);
wrapped :: (fn(n : i32) -> i32)(unsafe(helper(n)));
`
      );
      const report = generateUnsafeReport(dir);
      // First finding is the unsafe site (extern findings on the c_include
      // file are also collected, but there is none here).
      const f = report.findings.find((fnd) => fnd.kind === "unsafe")!;
      expect(f.subKind).toBe("other");
      expect(f.calleeName).toBeUndefined();
    });
  });

  test('harvests extern names from both c_include and extern("c",...)', () => {
    withTempDir((dir) => {
      writeFile(
        dir,
        "decls.yo",
        `pragma(Pragma.AllowUnsafe);
c_include(
  "<stdlib.h>",
  malloc :
    (fn(size : usize) -> *(void))
);
extern(
  "c",
  custom_alloc :
    fn(size : usize) -> *(void)
);
`
      );
      writeFile(
        dir,
        "use.yo",
        `pragma(Pragma.AllowUnsafe);
{ malloc, custom_alloc } :: import("./decls");
a :: (fn(n : usize) -> *(void))(unsafe(malloc(n)));
b :: (fn(n : usize) -> *(void))(unsafe(custom_alloc(n)));
`
      );
      const report = generateUnsafeReport(dir);
      const externCalls = report.findings.filter(
        (f) => f.kind === "unsafe" && f.subKind === "extern-call"
      );
      expect(externCalls).toHaveLength(2);
      const callees = new Set(externCalls.map((f) => f.calleeName));
      expect(callees).toEqual(new Set(["malloc", "custom_alloc"]));
    });
  });

  test("sorts topExternCallees by count desc", () => {
    withTempDir((dir) => {
      writeFile(
        dir,
        "decls.yo",
        `pragma(Pragma.AllowUnsafe);
c_include(
  "<stdlib.h>",
  malloc :
    (fn(size : usize) -> *(void)),
  free :
    (fn(p : *(void)) -> unit)
);
`
      );
      writeFile(
        dir,
        "use.yo",
        `pragma(Pragma.AllowUnsafe);
{ malloc, free } :: import("./decls");
a :: (fn() -> *(void))(unsafe(malloc(usize(8))));
b :: (fn() -> *(void))(unsafe(malloc(usize(16))));
c :: (fn() -> *(void))(unsafe(malloc(usize(32))));
d :: (fn(p : *(void)) -> unit)(unsafe(free(p)));
`
      );
      const report = generateUnsafeReport(dir);
      expect(report.topExternCallees).toEqual([
        { callee: "malloc", count: 3 },
        { callee: "free", count: 1 },
      ]);
    });
  });
});
