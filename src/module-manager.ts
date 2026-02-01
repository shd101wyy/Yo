import { existsSync } from "fs";
import * as path from "path";
import { CodeGeneratorC } from "./codegen/codegen-c";
import { setGenerateExprFn } from "./codegen/exprs/expr";
import { _generateExpr } from "./codegen/exprs/generation";
import { clearEnvContainingPrelude } from "./env";
import { _evaluateExpression } from "./evaluator/exprs/_expr";
import { setEvaluateExpressionFn } from "./evaluator/exprs/expr";
import Evaluator, {
  clearAllGlobalImplState,
  clearGenericImplsFromModule,
  clearImplsFromModule,
} from "./evaluator/index";
import { clearAllModuleCounters, resetModuleIdCounter } from "./utils";
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

  public stdPath: string;
  private codeGenratorC: CodeGeneratorC;
  private allowPartialModule: boolean;

  constructor(options?: { allowPartialModule?: boolean; stdPath?: string }) {
    this.allowPartialModule = options?.allowPartialModule ?? false;
    this.stdPath = options?.stdPath ?? findStdDirectory(__dirname);
    this.codeGenratorC = new CodeGeneratorC();

    // This line of code is to prevent circular dependency issues
    setEvaluateExpressionFn(_evaluateExpression);
    // Set the generateExpr function for use in other modules
    setGenerateExprFn(_generateExpr);
  }

  /**
   * Extract the relative path from a module path (e.g., "std/prelude.yo" or "tests/fixme.yo")
   */
  private getRelativePath(path: string): string | null {
    const stdMatch = path.match(/\/std\/(.+)$/);
    if (stdMatch) return `std/${stdMatch[1]}`;
    const testsMatch = path.match(/\/tests\/(.+)$/);
    if (testsMatch) return `tests/${testsMatch[1]}`;
    return null;
  }

  /**
   * Check if a module is from the workspace (not from extension)
   */
  private isWorkspaceModule(modulePath: string): boolean {
    return (
      !modulePath.includes("/extensions/") && !modulePath.includes("/.vscode/")
    );
  }

  /**
   * Find all extension duplicates of a workspace module and return them.
   * If the module is a std/ module, also includes extension prelude.
   */
  private findExtensionDuplicates(modulePath: string): string[] {
    if (!this.isWorkspaceModule(modulePath)) {
      return [];
    }

    const relPath = this.getRelativePath(modulePath);
    if (!relPath) {
      return [];
    }

    const duplicates: string[] = [];

    // Find all extension versions of this module
    for (const [path] of this.modules) {
      if (path !== modulePath && !this.isWorkspaceModule(path)) {
        const otherRelPath = this.getRelativePath(path);
        if (otherRelPath === relPath) {
          duplicates.push(path);
        }
      }
    }

    // If this is a workspace std/ module, also include extension prelude
    if (relPath.startsWith("std/")) {
      for (const [path] of this.modules) {
        if (
          !this.isWorkspaceModule(path) &&
          (path.endsWith("/std/prelude.yo") || path.endsWith("/prelude.yo")) &&
          !duplicates.includes(path)
        ) {
          duplicates.push(path);
        }
      }
    }

    return duplicates;
  }

  /**
   * Delete a module and all its dependents, clearing impls and dependencies
   */
  private deleteModuleAndDependents(modulePath: string): void {
    const dependents = this.getDependentModules(modulePath);

    // Delete dependents first
    for (const dep of dependents) {
      clearImplsFromModule(dep);
      clearGenericImplsFromModule(dep);
      this.clearDependencies(dep);
      resetModuleIdCounter(dep);
      this.modules.delete(dep);
    }

    // Then delete the module itself
    clearImplsFromModule(modulePath);
    clearGenericImplsFromModule(modulePath);
    this.clearDependencies(modulePath);
    resetModuleIdCounter(modulePath);
    this.modules.delete(modulePath);
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

  /**
   * Reset all cached modules, dependencies, and global evaluator state.
   * This is useful when switching std paths or forcing a clean analysis run.
   */
  public resetAllState(): void {
    for (const modulePath of this.modules.keys()) {
      clearImplsFromModule(modulePath);
      clearGenericImplsFromModule(modulePath);
      resetModuleIdCounter(modulePath);
    }

    this.modules.clear();
    this.dependencies.clear();
    this.dependents.clear();

    clearAllGlobalImplState();
    clearEnvContainingPrelude();
    clearAllModuleCounters();
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
      // console.log(`[ModuleManager] Cache hit for: ${modulePath}`);
      return {
        moduleValue: module.moduleValue,
        moduleError: module.moduleError,
      };
    }

    // console.log(`[ModuleManager] Loading module: ${modulePath}`);
    // console.log(`[ModuleManager] Stack trace:`, new Error().stack);

    // Before loading a workspace module, delete any extension duplicates
    // This ensures workspace versions always take precedence over bundled extension versions
    const duplicates = this.findExtensionDuplicates(modulePath);
    for (const dupPath of duplicates) {
      this.deleteModuleAndDependents(dupPath);
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
    // console.log(`[ModuleManager] deleteModule called for: ${modulePath}`);
    if (!modulePath.match(/^file:\/\//)) {
      throw new Error(
        `Invalid file protocol: ${modulePath}. Only file:// is supported for now.  `
      );
    }

    const modulesToInvalidate = [modulePath];

    // If deleting a workspace module, aggressively delete ALL extension modules
    // This prevents any possible type mismatches from stale extension modules
    if (this.isWorkspaceModule(modulePath)) {
      for (const [path] of this.modules) {
        if (
          !this.isWorkspaceModule(path) &&
          !modulesToInvalidate.includes(path)
        ) {
          modulesToInvalidate.push(path);
        }
      }
    }

    // If this is a prelude module, find all prelude variants (workspace and extension)
    const isPrelude =
      modulePath.endsWith("/std/prelude.yo") ||
      modulePath.endsWith("/prelude.yo");
    if (isPrelude) {
      for (const [path] of this.modules) {
        if (
          (path.endsWith("/std/prelude.yo") || path.endsWith("/prelude.yo")) &&
          path !== modulePath &&
          !modulesToInvalidate.includes(path)
        ) {
          modulesToInvalidate.push(path);
        }
      }
    }

    // Delete all modules and their dependents
    for (const modPath of modulesToInvalidate) {
      this.deleteModuleAndDependents(modPath);
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
