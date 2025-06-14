import * as path from "path";
import { ModuleManager } from "../module-manager";

describe("Evaluate fixme.yo", () => {
  beforeAll(() => {});

  it("should evaluate learn_mo.yo correctly", () => {
    const moduleManager = new ModuleManager();
    const testFileName = "fixme.yo";
    const { moduleError } = moduleManager.loadModule(
      "file://" + path.join(__dirname, `examples/${testFileName}`)
    );
    if (moduleError) {
      throw moduleError;
    }
  });
});
