/**
 * Negative tests for the reserved verification quantifiers.
 *
 * `plans/FORALL_TO_GENERIC.md` renamed the type-parameter binder
 * `forall` -> `generic` and reserved `forall` / `∀` for future Dafny-style
 * quantifiers in `requires` / `ensures`. `exists` / `∃` are deliberately NOT
 * reserved — `exists` is a live public API (`std/fs/file.yo:324`, 72 files). The
 * cutover ships targeted diagnostics instead of a compatibility alias, so
 * stale code fails with the exact fix rather than an "unknown identifier"
 * cascade.
 *
 * These are LEXER errors (src/lexer.ts), not evaluator errors, so they
 * cannot be expressed with `comptime_expect_error` in a `.yo` test — a
 * reserved word makes the whole file fail to tokenize. Hence the
 * shell-out shape, matching `comptime-ref-gate.test.ts`.
 *
 * The positive direction (`generic(T : Type)` still binds type
 * parameters) is covered by the entire `std/` + `tests/` corpus.
 */

import { describe, test, expect } from "bun:test";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const REPO_ROOT = path.resolve(__dirname, "../..");
const YO_CLI = path.join(REPO_ROOT, "out", "cjs", "yo-cli.cjs");

function compileAndExpectError(source: string): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yo-reserved-quant-"));
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

describe("reserved verification quantifiers", () => {
  test("`forall` as a type binder points at `generic`", () => {
    const out = compileAndExpectError(
      `sum :: (fn(forall(T : Type), a : T, b : T) -> T)((a + b));\nexport(sum);\n`
    );
    expect(out).toContain("`forall` is reserved for verification quantifiers");
    expect(out).toContain("Use `generic(T : Type)` to declare type parameters");
  });

  test("`forall` as a bare identifier is reserved too", () => {
    const out = compileAndExpectError(
      `main :: (fn() -> unit)({ x :: forall; });\nexport(main);\n`
    );
    expect(out).toContain("`forall` is reserved for verification quantifiers");
  });

  test("`exists` is NOT reserved — it is a live std API", () => {
    // `std/fs/file.yo:324` defines `exists(path, io)` and 72 files use it, so
    // reserving the word would break the filesystem API for a feature that
    // does not exist yet. See plans/FORALL_TO_GENERIC.md ("Deviation").
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yo-exists-ok-"));
    const file = path.join(tmpDir, "pos.yo");
    fs.writeFileSync(
      file,
      `exists :: (fn(x : i32) -> bool)((x > 0));\nexport(exists);\n`,
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

  test("`∀` is reserved", () => {
    const out = compileAndExpectError(
      `main :: (fn() -> unit)({ x :: ∀; });\nexport(main);\n`
    );
    expect(out).toContain("is reserved for verification quantifiers");
  });

  test("`generic` still binds type parameters", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yo-reserved-pos-"));
    const file = path.join(tmpDir, "pos.yo");
    fs.writeFileSync(
      file,
      `sum :: (fn(generic(T : Type), a : T, b : T) -> T)((a + b));\nexport(sum);\n`,
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
