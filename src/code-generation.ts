import * as path from "path";
import Parser from "./parser";
import { CodeGeneratorC } from "./targets/codegen-c";
import { TModule } from "./type-checker";

export class CodeGenerator {
  /**
   * Key is the absolute path of the module
   * Value is the module itself
   */
  public modules: Map<string, TModule> = new Map();
  public stdPath = path.join(__dirname, "../../std");
  private codeGenratorC: CodeGeneratorC;

  constructor() {
    this.codeGenratorC = new CodeGeneratorC();
  }

  /**
   * `modulePath` is the path of the module with protocol. For example:
   * - file:///home/username/project/src/main.mo
   * - https://github.com/username/project
   * - mo://@mo/std
   * @param modulePath
   * @returns
   */
  public loadModule(
    modulePath: string,
    {
      printTokens,
      printAst,
      printC,
      skipCodegen,
    }: {
      printTokens?: boolean;
      printAst?: boolean;
      printC?: boolean;
      skipCodegen?: boolean;
    } = {}
  ): TModule {
    let module = this.modules.get(modulePath);
    if (module) {
      return module;
    }
    // console.log(`= Loading module ${modulePath}`);
    const parser = new Parser({
      modulePath,
      stdPath: this.stdPath,
      loadModule: (modulePath: string) => {
        return this.loadModule(modulePath, {
          printTokens: false,
          printAst: false,
          printC: false,
          skipCodegen,
        });
      },
      printTokens,
      printAst,
    });
    module = parser.generateModule();
    console.log(`= Loaded module ${modulePath}`);
    this.modules.set(modulePath, module);

    if (!skipCodegen) {
      this.compileModule(module, { printC });
    }
    return module;
  }

  // We currently only supports to compile to C.
  // https://github.com/0xGG/mo/blob/7b75d9428000469a02704b0277465b6f1c8ba057/src/backup/code-generation-llvm.ts#L751
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  compileModule(module: TModule, { printC }: { printC?: boolean } = {}) {
    console.log(`= Compiling module ${module.modulePath}`);
    this.codeGenratorC.compileModule(module);
    if (printC) {
      console.log(this.codeGenratorC.print());
    }
  }
}
