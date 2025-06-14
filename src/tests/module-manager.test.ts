import { globSync } from "glob";
import * as path from "path";
import { ModuleManager } from "../module-manager";

describe("Module Manager Tests", () => {
  const examplesDir = path.join(__dirname, "examples");
  const files = globSync(`${examplesDir}/**/*.yo`, {
    ignore: [`${examplesDir}/not_working_yet/**`],
  });

  files.forEach((file) => {
    it(`should load and evaluate ${file} correctly`, () => {
      const moduleManager = new ModuleManager();
      const { moduleError } = moduleManager.loadModule("file://" + file);
      if (moduleError) {
        throw moduleError;
      }
    });
  });
});
