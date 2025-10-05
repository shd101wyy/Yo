import path from "node:path";
import { CodeGeneratorC } from "./codegen/codegen-c";
import Evaluator from "./evaluator/index";
import { ModuleValue } from "./value";

export class ModuleManager {
  /**
   * Key is the absolute path of the module
   * Value is the module itself
   */
  public modules: Map<
    string,
    {
      moduleValue: ModuleValue;
      moduleError: Error | undefined;
      evaluator: Evaluator;
    }
  > = new Map();

  public stdPath = path.join(__dirname, "../std");
  private codeGenratorC: CodeGeneratorC;

  constructor() {
    this.codeGenratorC = new CodeGeneratorC();
  }

  public loadModule(modulePath: string): {
    moduleValue: ModuleValue;
    moduleError: Error | undefined;
  } {
    if (!modulePath.match(/^file:\/\//)) {
      throw new Error(
        `Invalid file protocol: ${modulePath}. Only file:// is supported for now.  `
      );
    }

    const module = this.modules.get(modulePath);
    if (module) {
      return {
        moduleValue: module.moduleValue,
        moduleError: module.moduleError,
      };
    }

    const evaluator = new Evaluator({
      modulePath,
      stdPath: this.stdPath,
      loadModule: (modulePath: string) => {
        return this.loadModule(modulePath);
      },
    });
    const moduleValue = evaluator.getModuleValue();
    const moduleError = evaluator.getModuleError();
    this.modules.set(modulePath, { moduleValue, moduleError, evaluator });
    return { moduleValue, moduleError };
  }

  public deleteModule(modulePath: string): void {
    if (!modulePath.match(/^file:\/\//)) {
      throw new Error(
        `Invalid file protocol: ${modulePath}. Only file:// is supported for now.  `
      );
    }

    this.modules.delete(modulePath);
  }

  public compileModule(
    modulePath: string,
    {
      emitC,
      debugBrc,
      debugConcurrency,
    }: { emitC?: boolean; debugBrc?: boolean; debugConcurrency?: boolean } = {}
  ) {
    console.log(`= Compiling module ${modulePath}`);
    const { moduleValue, moduleError } = this.loadModule(modulePath);
    if (moduleError) {
      throw moduleError;
    }

    // Get the evaluator for the module so we can access its environment
    const moduleData = this.modules.get(modulePath);
    if (!moduleData) {
      throw new Error(`Module data not found for ${modulePath}`);
    }

    this.codeGenratorC.compileModule(modulePath, moduleValue, {
      debugBrc,
      debugConcurrency,
    });
    if (emitC) {
      console.log(this.codeGenratorC.print());
    }
  }

  getGeneratedCode(): string {
    return this.codeGenratorC.print();
  }
}
