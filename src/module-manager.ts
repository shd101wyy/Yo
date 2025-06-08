import Evaluator from "./evaluator";
import { StructValue } from "./value";

export class ModuleManager {
  /**
   * Key is the absolute path of the module
   * Value is the module itself
   */
  public modules: Map<
    string,
    { moduleValue: StructValue; evaluator: Evaluator }
  > = new Map();

  constructor() {}

  public loadModule(modulePath: string): StructValue {
    if (!modulePath.match(/^file:\/\//)) {
      throw new Error(
        `Invalid file protocol: ${modulePath}. Only file:// is supported for now.  `
      );
    }

    const module = this.modules.get(modulePath);
    if (module) {
      return module.moduleValue;
    }

    const evaluator = new Evaluator({
      modulePath,
      loadModule: (modulePath: string) => {
        return this.loadModule(modulePath);
      },
    });
    const moduleValue = evaluator.getModuleValue();
    this.modules.set(modulePath, { moduleValue, evaluator });
    return moduleValue;
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
