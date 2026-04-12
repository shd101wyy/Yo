import { existsSync, realpathSync } from "node:fs";
import * as path from "node:path";
import type {
  TextDocumentChangeEvent,
  TextDocuments,
} from "vscode-languageserver";
import type { TextDocument } from "vscode-languageserver-textdocument";
import {
  clearModuleImportRoots,
  setModuleImportRoot,
  clearBuildRegistry,
  getBuildRegistry,
  swapBuildRegistry,
  BuildRegistry,
} from "../evaluator/builtins/build";
import { snapshotAllImplTraitFields } from "../evaluator/values/impl";
import { resolveDependencyPath } from "../fetch";
import { ModuleManager } from "../module-manager";
import type { TraitField, TraitType } from "../types/definitions";
import { uriToModulePath } from "./utils";

/**
 * Manages ModuleManager instances and document synchronization for the LSP server.
 * Wraps the Yo evaluator's ModuleManager with LSP text document lifecycle.
 */
/** Module data stored in ModuleManager.modules */
type ModuleData = NonNullable<ReturnType<ModuleManager["modules"]["get"]>>;

/** Cached module with trait field snapshots (since deleteModule mutates types in-place) */
interface CachedModule {
  module: ModuleData;
  traitFieldSnapshots: Map<TraitType, TraitField[]>;
}

export class LspDocumentManager {
  private moduleManager: ModuleManager;
  private moduleManagerStdPath: string | null = null;

  /** Cache: which project directories have had their build.yo evaluated */
  private evaluatedBuildProjects = new Map<string, boolean>();

  /** Track the last analyzed text per URI to avoid redundant re-evaluation */
  private lastAnalyzedTextByUri = new Map<string, string>();

  /** Track in-flight analysis generation per URI to avoid race conditions */
  private analyzeGenerationByUri = new Map<string, number>();

  /**
   * Cache of the last module evaluation that produced useful AST data.
   * Used as fallback for completion when the current evaluation has errors
   * (e.g., user typed `p2.` which is an incomplete expression).
   * Includes trait field snapshots because deleteModule mutates type objects in-place.
   */
  private lastGoodModules = new Map<string, CachedModule>();

  constructor(stdPath?: string) {
    this.moduleManager = new ModuleManager({
      allowPartialModule: true,
      stdPath: stdPath ?? undefined,
    });
    this.moduleManagerStdPath = this.moduleManager.stdPath;
  }

  /**
   * Get the current std library path.
   */
  getStdPath(): string | null {
    return this.moduleManagerStdPath;
  }

  /**
   * Attach to an LSP TextDocuments manager, wiring up document lifecycle events.
   */
  attachToDocuments(
    documents: TextDocuments<TextDocument>,
    onDiagnostics: (uri: string) => void
  ): void {
    documents.onDidChangeContent(
      (change: TextDocumentChangeEvent<TextDocument>) => {
        this.analyzeDocument(change.document, onDiagnostics);
      }
    );

    documents.onDidClose((event: TextDocumentChangeEvent<TextDocument>) => {
      const uri = event.document.uri;
      const modulePath = uriToModulePath(uri);
      this.moduleManager.deleteModule(modulePath);
      this.lastAnalyzedTextByUri.delete(uri);
      this.analyzeGenerationByUri.delete(uri);
      this.lastGoodModules.delete(modulePath);
    });
  }

  /**
   * Analyze a document: evaluate it and trigger diagnostics callback.
   */
  analyzeDocument(
    document: TextDocument,
    onDiagnostics: (uri: string) => void
  ): void {
    const uri = document.uri;
    const text = document.getText();

    // Skip if we've already analyzed this exact text
    if (this.lastAnalyzedTextByUri.get(uri) === text) {
      return;
    }
    this.lastAnalyzedTextByUri.set(uri, text);

    const generation = (this.analyzeGenerationByUri.get(uri) ?? 0) + 1;
    this.analyzeGenerationByUri.set(uri, generation);

    // Ensure std path is correct for this document
    this.ensureStdPathForUri(uri);

    // Ensure build.yo import mappings are resolved
    this.ensureBuildImportsResolved(uri);

    const modulePath = uriToModulePath(uri);

    // Cache the current module if it has useful AST data before re-evaluating.
    // We cache even modules with errors — partial type info is better than none.
    // We must snapshot trait fields because deleteModule mutates type objects in-place.
    const oldModule = this.moduleManager.modules.get(modulePath);
    if (oldModule) {
      try {
        const program = oldModule.evaluator.getProgram();
        if (program.length > 0) {
          // Snapshot ALL trait fields across all modules because deleteModule
          // invalidates not just this module but also std library modules.
          const traitFieldSnapshots = snapshotAllImplTraitFields();
          this.lastGoodModules.set(modulePath, {
            module: oldModule,
            traitFieldSnapshots,
          });
        }
      } catch {
        /* ignore */
      }
    }

    // Clear and re-evaluate the module
    this.moduleManager.deleteModule(modulePath);
    this.moduleManager.loadModule(modulePath, text);

    // Only the latest analysis run should update diagnostics
    if (this.analyzeGenerationByUri.get(uri) === generation) {
      onDiagnostics(uri);
    }
  }

  /**
   * Get the evaluated module for a given URI.
   */
  getModule(uri: string) {
    const modulePath = uriToModulePath(uri);
    return this.moduleManager.modules.get(modulePath);
  }

