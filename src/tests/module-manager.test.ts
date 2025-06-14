import * as fs from "fs";
import * as path from "path";
import { ModuleManager } from "../module-manager";

describe("Module Manager Tests", () => {
  const examplesDir = path.join(__dirname, "examples");
  const files = fs.readdirSync(examplesDir).filter((f) => f.endsWith(".yo"));

  files.forEach((file) => {
    it(`should load and evaluate ${file} correctly`, () => {
      const moduleManager = new ModuleManager();
      const { moduleError } = moduleManager.loadModule(
        "file://" + path.join(examplesDir, file)
      );
      if (moduleError) {
        throw moduleError;
      }
    });
  });
});
