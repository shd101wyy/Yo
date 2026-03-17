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

export interface BuildProject {
  name: string;
  version: string;
  root: string;
}

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
  linkedArtifacts: string[]; // Names of Yo library artifacts to link
  linkedSystemLibraries: string[]; // Names of system libraries to link (via pkg-config)
}

export interface BuildTestSuite {
  name: string;
  root: string;
  target: string;
  verbose: boolean;
  bail: boolean;
  parallel: number;
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
  pkgConfig: string;
  fallbackInclude: string;
  fallbackLib: string;
  fallbackLink: string;
}

export class BuildRegistry {
  project: BuildProject | undefined;
  artifacts: BuildArtifact[] = [];
  testSuites: BuildTestSuite[] = [];
  runSteps: BuildRunStep[] = [];
  steps: BuildStep[] = [];
  dependencies: BuildGitDependency[] = [];
  pathDependencies: BuildPathDependency[] = [];
  systemLibraries: BuildSystemLibrary[] = [];
  /** User-provided build options from CLI -Dname=value */
  cliOptions: Map<string, string> = new Map();
  /** Declared build options (name → { description, default }) */
  declaredOptions: Map<string, { description: string; defaultValue: string }> =
    new Map();

  /** Set CLI options parsed from -Dname=value flags */
  setCliOptions(options: Map<string, string>): void {
    this.cliOptions = options;
  }

  registerProject(name: string, version: string, root: string): void {
    this.project = { name, version, root };
  }

  registerExecutable(config: Omit<BuildArtifact, "kind">): void {
    this.artifacts.push({ kind: "executable", ...config });
  }

  registerStaticLibrary(config: Omit<BuildArtifact, "kind">): void {
    this.artifacts.push({ kind: "static_library", ...config });
  }

  registerSharedLibrary(config: Omit<BuildArtifact, "kind">): void {
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
    | { kind: "step"; value: BuildStep }
    | undefined {
    const artifact = this.findArtifact(name);
    if (artifact) return { kind: "artifact", value: artifact };

    const test = this.findTest(name);
    if (test) return { kind: "test", value: test };

    // Run steps have synthetic names like "run:app-name"
    const run = this.findRunStep(name);
    if (run) return { kind: "run", value: run };

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
    this.project = undefined;
    this.artifacts = [];
    this.testSuites = [];
    this.runSteps = [];
    this.steps = [];
    this.dependencies = [];
    this.pathDependencies = [];
    this.systemLibraries = [];
  }
}

// Global singleton — cleared before each build.yo evaluation
let globalRegistry: BuildRegistry | undefined;

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

// ── Argument extraction helpers ───────────────────────────────────────

function extractComptimeString(
  value: Value | undefined,
  paramName: string,
  token: Token
): string {
  if (!isComptimeStringValue(value)) {
    throw formatErrorMessage({
      token,
      errorMessage: `Build function: expected comptime_string for "${paramName}", got ${value ? "non-string" : "undefined"}`,
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
    // For functions that return comptime_string, always return a valid string value
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

  // __yo_build_project(name, version, root)
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_build_project)) {
    if (expr.args.length < 2) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `__yo_build_project expects at least 2 arguments (name, version), got ${expr.args.length}`,
      });
    }
    const name = extractComptimeString(
      expr.args[0]!.$?.value,
      "name",
      expr.token
    );
    const version = extractComptimeString(
      expr.args[1]!.$?.value,
      "version",
      expr.token
    );
    const root = expr.args[2]
      ? extractComptimeString(expr.args[2].$?.value, "root", expr.token)
      : "./src/lib.yo";
    registry.registerProject(name, version, root);
    return makeUnitResult(expr, env);
  }

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
      linkedArtifacts: [],
      linkedSystemLibraries: [],
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
      allocator: "mimalloc",
      sanitize: "none",
      linkLibraries: [],
      includePaths: [],
      libraryPaths: [],
      cSources: [],
      cFlags: [],
      defines: [],
      strip: false,
      staticLink: false,
      linkedArtifacts: [],
      linkedSystemLibraries: [],
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
      allocator: "mimalloc",
      sanitize: "none",
      linkLibraries: [],
      includePaths: [],
      libraryPaths: [],
      cSources: [],
      cFlags: [],
      defines: [],
      strip: false,
      staticLink: false,
      linkedArtifacts: [],
      linkedSystemLibraries: [],
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

  // __yo_build_test(name, root, target)
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

    registry.registerTest({
      name,
      root,
      target,
      verbose: false,
      bail: false,
      parallel: 1,
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

  // __yo_build_target_host() — returns comptime_string (used as a value)
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_build_target_host)) {
    const target = hostTarget();
    return makeComptimeStringResult(expr, env, target.triple);
  }

  // __yo_build_target_parse(triple) — returns comptime_string (used as a value)
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

  // __yo_build_system_library(name, pkg_config, fallback_include, fallback_lib, fallback_link)
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_build_system_library)) {
    if (expr.args.length < 2) {
      throw formatErrorMessage({
        token: expr.token,
        errorMessage: `__yo_build_system_library expects at least 2 arguments (name, pkg_config), got ${expr.args.length}`,
      });
    }
    const name = extractComptimeString(
      expr.args[0]!.$?.value,
      "name",
      expr.token
    );
    const pkgConfig = extractComptimeString(
      expr.args[1]!.$?.value,
      "pkg_config",
      expr.token
    );
    const fallbackInclude =
      expr.args.length > 2
        ? extractComptimeString(
            expr.args[2]!.$?.value,
            "fallback_include",
            expr.token
          )
        : "";
    const fallbackLib =
      expr.args.length > 3
        ? extractComptimeString(
            expr.args[3]!.$?.value,
            "fallback_lib",
            expr.token
          )
        : "";
    const fallbackLink =
      expr.args.length > 4
        ? extractComptimeString(
            expr.args[4]!.$?.value,
            "fallback_link",
            expr.token
          )
        : "";

    registry.registerSystemLibrary({
      name,
      pkgConfig,
      fallbackInclude,
      fallbackLib,
      fallbackLink,
    });
    return makeUnitResult(expr, env);
  }

  // __yo_build_option(name, description, default) -> comptime_string
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

  throw formatErrorMessage({
    token: expr.token,
    errorMessage: `Unknown build function: ${expr.func.token.value}`,
  });
}
