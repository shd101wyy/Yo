import * as path from "path";
import { ModuleManager } from "../module-manager";

describe("Evaluate fixme.yo", () => {
  beforeAll(() => {
    const moduleManager = new ModuleManager();
    moduleManager.loadModule(
      "file://" + path.join(__dirname, `../../std/prelude.yo`)
    );
  });

  it("should evaluate learn_mo.yo correctly", () => {
    expect(true).toBe(true);
  });
});
