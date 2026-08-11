/**
 * Build system evaluator builtins.
 *
 * These builtins handle compile-time evaluation of build.yo declarations.
 * Each builtin registers build artifacts/steps in a global BuildRegistry.
 * All build-declaration builtins return unit — dependencies are resolved
 * by name, not by ID tokens.
 *
 * The build runner evaluates build.yo via ModuleManager, then reads the
 * registry to orchestrate compilation.
 */

import type { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinFunctions,
  exprIsFunctionCallOf,
  type FnCallExpr,
} from "../../expr";
import { hostTarget, parseTarget } from "../../target";
import { createComptimeStringType, createUnitType } from "../../types/creators";
import type { Token } from "../../token";
import {
  createComptimeStringValue,
  isComptimeStringValue,
  isEnumValue,
  isUnknownValue,
  type Value,
} from "../../value";
import { VUnit } from "../../unit-value";
import type { EvaluatorContext } from "../context";

// ── Build Registry ────────────────────────────────────────────────────

export interface BuildArtifact {
  kind: "executable" | "static_library" | "shared_library";
  name: string;
  root: string;
  target: string;
  optimize: string;
  allocator: string;
  sanitize: string;
  linkLibraries: string[];
  includePaths: string[];
  libraryPaths: string[];
  cSources: string[];
  cFlags: string[];
  defines: string[];
  strip: boolean;
  staticLink: boolean;
  runtimeFiles?: string[];
  linkedArtifacts: string[]; // Names of Yo library artifacts to link
  linkedSystemLibraries: string[]; // Names of system libraries to link (via pkg-config)
  importedModules: ImportedModule[]; // Module imports registered via add_import
}

export interface BuildTestSuite {
  name: string;
  root: string;
  target: string;
  verbose: boolean;
  bail: boolean;
  parallel: number;
  /** Project-relative paths (files or directories) excluded from the test walk. */
  exclude: string[];
}

export interface BuildRunStep {
  name: string; // Synthetic name for dependency resolution (e.g., "run:my-app")
  artifactName: string;
  args: string[];
}

export interface BuildStep {
  name: string;
  description: string;
  dependencyNames: string[];
}

export interface BuildGitDependency {
  name: string;
  url: string;
  ref: string;
  path: string;
}

export interface BuildPathDependency {
  name: string;
  path: string;
}

export interface BuildSystemLibrary {
  name: string;
  fallbackInclude: string;
  fallbackLib: string;
  fallbackLink: string;
  defines?: string[];
}

export interface DependencyArtifactRef {
  dependencyName: string;
  artifactName: string;
}

export interface BuildModuleEntry {
  name: string;
  root: string;
  linkedSystemLibraries: string[];
}

export interface ImportedModule {
  importName: string;
  moduleName: string;
  /** Dependency name, or empty for local modules */
  dependencyName: string;
  /** Resolved root file path (set by build runner) */
  resolvedRoot?: string;
  /** System libraries propagated from this module (set by build runner) */
  propagatedSystemLibraries?: string[];
}

export interface BuildDocConfig {
  name: string;
  root: string;
  outputDir: string;
  format: string;
  includePrivate: boolean;
  includeDeps: boolean;
  title: string;
  logo: string;
  favicon: string;
  version: string;
}

export class BuildRegistry {
  artifacts: BuildArtifact[] = [];
  testSuites: BuildTestSuite[] = [];
  runSteps: BuildRunStep[] = [];
  steps: BuildStep[] = [];
  dependencies: BuildGitDependency[] = [];
  pathDependencies: BuildPathDependency[] = [];
  systemLibraries: BuildSystemLibrary[] = [];
  dependencyArtifacts: DependencyArtifactRef[] = [];
  modules: BuildModuleEntry[] = [];
  docConfigs: BuildDocConfig[] = [];
  /** User-provided build options from CLI -Dname=value */
  cliOptions: Map<string, string> = new Map();
  /** Declared build options (name → { description, default }) */
  declaredOptions: Map<string, { description: string; defaultValue: string }> =
    new Map();

  /** Set CLI options parsed from -Dname=value flags */
  setCliOptions(options: Map<string, string>): void {
    this.cliOptions = options;
  }

  registerExecutable(config: Omit<BuildArtifact, "kind">): void {
    this.checkDuplicateArtifactName(config.name);
    this.artifacts.push({ kind: "executable", ...config });
  }

