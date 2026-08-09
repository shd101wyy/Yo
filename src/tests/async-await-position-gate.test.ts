/**
 * Negative tests for `io.await` in positions the async state machine cannot
 * split at.
 *
 * The positive direction lives in `tests/async_await.test.yo` (await inside an
 * `if`/`else` body, and the hoisted form of a conditional await).
 *
 * These exist because the failure they pin used to be SILENT. The state segment
 * generator wrote `// ERROR: Unsupported pattern for await expression` as a C
 * *comment* and returned, but its caller then emitted the await machinery
 * anyway — reading `sm->await_future_N`, a field only the (skipped) handlers
 * ever assign. The result compiled with rc=0 and segfaulted on the NULL
 * dereference, with the `if` body silently dropped. `yo-self init` shipped in
 * exactly that state.
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

describe("io.await in conditional position — rejected, never miscompiled", () => {
  test("await in an `if` condition is rejected and names `if`", () => {
    const output = compileAndExpectError(
      `${PRELUDE}
do_it :: (fn(io : Io, exn : Exception) -> Impl(Future(unit, IoExn)))(
  io.async((e) => {
    if(e.io.await(ready(e.io), e.io), {
      println(String.from("taken"));
    });
  })
);
${EPILOGUE}`
    );
    expect(output).toMatch(
      /`io\.await` is not supported in the condition of `if`/
    );
    // The diagnostic must carry the fix, not just the complaint.
    expect(output).toMatch(/Hoist it into a local first/);
  });

  test("await in a `cond` branch condition is rejected and names `cond`", () => {
    const output = compileAndExpectError(
      `${PRELUDE}
do_it :: (fn(io : Io, exn : Exception) -> Impl(Future(unit, IoExn)))(
  io.async((e) => {
    cond(
      e.io.await(ready(e.io), e.io) => {
        println(String.from("taken"));
      },
      true => ()
    );
  })
);
${EPILOGUE}`
    );
    expect(output).toMatch(
      /`io\.await` is not supported in the condition of `cond`/
    );
    expect(output).toMatch(/Hoist it into a local first/);
  });

  test("a negated await in an `if` condition is rejected too", () => {
    // `!(await ...)` is the shape yo-self/init.yo used six times over.
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
    expect(output).toMatch(
      /`io\.await` is not supported in the condition of `if`/
    );
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
