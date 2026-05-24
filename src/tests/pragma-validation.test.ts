/**
 * Tests for `pragma(Pragma.X);` argument validation (Phase G of
 * plans/MEMORY_SAFETY.md).
 *
 * `evaluatePragma` now evaluates its argument and checks it against
 * the `Pragma` enum in `std/prelude.yo`. Typos and non-Pragma values
 * must produce clear errors. The previous AST-shape token-name match
 * silently accepted unknown variants — these tests pin the new
 * stricter behavior.
 *
 * `SkipPrelude` still has a separate AST-level pre-scan (it must run
 * before the prelude loads), but the runtime evaluatePragma call on
 * the same line short-circuits — so a SkipPrelude file with a typo
 * elsewhere is still caught.
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
    path.join(os.tmpdir(), "yo-pragma-validation-")
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

describe("pragma(...) argument validation", () => {
  test("typo'd Pragma variant produces a clear error (not silent acceptance)", () => {
    // `Pragma.AlloeUnsafe` — single-letter typo. Under the old
    // AST-shape match, this would have hit the `default: return null`
    // branch and produced an error — but only because the variant
    // name was wrong, not because it wasn't a real Pragma value. The
    // new evaluation path catches the same case AND additionally
    // catches "looks like Pragma.X but isn't actually a Pragma" (see
    // next test).
    const output = compileAndExpectError(`
pragma(Pragma.AlloeUnsafe);
main :: (fn() -> i32)(i32(0));
export(main);
`);
    expect(output).toMatch(/Enum variant ['"]AlloeUnsafe['"] not found/i);
  });

  test("non-Pragma enum value rejected — was silently accepted before", () => {
    // `Ordering.Less` evaluates to a real enum value, just not a
    // Pragma one. Under the old AST-shape path this would have been
    // recognized as "doesn't match `Pragma.X` shape, but the LHS atom
    // name doesn't match either" and rejected with the wrong error.
    // The new path produces a specific "expects a 'Pragma.X' argument"
    // error mentioning the actual offending type.
    const output = compileAndExpectError(`
pragma(Ordering.Less);
main :: (fn() -> i32)(i32(0));
export(main);
`);
    expect(output).toMatch(/'pragma\(\.\.\.\)' expects a 'Pragma\.X' argument/);
    expect(output).toMatch(/Ordering/);
  });

  test("non-enum argument rejected", () => {
    // Old behavior: AST-shape didn't match (not a `.` call), error
    // said "expects a 'Pragma.X' argument" with the expression
    // textually echoed. New behavior: evaluates the argument, sees a
    // non-enum type, and produces the same kind of error with the
    // type name surfaced.
    const output = compileAndExpectError(`
pragma(42);
main :: (fn() -> i32)(i32(0));
export(main);
`);
    expect(output).toMatch(/'pragma\(\.\.\.\)' expects a 'Pragma\.X' argument/);
  });
});
