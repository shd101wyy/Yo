/**
 * Negative tests for `io.await` in positions the async state machine cannot
 * split at.
 *
 * The positive direction lives in `tests/async_await.test.yo`: an await used
 * DIRECTLY as an `if`/`cond` condition or a `match` scrutinee is supported —
 * codegen hoists it across the state boundary, and it is a real suspension (a
 * task spawned first still interleaves).
 *
 * What is left unsupported, and pinned here:
 *
 *  - an await NESTED inside a larger condition (`if(!(io.await(f, io)), ...)`).
 *    Substituting the extracted result into a bigger expression asks codegen
 *    for helper specialisations the collection pass never saw. This is a
 *    general limit on nested awaits — plain `b := !(io.await(f, io))` fails the
 *    same way — not something the conditional hoist introduces.
 *  - an await in a LATER `cond` branch condition. `cond` is lazy, so hoisting
 *    it would await even when an earlier branch matches: a silent change of
 *    meaning, not just of timing.
 *
 * These exist because the failure they pin used to be SILENT. The state segment
 * generator wrote `// ERROR: Unsupported pattern for await expression` as a C
 * *comment* and returned, but its caller then emitted the await machinery
 * anyway — reading `sm->await_future_N`, a field only the (skipped) handlers
 * ever assign. The result compiled with rc=0 and segfaulted on the NULL
 * dereference. `yo-self init` shipped in exactly that state.
 *
 * So the property under test is not just "the message is right" — it is that
 * these shapes fail at COMPILE time at all.
 */

import { describe, test, expect } from "bun:test";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const REPO_ROOT = path.resolve(__dirname, "../..");
const YO_CLI = path.join(REPO_ROOT, "out", "cjs", "yo-cli.cjs");

function compileAndExpectError(source: string): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yo-await-position-"));
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
    throw new Error(
      "Expected compilation to fail, but it succeeded. An await in conditional " +
        "position must never reach codegen — it produces a NULL await_future_N."
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

const PRELUDE = `open(import("std/string"));
open(import("std/fmt"));
{ Exception, IoExn } :: import("std/error");
{ yield } :: import("std/async");

ready :: (fn(io : Io) -> Impl(Future(bool, Io)))(
  io.async((io : Io) => {
    io.await(yield(io), io);
    return(true);
  })
);
`;

const EPILOGUE = `
main :: (fn(io : Io, exn : Exception) -> unit)({
  io.await(do_it(io, exn), IoExn(io : io, exn : exn));
});

export(main);
`;

describe("io.await in unsplittable positions — rejected, never miscompiled", () => {
  test("an await NESTED inside an `if` condition is rejected", () => {
    const output = compileAndExpectError(
      `${PRELUDE}
do_it :: (fn(io : Io, exn : Exception) -> Impl(Future(unit, IoExn)))(
  io.async((e) => {
    if(!(e.io.await(ready(e.io), e.io)), {
      println(String.from("not taken"));
    });
  })
);
${EPILOGUE}`
    );
    expect(output).toMatch(/must BE the first condition/);
    // The diagnostic must carry the fix, not just the complaint.
    expect(output).toMatch(/Bind it to a local first/);
  });

  test("an await in a LATER `cond` branch condition is rejected", () => {
    // Hoisting here would break `cond`'s laziness: the await would run even
    // when the first branch matches.
    const output = compileAndExpectError(
      `${PRELUDE}
do_it :: (fn(io : Io, exn : Exception) -> Impl(Future(unit, IoExn)))(
  io.async((e) => {
    cond(
      runtime(false) => {
        println(String.from("first"));
      },
      e.io.await(ready(e.io), e.io) => {
        println(String.from("second"));
      },
      true => ()
    );
  })
);
${EPILOGUE}`
    );
    expect(output).toMatch(/must BE the first condition/);
    expect(output).toMatch(/only evaluated if the earlier ones fail/);
  });

  test("the generated C never contains the old silent-failure marker", () => {
    // Belt and braces: if the marker is ever emitted again as a comment, the
    // binary it produces dereferences NULL. Nothing may reintroduce it.
    const stateCodeGen = fs.readFileSync(
      path.join(REPO_ROOT, "src", "codegen", "async", "state-code-gen.ts"),
      "utf8"
    );
    expect(stateCodeGen).not.toMatch(
      /emitLine\([^)]*ERROR: Unsupported pattern for await/
    );
  });
});