  /**
   * Get the best module for completion: current module if it has good AST data,
   * otherwise fall back to the last cached good module.
   * This handles the case where the user typed e.g. `p2.` which breaks evaluation.
   */
  getModuleForCompletion(uri: string): ModuleData | undefined {
    const modulePath = uriToModulePath(uri);
    const current = this.moduleManager.modules.get(modulePath);
    // Prefer current module if it exists (even with errors — partial data may be useful)
    // But also provide fallback for when inner scope evaluation lost type info
    if (current) return current;
    return this.getLastGoodModule(uri);
  }

  /**
   * Get the last good (successfully evaluated) module for a URI.
   * Restores trait field snapshots since deleteModule mutates types in-place.
   * Returns undefined if no good module has been cached.
   */
  getLastGoodModule(uri: string): ModuleData | undefined {
    const modulePath = uriToModulePath(uri);
    const cached = this.lastGoodModules.get(modulePath);
    if (!cached) return undefined;
    // Restore trait fields that were stripped by deleteModule
    for (const [traitType, fields] of cached.traitFieldSnapshots) {
      traitType.fields = fields;
    }
    return cached.module;
  }

  /**
   * Get the underlying ModuleManager (for advanced queries).
   */
  getModuleManager(): ModuleManager {
    return this.moduleManager;
  }

  /**
   * Ensure the std path is correctly set for the document's workspace.
   */
  private ensureStdPathForUri(uri: string): void {
    const fsPath = uri.replace("file://", "");
    const stdPath = this.findStdPath(fsPath);
    if (stdPath && this.moduleManagerStdPath !== stdPath) {
      this.moduleManager.resetAllState();
      this.moduleManager.stdPath = stdPath;
      this.moduleManagerStdPath = stdPath;
      this.evaluatedBuildProjects.clear();
      this.lastGoodModules.clear();
      clearModuleImportRoots();
    }
  }

  /**
   * Walk up from a file path to find a `std/` directory.
   */
  private findStdPath(fsPath: string): string | null {
    let currentPath = path.dirname(fsPath);
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const candidate = path.join(currentPath, "std");
      if (existsSync(candidate)) {
        return candidate;
      }
      const parentPath = path.dirname(currentPath);
      if (parentPath === currentPath) {
        return null;
      }
      currentPath = parentPath;
    }
  }

  /**
   * Find build.yo for a given file URI.
   */
  private findBuildYoForUri(
    uri: string
  ): { buildFile: string; projectDir: string } | null {
    const fsPath = uri.replace("file://", "");
    let currentPath = path.dirname(fsPath);
    const root = path.parse(currentPath).root;

    while (currentPath !== root) {
      const candidate = path.join(currentPath, "build.yo");
      if (existsSync(candidate)) {
        return { buildFile: candidate, projectDir: currentPath };
      }
      currentPath = path.dirname(currentPath);
    }
    return null;
  }

  /**
   * Evaluate build.yo to resolve custom import mappings (cached per project).
   */
  private ensureBuildImportsResolved(uri: string): void {
    const buildInfo = this.findBuildYoForUri(uri);
    if (!buildInfo) return;
    if (this.evaluatedBuildProjects.has(buildInfo.projectDir)) return;
    this.evaluatedBuildProjects.set(buildInfo.projectDir, true);

    const buildModuleManager = new ModuleManager();
    try {
      clearBuildRegistry();
      const modulePath = `file://${realpathSync(buildInfo.buildFile)}`;
      buildModuleManager.loadModule(modulePath);

      const registry: BuildRegistry = getBuildRegistry();

      for (const artifact of registry.artifacts) {
        for (const imported of artifact.importedModules) {
          const depName = imported.dependencyName;
          if (!depName) {
            const localModule = registry.modules.find(
              (m) => m.name === imported.moduleName
            );
            if (localModule) {
              setModuleImportRoot(
                imported.importName,
                path.resolve(buildInfo.projectDir, localModule.root)
              );
            }
          } else {
            const depDir = this.findDependencyDir(
              registry,
              buildInfo.projectDir,
              depName
            );
            if (depDir) {
              this.resolveDepModuleRoot(depDir, imported);
            }
          }
        }
      }

      clearBuildRegistry();
    } catch {
      // build.yo evaluation failed — skip silently
    } finally {
      // Always clean up global state from the temporary module manager
      // to avoid polluting the main module manager with stale prelude type data
      buildModuleManager.resetAllState();
    }
  }

  private findDependencyDir(
    registry: BuildRegistry,
    projectDir: string,
    depName: string
  ): string | undefined {
    const pathDep = registry.pathDependencies.find((d) => d.name === depName);
    if (pathDep) {
      const resolved = path.resolve(projectDir, pathDep.path);
      if (existsSync(resolved)) return resolved;
    }
    try {
      return resolveDependencyPath(projectDir, depName);
    } catch {
      return undefined;
    }
  }

  private resolveDepModuleRoot(
    depDir: string,
    imported: { importName: string; moduleName: string }
  ): void {
    const depBuildFile = path.join(depDir, "build.yo");
    if (!existsSync(depBuildFile)) return;

    const parentRegistry = swapBuildRegistry(new BuildRegistry());
    const depMm = new ModuleManager();
    try {
      depMm.loadModule(`file://${realpathSync(depBuildFile)}`);

      const depRegistry = getBuildRegistry();
      const depModule =
        imported.moduleName === ""
          ? depRegistry.modules[0]
          : depRegistry.modules.find((m) => m.name === imported.moduleName);

      if (depModule) {
        setModuleImportRoot(
          imported.importName,
          path.resolve(depDir, depModule.root)
        );
      }
    } catch {
      // skip silently
    } finally {
      depMm.resetAllState();
      swapBuildRegistry(parentRegistry);
    }
  }
}
