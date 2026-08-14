import { existsSync, realpathSync } from "fs";
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
import {
  _clearPragmaForModule,
  _clearPragmaRegistry,
} from "./evaluator/memory-safety";
import { clearAllModuleCounters, resetModuleIdCounter } from "./utils";
import { clearAllCachedTypes } from "./types/creators";
import type { Expr } from "./expr";
import type { StructValue } from "./value";

/**
 * The `--std-path` CLI override (highest-precedence std root), stashed by
 * the root-level yargs middleware in `yo-cli.ts`. The self-hosted
 * counterpart is `set_std_path_override` in `yo-self/module_manager.yo`.
 */
let stdPathOverride: string | undefined;

export function setStdPathOverride(stdPath: string): void {
  stdPathOverride = stdPath;
}

/**
 * Resolve the standard-library root. Lookup order (mirrored by
 * `resolve_std_path` in `yo-self/module_manager.yo`):
 *   1. The `--std-path` CLI flag (stashed via `setStdPathOverride`).
 *   2. `YO_STD` env var, if set and non-empty.
 *   3. A `std` directory next to — or in any ancestor of — the compiler's
 *      own location (`startPath`, i.e. `__dirname`). This is what makes an
 *      installed bundle self-locating.
 *   4. `./std` relative to the current working directory (repo dev flow).
 */
function findStdDirectory(startPath: string): string {
  if (stdPathOverride) {
    return stdPathOverride;
  }

  const envStd = process.env.YO_STD;
  if (envStd) {
    return envStd;
  }

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

  const cwdStdPath = path.resolve("std");
  if (existsSync(cwdStdPath)) {
    return cwdStdPath;
  }

  return path.join(__dirname, "../std");
}

/**
 * Canonicalize a `file://` module path so every reference to the same
 * file shares one module-cache entry: resolve to an absolute, normalized
 * path and collapse symlinks (macOS `/tmp` -> `/private/tmp`). Without
 * this, a module reached via two spellings — e.g. `check`'s
 * `realpathSync` top-level key vs the evaluator's `path.join(stdPath,
 * "prelude.yo")` implicit-prelude key — evaluates twice, and a second
 * prelude evaluation corrupts where-constrained generic-impl resolution
 * (see issues/seed-built-stage1-array-fill-method-miss.md). Mirrored by
 * `canonicalize_module_path` in `yo-self/module_manager.yo`.
 */
export function canonicalizeModulePath(modulePath: string): string {
  if (!modulePath.startsWith("file://")) {
    return modulePath;
  }
  let canonical = path.resolve(modulePath.slice("file://".length));
  try {
    canonical = realpathSync(canonical);
  } catch {
    // Not on disk (e.g. an inputString-backed load): keep the resolved
    // path; a genuinely missing file errors later in the load itself.
  }
  return "file://" + canonical;
}

