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
const YO_CLI = path.join(REPO_ROOT, "yo-cli");

function compileAndExpectError(source: string): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yo-unsafe-gate-"));
  const file = path.join(tmpDir, "neg.yo");
  fs.writeFileSync(file, source, "utf8");
  try {
    try {
      execFileSync(
        YO_CLI,
        ["compile", file, "--emit-c", "--skip-c-compiler", "--release"],
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
  test("pointer dereference requires unsafe", () => {
    const out = compileAndExpectError(`
main :: (fn() -> unit)({
  x := i32(42);
  p := &(x);
  v := p.*;
  assert((v == i32(42)), "deref");
});
export(main);
`);
    expect(out).toContain("Pointer dereference requires 'unsafe(...)'");
    expect(out).toContain("Wrap as: unsafe(p.*)");
  });

  test("pointer arithmetic (&+) requires unsafe", () => {
    const out = compileAndExpectError(`
foo :: (fn(p : *(i32)) -> *(i32))(
  (p &+ usize(1))
);
main :: (fn() -> unit)({
  x := i32(0);
  q := foo(&(x));
});
export(main);
`);
    expect(out).toContain("Pointer arithmetic ('&+') requires 'unsafe(...)'");
  });

  test("unsafe wrap lets the same code compile", () => {
    // Compile-only sanity check that wrapping makes the program legal.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yo-unsafe-gate-"));
    const file = path.join(tmpDir, "pos.yo");
    fs.writeFileSync(
      file,
      `
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
        YO_CLI,
        ["compile", file, "--emit-c", "--skip-c-compiler", "--release"],
        { stdio: "pipe" }
      );
      // No throw — compiled.
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
