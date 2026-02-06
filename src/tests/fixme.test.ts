import { beforeAll, describe, it } from "bun:test";
import * as path from "node:path";
import { printYoError } from "../error";
import { ModuleManager } from "../module-manager";

describe("Evaluate fixme.yo", () => {
  beforeAll(() => {});

  it("should evaluate learn_mo.yo correctly", () => {
    const moduleManager = new ModuleManager();
    const testFileName = "fixme.yo";
    const { moduleError } = moduleManager.loadModule(
      "file://" + path.join(__dirname, `/${testFileName}`)
    );
    if (moduleError) {
      printYoError(moduleError);
      throw moduleError;
    }
  });
});
