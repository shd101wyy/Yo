/**
 * Negative tests for `comptime(ref(name)) : T` parameter form.
 *
 * The positive direction lives in `tests/comptime_inout.test.yo`
 * (Yo-level). This file pins the error messages the evaluator
 * surfaces when a user combines `inout` with the wrong outer
 * modifier or omits required pieces.
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
    path.join(os.tmpdir(), "yo-comptime-inout-gate-")
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

describe("comptime(ref(...)) parameter form — error cases", () => {
  test("inout inside generic(...) is rejected with a targeted error", () => {
    // generic(...) params are comptime-by-default AND erased at
    // runtime, so there's no callee-side binding for inout to
    // refer to. The rejection fires at
    // src/evaluator/types/function.ts when the parameter walker
    // encounters inout under a generic context.
    const output = compileAndExpectError(`
take_param :: (
  fn(generic(ref(T) : Type), x : T) -> T
)(x);
main :: (fn() -> unit)({});
export(main);
`);
    expect(output).toMatch(
      /'ref' cannot combine with 'generic'\/'using' parameters/
    );
  });

  test("own(ref(...)) is rejected (opposite calling conventions)", () => {
    // Pre-existing rule, but worth re-pinning under this gate's
    // umbrella so the error doesn't regress as the modifier
    // ordering evolves. Note: the rejection fires for the
    // own-outer ordering — the parser processes `own` first, then
    // `inout`, and the inout check sees `isOwningTheRcValue` set.
    const output = compileAndExpectError(`
takes :: (fn(own(ref(x)) : i32) -> i32)(x);
main :: (fn() -> unit)({});
export(main);
`);
    expect(output).toMatch(
      /Cannot combine 'own' and 'ref' on the same parameter/
    );
  });

  test("comptime(ref(...)) compiles cleanly (positive guardrail)", () => {
    // Confirms the *positive* path actually works end-to-end —
    // catches accidental over-tightening of the gate.
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "yo-comptime-inout-gate-pos-")
    );
    const file = path.join(tmpDir, "pos.yo");
    fs.writeFileSync(
      file,
      `
bump :: (fn(comptime(ref(n)) : usize) -> comptime(usize))({
  n = (n + usize(1));
  n
});
comptime_assert(bump(usize(5)) == usize(6), "5+1 should be 6");
main :: (fn() -> unit)({});
export(main);
`,
      "utf8"
    );
    try {
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
