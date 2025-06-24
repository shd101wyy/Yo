import path from "path";

import ModuleManager from "../../src/module-manager";

describe("Test u8 numeric operations", () => {
  const moduleManager = new ModuleManager(path.join(__dirname, ".."));

  test("should handle u8 operations correctly", () => {
    const testFileName = "test_u8.yo";
    const { moduleError } = moduleManager.loadModule(
      "file://" + path.join(__dirname, `examples/${testFileName}`)
    );
    if (moduleError) {
      throw moduleError;
    }
  });
});
