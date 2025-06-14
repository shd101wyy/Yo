import path from "node:path";
import Evaluator from "./evaluator";
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
  constructor() {}

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
}