  registerStaticLibrary(config: Omit<BuildArtifact, "kind">): void {
    this.checkDuplicateArtifactName(config.name);
    this.artifacts.push({ kind: "static_library", ...config });
  }

  registerSharedLibrary(config: Omit<BuildArtifact, "kind">): void {
    this.checkDuplicateArtifactName(config.name);
    this.artifacts.push({ kind: "shared_library", ...config });
  }

  registerTest(config: BuildTestSuite): void {
    this.testSuites.push(config);
  }

  registerRun(artifactName: string, args: string[]): void {
    const name = `run:${artifactName}`;
    this.runSteps.push({ name, artifactName, args });
  }

  registerStep(
    name: string,
    description: string,
    dependencyNames: string[] = []
  ): void {
    this.steps.push({ name, description, dependencyNames });
  }

  /** Add a dependency to an existing step */
  addStepDependency(stepName: string, depName: string): void {
    const step = this.findStep(stepName);
    if (step) {
      if (!step.dependencyNames.includes(depName)) {
        step.dependencyNames.push(depName);
      }
    }
  }

  registerDependency(dep: BuildGitDependency): void {
    this.dependencies.push(dep);
  }

  registerPathDependency(dep: BuildPathDependency): void {
    this.pathDependencies.push(dep);
  }

  registerSystemLibrary(lib: BuildSystemLibrary): void {
    this.systemLibraries.push(lib);
  }

  registerDependencyArtifact(ref: DependencyArtifactRef): void {
    // Avoid duplicates
    if (
      !this.dependencyArtifacts.some(
        (a) =>
          a.dependencyName === ref.dependencyName &&
          a.artifactName === ref.artifactName
      )
    ) {
      this.dependencyArtifacts.push(ref);
    }
  }

  registerModule(entry: BuildModuleEntry): void {
    // Check for duplicate module names
    if (this.modules.some((m) => m.name === entry.name)) {
      return; // Silently ignore duplicates (same module registered twice)
    }
    this.modules.push(entry);
  }

  registerModuleLink(moduleName: string, systemLibraryName: string): void {
    const mod = this.modules.find((m) => m.name === moduleName);
    if (mod && !mod.linkedSystemLibraries.includes(systemLibraryName)) {
      mod.linkedSystemLibraries.push(systemLibraryName);
    }
  }

  registerImportedModule(artifactName: string, imported: ImportedModule): void {
    const artifact = this.findArtifact(artifactName);
    if (artifact) {
      if (
        artifact.importedModules.some(
          (m) => m.importName === imported.importName
        )
      ) {
        return; // Duplicate import name — will be caught at compile time
      }
      artifact.importedModules.push(imported);
    }
  }

  /** Find a module by name */
  findModule(name: string): BuildModuleEntry | undefined {
    return this.modules.find((m) => m.name === name);
  }

  /** Register a link relationship: artifact links to a library */
  registerLink(artifactName: string, libraryName: string): void {
    const artifact = this.findArtifact(artifactName);
    if (artifact) {
      if (!artifact.linkedArtifacts.includes(libraryName)) {
        artifact.linkedArtifacts.push(libraryName);
      }
    }
  }

  /** Find an artifact by name */
  findArtifact(name: string): BuildArtifact | undefined {
    return this.artifacts.find((a) => a.name === name);
  }

  /** Find a test suite by name */
  findTest(name: string): BuildTestSuite | undefined {
    return this.testSuites.find((t) => t.name === name);
  }

  /** Find a run step by name (e.g., "run:my-app") */
  findRunStep(name: string): BuildRunStep | undefined {
    return this.runSteps.find((r) => r.name === name);
  }

  /** Find a named step */
  findStep(name: string): BuildStep | undefined {
    return this.steps.find((s) => s.name === name);
  }

  /** Find a documentation config by name */
  findDocumentation(name: string): BuildDocConfig | undefined {
    return this.docConfigs.find((d) => d.name === name);
  }

  registerDocumentation(config: BuildDocConfig): void {
    this.docConfigs.push(config);
  }

  /** Throw if an artifact with the given name already exists */
  private checkDuplicateArtifactName(name: string): void {
    const existing = this.artifacts.find((a) => a.name === name);
    if (existing) {
      throw new Error(
        `Build error: Artifact "${name}" already registered as ${existing.kind}. Use a unique name for each artifact.`
      );
    }
  }

  /** Find a dependency by name */
  findDependency(name: string): BuildGitDependency | undefined {
    return this.dependencies.find((d) => d.name === name);
  }

