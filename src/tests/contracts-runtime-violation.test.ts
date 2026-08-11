/**
 * Runtime contract-violation tests (plans/FORMAL_VERIFICATION.md Phase 0).
 *
 * A `requires(...)` / `ensures(...)` on a RUNTIME function lowers to a
 * runtime `assert(...)`. When the predicate is violated at runtime the
 * program must panic (abort) with a "requires failed" / "ensures failed"
 * message.
 *
 * These can't be Yo-level tests: a violating call aborts the whole test
 * process. So we compile each program to a binary, run it, and assert on
 * the exit code and stderr — the panic path. The passing counterparts
 * (contract holds) live in `tests/spec/contracts_phase0.test.yo`.
 */

import { describe, test, expect } from "bun:test";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const REPO_ROOT = path.resolve(__dirname, "../..");
const YO_CLI = path.join(REPO_ROOT, "out", "cjs", "yo-cli.cjs");

/**
 * Compile `source` to a binary and run it. Returns the run result:
 * `{ code, output }` where `code` is the process exit code (null if
 * killed by a signal) and `output` is combined stdout+stderr.
 */
function compileAndRun(source: string): {
  code: number | null;
  output: string;
} {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yo-contracts-rt-"));
  const src = path.join(tmpDir, "prog.yo");
  const bin = path.join(tmpDir, "prog");
  fs.writeFileSync(src, source, "utf8");
  try {
    // Compile (must succeed — the violation is a runtime, not compile, error).
    execFileSync("node", [YO_CLI, "compile", src, "--release", "-o", bin], {
      stdio: "pipe",
    });
    // Run the binary; capture exit code + output.
    try {
      const stdout = execFileSync(bin, [], { stdio: "pipe" });
      return { code: 0, output: stdout.toString() };
    } catch (e: unknown) {
      const err = e as {
        status?: number | null;
        stderr?: Buffer;
        stdout?: Buffer;
      };
      const output =
        (err.stdout ? err.stdout.toString() : "") +
        (err.stderr ? err.stderr.toString() : "");
      return { code: err.status ?? null, output };
    }
  } finally {
    // Cleanup must not fail a passing test. On Windows, removing a directory
    // that holds a just-executed binary fails with EBUSY/EPERM while the image
    // is still mapped (or an AV scanner holds a handle), and `force: true` only
    // suppresses ENOENT — so this line, not any assertion, failed the Windows
    // leg of CI. This is the only TS test that RUNS a binary out of its temp
    // dir, which is why it is the only one that flaked.
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // leave the temp dir behind; the OS reaps it
    }
  }
}

describe("runtime contract violations — panic at run time", () => {
  test("runtime requires(...) violation panics", () => {
    const { code, output } = compileAndRun(`
divide :: (fn(x : i32, y : i32, requires(y != i32(0))) -> i32)(x / y);
main :: (fn() -> unit)({
  d := divide(i32(10), i32(0));
});
export(main);
`);
    expect(code).not.toBe(0);
    expect(output).toMatch(/requires failed/);
  });

  test("runtime ensures(...) violation panics", () => {
    const { code, output } = compileAndRun(`
bad_abs :: (fn(x : i32, ensures(result >= i32(0))) -> i32)(x);
main :: (fn() -> unit)({
  a := bad_abs(i32(-(5)));
});
export(main);
`);
    expect(code).not.toBe(0);
    expect(output).toMatch(/ensures failed/);
  });

  test("ensures(...) with old(...) violation panics", () => {
    const { code, output } = compileAndRun(`
bump :: (fn(inout(n) : i32, ensures(n == old(n))) -> unit)({ n = (n + i32(1)); });
main :: (fn() -> unit)({ x := i32(5); bump(x); });
export(main);
`);
    expect(code).not.toBe(0);
    expect(output).toMatch(/ensures failed/);
  });

  test("satisfying contract does NOT panic (exit 0)", () => {
    const { code } = compileAndRun(`
{ assert } :: import("std/assert");
divide :: (fn(x : i32, y : i32, requires(y != i32(0)), ensures(result == (x / y))) -> i32)(x / y);
main :: (fn() -> unit)({
  d := divide(i32(10), i32(2));
  assert(d == i32(5), "10/2 == 5");
});
export(main);
`);
    expect(code).toBe(0);
  });
});
