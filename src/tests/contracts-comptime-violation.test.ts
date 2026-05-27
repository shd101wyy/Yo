/**
 * Negative tests for comptime contract violations
 * (plans/FORMAL_VERIFICATION.md Phase 0).
 *
 * A `requires(...)` / `ensures(...)` on a COMPTIME function (one whose
 * return type is `comptime(...)`) lowers to `comptime_assert(...)`.
 * When the predicate is violated, the failure surfaces during
 * compile-time evaluation of the call site.
 *
 * These cannot be expressed as in-language `comptime_expect_error`
 * tests: the comptime failure escapes the surrounding test body to the
 * module-load level (it crosses the test-runner's batched compile), so
 * `comptime_expect_error` never sees it. A shell-out gate test is the
 * right tool — same pattern as `comptime-ref-gate.test.ts`,
 * `pragma-validation.test.ts`, `unsafe-gate.test.ts`.
 *
 * The positive (passing) comptime cases live in the Yo-level
 * `tests/spec/contracts_phase0.test.yo`.
 */

import { describe, test, expect } from "bun:test";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const REPO_ROOT = path.resolve(__dirname, "../..");
const YO_CLI = path.join(REPO_ROOT, "out", "cjs", "yo-cli.cjs");

function compileAndExpectError(source: string): string {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "yo-contracts-comptime-")
  );
  const file = path.join(tmpDir, "neg.yo");
  fs.writeFileSync(file, source, "utf8");
  try {
    try {
      execFileSync(
        "node",
        [YO_CLI, "compile", file, "--emit-c", "--skip-c-compiler", "--release"],
        { stdio: "pipe" }
      );
    } catch (e: unknown) {
      const err = e as { stderr?: Buffer; stdout?: Buffer; message?: string };
      const stderr = err.stderr ? err.stderr.toString() : "";
      const stdout = err.stdout ? err.stdout.toString() : "";
      return stderr + stdout + (err.message ?? "");
    }
    throw new Error("Expected compilation to fail, but it succeeded.");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("comptime contract violations — compile errors", () => {
  test("comptime requires(...) violation fails the compile", () => {
    const output = compileAndExpectError(`
abs :: (fn(comptime(x) : i32, requires(x >= i32(-(100)))) -> comptime(i32))(
  cond((x >= i32(0)) => x, true => -(x))
);
BAD :: abs(i32(-(200)));
main :: (fn() -> unit)({});
export(main);
`);
    expect(output).toMatch(/requires failed/);
  });

  test("comptime ensures(...) violation fails the compile", () => {
    const output = compileAndExpectError(`
neg :: (fn(comptime(x) : i32, ensures(result >= i32(0))) -> comptime(i32))(-(x));
BAD :: neg(i32(5));
main :: (fn() -> unit)({});
export(main);
`);
    expect(output).toMatch(/ensures failed/);
  });

  test("comptime requires(...) on a satisfying call compiles cleanly", () => {
    // Sanity: the same function with a valid argument must NOT error.
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "yo-contracts-comptime-ok-")
    );
    const file = path.join(tmpDir, "ok.yo");
    fs.writeFileSync(
      file,
      `
abs :: (fn(comptime(x) : i32, requires(x >= i32(-(100)))) -> comptime(i32))(
  cond((x >= i32(0)) => x, true => -(x))
);
GOOD :: abs(i32(-(50)));
main :: (fn() -> unit)({});
export(main);
`,
      "utf8"
    );
    try {
      // Should NOT throw.
      execFileSync(
        "node",
        [YO_CLI, "compile", file, "--emit-c", "--skip-c-compiler", "--release"],
        { stdio: "pipe" }
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