  /** Find a path dependency by name */
  findPathDependency(name: string): BuildPathDependency | undefined {
    return this.pathDependencies.find((d) => d.name === name);
  }

  /** Find a system library by name */
  findSystemLibrary(name: string): BuildSystemLibrary | undefined {
    return this.systemLibraries.find((l) => l.name === name);
  }

  /** Get all step names */
  getStepNames(): string[] {
    return this.steps.map((s) => s.name);
  }

  /**
   * Resolve a dependency name to its type and entry.
   * Resolution order: artifact → test → run step (by name, e.g. "run:app") → sub-step.
   */
  resolveDependency(
    name: string
  ):
    | { kind: "artifact"; value: BuildArtifact }
    | { kind: "test"; value: BuildTestSuite }
    | { kind: "run"; value: BuildRunStep }
    | { kind: "doc"; value: BuildDocConfig }
    | { kind: "step"; value: BuildStep }
    | undefined {
    const artifact = this.findArtifact(name);
    if (artifact) return { kind: "artifact", value: artifact };

    const test = this.findTest(name);
    if (test) return { kind: "test", value: test };

    // Run steps have synthetic names like "run:app-name"
    const run = this.findRunStep(name);
    if (run) return { kind: "run", value: run };

    const doc = this.findDocumentation(name);
    if (doc) return { kind: "doc", value: doc };

    const step = this.findStep(name);
    if (step) return { kind: "step", value: step };

    return undefined;
  }

  /** Resolve all dependencies for a step into categorized lists */
  resolveDependencies(step: BuildStep): {
    artifacts: BuildArtifact[];
    tests: BuildTestSuite[];
    runs: BuildRunStep[];
  } {
    const artifacts: BuildArtifact[] = [];
    const tests: BuildTestSuite[] = [];
    const runs: BuildRunStep[] = [];

    for (const depName of step.dependencyNames) {
      const resolved = this.resolveDependency(depName);
      if (!resolved) continue;

      switch (resolved.kind) {
        case "artifact":
          if (!artifacts.some((a) => a.name === resolved.value.name))
            artifacts.push(resolved.value);
          break;
        case "test":
          if (!tests.some((t) => t.name === resolved.value.name))
            tests.push(resolved.value);
          break;
        case "run":
          if (!runs.some((r) => r.name === resolved.value.name))
            runs.push(resolved.value);
          // Also include the artifact the run depends on
          {
            const runArtifact = this.findArtifact(resolved.value.artifactName);
            if (
              runArtifact &&
              !artifacts.some((a) => a.name === runArtifact.name)
            ) {
              artifacts.push(runArtifact);
            }
          }
          break;
        case "step": {
          const sub = this.resolveDependencies(resolved.value);
          for (const a of sub.artifacts) {
            if (!artifacts.some((x) => x.name === a.name)) artifacts.push(a);
          }
          for (const t of sub.tests) {
            if (!tests.some((x) => x.name === t.name)) tests.push(t);
          }
          for (const r of sub.runs) {
            if (!runs.some((x) => x.name === r.name)) runs.push(r);
          }
          break;
        }
      }
    }

    return { artifacts, tests, runs };
  }

  clear(): void {
    this.artifacts = [];
    this.testSuites = [];
    this.runSteps = [];
    this.steps = [];
    this.dependencies = [];
    this.pathDependencies = [];
    this.systemLibraries = [];
    this.dependencyArtifacts = [];
    this.modules = [];
  }
}

// Global singleton — cleared before each build.yo evaluation
let globalRegistry: BuildRegistry | undefined;

// Root project directory for transitive import resolution.
// Set by the build runner so that imports within dependencies
// can fall back to the root project's yo.lock.
let rootBuildProjectDir: string | undefined;

// Map from import name → resolved absolute file path.
// Populated by the build runner from artifact.importedModules[].resolvedRoot.
// Used by import resolution to handle `import "dep_name"` via module system.
const moduleImportRoots = new Map<string, string>();

export function getRootBuildProjectDir(): string | undefined {
  return rootBuildProjectDir;
}

export function setRootBuildProjectDir(dir: string | undefined): void {
  rootBuildProjectDir = dir;
}

export function clearModuleImportRoots(): void {
  moduleImportRoots.clear();
}

export function getModuleImportRoot(importName: string): string | undefined {
  return moduleImportRoots.get(importName);
}

export function setModuleImportRoot(
  importName: string,
  resolvedRoot: string
): void {
  moduleImportRoots.set(importName, resolvedRoot);
}

