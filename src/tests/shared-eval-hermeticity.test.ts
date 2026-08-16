import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as path from "node:path";

// Hermeticity pin for the run-scoped shared evaluator universe in the
// sequential test runner (plans/SHARED_MODULE_CACHE_TESTS.md). The fixture
// files define the SAME method name on the same builtin receiver with
// DIFFERENT behavior, and each imports a private helper module with
// module-level mutable state. If the per-file scrub ever regresses, the
// second file either trips the duplicate-method check, resolves the other
// file's impl, or its batch program inherits the first file's helper init
// exprs — all of which fail this run. Red-first verified: disabling the
// scrub makes both fixture tests fail.
//
// Uses `node out/cjs/yo-cli.cjs` (not the yo-cli bash script) so it runs on
// Windows too — see AGENTS.md "Windows compatibility".
const YO_CLI = path.resolve(__dirname, "../../out/cjs/yo-cli.cjs");
const FIXTURES = path.resolve(__dirname, "hermeticity-fixtures");

describe("shared-eval hermeticity", () => {
  test("clashing impls and private module state stay per-file in one sequential run", () => {
    const stdout = execFileSync(
      "node",
      [YO_CLI, "test", FIXTURES, "--parallel", "1"],
      { encoding: "utf-8", timeout: 300_000 }
    );
    expect(stdout).toContain("2 passed");
    expect(stdout).not.toContain("failed");
  }, 300_000);
});
