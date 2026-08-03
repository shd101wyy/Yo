/**
 * Tests for the `unsafe(...)` gate (Phase A of plans/MEMORY_SAFETY.md).
 *
 * The Yo-level test file `tests/unsafe.test.yo` covers the positive
 * cases (`unsafe(...)` accepts deref/arithmetic, transparency,
 * nesting, etc.). This TypeScript-level test covers the **negative**
 * direction: a user-code file outside the implicitly-unsafe-capable
 * directories (`/std/`, `/yo-self/`, `/tests/`,
 * `auto-generated://...`) must fail to compile when it does pointer
 * ops without an `unsafe(...)` wrap, with the expected error message.
 *
 * We compile a temp file under `/tmp/` (not an implicit-unsafe path)
 * via `yo-cli compile` and assert on stderr.
 */

import { describe, test, expect } from "bun:test";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const REPO_ROOT = path.resolve(__dirname, "../..");
const YO_CLI = path.join(REPO_ROOT, "out", "cjs", "yo-cli.cjs");

function compileAndExpectError(source: string): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yo-unsafe-gate-"));
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
      // Expected — return stderr/stdout for assertions.
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

describe("unsafe(...) gate — user code (outside std/, yo-self/, tests/)", () => {
  test("&(x) — taking an address — is rejected in safe code", () => {
    // Phase C structural gate: `&(x)` produces a raw pointer
    // value. Before any of the deeper "needs unsafe wrap"
    // diagnostics fire, the structural rule rejects the
    // address-of operator itself.
    const out = compileAndExpectError(`
main :: (fn() -> unit)({
  x := i32(42);
  p := &(x);
});
export(main);
`);
    expect(out).toContain(
      "Taking an address with '&(...)' produces a raw pointer"
    );
    expect(out).toContain("pragma(Pragma.AllowUnsafe)");
  });

  test("*(T) type declaration is rejected in safe code", () => {
    // Phase C structural gate: declaring a parameter, field, or
    // return of type `*(T)` is rejected without the pragma. The
    // diagnostic points at the `*(i32)` in the signature.
    const out = compileAndExpectError(`
foo :: (fn(p : *(i32)) -> i32)(i32(0));
main :: (fn() -> unit)({});
export(main);
`);
    expect(out).toContain("Raw pointer types ('*(i32)') are not available");
    expect(out).toContain("pragma(Pragma.AllowUnsafe)");
  });

  test("unsafe(...) without pragma is rejected at the unsafe(...) call", () => {
    // To pin the unsafe-call gate specifically (not the
    // structural `&(x)` / `*(T)` gates), use a value expression
    // that doesn't itself produce a raw pointer. Without pragma,
    // even the bare `unsafe(...)` call fires.
    const out = compileAndExpectError(`
main :: (fn() -> unit)({
  v := unsafe(i32(0));
});
export(main);
`);
    expect(out).toContain("'unsafe(...)' is not available in safe code");
    expect(out).toContain("pragma(Pragma.AllowUnsafe)");
  });

  test("pragma + unsafe wrap lets the same code compile", () => {
    // With pragma at the top, the file is unsafe-capable; `unsafe(...)`
    // can be used and pointer ops inside it are permitted.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yo-unsafe-gate-"));
    const file = path.join(tmpDir, "pos.yo");
    fs.writeFileSync(
      file,
      `pragma(Pragma.AllowUnsafe);
{ assert } :: import("std/assert");
main :: (fn() -> unit)({
  x := i32(42);
  p := &(x);
  v := unsafe(p.*);
  assert((v == i32(42)), "deref via unsafe");
});
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
      // No throw — compiled.
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
