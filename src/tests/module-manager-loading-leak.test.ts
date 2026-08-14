import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModuleManager, canonicalizeModulePath } from "../module-manager";

// Regression pin: a module whose EVALUATION throws must not leave its partial
// value registered as "currently loading".
//
// `ModuleManager.loadModule` registers a partial StructValue before evaluating
// (so a circular import can see already-exported fields) and unregisters after.
// The Evaluator CONSTRUCTOR is what evaluates, so before the try/finally a
// failed load leaked that entry forever — and the next load of the same path
// hit the leaked entry and returned the partial value with NO error, turning an
// import that must fail into one that silently succeeds.
//
// Latent while every compile built a fresh ModuleManager; live the moment one is
// reused, which is exactly what the test runner's shared universe does
// (plans/SHARED_MODULE_CACHE_TESTS.md). yo-self already carried the fix — see
// the "ALWAYS unregister" comment in yo-self/module_manager.yo.
//
// Red-first verified: with the finally removed, the second load below reports NO
// error and the test fails.

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yo-loading-leak-"));
  // A imports B; B imports A and destructures a field A has not exported yet.
  fs.writeFileSync(
    path.join(tmpDir, "a.yo"),
    `{ LateField } :: import("./b.yo");\nEarlyField :: i32(42);\nexport(EarlyField);\n`
  );
  fs.writeFileSync(
    path.join(tmpDir, "b.yo"),
    `{ EarlyField } :: import("./a.yo");\nLateField :: EarlyField;\nexport(LateField);\n`
  );
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("ModuleManager loadingModules hygiene", () => {
  test("a failed load reports an error on EVERY subsequent load", () => {
    const mm = new ModuleManager();
    const modulePath = canonicalizeModulePath(
      `file://${path.join(tmpDir, "a.yo")}`
    );

    // The circular destructure makes evaluation throw, so loadModule throws.
    expect(() => mm.loadModule(modulePath)).toThrow(
      /still being evaluated \(circular import\)/
    );

    // ...and it must throw again. Before the fix the second call resolved to
    // the leaked in-flight partial value and returned it WITHOUT an error.
    expect(() => mm.loadModule(modulePath)).toThrow(
      /still being evaluated \(circular import\)/
    );
  }, 120_000);
});