export class ModuleManager {
  /**
   * Key is the absolute path of the module
   * Value is the module itself
   */
  public modules: Map<
    string,
    {
      moduleValue: StructValue;
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

  /**
   * Track modules currently being evaluated (for circular dependency detection).
   * Maps module path to its placeholder StructValue being populated.
   */
  private loadingModules: Map<string, StructValue> = new Map();

  public stdPath: string;
  private codeGenratorC: CodeGeneratorC;
  private allowPartialModule: boolean;

  constructor(options?: { allowPartialModule?: boolean; stdPath?: string }) {
    this.allowPartialModule = options?.allowPartialModule ?? false;
    this.stdPath = options?.stdPath ?? findStdDirectory(__dirname);
    this.codeGenratorC = new CodeGeneratorC();

    // Clear global evaluator state from any previous ModuleManager instances.
    // The impl registries, prelude env cache, module counters, and cached builtin
    // types are module-level globals that persist across instances and cause
    // "duplicate method" errors if not reset.
    clearAllGlobalImplState();
    clearEnvContainingPrelude();
    clearAllModuleCounters();
    clearAllCachedTypes();

    // This line of code is to prevent circular dependency issues
    setEvaluateExpressionFn(_evaluateExpression);
    // Set the generateExpr function for use in other modules
    setGenerateExprFn(_generateExpr);
  }

  /**
   * Extract the relative path from a module path (e.g., "std/prelude.yo" or "tests/fixme.yo")
   */
  private getRelativePath(_path: string): string | null {
    const stdMatch = _path.match(/\/std\/(.+)$/);
    if (stdMatch) return `std/${stdMatch[1]}`;
    const testsMatch = _path.match(/\/tests\/(.+)$/);
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
    for (const [_path] of this.modules) {
      if (_path !== modulePath && !this.isWorkspaceModule(_path)) {
        const otherRelPath = this.getRelativePath(_path);
        if (otherRelPath === relPath) {
          duplicates.push(_path);
        }
      }
    }

    // If this is a workspace std/ module, also include extension prelude
    if (relPath.startsWith("std/")) {
      for (const [_path] of this.modules) {
        if (
          !this.isWorkspaceModule(_path) &&
          (_path.endsWith("/std/prelude.yo") ||
            _path.endsWith("/prelude.yo")) &&
          !duplicates.includes(_path)
        ) {
          duplicates.push(_path);
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
      // Drop any `pragma(Pragma.AllowUnsafe);` privilege the module
      // had registered. Without this, an LSP edit that removes the
      // pragma from a file would leave the old privilege in the
      // registry and continue treating the file as unsafe-capable.
      _clearPragmaForModule(dep);
      this.modules.delete(dep);
    }

    // Then delete the module itself
    clearImplsFromModule(modulePath);
    clearGenericImplsFromModule(modulePath);
    this.clearDependencies(modulePath);
    resetModuleIdCounter(modulePath);
    _clearPragmaForModule(modulePath);
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
    this.loadingModules.clear();

    clearAllGlobalImplState();
    clearEnvContainingPrelude();
    clearAllModuleCounters();
    clearAllCachedTypes();
    _clearPragmaRegistry();
  }

  public loadModule(
    modulePath: string,
    inputString?: string,
    parentModule?: string
  ): {
    moduleValue: StructValue;
    moduleError: Error | undefined;
  } {
    if (!modulePath.match(/^file:\/\//)) {
      throw new Error(
        `Invalid file protocol: ${modulePath}. Only file:// is supported for now.  `
      );
    }
    modulePath = canonicalizeModulePath(modulePath);

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

    // Check if this module is currently being evaluated (circular import).
    // Return the partially-populated StructValue so the importing module
    // can access fields that have already been exported.
    const loadingModule = this.loadingModules.get(modulePath);
    if (loadingModule) {
      return {
        moduleValue: loadingModule,
        moduleError: undefined,
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
      registerPartialModule: (mv: StructValue) => {
        this.loadingModules.set(modulePath, mv);
      },
    });

    // Module evaluation complete — remove from loading set
    this.loadingModules.delete(modulePath);

    const moduleValue = evaluator.getModuleValue();
    const moduleError = evaluator.getModuleError();
    this.modules.set(modulePath, { moduleValue, moduleError, evaluator });
    return { moduleValue, moduleError };
  }

  public deleteModule(modulePath: string): void {
    // console.log(`[ModuleManager] deleteModule called for: ${modulePath}`);
    modulePath = canonicalizeModulePath(modulePath);
    if (!modulePath.match(/^file:\/\//)) {
      throw new Error(
        `Invalid file protocol: ${modulePath}. Only file:// is supported for now.  `
      );
    }

    const modulesToInvalidate = [modulePath];

    // If deleting a workspace module, aggressively delete ALL extension modules
    // This prevents any possible type mismatches from stale extension modules
    if (this.isWorkspaceModule(modulePath)) {
      for (const [_path] of this.modules) {
        if (
          !this.isWorkspaceModule(_path) &&
          !modulesToInvalidate.includes(_path)
        ) {
          modulesToInvalidate.push(_path);
        }
      }
    }

    // If this is a prelude module, find all prelude variants (workspace and extension)
    const isPrelude =
      modulePath.endsWith("/std/prelude.yo") ||
      modulePath.endsWith("/prelude.yo");
    if (isPrelude) {
      for (const [_path] of this.modules) {
        if (
          (_path.endsWith("/std/prelude.yo") ||
            _path.endsWith("/prelude.yo")) &&
          _path !== modulePath &&
          !modulesToInvalidate.includes(_path)
        ) {
          modulesToInvalidate.push(_path);
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
      isLibrary,
    }: {
      emitC?: boolean;
      debugGc?: boolean;
      debugParallelism?: boolean;
      debugAsyncAwait?: boolean;
      allocator?: "mimalloc" | "libc";
      isLibrary?: boolean;
    } = {}
  ) {
    // console.log(`= Compiling module ${modulePath}`);
    modulePath = canonicalizeModulePath(modulePath);
    const { moduleValue, moduleError } = this.loadModule(modulePath);
    if (moduleError) {
      throw moduleError.toString();
    }

    // Get the evaluator for the module so we can access its environment
    const moduleData = this.modules.get(modulePath);
    if (!moduleData) {
      throw new Error(`Module data not found for ${modulePath}`);
    }

    // Collect module-level init exprs from ALL loaded modules (not just the main one)
    // This is needed because imported modules may also have module-level mutable variables
    const allModuleLevelInitExprs: Expr[] = [];
    for (const [, modData] of this.modules) {
      const mv = modData.moduleValue;
      if (mv.moduleLevelInitExprs && mv.moduleLevelInitExprs.length > 0) {
        allModuleLevelInitExprs.push(...mv.moduleLevelInitExprs);
      }
    }

    this.codeGenratorC.compileModule(modulePath, moduleValue, {
      debugGc,
      debugParallelism,
      debugAsyncAwait,
      allocator,
      isLibrary,
      allModuleLevelInitExprs:
        allModuleLevelInitExprs.length > 0
          ? allModuleLevelInitExprs
          : undefined,
    });
    if (emitC) {
      console.log(this.codeGenratorC.print());
    }
  }

  getGeneratedCode(): string {
    return this.codeGenratorC.print();
  }

  getExportedFunctionNames(): Set<string> {
    return this.codeGenratorC.getExportedFunctionNames();
  }

  get needsIntelAsmSyntax(): boolean {
    return this.codeGenratorC.needsIntelAsmSyntax;
  }

  get usesParallelism(): boolean {
    return this.codeGenratorC.usesParallelism;
  }
}
