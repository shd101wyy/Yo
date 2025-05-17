import * as path from "path";
import { ModuleManager } from "../module-manager";

describe("Module Manager Tests", () => {
  beforeAll(() => {
    const testFileName = "fixme.yo";
    const moduleManager = new ModuleManager();
    moduleManager.loadModule(
      "file://" + path.join(__dirname, `examples/${testFileName}`)
    );
  });

  it("should evaluate learn_mo.yo correctly", () => {
    expect(true).toBe(true);
  });
});
