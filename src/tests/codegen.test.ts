import { realpathSync } from "fs";
import * as path from "path";
import { CodeGenerator } from "../codegen";

describe("Code Generation Tests", () => {
  const codeGenerator = new CodeGenerator();
  const stdPath = path.join(__dirname, "../../std/index.yo");
  const absolutePath = `file://` + realpathSync(stdPath);

  it("Should compile the std library without errors", () => {
    codeGenerator.compileModule(absolutePath, {
      output: "std.out",
      cCompiler: "cc",
      target: "c",
      extern: [],
      emitC: false,
      skipCodegen: false,
      skipCCompiler: true,
    });
  });
});
