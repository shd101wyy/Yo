import { existsSync } from "node:fs";
import path from "node:path";
import { CodeGeneratorC } from "./codegen/codegen-c";
import { _evaluateExpression } from "./evaluator/exprs/_expr";
import { setEvaluateExpressionFn } from "./evaluator/exprs/expr";
import Evaluator, {
  clearGenericImplsFromModule,
  clearImplsFromModule,
} from "./evaluator/index";
import { resetModuleIdCounter } from "./utils";
import { ModuleValue } from "./value";

function findStdDirectory(startPath: string): string {
  let currentPath = startPath;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const potentialStdPath = path.join(currentPath, "std");
    if (existsSync(potentialStdPath)) {
      return potentialStdPath;
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      break;
    }
    currentPath = parentPath;
  }

  return path.join(__dirname, "../std");
}

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

  /**
   * Track module dependencies: key is the module path, value is set of modules it imports
   */
  private dependencies: Map<string, Set<string>> = new Map();

  /**
   * Track reverse dependencies: key is the module path, value is set of modules that import it
   */
  private dependents: Map<string, Set<string>> = new Map();

  public stdPath = findStdDirectory(__dirname);
  private codeGenratorC: CodeGeneratorC;
  private allowPartialModule: boolean;

  constructor(options?: { allowPartialModule?: boolean }) {
    this.allowPartialModule = options?.allowPartialModule ?? false;
    this.codeGenratorC = new CodeGeneratorC();

    // This line of code is to prevent circular dependency issues
    setEvaluateExpressionFn(_evaluateExpression);
  }

  /**
   * Track that parentModule imports childModule
   */
  private addDependency(parentModule: string, childModule: string): void {
    // Add to dependencies (parent -> children)
    if (!this.dependencies.has(parentModule)) {
      this.dependencies.set(parentModule, new Set());
    }
    this.dependencies.get(parentModule)!.add(childModule);

    // Add to dependents (child -> parents)
    if (!this.dependents.has(childModule)) {
      this.dependents.set(childModule, new Set());
    }
    this.dependents.get(childModule)!.add(parentModule);
  }

  /**
   * Get all modules that depend on the given module (directly or transitively)
   */
  private getDependentModules(modulePath: string): Set<string> {
    const result = new Set<string>();
    const queue = [modulePath];

    while (queue.length > 0) {
      const current = queue.pop()!;
      const dependents = this.dependents.get(current);
      if (dependents) {
        for (const dep of dependents) {
          if (!result.has(dep)) {
            result.add(dep);
            queue.push(dep);
          }
        }
      }
    }

    return result;
  }

  /**
   * Clear dependency tracking for a module
   */
  private clearDependencies(modulePath: string): void {
    // Remove this module from the dependents list of its dependencies
    const deps = this.dependencies.get(modulePath);
    if (deps) {
      for (const dep of deps) {
        const depDependents = this.dependents.get(dep);
        if (depDependents) {
          depDependents.delete(modulePath);
        }
      }
    }
    this.dependencies.delete(modulePath);
  }

  public loadModule(
    modulePath: string,
    inputString?: string,
    parentModule?: string
  ): {
    moduleValue: ModuleValue;
    moduleError: Error | undefined;
  } {
    if (!modulePath.match(/^file:\/\//)) {
      throw new Error(
        `Invalid file protocol: ${modulePath}. Only file:// is supported for now.  `
      );
    }

    // Track dependency if this is being loaded by another module
    if (parentModule) {
      this.addDependency(parentModule, modulePath);
    }

    const module = this.modules.get(modulePath);
    if (module) {
      return {
        moduleValue: module.moduleValue,
        moduleError: module.moduleError,
      };
    }

    const currentModulePath = modulePath;
    const evaluator = new Evaluator({
      modulePath,
      stdPath: this.stdPath,
      loadModule: (childModulePath: string) => {
        return this.loadModule(childModulePath, undefined, currentModulePath);
      },
      inputString,
      allowPartialModule: this.allowPartialModule,
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

    // Get all modules that depend on this module (they need to be invalidated too)
    const dependentModules = this.getDependentModules(modulePath);

    // Delete the module and all its dependents
    const modulesToDelete = [modulePath, ...dependentModules];

    for (const modPath of modulesToDelete) {
      // Clear any impls that were added by this module before deleting it
      clearImplsFromModule(modPath);
      clearGenericImplsFromModule(modPath);

      // Clear dependency tracking for this module
      this.clearDependencies(modPath);

      // Clear the ID counter for this module
      resetModuleIdCounter(modPath);

      // Delete the module from cache
      this.modules.delete(modPath);
    }
  }

  public compileModule(
    modulePath: string,
    {
      emitC,
      debugGc,
      debugParallelism,
      debugAsyncAwait,
      allocator,
    }: {
      emitC?: boolean;
      debugGc?: boolean;
      debugParallelism?: boolean;
      debugAsyncAwait?: boolean;
      allocator?: "mimalloc" | "libc";
    } = {}
  ) {
    // console.log(`= Compiling module ${modulePath}`);
    const { moduleValue, moduleError } = this.loadModule(modulePath);
    if (moduleError) {
      throw moduleError.toString();
    }

    // Get the evaluator for the module so we can access its environment
    const moduleData = this.modules.get(modulePath);
    if (!moduleData) {
      throw new Error(`Module data not found for ${modulePath}`);
    }

    this.codeGenratorC.compileModule(modulePath, moduleValue, {
      debugGc,
      debugParallelism,
      debugAsyncAwait,
      allocator,
    });
    if (emitC) {
      console.log(this.codeGenratorC.print());
    }
  }

  getGeneratedCode(): string {
    return this.codeGenratorC.print();
  }
}
