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
      // console.log(`[ModuleManager] Cache hit for: ${modulePath}`);
      return {
        moduleValue: module.moduleValue,
        moduleError: module.moduleError,
      };
    }

    // console.log(`[ModuleManager] Loading module: ${modulePath}`);
    // console.log(`[ModuleManager] Stack trace:`, new Error().stack);

    // Before loading, check if there's a module with the same relative path but different base
    // This handles cases where:
    // 1. Extension bundles std/ files
    // 2. User opens workspace std/ files
    // We want the workspace version to replace the extension version

    // Extract the relative path (everything after /std/ or after the workspace root)
    const getRelativePath = (path: string): string | null => {
      // Try to extract /std/... path
      const stdMatch = path.match(/\/std\/(.+)$/);
      if (stdMatch) {
        return `std/${stdMatch[1]}`;
      }
      // Try to extract /tests/... path
      const testsMatch = path.match(/\/tests\/(.+)$/);
      if (testsMatch) {
        return `tests/${testsMatch[1]}`;
      }
      return null;
    };

    const relPath = getRelativePath(modulePath);
    // Check if this is a workspace module (not from extension)
    const isWorkspaceModule =
      !modulePath.includes("/extensions/") && !modulePath.includes("/.vscode/");

    if (relPath && isWorkspaceModule) {
      // console.log(
      //   `[ModuleManager] Checking for duplicates of relative path: ${relPath}`
      // );
      const duplicatesToDelete: string[] = [];

      // Find all extension versions of this module
      for (const [path] of this.modules) {
        if (
          path !== modulePath &&
          (path.includes("/extensions/") || path.includes("/.vscode/"))
        ) {
          const otherRelPath = getRelativePath(path);
          if (otherRelPath === relPath) {
            // console.log(
            //   `[ModuleManager] Found duplicate module to delete: ${path}`
            // );
            duplicatesToDelete.push(path);
          }
        }
      }

      // If we're loading a workspace std/ module, also delete extension prelude
      // This ensures workspace modules use workspace prelude types
      if (relPath.startsWith("std/")) {
        // console.log(
        //   `[ModuleManager] Loading workspace std module, checking for extension prelude`
        // );
        for (const [path] of this.modules) {
          if (
            (path.includes("/extensions/") || path.includes("/.vscode/")) &&
            (path.endsWith("/std/prelude.yo") || path.endsWith("/prelude.yo"))
          ) {
            // console.log(
            //   `[ModuleManager] Found extension prelude to delete: ${path}`
            // );
            if (!duplicatesToDelete.includes(path)) {
              duplicatesToDelete.push(path);
            }
          }
        }
      }

      // Delete all duplicates and their dependents
      for (const dupPath of duplicatesToDelete) {
        const dependents = this.getDependentModules(dupPath);
        // console.log(
        //   `[ModuleManager] Deleting duplicate ${dupPath} with dependents:`,
        //   dependents
        // );

        // Delete dependents first
        for (const dep of dependents) {
          // console.log(`[ModuleManager] Deleting dependent: ${dep}`);
          clearImplsFromModule(dep);
          clearGenericImplsFromModule(dep);
          this.clearDependencies(dep);
          resetModuleIdCounter(dep);
          this.modules.delete(dep);
        }

        // Then delete the duplicate module
        // console.log(`[ModuleManager] Deleting duplicate module: ${dupPath}`);
        clearImplsFromModule(dupPath);
        clearGenericImplsFromModule(dupPath);
        this.clearDependencies(dupPath);
        resetModuleIdCounter(dupPath);
        this.modules.delete(dupPath);
      }
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

    // If this is a prelude module, find all prelude variants (workspace and extension)
    const isPrelude =
      modulePath.endsWith("/std/prelude.yo") ||
      modulePath.endsWith("/prelude.yo");
    const modulesToInvalidate = [modulePath];

    if (isPrelude) {
      // console.log(
      //   `[ModuleManager] Detected prelude module, finding all prelude variants`
      // );
      // Find all modules that end with prelude.yo
      for (const [path] of this.modules) {
        if (
          (path.endsWith("/std/prelude.yo") || path.endsWith("/prelude.yo")) &&
          path !== modulePath
        ) {
          // console.log(`[ModuleManager] Found prelude variant: ${path}`);
          modulesToInvalidate.push(path);
        }
      }
    }

    // Get dependents for all modules to invalidate
    const allDependents = new Set<string>();
    for (const modPath of modulesToInvalidate) {
      const dependents = this.getDependentModules(modPath);
      for (const dep of dependents) {
        allDependents.add(dep);
      }
    }

    // console.log(`[ModuleManager] Dependent modules:`, allDependents);

    // Delete the module and all its dependents
    const modulesToDelete = [...modulesToInvalidate, ...allDependents];

    for (const modPath of modulesToDelete) {
      // console.log(`[ModuleManager] Deleting module: ${modPath}`);
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