export function getBuildRegistry(): BuildRegistry {
  if (!globalRegistry) {
    globalRegistry = new BuildRegistry();
  }
  return globalRegistry;
}

export function clearBuildRegistry(): void {
  if (globalRegistry) {
    globalRegistry.clear();
  }
  globalRegistry = undefined;
}

/** Swap the global registry and return the previous one. */
export function swapBuildRegistry(
  newRegistry: BuildRegistry | undefined
): BuildRegistry | undefined {
  const prev = globalRegistry;
  globalRegistry = newRegistry;
  return prev;
}

// ── Argument extraction helpers ───────────────────────────────────────

function extractComptimeString(
  value: Value | undefined,
  paramName: string,
  token: Token
): string {
  if (!isComptimeStringValue(value)) {
    throw formatErrorMessage({
      token,
      errorMessage: `Build function: expected comptime_str for "${paramName}", got ${value ? "non-string" : "undefined"}`,
    });
  }
  return value.value;
}

function makeUnitResult(expr: FnCallExpr, env: Environment): FnCallExpr {
  expr.$ = {
    env,
    type: createUnitType(),
    value: VUnit,
    pathCollection: [],
  };
  return expr;
}

function makeComptimeStringResult(
  expr: FnCallExpr,
  env: Environment,
  value: string
): FnCallExpr {
  expr.$ = {
    env,
    type: createComptimeStringType(),
    value: createComptimeStringValue(value),
    pathCollection: [],
  };
  return expr;
}

// ── Builtin handlers ──────────────────────────────────────────────────

/**
 * Check if this is a trial evaluation (function definition body check).
 * During trial runs, comptime params have UnknownValue.
 */
function isTrialEvaluation(expr: FnCallExpr): boolean {
  for (const arg of expr.args) {
    if (arg === undefined) continue;
    const value = arg.$?.value;
    if (value === undefined || isUnknownValue(value)) {
      return true;
    }
  }
  return false;
}

