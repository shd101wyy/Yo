import { ModuleManager } from "../module-manager";

export class CodeGenerator {
  private moduleManager: ModuleManager;

  constructor() {
    this.moduleManager = new ModuleManager();
  }

  public loadModule(
    modulePath: string,
    options: {
      printC?: boolean;
      skipCodegen?: boolean;
    } = {}
  ): void {
    try {
      if (!options.skipCodegen) {
        this.moduleManager.compileModule(modulePath, {
          printC: options.printC,
        });
      } else {
        // Just load the module for parsing/evaluation
        this.moduleManager.loadModule(modulePath);
      }
    } catch (error) {
      console.error(`Error compiling module ${modulePath}:`, error);
      process.exit(1);
    }
  }
}
