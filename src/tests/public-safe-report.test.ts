/**
 * Tests for `yo public-safe-report` — the stdlib-public-safe lint
 * (Phase D follow-up of plans/MEMORY_SAFETY.md).
 *
 * Coverage matrix:
 * - Flags raw pointer in a parameter slot.
 * - Flags raw pointer in a return-type slot.
 * - Skips signatures inside `extern(...)` blocks (FFI by design).
 * - Skips `_`-prefixed (private) declarations.
 * - Skips raw-pointer-API names (`*_cstr`, `from_raw_parts`,
 *   `as_ptr`, names starting with `raw_`, `argv`).
 * - Skips files under directories that are FFI-by-construction
 *   (`libc/`, `linux/`, `darwin/`, `cuda/`, `sys/`, `sync/`).
 */
import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { generatePublicSafeReport } from "../public-safe-report";

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yo-public-safe-"));
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

describe("yo public-safe-report", () => {
  test("flags a raw pointer parameter on a public top-level fn", () => {
    withTempDir((dir) => {
      writeFile(
        dir,
        "leaky.yo",
        `bad_api :: (fn(buf : *(u8), size : usize) -> unit)({
  return(());
});
`
      );
      const report = generatePublicSafeReport(dir);
      expect(report.totals.findings).toBe(1);
      expect(report.findings[0]!.declName).toBe("bad_api");
      expect(report.findings[0]!.slot).toBe("parameter");
      expect(report.findings[0]!.pointerType).toBe("*(u8)");
    });
  });

  test("flags a raw pointer return type", () => {
    withTempDir((dir) => {
      writeFile(
        dir,
        "leaky.yo",
        `escape_hatch :: (fn(x : i32) -> *(u8))({
  return(*(u8)("hi"));
});
`
      );
      const report = generatePublicSafeReport(dir);
      expect(report.totals.findings).toBe(1);
      expect(report.findings[0]!.declName).toBe("escape_hatch");
      expect(report.findings[0]!.slot).toBe("return");
      expect(report.findings[0]!.pointerType).toBe("*(u8)");
    });
  });

  test("skips signatures inside extern(...) blocks", () => {
    withTempDir((dir) => {
      writeFile(
        dir,
        "ffi.yo",
        `extern(
  "Yo",
  __yo_some_syscall : (fn(buf : *(u8), size : usize) -> i32)
);
`
      );
      const report = generatePublicSafeReport(dir);
      expect(report.totals.findings).toBe(0);
    });
  });

  test("skips _-prefixed (private) declarations", () => {
    withTempDir((dir) => {
      writeFile(
        dir,
        "private.yo",
        `_internal_helper :: (fn(buf : *(u8)) -> unit)({
  return(());
});
`
      );
      const report = generatePublicSafeReport(dir);
      expect(report.totals.findings).toBe(0);
    });
  });

  test("skips raw-pointer-API names (_cstr, raw_, as_ptr, argv)", () => {
    withTempDir((dir) => {
      writeFile(
        dir,
        "by_contract.yo",
        `read_cstr :: (fn(path : *(u8)) -> unit)({ return(()); });
raw_args :: (fn() -> *(*(u8)))({ return(*(*(u8))(0)); });
as_ptr :: (fn() -> *(u8))({ return(*(u8)("")); });
argv :: (fn() -> *(*(u8)))({ return(*(*(u8))(0)); });
from_raw_parts :: (fn(p : *(u8), n : usize) -> unit)({ return(()); });
`
      );
      const report = generatePublicSafeReport(dir);
      expect(report.totals.findings).toBe(0);
    });
  });

  test("skips files under FFI-by-construction directories", () => {
    withTempDir((dir) => {
      writeFile(
        dir,
        "libc/string.yo",
        `memcpy_yo :: (fn(dest : *(u8), src : *(u8), n : usize) -> *(u8))({
  return(dest);
});
`
      );
      writeFile(
        dir,
        "sys/file.yo",
        `read :: (fn(fd : i32, buf : *(u8), size : u32, offset : u64) -> isize)({
  return(isize(0));
});
`
      );
      const report = generatePublicSafeReport(dir);
      expect(report.totals.findings).toBe(0);
    });
  });

  test("reports public count even when zero findings", () => {
    withTempDir((dir) => {
      writeFile(
        dir,
        "clean.yo",
        `pure_fn :: (fn(x : i32) -> i32)({
  return(x + 1);
});
takes_inout :: (fn(inout(x) : i32) -> unit)({
  x = (x + 1);
});
`
      );
      const report = generatePublicSafeReport(dir);
      expect(report.totals.findings).toBe(0);
      expect(report.totals.publicDeclsScanned).toBe(2);
    });
  });
});