export function evaluateYoBuildFunctions({
  expr,
  env,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  // During trial evaluation (function definition type-check),
  // just return unit without registering anything.
  if (isTrialEvaluation(expr)) {
    // For functions that return comptime_str, always return a valid string value
    if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_build_target_host)) {
      const target = hostTarget();
      return makeComptimeStringResult(expr, env, target.triple);
    }
    if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_build_option)) {
      return makeComptimeStringResult(expr, env, "");
    }
    return makeUnitResult(expr, env);
  }

  const registry = getBuildRegistry();

  // __yo_build_executable(name, root, target, optimize, allocator, sanitize)
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_build_executable)) {
    if (expr.args.length < 2) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `__yo_build_executable expects at least 2 arguments (name, root), got ${expr.args.length}`,
      });
    }
    const name = extractComptimeString(
      expr.args[0]!.$?.value,
      "name",
      expr.token
    );
    const root = extractComptimeString(
      expr.args[1]!.$?.value,
      "root",
      expr.token
    );
    const target =
      expr.args.length > 2
        ? extractComptimeString(expr.args[2]!.$?.value, "target", expr.token)
        : hostTarget().triple;
    const optimize =
      expr.args.length > 3
        ? extractComptimeString(expr.args[3]!.$?.value, "optimize", expr.token)
        : "debug";
    const allocator =
      expr.args.length > 4
        ? extractComptimeString(expr.args[4]!.$?.value, "allocator", expr.token)
        : "mimalloc";
    const sanitize =
      expr.args.length > 5
        ? extractComptimeString(expr.args[5]!.$?.value, "sanitize", expr.token)
        : "none";

    registry.registerExecutable({
      name,
      root,
      target,
      optimize,
      allocator,
      sanitize,
      linkLibraries: [],
      includePaths: [],
      libraryPaths: [],
      cSources: [],
      cFlags: [],
      defines: [],
      strip: false,
      staticLink: false,
      runtimeFiles: [],
      linkedArtifacts: [],
      linkedSystemLibraries: [],
      importedModules: [],
    });
    return makeUnitResult(expr, env);
  }

  // __yo_build_static_library(name, root, target, optimize)
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_build_static_library)) {
    if (expr.args.length < 2) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `__yo_build_static_library expects at least 2 arguments (name, root), got ${expr.args.length}`,
      });
    }
    const name = extractComptimeString(
      expr.args[0]!.$?.value,
      "name",
      expr.token
    );
    const root = extractComptimeString(
      expr.args[1]!.$?.value,
      "root",
      expr.token
    );
    const target =
      expr.args.length > 2
        ? extractComptimeString(expr.args[2]!.$?.value, "target", expr.token)
        : hostTarget().triple;
    const optimize =
      expr.args.length > 3
        ? extractComptimeString(expr.args[3]!.$?.value, "optimize", expr.token)
        : "debug";

    registry.registerStaticLibrary({
      name,
      root,
      target,
      optimize,
      allocator: "libc",
      sanitize: "none",
      linkLibraries: [],
      includePaths: [],
      libraryPaths: [],
      cSources: [],
      cFlags: [],
      defines: [],
      strip: false,
      staticLink: false,
      runtimeFiles: [],
      linkedArtifacts: [],
      linkedSystemLibraries: [],
      importedModules: [],
    });
    return makeUnitResult(expr, env);
  }

  // __yo_build_shared_library(name, root, target, optimize)
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_build_shared_library)) {
    if (expr.args.length < 2) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `__yo_build_shared_library expects at least 2 arguments (name, root), got ${expr.args.length}`,
      });
    }
    const name = extractComptimeString(
      expr.args[0]!.$?.value,
      "name",
      expr.token
    );
    const root = extractComptimeString(
      expr.args[1]!.$?.value,
      "root",
      expr.token
    );
    const target =
      expr.args.length > 2
        ? extractComptimeString(expr.args[2]!.$?.value, "target", expr.token)
        : hostTarget().triple;
    const optimize =
      expr.args.length > 3
        ? extractComptimeString(expr.args[3]!.$?.value, "optimize", expr.token)
        : "debug";

    registry.registerSharedLibrary({
      name,
      root,
      target,
      optimize,
      allocator: "libc",
      sanitize: "none",
      linkLibraries: [],
      includePaths: [],
      libraryPaths: [],
      cSources: [],
      cFlags: [],
      defines: [],
      strip: false,
      staticLink: false,
      runtimeFiles: [],
      linkedArtifacts: [],
      linkedSystemLibraries: [],
      importedModules: [],
    });
    return makeUnitResult(expr, env);
  }

  // __yo_build_link(artifact_name, library_name)
  // Unified link handler: checks if library_name is a Yo artifact or system library
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_build_link)) {
    if (expr.args.length < 2) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `__yo_build_link expects 2 arguments (artifact_name, library_name), got ${expr.args.length}`,
      });
    }
    const artifactName = extractComptimeString(
      expr.args[0]!.$?.value,
      "artifact_name",
      expr.token
    );
    const libraryName = extractComptimeString(
      expr.args[1]!.$?.value,
      "library_name",
      expr.token
    );
    // Check if it's a system library first, then fall back to artifact link
    if (registry.findSystemLibrary(libraryName)) {
      const artifact = registry.findArtifact(artifactName);
      if (artifact) {
        if (!artifact.linkedSystemLibraries.includes(libraryName)) {
          artifact.linkedSystemLibraries.push(libraryName);
        }
      }
    } else {
      registry.registerLink(artifactName, libraryName);
    }
    return makeUnitResult(expr, env);
  }

  // __yo_build_link_system_library(artifact_name, system_lib_name)
  // Kept for backward compatibility; build.link() now handles both cases
  if (
    exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_build_link_system_library)
  ) {
    if (expr.args.length < 2) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `__yo_build_link_system_library expects 2 arguments (artifact_name, system_lib_name), got ${expr.args.length}`,
      });
    }
    const artifactName = extractComptimeString(
      expr.args[0]!.$?.value,
      "artifact_name",
      expr.token
    );
    const systemLibName = extractComptimeString(
      expr.args[1]!.$?.value,
      "system_lib_name",
      expr.token
    );
    const artifact = registry.findArtifact(artifactName);
    if (artifact) {
      if (!artifact.linkedSystemLibraries.includes(systemLibName)) {
        artifact.linkedSystemLibraries.push(systemLibName);
      }
    }
    return makeUnitResult(expr, env);
  }

  // __yo_build_test(name, root, target, exclude)
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_build_test)) {
    if (expr.args.length < 2) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `__yo_build_test expects at least 2 arguments (name, root), got ${expr.args.length}`,
      });
    }
    const name = extractComptimeString(
      expr.args[0]!.$?.value,
      "name",
      expr.token
    );
    const root = extractComptimeString(
      expr.args[1]!.$?.value,
      "root",
      expr.token
    );
    const target =
      expr.args.length > 2
        ? extractComptimeString(expr.args[2]!.$?.value, "target", expr.token)
        : hostTarget().triple;
    // Comma-separated project-relative paths excluded from the test walk
    // (std/build.yo TestSuite.exclude; "" means no excludes).
    const excludeRaw =
      expr.args.length > 3
        ? extractComptimeString(expr.args[3]!.$?.value, "exclude", expr.token)
        : "";
    const exclude = excludeRaw
      .split(",")
      .map((e) => e.trim())
      .filter((e) => e.length > 0);

    registry.registerTest({
      name,
      root,
      target,
      verbose: false,
      bail: false,
      parallel: 1,
      exclude,
    });
    return makeUnitResult(expr, env);
  }

  // __yo_build_run(artifact_name)
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_build_run)) {
    if (expr.args.length < 1) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `__yo_build_run expects at least 1 argument (artifact_name), got ${expr.args.length}`,
      });
    }
    const artifactName = extractComptimeString(
      expr.args[0]!.$?.value,
      "artifact_name",
      expr.token
    );
    registry.registerRun(artifactName, []);
    return makeUnitResult(expr, env);
  }

  // __yo_build_step(name, description)
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_build_step)) {
    if (expr.args.length < 2) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `__yo_build_step expects 2 arguments (name, description), got ${expr.args.length}`,
      });
    }
    const name = extractComptimeString(
      expr.args[0]!.$?.value,
      "name",
      expr.token
    );
    const description = extractComptimeString(
      expr.args[1]!.$?.value,
      "description",
      expr.token
    );
    registry.registerStep(name, description);
    return makeUnitResult(expr, env);
  }

  // __yo_build_doc(name, root, output, format, include_private, include_deps, title, logo, favicon, version)
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_build_doc)) {
    if (expr.args.length < 10) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `__yo_build_doc expects 10 arguments, got ${expr.args.length}`,
      });
    }
    const name = extractComptimeString(
      expr.args[0]!.$?.value,
      "name",
      expr.token
    );
    const root = extractComptimeString(
      expr.args[1]!.$?.value,
      "root",
      expr.token
    );
    const outputDir = extractComptimeString(
      expr.args[2]!.$?.value,
      "output",
      expr.token
    );
    const format = extractComptimeString(
      expr.args[3]!.$?.value,
      "format",
      expr.token
    );
    const includePrivate = Boolean(expr.args[4]!.$?.value);
    const includeDeps = Boolean(expr.args[5]!.$?.value);
    const title = extractComptimeString(
      expr.args[6]!.$?.value,
      "title",
      expr.token
    );
    const logo = extractComptimeString(
      expr.args[7]!.$?.value,
      "logo",
      expr.token
    );
    const favicon = extractComptimeString(
      expr.args[8]!.$?.value,
      "favicon",
      expr.token
    );
    const version = extractComptimeString(
      expr.args[9]!.$?.value,
      "version",
      expr.token
    );
    registry.registerDocumentation({
      name,
      root,
      outputDir,
      format,
      includePrivate,
      includeDeps,
      title,
      logo,
      favicon,
      version,
    });
    return makeUnitResult(expr, env);
  }

  // __yo_build_step_depend_on(step_name, dep_name, dep_kind)
  // Adds a dependency to an existing step.
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_build_step_depend_on)) {
    if (expr.args.length < 3) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `__yo_build_step_depend_on expects 3 arguments (step_name, dep_name, dep_kind), got ${expr.args.length}`,
      });
    }
    const stepName = extractComptimeString(
      expr.args[0]!.$?.value,
      "step_name",
      expr.token
    );
    const depName = extractComptimeString(
      expr.args[1]!.$?.value,
      "dep_name",
      expr.token
    );
    // Check kind to construct correct dependency name (Run steps get "run:" prefix)
    const depKindValue = expr.args[2]!.$?.value;
    let resolvedDepName = depName;
    if (depKindValue && isEnumValue(depKindValue)) {
      if (depKindValue.variantName === "Run") {
        resolvedDepName = `run:${depName}`;
      }
    }
    registry.addStepDependency(stepName, resolvedDepName);
    return makeUnitResult(expr, env);
  }

  // __yo_build_target_host() — returns comptime_str (used as a value)
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_build_target_host)) {
    const target = hostTarget();
    return makeComptimeStringResult(expr, env, target.triple);
  }

  // __yo_build_target_parse(triple) — returns comptime_str (used as a value)
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_build_target_parse)) {
    if (expr.args.length !== 1) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `__yo_build_target_parse expects 1 argument (triple), got ${expr.args.length}`,
      });
    }
    const triple = extractComptimeString(
      expr.args[0]!.$?.value,
      "triple",
      expr.token
    );
    const target = parseTarget(triple);
    return makeComptimeStringResult(expr, env, target.triple);
  }

  // __yo_build_dependency(name, url, ref, path)
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_build_dependency)) {
    if (expr.args.length < 2) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `__yo_build_dependency expects at least 2 arguments (name, url), got ${expr.args.length}`,
      });
    }
    const name = extractComptimeString(
      expr.args[0]!.$?.value,
      "name",
      expr.token
    );
    const url = extractComptimeString(
      expr.args[1]!.$?.value,
      "url",
      expr.token
    );
    const ref =
      expr.args.length > 2
        ? extractComptimeString(expr.args[2]!.$?.value, "ref", expr.token)
        : "HEAD";
    const depPath =
      expr.args.length > 3
        ? extractComptimeString(expr.args[3]!.$?.value, "path", expr.token)
        : "";

    registry.registerDependency({ name, url, ref, path: depPath });
    return makeUnitResult(expr, env);
  }

  // __yo_build_path_dependency(name, path)
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_build_path_dependency)) {
    if (expr.args.length !== 2) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `__yo_build_path_dependency expects 2 arguments (name, path), got ${expr.args.length}`,
      });
    }
    const name = extractComptimeString(
      expr.args[0]!.$?.value,
      "name",
      expr.token
    );
    const depPath = extractComptimeString(
      expr.args[1]!.$?.value,
      "path",
      expr.token
    );

    registry.registerPathDependency({ name, path: depPath });
    return makeUnitResult(expr, env);
  }

  // __yo_build_system_library(name, fallback_include, fallback_lib, fallback_link)
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_build_system_library)) {
    if (expr.args.length < 1) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `__yo_build_system_library expects at least 1 argument (name), got ${expr.args.length}`,
      });
    }
    const name = extractComptimeString(
      expr.args[0]!.$?.value,
      "name",
      expr.token
    );
    const fallbackInclude =
      expr.args.length > 1
        ? extractComptimeString(
            expr.args[1]!.$?.value,
            "fallback_include",
            expr.token
          )
        : "";
    const fallbackLib =
      expr.args.length > 2
        ? extractComptimeString(
            expr.args[2]!.$?.value,
            "fallback_lib",
            expr.token
          )
        : "";
    const fallbackLink =
      expr.args.length > 3
        ? extractComptimeString(
            expr.args[3]!.$?.value,
            "fallback_link",
            expr.token
          )
        : "";
    const defines =
      expr.args.length > 4
        ? extractComptimeString(expr.args[4]!.$?.value, "defines", expr.token)
            .split(/\s+/)
            .filter(Boolean)
        : [];

    registry.registerSystemLibrary({
      name,
      fallbackInclude,
      fallbackLib,
      fallbackLink,
      defines,
    });
    return makeUnitResult(expr, env);
  }

  // __yo_build_option(name, description, default) -> comptime_str
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_build_option)) {
    if (expr.args.length < 3) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `__yo_build_option expects 3 arguments (name, description, default), got ${expr.args.length}`,
      });
    }
    const name = extractComptimeString(
      expr.args[0]!.$?.value,
      "name",
      expr.token
    );
    const description = extractComptimeString(
      expr.args[1]!.$?.value,
      "description",
      expr.token
    );
    const defaultValue = extractComptimeString(
      expr.args[2]!.$?.value,
      "default",
      expr.token
    );

    registry.declaredOptions.set(name, { description, defaultValue });

    // Return CLI override if provided, otherwise the default
    const value = registry.cliOptions.get(name) ?? defaultValue;
    return makeComptimeStringResult(expr, env, value);
  }

  // __yo_build_dep_artifact(dependency_name, artifact_name)
  // Registers a reference to an artifact from a dependency's build.yo.
  // The build runner resolves and compiles it during the build phase.
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_build_dep_artifact)) {
    if (expr.args.length < 2) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `__yo_build_dep_artifact expects 2 arguments (dependency_name, artifact_name), got ${expr.args.length}`,
      });
    }
    const dependencyName = extractComptimeString(
      expr.args[0]!.$?.value,
      "dependency_name",
      expr.token
    );
    const artifactName = extractComptimeString(
      expr.args[1]!.$?.value,
      "artifact_name",
      expr.token
    );

    registry.registerDependencyArtifact({ dependencyName, artifactName });
    return makeUnitResult(expr, env);
  }

  // __yo_build_module(name, root)
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_build_module)) {
    if (expr.args.length < 2) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `__yo_build_module expects 2 arguments (name, root), got ${expr.args.length}`,
      });
    }
    const name = extractComptimeString(
      expr.args[0]!.$?.value,
      "name",
      expr.token
    );
    const root = extractComptimeString(
      expr.args[1]!.$?.value,
      "root",
      expr.token
    );
    registry.registerModule({ name, root, linkedSystemLibraries: [] });
    return makeUnitResult(expr, env);
  }

  // __yo_build_module_link(module_name, system_library_name)
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_build_module_link)) {
    if (expr.args.length < 2) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `__yo_build_module_link expects 2 arguments (module_name, system_library_name), got ${expr.args.length}`,
      });
    }
    const moduleName = extractComptimeString(
      expr.args[0]!.$?.value,
      "module_name",
      expr.token
    );
    const systemLibraryName = extractComptimeString(
      expr.args[1]!.$?.value,
      "system_library_name",
      expr.token
    );
    registry.registerModuleLink(moduleName, systemLibraryName);
    return makeUnitResult(expr, env);
  }

  // __yo_build_add_import(artifact_name, import_name, module_name, dependency_name)
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_build_add_import)) {
    if (expr.args.length < 4) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `__yo_build_add_import expects 4 arguments (artifact_name, import_name, module_name, dependency_name), got ${expr.args.length}`,
      });
    }
    const artifactName = extractComptimeString(
      expr.args[0]!.$?.value,
      "artifact_name",
      expr.token
    );
    const importName = extractComptimeString(
      expr.args[1]!.$?.value,
      "import_name",
      expr.token
    );
    const moduleName = extractComptimeString(
      expr.args[2]!.$?.value,
      "module_name",
      expr.token
    );
    const dependencyName = extractComptimeString(
      expr.args[3]!.$?.value,
      "dependency_name",
      expr.token
    );

    // Check for duplicate import names
    const artifact = registry.findArtifact(artifactName);
    if (artifact) {
      const existing = artifact.importedModules.find(
        (m) => m.importName === importName
      );
      if (existing) {
        throw formatErrorMessage({
          token: expr.token,
          errorMessage: `Duplicate import name "${importName}" on artifact "${artifactName}". Already imported from module "${existing.moduleName}".`,
        });
      }
    }

    registry.registerImportedModule(artifactName, {
      importName,
      moduleName,
      dependencyName,
    });
    return makeUnitResult(expr, env);
  }

  // __yo_build_add_cflags(artifact_name, flags)
  // Appends custom C compiler/linker flags to the artifact
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_build_add_cflags)) {
    if (expr.args.length < 2) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `__yo_build_add_cflags expects 2 arguments (artifact_name, flags), got ${expr.args.length}`,
      });
    }
    const artifactName = extractComptimeString(
      expr.args[0]!.$?.value,
      "artifact_name",
      expr.token
    );
    const flags = extractComptimeString(
      expr.args[1]!.$?.value,
      "flags",
      expr.token
    );

    const artifact = registry.findArtifact(artifactName);
    if (artifact) {
      const flagList = flags
        .trim()
        .split(/\s+/)
        .filter((f) => f.length > 0);
      artifact.cFlags.push(...flagList);
    }
    return makeUnitResult(expr, env);
  }

  // __yo_build_dep_module(dependency_name, module_name)
  // Returns comptime_str encoding: "dep_name\0module_name"
  // The build runner interprets this to resolve the module at build time.
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_build_dep_module)) {
    if (expr.args.length < 2) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `__yo_build_dep_module expects 2 arguments (dependency_name, module_name), got ${expr.args.length}`,
      });
    }
    const dependencyName = extractComptimeString(
      expr.args[0]!.$?.value,
      "dependency_name",
      expr.token
    );
    const moduleName = extractComptimeString(
      expr.args[1]!.$?.value,
      "module_name",
      expr.token
    );
    // Encode as "dep_name\0module_name" — decoded by add_import handler
    return makeComptimeStringResult(
      expr,
      env,
      `${dependencyName}\0${moduleName}`
    );
  }

  throw formatErrorMessage({
    token: expr.token,
    errorMessage: `Unknown build function: ${expr.func.token.value}`,
  });
}
