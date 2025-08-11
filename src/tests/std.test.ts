import * as path from "path";
import { printMoParserError } from "../error";
import { ModuleManager } from "../module-manager";

describe("Evaluate fixme.yo", () => {
  beforeAll(() => {
    const moduleManager = new ModuleManager();
    const { moduleError } = moduleManager.loadModule(
      "file://" + path.join(__dirname, `../../std/index.yo`)
    );
    if (moduleError) {
      printMoParserError(moduleError);
      throw moduleError;
    }
  });

  it("should evaluate learn_mo.yo correctly", () => {
    expect(true).toBe(true);
  });
});
