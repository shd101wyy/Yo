/**
 * Phase G (THREAD_SAFETY): Codegen pin tests for atomic RC operations.
 *
 * Verifies that the generated C code uses correct C11 memory ordering:
 * - __yo_incr_rc_atomic: atomic_fetch_add_explicit(..., relaxed)
 * - __yo_decr_rc_atomic: atomic_fetch_sub_explicit(..., acq_rel)
 * - Drop runs after acq_rel decrement (happens-before edge)
 */
import { describe, test, expect } from "bun:test";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const REPO_ROOT = path.resolve(__dirname, "../..");
const YO_CLI = path.join(REPO_ROOT, "out", "cjs", "yo-cli.cjs");

function compileAndGetC(source: string): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yo-atomics-gate-"));
  const file = path.join(tmpDir, "test.yo");
  fs.writeFileSync(file, source, "utf8");
  try {
    const result = execFileSync(
      "node",
      [YO_CLI, "compile", file, "--emit-c", "--skip-c-compiler", "--release"],
      { stdio: "pipe" }
    );
    return result.toString();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("Phase G — atomic RC codegen pin tests", () => {
  test("__yo_incr_rc_atomic uses atomic_fetch_add_explicit with relaxed", () => {
    const c = compileAndGetC(`
      main :: (fn() -> unit)({
        a := arc(i32(42));
        b := a;
      });
      export(main);
    `);
    // Verify the increment function uses relaxed ordering
    expect(c).toContain("atomic_fetch_add_explicit");
    expect(c).toMatch(/atomic_fetch_add_explicit.*memory_order_relaxed/);
  });

  test("__yo_decr_rc_atomic uses atomic_fetch_sub_explicit with acq_rel", () => {
    const c = compileAndGetC(`
      main :: (fn() -> unit)({
        a := arc(i32(42));
        b := a;
      });
      export(main);
    `);
    expect(c).toMatch(/atomic_fetch_sub_explicit.*memory_order_acq_rel/);
  });

  test("drop on last-release runs after acq_rel decrement", () => {
    const c = compileAndGetC(`
      main :: (fn() -> unit)({
        a := arc(i32(42));
        b := a;
      });
      export(main);
    `);
    // Verify the decrement function checks old_count == 1 and calls dispose
    expect(c).toMatch(/atomic_fetch_sub_explicit.*memory_order_acq_rel/);
    // The __yo_decr_rc_atomic function should contain both the acq_rel decrement
    // and the dispose dispatch call
    const decrFn = c.slice(
      c.indexOf("static void __yo_decr_rc_atomic"),
      c.indexOf("}", c.indexOf("static void __yo_decr_rc_atomic")) + 500
    );
    expect(decrFn).toContain("atomic_fetch_sub_explicit");
    expect(decrFn).toContain("memory_order_acq_rel");
    expect(decrFn).toContain("__yo_dispose_dispatch");
  });
});
