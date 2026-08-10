/**
 * `yo build` — build system runner.
 *
 * Evaluates `build.yo` using the Yo evaluator at compile time.
 * Build functions (build.module, build.executable, etc.) are backed by
 * evaluator builtins that register artifacts in a global BuildRegistry.
 * After evaluation, the build runner reads the registry and orchestrates
 * compilation for each artifact.
 */

import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { execSync } from "child_process";
import { CodeGenerator } from "./codegen";
import { findAvailableCompiler } from "./compiler-utils";
import { clearEnvContainingPrelude } from "./env";
import {
  type BuildArtifact,
  type BuildDocConfig,
  type BuildGitDependency,
  type BuildModuleEntry,
  BuildRegistry,
  type BuildTestSuite,
  type DependencyArtifactRef,
  type ImportedModule,
  clearBuildRegistry,
  getBuildRegistry,
  swapBuildRegistry,
  setRootBuildProjectDir,
  setModuleImportRoot,
} from "./evaluator/builtins/build";
import { clearAllGlobalImplState } from "./evaluator/values/impl";
import {
  fetchAllDependencies,
  areDependenciesCached,
  resolveDependencyPath,
} from "./fetch";
import { ModuleManager } from "./module-manager";
import { clearAllModuleCounters } from "./utils";
import { clearAllCachedTypes } from "./types/creators";
import { resolveAllSystemLibraries } from "./pkg-config";
import { isTargetWasm, isTargetWindows, parseTarget } from "./target";

export interface BuildOptions {
  /** Path to build file (default: ./build.yo) */
  buildFile: string;
  /** Override target triple for all artifacts */
  targetTriple?: string;
  /** Verbose output */
  verbose?: boolean;
  /** Show what would be built without building */
  dryRun?: boolean;
  /** List available build steps */
  listSteps?: boolean;
  /** Named steps to execute */
  steps?: string[];
  /** User-defined -D options */
  defines?: Record<string, string>;
  /** C compiler to use */
  cCompiler?: string;
  /** Sysroot directory for cross-compilation */
  sysroot?: string;
  /** Print build summary tree (like Zig's --summary) */
  summary?: boolean;
}

export function getArtifactOutputFileName(
  artifact: Pick<BuildArtifact, "kind" | "name" | "target"> &
    Partial<Pick<BuildArtifact, "cFlags">>,
  targetTriple?: string
): string {
  if (artifact.kind === "static_library") {
    return `lib${artifact.name}`;
  }

  const effectiveTarget =
    targetTriple !== undefined
      ? parseTarget(targetTriple)
      : parseTarget(artifact.target);

  if (artifact.kind === "executable" && isTargetWindows(effectiveTarget)) {
    return `${artifact.name}.exe`;
  }

  if (artifact.kind === "executable" && isTargetWasm(effectiveTarget)) {
    // -sMODULARIZE is incompatible with .html output; use .js in that case.
    // Otherwise default to .html (emcc also generates .js and .wasm alongside).
    const hasModularize = (artifact.cFlags ?? []).some((f) =>
      f.includes("-sMODULARIZE")
    );
    return `${artifact.name}.${hasModularize ? "js" : "html"}`;
  }

  return artifact.name;
}

/**
 * Get the target-specific output directory for build artifacts.
 * Layout: yo-out/<target>/bin/ or yo-out/<target>/lib/
 *
 * This mirrors Cargo's approach where each target triple gets its own
 * subdirectory, preventing conflicts in multi-target builds.
 */
function getTargetOutputDir(
  projectDir: string,
  targetTriple: string,
  kind: "bin" | "lib" | "deps"
): string {
  return path.join(projectDir, "yo-out", targetTriple, kind);
}

export function stageRuntimeFiles(
  runtimeFiles: readonly string[],
  outputDir: string,
  verbose: boolean = false
): string[] {
  const stagedFiles: string[] = [];
  const seenDestinations = new Set<string>();

  for (const runtimeFile of runtimeFiles) {
    const sourcePath = path.resolve(runtimeFile);
    if (!fs.existsSync(sourcePath)) {
      continue;
    }

    const destinationPath = path.join(outputDir, path.basename(sourcePath));
    if (seenDestinations.has(destinationPath)) {
      continue;
    }
    seenDestinations.add(destinationPath);

    if (path.resolve(destinationPath) !== sourcePath) {
      fs.copyFileSync(sourcePath, destinationPath);
    }

    stagedFiles.push(destinationPath);
    if (verbose) {
      console.log(
        `  Staged runtime dependency: ${path.relative(process.cwd(), destinationPath)}`
      );
    }
  }

  return stagedFiles;
}

function resolveDependencyPathOrExit(
  projectDir: string,
  depName: string,
  depPath: string = ""
): string | undefined {
  try {
    return resolveDependencyPath(projectDir, depName, depPath);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

/**
 * Run the build system.
 *
 * 1. Evaluate build.yo using the Yo evaluator (builtins populate BuildRegistry)
 * 2. Read build config from registry
 * 3. For each requested step, compile/run/test artifacts
 */
export async function runBuild(options: BuildOptions): Promise<void> {
  const userCwd = process.env.YO_ORIGINAL_CWD ?? process.cwd();
  const buildFile = path.resolve(userCwd, options.buildFile);

  if (!fs.existsSync(buildFile)) {
    console.error(
      `Error: Build file not found: ${buildFile}\n` +
        `Run 'yo init' to create a new project with a build.yo file.`
    );
    process.exit(1);
  }

  // Parse -D options into a Map
  const cliOptions = new Map<string, string>();
  if (options.defines) {
    for (const [key, value] of Object.entries(options.defines)) {
      cliOptions.set(key, value);
    }
  }

  // Evaluate build.yo — builtins populate the global BuildRegistry
  const registry = evaluateBuildFile(buildFile, cliOptions);

  if (options.listSteps) {
    printSteps(registry);
    return;
  }

  // Determine which steps to run
  const requestedSteps =
    options.steps && options.steps.length > 0 ? options.steps : ["install"];

  // Find C compiler
  let cCompiler = options.cCompiler;
  if (!cCompiler) {
    const available = findAvailableCompiler();
    if (!available) {
      console.error(
        "Error: No C compiler found. Please install clang, gcc, or another C compiler."
      );
      process.exit(1);
    }
    cCompiler = available;
  }

  const projectDir = path.dirname(buildFile);

  // Set root project dir for transitive import resolution
  setRootBuildProjectDir(projectDir);
  if (registry.dependencies.length > 0) {
    if (!areDependenciesCached(projectDir, registry.dependencies)) {
      if (options.verbose) {
        console.log("Dependencies not cached — fetching...");
      }
      fetchAllDependencies(projectDir, registry.dependencies, options.verbose);
    } else if (options.verbose) {
      console.log("All dependencies cached.");
    }

    // Recursively discover and fetch transitive dependencies
    fetchTransitiveDependencies(
      projectDir,
      registry.dependencies,
      options.verbose
    );
  }

  // Resolve system libraries per-artifact via pkg-config
  // Each artifact only gets flags for system libraries explicitly linked to it.
  // For WASM targets, skip host-platform pkg-config/vcpkg resolution (paths are
  // incompatible) but still add -l<name> so the emscripten linker finds them.
  if (registry.systemLibraries.length > 0) {
    for (const artifact of registry.artifacts) {
      if (artifact.linkedSystemLibraries.length === 0) continue;
      const effectiveTarget = options.targetTriple ?? artifact.target;
      const linkedLibs = registry.systemLibraries.filter((lib) =>
        artifact.linkedSystemLibraries.includes(lib.name)
      );
      if (linkedLibs.length === 0) continue;

      if (isTargetWasm(parseTarget(effectiveTarget))) {
        // WASM: just add -l<name> for each linked system library
        for (const lib of linkedLibs) {
          if (!artifact.linkLibraries.includes(lib.name)) {
            artifact.linkLibraries.push(lib.name);
          }
        }
        continue;
      }

      const sysLibFlags = resolveAllSystemLibraries(
        linkedLibs,
        options.verbose,
        { preferDebugRuntime: artifact.optimize === "debug" }
      );
      artifact.includePaths.push(...sysLibFlags.includePaths);
      artifact.libraryPaths.push(...sysLibFlags.libraryPaths);
      artifact.linkLibraries.push(...sysLibFlags.linkLibraries);
      artifact.defines.push(...sysLibFlags.defines);
      artifact.cFlags.push(...sysLibFlags.cFlags);
      artifact.runtimeFiles ??= [];
      for (const runtimeFile of sysLibFlags.runtimeFiles) {
        if (!artifact.runtimeFiles.includes(runtimeFile)) {
          artifact.runtimeFiles.push(runtimeFile);
        }
      }
    }
  }

  // Resolve dependency artifacts — evaluate dependency build.yo files
  // and compile their artifacts before the root project
  if (registry.dependencyArtifacts.length > 0) {
    await resolveDependencyArtifacts(registry, projectDir, {
      cCompiler,
      targetTriple: options.targetTriple,
      sysroot: options.sysroot,
      verbose: options.verbose,
    });
  }

  // Resolve imported modules — evaluate dependency build.yo files
  // to discover modules, collect their system library requirements,
  // and propagate C flags to consumer artifacts.
  resolveImportedModules(registry, projectDir, options.verbose);

  for (const stepName of requestedSteps) {
    if (options.dryRun) {
      console.log(`[dry-run] Would execute step: ${stepName}`);
      continue;
    }

    await executeStep(stepName, {
      registry,
      projectDir,
      cCompiler,
      targetTriple: options.targetTriple,
      sysroot: options.sysroot,
      verbose: options.verbose,
      summary: options.summary,
    });
  }
}

// ── Build file evaluation ─────────────────────────────────────────────

function evaluateBuildFile(
  buildFile: string,
  cliOptions?: Map<string, string>
): BuildRegistry {
  // Clear any previous build registry
  clearBuildRegistry();

  // Set CLI options before evaluation so build.option() can read them
  if (cliOptions && cliOptions.size > 0) {
    getBuildRegistry().setCliOptions(cliOptions);
  }

  const modulePath = `file://${fs.realpathSync(buildFile)}`;

  try {
    const moduleManager = new ModuleManager();
    moduleManager.loadModule(modulePath);
    // Reset global evaluator state so the compilation step starts clean
    moduleManager.resetAllState();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error evaluating ${buildFile}:\n${message}`);
    process.exit(1);
  }

  return getBuildRegistry();
}

// ── Step listing ──────────────────────────────────────────────────────

function printSteps(registry: BuildRegistry): void {
  const steps = registry.steps;
  if (steps.length === 0) {
    console.log("No build steps defined.");
    return;
  }

  console.log("Available steps:");
  for (const step of steps) {
    const isDefault = step.name === "install" ? " (default)" : "";
    console.log(`  ${step.name}${isDefault}\t${step.description}`);
  }
}

// ── Step execution ────────────────────────────────────────────────────

interface ExecutionContext {
  registry: BuildRegistry;
  projectDir: string;
  cCompiler: string;
  targetTriple?: string;
  sysroot?: string;
  verbose?: boolean;
  summary?: boolean;
}

/** Result of executing a single build step. */
interface StepResult {
  name: string;
  kind: "artifact" | "test" | "run" | "step" | "doc";
  success: boolean;
  durationMs: number;
  /** Peak RSS in bytes during this step's execution */
  maxRssBytes: number;
  /** Short description for summary (e.g., "compile lib fizzbuzz Debug native") */
  description: string;
  /** Child step results (dependencies that were executed) */
  children: StepResult[];
}

// ── DAG-based execution ──────────────────────────────────────────────

/**
 * A node in the build DAG. Each node represents an artifact, test,
 * run step, or custom step that may depend on other nodes.
 */
export interface DAGNode {
  name: string;
  kind: "artifact" | "test" | "run" | "step" | "doc";
  dependsOn: string[];
}

/**
 * Build a DAG by walking the step's dependency tree.
 * Each node gets its transitive dependencies resolved into direct edges.
 */
export function buildDAG(
  registry: BuildRegistry,
  rootStepName: string
): DAGNode[] {
  const nodes = new Map<string, DAGNode>();
  const visited = new Set<string>();

  function walk(name: string): void {
    if (visited.has(name)) return;
    visited.add(name);

    const resolved = registry.resolveDependency(name);
    if (!resolved) return;

    switch (resolved.kind) {
      case "artifact": {
        const artifact = resolved.value;
        const deps: string[] = [];
        // Linked artifacts are dependencies
        for (const linked of artifact.linkedArtifacts) {
          deps.push(linked);
          walk(linked);
        }
        nodes.set(name, { name, kind: "artifact", dependsOn: deps });
        break;
      }
      case "test": {
        nodes.set(name, { name, kind: "test", dependsOn: [] });
        break;
      }
      case "run": {
        const runStep = resolved.value;
        // Run step depends on its artifact being compiled
        const deps = [runStep.artifactName];
        walk(runStep.artifactName);
        nodes.set(name, { name, kind: "run", dependsOn: deps });
        break;
      }
      case "step": {
        const step = resolved.value;
        const deps: string[] = [];
        for (const depName of step.dependencyNames) {
          deps.push(depName);
          walk(depName);
        }
        nodes.set(name, { name, kind: "step", dependsOn: deps });
        break;
      }
      case "doc": {
        nodes.set(name, { name, kind: "doc", dependsOn: [] });
        break;
      }
    }
  }

  // Start from the root step
  const rootStep = registry.findStep(rootStepName);
  if (!rootStep) return [];

  walk(rootStepName);
  return Array.from(nodes.values());
}

/**
 * Detect cycles in a DAG. Returns the cycle path if found, null otherwise.
 */
export function detectCycle(dag: DAGNode[]): string[] | null {
  const nodeMap = new Map<string, DAGNode>();
  for (const node of dag) nodeMap.set(node.name, node);

  const WHITE = 0,
    GRAY = 1,
    BLACK = 2;
  const color = new Map<string, number>();
  for (const node of dag) color.set(node.name, WHITE);

  const parent = new Map<string, string | null>();

  function dfs(name: string): string | null {
    color.set(name, GRAY);
    const node = nodeMap.get(name);
    if (!node) {
      color.set(name, BLACK);
      return null;
    }

    for (const dep of node.dependsOn) {
      if (!nodeMap.has(dep)) continue;
      if (color.get(dep) === GRAY) {
        // Found cycle — reconstruct path
        const cycle = [dep, name];
        let cur = name;
        while (parent.get(cur) !== undefined && parent.get(cur) !== dep) {
          cur = parent.get(cur)!;
          cycle.push(cur);
        }
        cycle.push(dep);
        return dep; // signal cycle found
      }
      if (color.get(dep) === WHITE) {
        parent.set(dep, name);
        const result = dfs(dep);
        if (result !== null) return result;
      }
    }

    color.set(name, BLACK);
    return null;
  }

  // Reconstruct a cleaner cycle
  for (const node of dag) {
    if (color.get(node.name) === WHITE) {
      const cycleNode = dfs(node.name);
      if (cycleNode !== null) {
        // Walk the cycle
        const cycle: string[] = [cycleNode];
        const nodeObj = nodeMap.get(cycleNode);
        if (nodeObj) {
          for (const dep of nodeObj.dependsOn) {
            if (color.get(dep) === GRAY || dep === cycleNode) {
              // Simple cycle reporting
              cycle.push(dep);
              break;
            }
          }
        }
        return cycle;
      }
    }
  }

  return null;
}

/**
 * Execute a step using DAG-based scheduling.
 *
 * Nodes at each "level" (zero in-degree) execute concurrently.
 * Artifact compilations are serialized (global evaluator state),
 * but tests and run steps can run in parallel.
 */
async function executeStep(
  stepName: string,
  ctx: ExecutionContext
): Promise<void> {
  const { registry } = ctx;
  const step = registry.findStep(stepName);

  if (!step) {
    const availableNames = registry.getStepNames();
    console.error(
      `Error: Unknown step "${stepName}".` +
        (availableNames.length > 0
          ? ` Available steps: ${availableNames.join(", ")}`
          : " No steps defined in build.yo.")
    );
    process.exit(1);
  }

  // Build the DAG from the step's dependency tree
  const dag = buildDAG(registry, stepName);

  // Check for cycles
  const cycle = detectCycle(dag);
  if (cycle) {
    console.error(`Error: Cycle detected in build DAG: ${cycle.join(" → ")}`);
    process.exit(1);
  }

  // Execute using level-based scheduling
  const results = await executeDAG(dag, stepName, ctx);

  // Print build summary if requested
  if (ctx.summary) {
    printBuildSummary(results, dag, stepName);
  }

  // A failed step must fail the build. executeNode catches per-step errors
  // into StepResult.success so the DAG can finish and the summary can show
  // WHICH step broke — but `yo build` exiting 0 after a failed compile would
  // let CI pass silently. See
  // issues/fixed/yo-build-exits-zero-on-failed-step.md
  for (const result of results.values()) {
    if (!result.success) {
      process.exit(1);
    }
  }
}

/**
 * Level-based DAG executor (Kahn's algorithm).
 * Runs independent nodes concurrently at each level.
 * Returns a map of step results for summary output.
 */
async function executeDAG(
  dag: DAGNode[],
  rootName: string,
  ctx: ExecutionContext
): Promise<Map<string, StepResult>> {
  const results = new Map<string, StepResult>();
  if (dag.length === 0) return results;

  const nodeMap = new Map<string, DAGNode>();
  for (const node of dag) nodeMap.set(node.name, node);

  // Compute in-degrees
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const node of dag) {
    if (!inDegree.has(node.name)) inDegree.set(node.name, 0);
    for (const dep of node.dependsOn) {
      if (!nodeMap.has(dep)) continue; // skip external deps not in DAG
      const list = dependents.get(dep) ?? [];
      list.push(node.name);
      dependents.set(dep, list);
      inDegree.set(node.name, (inDegree.get(node.name) ?? 0) + 1);
    }
  }

  const completed = new Set<string>();

  while (completed.size < dag.length) {
    // Find all ready nodes (in-degree == 0, not yet completed)
    const ready = dag.filter(
      (n) => !completed.has(n.name) && (inDegree.get(n.name) ?? 0) === 0
    );

    if (ready.length === 0) {
      // Should not happen after cycle detection, but guard anyway
      const remaining = dag
        .filter((n) => !completed.has(n.name))
        .map((n) => n.name);
      console.error(
        `Error: Build DAG stalled. Remaining nodes: ${remaining.join(", ")}`
      );
      process.exit(1);
    }

    // Group by kind for execution strategy
    // Artifacts and doc nodes use global evaluator state — serialize them
    const serializedNodes = ready.filter(
      (n) => n.kind === "artifact" || n.kind === "doc"
    );
    const otherNodes = ready.filter(
      (n) => n.kind !== "artifact" && n.kind !== "doc"
    );

    // Artifacts and docs must be serialized (global evaluator state)
    for (const node of serializedNodes) {
      const result = await executeNode(node, ctx);
      results.set(node.name, result);
    }

    // Tests and run steps can execute concurrently
    if (otherNodes.length > 0) {
      const nodeResults = await Promise.all(
        otherNodes.map((node) => executeNode(node, ctx))
      );
      for (let i = 0; i < otherNodes.length; i++) {
        results.set(otherNodes[i]!.name, nodeResults[i]!);
      }
    }

    // Mark completed and update in-degrees
    for (const node of ready) {
      completed.add(node.name);
      for (const dep of dependents.get(node.name) ?? []) {
        inDegree.set(dep, (inDegree.get(dep) ?? 1) - 1);
      }
    }
  }

  return results;
}

/**
 * Execute a single DAG node based on its kind.
 * Returns a StepResult with timing and status information.
 */
async function executeNode(
  node: DAGNode,
  ctx: ExecutionContext
): Promise<StepResult> {
  const { registry } = ctx;
  const startTime = Date.now();
  const startRss = process.memoryUsage.rss();
  let peakRss = startRss;
  let success = true;
  let description = "";

  // Sample RSS periodically during execution via a wrapper
  const sampleRss = (): void => {
    const current = process.memoryUsage.rss();
    if (current > peakRss) peakRss = current;
  };

  switch (node.kind) {
    case "artifact": {
      const artifact = registry.findArtifact(node.name);
      if (artifact) {
        const target = artifact.target || "native";
        const optimize = artifact.optimize || "debug";
        description = `compile ${artifact.kind === "static_library" ? "lib" : artifact.kind === "shared_library" ? "shared lib" : "exe"} ${artifact.name} ${capitalize(optimize)} ${target}`;
        try {
          await compileArtifact(artifact, ctx);
        } catch (e) {
          console.error(
            `Compilation error: ${e instanceof Error ? e.message : String(e)}`
          );
          if (e instanceof Error && e.stack) console.error(e.stack);
          success = false;
        }
      }
      break;
    }
    case "test": {
      const testSuite = registry.findTest(node.name);
      if (testSuite) {
        description = `test ${testSuite.name}`;
        try {
          await runTestSuite(testSuite, ctx);
        } catch {
          success = false;
        }
      }
      break;
    }
    case "run": {
      const runStep = registry.findRunStep(node.name);
      if (runStep) {
        description = `run ${runStep.artifactName}`;
        const artifact = registry.findArtifact(runStep.artifactName);
        if (artifact) {
          try {
            await runExecutable(artifact, runStep.args, ctx);
          } catch {
            success = false;
          }
        }
      }
      break;
    }
    case "step":
      description = node.name;
      break;
    case "doc": {
      const docConfig = registry.findDocumentation(node.name);
      if (docConfig) {
        description = `doc ${docConfig.name}`;
        try {
          await runDocGeneration(docConfig, ctx);
        } catch (e) {
          console.error(
            `Documentation generation error: ${e instanceof Error ? e.message : String(e)}`
          );
          success = false;
        }
      }
      break;
    }
  }

  sampleRss();
  const durationMs = Date.now() - startTime;
  return {
    name: node.name,
    kind: node.kind,
    success,
    durationMs,
    maxRssBytes: peakRss,
    description: description || node.name,
    children: [],
  };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Format a duration in milliseconds as a human-readable string.
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSec = seconds % 60;
  return `${minutes}m${remainingSec.toFixed(0)}s`;
}

/**
 * Format bytes as a human-readable memory size.
 */
function formatMemory(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)}K`;
  const mb = kb / 1024;
  if (mb < 1024) return `${Math.round(mb)}M`;
  const gb = mb / 1024;
  return `${gb.toFixed(1)}G`;
}

/**
 * Print a Zig-style build summary tree.
 *
 * Example output:
 * ```
 * Build Summary: 3/3 steps succeeded
 * install success
 * └── compile exe my-app Debug native success 175ms
 *     └── compile lib add Debug native success 42ms
 * ```
 */
function printBuildSummary(
  results: Map<string, StepResult>,
  dag: DAGNode[],
  rootName: string
): void {
  const totalSteps = results.size;
  let succeededSteps = 0;
  for (const result of results.values()) {
    if (result.success) succeededSteps++;
  }

  console.log("");
  console.log(`Build Summary: ${succeededSteps}/${totalSteps} steps succeeded`);

  // Build adjacency list from DAG (parent → children)
  const nodeMap = new Map<string, DAGNode>();
  for (const node of dag) nodeMap.set(node.name, node);

  // Print tree recursively from root
  const rootNode = nodeMap.get(rootName);
  if (rootNode) {
    printSummaryNode(rootNode, results, nodeMap, "", "", true);
  }
}

function printSummaryNode(
  node: DAGNode,
  results: Map<string, StepResult>,
  nodeMap: Map<string, DAGNode>,
  linePrefix: string,
  childrenPrefix: string,
  isRoot: boolean
): void {
  const result = results.get(node.name);
  const status = result ? (result.success ? "success" : "FAILURE") : "skipped";
  const duration =
    result && result.durationMs > 0
      ? ` ${formatDuration(result.durationMs)}`
      : "";
  const memory =
    result && result.maxRssBytes > 0
      ? ` MaxRSS:${formatMemory(result.maxRssBytes)}`
      : "";
  const description = result?.description ?? node.name;

  if (isRoot) {
    console.log(`${description} ${status}`);
  } else {
    console.log(`${linePrefix}${description} ${status}${duration}${memory}`);
  }

  // Find children (nodes that this node depends on)
  const children = node.dependsOn
    .map((dep) => nodeMap.get(dep))
    .filter((n): n is DAGNode => n !== undefined);

  for (let i = 0; i < children.length; i++) {
    const isLast = i === children.length - 1;
    const connector = isLast ? "└── " : "├── ";
    const nextChildPrefix = isLast ? "    " : "│   ";
    printSummaryNode(
      children[i]!,
      results,
      nodeMap,
      childrenPrefix + connector,
      childrenPrefix + nextChildPrefix,
      false
    );
  }
}

// ── Artifact compilation ──────────────────────────────────────────────

/** Track which artifacts have been compiled to avoid duplicates */
const compiledArtifacts = new Set<string>();

async function compileArtifact(
  artifact: BuildArtifact,
  ctx: ExecutionContext
): Promise<void> {
  // Skip if already compiled this session
  if (compiledArtifacts.has(artifact.name)) return;
  compiledArtifacts.add(artifact.name);

  const { projectDir, registry } = ctx;
  let { cCompiler } = ctx;

  // Auto-select emcc for WASM targets
  const effectiveTarget = ctx.targetTriple ?? artifact.target;
  const parsedTarget = parseTarget(effectiveTarget);
  if (isTargetWasm(parsedTarget) && cCompiler !== "emcc") {
    cCompiler = "emcc";
  }

  // Compile linked library artifacts first
  for (const linkedName of artifact.linkedArtifacts) {
    const linkedArtifact = registry.findArtifact(linkedName);
    if (linkedArtifact) {
      await compileArtifact(linkedArtifact, ctx);

      const linkedTarget = ctx.targetTriple ?? linkedArtifact.target;
      if (linkedArtifact.kind === "static_library") {
        // For static libraries, pass the .a file directly as an extern source
        const libDir = getTargetOutputDir(projectDir, linkedTarget, "lib");
        const libFile = path.join(libDir, `lib${linkedName}.a`);
        if (fs.existsSync(libFile)) {
          artifact.cSources.push(libFile);
        }
      } else {
        // For shared libraries, use -L and -l flags
        const libDir = getTargetOutputDir(projectDir, linkedTarget, "lib");
        if (!artifact.libraryPaths.includes(libDir)) {
          artifact.libraryPaths.push(libDir);
        }
        artifact.linkLibraries.push(linkedName);
      }
    }
  }

  const sourcePath = path.resolve(projectDir, artifact.root);
  if (!fs.existsSync(sourcePath)) {
    console.error(`Error: Source file not found: ${sourcePath}`);
    process.exit(1);
  }

  // Determine output directory and path
  const isLibKind =
    artifact.kind === "static_library" || artifact.kind === "shared_library";
  const outputDir = getTargetOutputDir(
    projectDir,
    effectiveTarget,
    isLibKind ? "lib" : "bin"
  );
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // For static libraries, output is lib<name>.a; for others, just the name
  const outputName = getArtifactOutputFileName(
    artifact,
    ctx.targetTriple ?? artifact.target
  );
  const outputPath = path.join(outputDir, outputName);

  const projectName =
    ctx.registry.modules.length > 0
      ? ctx.registry.modules[0]!.name
      : artifact.name;
  const gitVersion = getGitVersion(projectDir);
  const versionSuffix = gitVersion ? ` ${gitVersion}` : "";
  console.log(
    `Building ${projectName}${versionSuffix} → ${path.relative(projectDir, outputPath)}${artifact.kind === "static_library" ? ".a" : ""}`
  );

  const absolutePath = `file://${fs.realpathSync(sourcePath)}`;

  // Reset global evaluator state before each artifact compilation
  // to avoid duplicate function definitions and impl conflicts
  clearAllGlobalImplState();
  clearEnvContainingPrelude();
  clearAllModuleCounters();
  clearAllCachedTypes();

  // Map build optimize level to compiler options
  const release =
    artifact.optimize !== "debug" && artifact.optimize !== "release-safe";
  const optimize = mapOptimize(artifact.optimize);

  const codeGenerator = new CodeGenerator();
  codeGenerator.compileModule(absolutePath, {
    output: outputPath,
    cCompiler,
    target: "c",
    targetTriple: ctx.targetTriple ?? artifact.target,
    sysroot: ctx.sysroot,
    extern: artifact.cSources,
    includePaths: artifact.includePaths,
    libraryPaths: artifact.libraryPaths,
    libraries: artifact.linkLibraries,
    defines: artifact.defines,
    release,
    optimize,
    allocator: artifact.allocator as "mimalloc" | "libc",
    sanitize:
      artifact.sanitize !== "none"
        ? (artifact.sanitize as "address" | "leak" | "thread")
        : undefined,
    strip: artifact.strip,
    static: artifact.staticLink,
    shared: artifact.kind === "shared_library",
    staticLibrary: artifact.kind === "static_library",
    cflags: artifact.cFlags.length > 0 ? artifact.cFlags.join(" ") : undefined,
    emccEnvironment: isTargetWasm(parsedTarget) ? "web" : undefined,
  });

  if (
    artifact.kind !== "static_library" &&
    (artifact.runtimeFiles?.length ?? 0) > 0
  ) {
    stageRuntimeFiles(artifact.runtimeFiles ?? [], outputDir, ctx.verbose);
  }
}

// ── Dependency artifact resolution ────────────────────────────────────

/**
 * Content-addressed cache for compiled dependency artifacts.
 * Key: `<content_hash>:<artifact_name>`, Value: lib file path + transitive sources.
 * Prevents rebuilding the same dependency artifact multiple times.
 */
interface CachedArtifact {
  libFile: string;
  transitiveSources: string[];
}
const compiledDepCache = new Map<string, CachedArtifact>();

/**
 * Compute a content-based identity hash for a dependency.
 * Same dependency identity (same path or same git URL+ref) → same hash → shared build.
 */
export function computeDependencyHash(
  registry: BuildRegistry,
  depName: string,
  projectDir: string
): string {
  const pathDep = registry.findPathDependency(depName);
  if (pathDep) {
    const absPath = path.resolve(projectDir, pathDep.path);
    return createHash("sha256")
      .update(`path:${absPath}`)
      .digest("hex")
      .slice(0, 12);
  }

  const gitDep = registry.findDependency(depName);
  if (gitDep) {
    return createHash("sha256")
      .update(`git:${gitDep.url}:${gitDep.ref}`)
      .digest("hex")
      .slice(0, 12);
  }

  // Fallback: hash the name itself
  return createHash("sha256")
    .update(`name:${depName}`)
    .digest("hex")
    .slice(0, 12);
}

/**
 * Resolve and compile transitive dependency artifacts.
 *
 * When a dependency's build.yo references sub-dependencies (via dep.artifact()),
 * this function resolves those sub-dep artifacts and links them into the
 * dependency's artifacts before the dependency itself is compiled.
 *
 * @param depRegistry - The evaluated registry of the dependency
 * @param depDir - Absolute path to the dependency's source directory
 * @param rootProjectDir - Root project directory (for yo-out/<target>/ output)
 * @param opts - Compilation options
 */
async function resolveTransitiveDependencyArtifacts(
  depRegistry: BuildRegistry,
  depDir: string,
  rootProjectDir: string,
  opts: {
    cCompiler: string;
    targetTriple?: string;
    sysroot?: string;
    verbose?: boolean;
  }
): Promise<void> {
  // Group refs by sub-dependency name
  const refsByDep = new Map<string, DependencyArtifactRef[]>();
  for (const ref of depRegistry.dependencyArtifacts) {
    const existing = refsByDep.get(ref.dependencyName);
    if (existing) {
      existing.push(ref);
    } else {
      refsByDep.set(ref.dependencyName, [ref]);
    }
  }

  for (const [subDepName, refs] of refsByDep) {
    // Find the sub-dependency's source directory
    // For path deps: resolve relative to the dependency's directory
    // For git deps: resolve via root project's yo.lock (transitive deps are there)
    let subDepDir: string | undefined;

    const pathDep = depRegistry.findPathDependency(subDepName);
    if (pathDep) {
      subDepDir = path.resolve(depDir, pathDep.path);
    } else {
      // Git dependency: should be in root yo.lock via fetchTransitiveDependencies
      subDepDir = resolveDependencyPathOrExit(rootProjectDir, subDepName);
    }

    if (!subDepDir) {
      console.error(
        `Error: Cannot resolve transitive dependency "${subDepName}" ` +
          `(required by dependency in ${depDir}). Run 'yo fetch'.`
      );
      process.exit(1);
    }

    const subBuildFile = path.join(subDepDir, "build.yo");
    if (!fs.existsSync(subBuildFile)) {
      console.error(
        `Error: Transitive dependency "${subDepName}" has no build.yo at ${subBuildFile}.`
      );
      process.exit(1);
    }

    // Compute hash for the sub-dependency
    const subDepHash = computeDependencyHash(depRegistry, subDepName, depDir);

    // Check cache first
    const allCached = refs.every((ref) =>
      compiledDepCache.has(`${subDepHash}:${ref.artifactName}`)
    );

    let subRegistry: BuildRegistry | undefined;
    if (!allCached) {
      if (opts.verbose) {
        console.log(`    Evaluating transitive dep: ${subDepName}/build.yo...`);
      }
      subRegistry = evaluateDependencyBuildFile(subBuildFile);

      // Recurse further if sub-dep has its own sub-deps
      if (subRegistry.dependencyArtifacts.length > 0) {
        await resolveTransitiveDependencyArtifacts(
          subRegistry,
          subDepDir,
          rootProjectDir,
          opts
        );
      }
    }

    // Compile each requested artifact from the sub-dependency
    for (const ref of refs) {
      const cacheKey = `${subDepHash}:${ref.artifactName}`;
      const cached = compiledDepCache.get(cacheKey);

      if (cached) {
        if (opts.verbose) {
          console.log(
            `    Reusing cached transitive artifact: ${subDepName}/${ref.artifactName}`
          );
        }
        // Link into parent dep's artifacts (lib file + transitive sources)
        for (const depArtifact of depRegistry.artifacts) {
          if (depArtifact.linkedArtifacts.includes(ref.artifactName)) {
            if (!depArtifact.cSources.includes(cached.libFile)) {
              depArtifact.cSources.push(cached.libFile);
            }
            for (const src of cached.transitiveSources) {
              if (!depArtifact.cSources.includes(src)) {
                depArtifact.cSources.push(src);
              }
            }
          }
        }
        continue;
      }

      const subArtifact = subRegistry!.findArtifact(ref.artifactName);
      if (!subArtifact) {
        console.error(
          `Error: Artifact "${ref.artifactName}" not found in transitive dependency "${subDepName}". ` +
            `Available: ${subRegistry!.artifacts.map((a) => a.name).join(", ") || "(none)"}`
        );
        process.exit(1);
      }

      const adjustedArtifact: BuildArtifact = {
        ...subArtifact,
        root: path.resolve(subDepDir, subArtifact.root),
      };

      // Output to root project's yo-out/<target>/deps/<sub_dep>/lib/
      const subDepTarget = opts.targetTriple ?? adjustedArtifact.target;
      const subOutputDir = path.join(
        getTargetOutputDir(rootProjectDir, subDepTarget, "deps"),
        subDepName,
        "lib"
      );
      if (!fs.existsSync(subOutputDir)) {
        fs.mkdirSync(subOutputDir, { recursive: true });
      }

      if (opts.verbose) {
        console.log(
          `    Compiling transitive artifact: ${subDepName}/${ref.artifactName}`
        );
      }

      await compileDependencyArtifact(
        adjustedArtifact,
        subOutputDir,
        subDepDir,
        opts
      );

      if (adjustedArtifact.kind === "static_library") {
        const libFile = path.join(subOutputDir, `lib${ref.artifactName}.a`);
        // Collect transitive .a files from the sub-artifact
        const transitiveSources = adjustedArtifact.cSources.filter((s) =>
          s.endsWith(".a")
        );
        compiledDepCache.set(cacheKey, { libFile, transitiveSources });
        // Link into parent dep's artifacts that reference this sub-dep artifact
        for (const depArtifact of depRegistry.artifacts) {
          if (depArtifact.linkedArtifacts.includes(ref.artifactName)) {
            if (!depArtifact.cSources.includes(libFile)) {
              depArtifact.cSources.push(libFile);
            }
            for (const src of transitiveSources) {
              if (!depArtifact.cSources.includes(src)) {
                depArtifact.cSources.push(src);
              }
            }
          }
        }
      }
    }
  }
}

/**
 * Resolve and compile dependency artifacts.
 *
 * For each DependencyArtifactRef (from dep.artifact("name") calls in build.yo):
 * 1. Find the dependency's source directory (path dep or git cache)
 * 2. Evaluate the dependency's build.yo in isolation
 * 3. Find the requested artifact in the dependency's registry
 * 4. Compile it (into the root project's yo-out/<target>/deps/<dep>/ directory)
 * 5. Register it in the root registry so the consumer can link it
 */
async function resolveDependencyArtifacts(
  rootRegistry: BuildRegistry,
  projectDir: string,
  opts: {
    cCompiler: string;
    targetTriple?: string;
    sysroot?: string;
    verbose?: boolean;
  }
): Promise<void> {
  // Group refs by dependency name to evaluate each build.yo only once
  const refsByDep = new Map<string, DependencyArtifactRef[]>();
  for (const ref of rootRegistry.dependencyArtifacts) {
    const existing = refsByDep.get(ref.dependencyName);
    if (existing) {
      existing.push(ref);
    } else {
      refsByDep.set(ref.dependencyName, [ref]);
    }
  }

  for (const [depName, refs] of refsByDep) {
    // Compute content hash for deduplication
    const depHash = computeDependencyHash(rootRegistry, depName, projectDir);

    // 1. Find dependency source directory
    const depDir = findDependencyDir(rootRegistry, projectDir, depName);
    if (!depDir) {
      console.error(
        `Error: Cannot resolve dependency "${depName}". ` +
          `Ensure it is declared via build.dependency() or build.path_dependency() and run 'yo fetch' if needed.`
      );
      process.exit(1);
    }

    // 2. Check for build.yo in the dependency
    const depBuildFile = path.join(depDir, "build.yo");
    if (!fs.existsSync(depBuildFile)) {
      console.error(
        `Error: Dependency "${depName}" has no build.yo at ${depBuildFile}. ` +
          `Cannot resolve artifact references.`
      );
      process.exit(1);
    }

    // Check if ALL requested artifacts for this dep are already cached
    const allCached = refs.every((ref) =>
      compiledDepCache.has(`${depHash}:${ref.artifactName}`)
    );

    let depRegistry: BuildRegistry | undefined;
    if (!allCached) {
      if (opts.verbose) {
        console.log(`Evaluating build.yo for dependency "${depName}"...`);
      }
      // 3. Evaluate the dependency's build.yo in isolation
      depRegistry = evaluateDependencyBuildFile(depBuildFile);

      // Recursively resolve sub-dependencies (transitive)
      // If this dep has its own dependencyArtifacts, compile those first
      if (depRegistry.dependencyArtifacts.length > 0) {
        if (opts.verbose) {
          console.log(`  Resolving transitive deps for "${depName}"...`);
        }
        await resolveTransitiveDependencyArtifacts(
          depRegistry,
          depDir,
          projectDir,
          opts
        );
      }
    }

    // 4. For each requested artifact, compile it (or reuse cached) and register in root
    for (const ref of refs) {
      const cacheKey = `${depHash}:${ref.artifactName}`;

      // Check content-addressed cache
      const cached = compiledDepCache.get(cacheKey);
      if (cached) {
        if (opts.verbose) {
          console.log(
            `  Reusing cached artifact: ${depName}/${ref.artifactName} (${depHash})`
          );
        }
        // Reuse the cached .a file + transitive sources for all root artifacts
        for (const rootArtifact of rootRegistry.artifacts) {
          if (rootArtifact.linkedArtifacts.includes(ref.artifactName)) {
            if (!rootArtifact.cSources.includes(cached.libFile)) {
              rootArtifact.cSources.push(cached.libFile);
            }
            for (const src of cached.transitiveSources) {
              if (!rootArtifact.cSources.includes(src)) {
                rootArtifact.cSources.push(src);
              }
            }
          }
        }
        continue;
      }

      const depArtifact = depRegistry!.findArtifact(ref.artifactName);
      if (!depArtifact) {
        console.error(
          `Error: Artifact "${ref.artifactName}" not found in dependency "${depName}". ` +
            `Available artifacts: ${depRegistry!.artifacts.map((a) => a.name).join(", ") || "(none)"}`
        );
        process.exit(1);
      }

      // Adjust the artifact's root to be absolute (relative to dep directory)
      const adjustedArtifact: BuildArtifact = {
        ...depArtifact,
        root: path.resolve(depDir, depArtifact.root),
      };

      // Output directory: yo-out/<target>/deps/<dep_name>/lib/ in the root project
      const depTarget = opts.targetTriple ?? adjustedArtifact.target;
      const depOutputDir = path.join(
        getTargetOutputDir(projectDir, depTarget, "deps"),
        depName,
        "lib"
      );
      if (!fs.existsSync(depOutputDir)) {
        fs.mkdirSync(depOutputDir, { recursive: true });
      }

      if (opts.verbose) {
        console.log(
          `  Compiling dependency artifact: ${depName}/${ref.artifactName} (${adjustedArtifact.kind})`
        );
      }

      // 5. Compile the dependency artifact
      await compileDependencyArtifact(
        adjustedArtifact,
        depOutputDir,
        depDir,
        opts
      );

      // 6. Register in cache and root registry
      if (adjustedArtifact.kind === "static_library") {
        const libFile = path.join(depOutputDir, `lib${ref.artifactName}.a`);
        // Collect transitive .a files from the dep artifact's cSources
        const transitiveSources = adjustedArtifact.cSources.filter((s) =>
          s.endsWith(".a")
        );
        // Cache the compiled artifact by content hash
        compiledDepCache.set(cacheKey, { libFile, transitiveSources });
        // For any root artifact that links this dependency artifact,
        // add the .a file + transitive sources as extern sources
        for (const rootArtifact of rootRegistry.artifacts) {
          if (rootArtifact.linkedArtifacts.includes(ref.artifactName)) {
            if (!rootArtifact.cSources.includes(libFile)) {
              rootArtifact.cSources.push(libFile);
            }
            for (const src of transitiveSources) {
              if (!rootArtifact.cSources.includes(src)) {
                rootArtifact.cSources.push(src);
              }
            }
          }
        }
      }
    }
  }
}

/**
 * Get the current git version tag for the project directory.
 * Returns the tag if HEAD is at a tag (e.g., "v1.0.0"), or
 * a short describe string (e.g., "v1.0.0-3-gabcdef"), or undefined.
 */
function getGitVersion(projectDir: string): string | undefined {
  try {
    const result = execSync("git describe --tags --always", {
      cwd: projectDir,
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return result || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Find the local directory for a dependency (path dep or git cache).
 */
function findDependencyDir(
  registry: BuildRegistry,
  projectDir: string,
  depName: string
): string | undefined {
  // Check path dependencies first
  const pathDep = registry.findPathDependency(depName);
  if (pathDep) {
    const resolved = path.resolve(projectDir, pathDep.path);
    if (fs.existsSync(resolved)) return resolved;
  }

  // Check git dependencies via yo.lock cache
  return resolveDependencyPathOrExit(projectDir, depName);
}

/**
 * Evaluate a dependency's build.yo in isolation.
 * Swaps the global registry so the dependency's builtins populate a fresh one,
 * then restores the root registry afterwards.
 */
function evaluateDependencyBuildFile(buildFile: string): BuildRegistry {
  // Swap in a fresh registry for the dependency
  const rootRegistry = swapBuildRegistry(new BuildRegistry());

  const modulePath = `file://${fs.realpathSync(buildFile)}`;

  try {
    const moduleManager = new ModuleManager();
    moduleManager.loadModule(modulePath);
    moduleManager.resetAllState();
  } catch (error) {
    // Restore root registry before exiting
    swapBuildRegistry(rootRegistry);
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error evaluating dependency ${buildFile}:\n${message}`);
    process.exit(1);
  }

  // Capture the dependency's populated registry
  const depRegistry = getBuildRegistry();

  // Restore the root project's registry
  swapBuildRegistry(rootRegistry);

  return depRegistry;
}

/**
 * Recursively discover and fetch transitive git dependencies.
 *
 * After the root dependencies are fetched, this function evaluates each
 * dependency's build.yo to discover its own git dependencies. Any newly
 * discovered deps are fetched and added to the root yo.lock, then the
 * process repeats until no new dependencies are found.
 *
 * Uses BFS with a visited set to avoid cycles and redundant evaluation.
 */
function fetchTransitiveDependencies(
  projectDir: string,
  rootDeps: BuildGitDependency[],
  verbose: boolean = false
): void {
  const visited = new Set<string>();
  // Mark root deps as visited
  for (const dep of rootDeps) {
    visited.add(dep.name);
  }

  // Queue: deps to check for transitive dependencies
  const queue: BuildGitDependency[] = [...rootDeps];

  while (queue.length > 0) {
    const dep = queue.shift()!;

    // Find the cached directory for this dependency
    const depDir = resolveDependencyPathOrExit(projectDir, dep.name);
    if (!depDir) continue;

    // Check if it has a build.yo
    const depBuildFile = path.join(depDir, "build.yo");
    if (!fs.existsSync(depBuildFile)) continue;

    // Evaluate the dependency's build.yo to discover its dependencies
    let depRegistry: BuildRegistry;
    try {
      depRegistry = evaluateDependencyBuildFile(depBuildFile);
    } catch {
      // If evaluation fails, skip transitive discovery for this dep
      if (verbose) {
        console.log(
          `  Warning: Could not evaluate ${dep.name}/build.yo for transitive deps`
        );
      }
      continue;
    }

    // Collect newly-discovered git dependencies
    const newDeps: BuildGitDependency[] = [];
    for (const transitiveDep of depRegistry.dependencies) {
      if (!visited.has(transitiveDep.name)) {
        visited.add(transitiveDep.name);
        newDeps.push(transitiveDep);
      }
    }

    if (newDeps.length > 0) {
      if (verbose) {
        console.log(
          `  Found ${newDeps.length} transitive dep(s) from ${dep.name}: ${newDeps.map((d) => d.name).join(", ")}`
        );
      }
      // Fetch the transitive deps (updates yo.lock)
      fetchAllDependencies(projectDir, newDeps, verbose);
      // Add to queue for further transitive discovery
      queue.push(...newDeps);
    }
  }
}

// ── Imported module resolution ────────────────────────────────────────

/** Cache of evaluated dependency registries for module resolution */
const evaluatedDepRegistries = new Map<string, BuildRegistry>();

/**
 * Resolve imported modules for all artifacts.
 *
 * For each artifact's importedModules:
 * 1. Find the dependency directory
 * 2. Evaluate the dependency's build.yo
 * 3. Find the requested module (or default to sole module)
 * 4. Collect system library requirements from the module
 * 5. Resolve those system libraries via pkg-config/vcpkg
 * 6. Merge flags into the consumer artifact
 * 7. Store the resolved root file path for import resolution
 */
function resolveImportedModules(
  registry: BuildRegistry,
  projectDir: string,
  verbose: boolean = false
): void {
  for (const artifact of registry.artifacts) {
    if (artifact.importedModules.length === 0) continue;

    for (const imported of artifact.importedModules) {
      resolveImportedModule(registry, artifact, imported, projectDir, verbose);

      // Register the resolved root in the global module import map
      // so that `import "name"` in Yo source resolves to the correct file
      if (imported.resolvedRoot) {
        setModuleImportRoot(imported.importName, imported.resolvedRoot);
      }
    }
  }
}

function resolveImportedModule(
  registry: BuildRegistry,
  artifact: BuildArtifact,
  imported: ImportedModule,
  projectDir: string,
  verbose: boolean
): void {
  const depName = imported.dependencyName;
  if (!depName) {
    // Local module — just resolve root relative to project
    const localModule = registry.findModule(imported.moduleName);
    if (localModule) {
      imported.resolvedRoot = path.resolve(projectDir, localModule.root);
      // Propagate system libraries from local module
      if (localModule.linkedSystemLibraries.length > 0) {
        propagateSystemLibraries(
          registry,
          artifact,
          localModule.linkedSystemLibraries,
          verbose
        );
        imported.propagatedSystemLibraries = [
          ...localModule.linkedSystemLibraries,
        ];
      }
    } else {
      const available =
        registry.modules.map((m) => m.name).join(", ") || "(none)";
      console.error(
        `Error: Local module "${imported.moduleName}" not found. ` +
          `Available modules: ${available}`
      );
      process.exit(1);
    }
    return;
  }

  // Find the dependency directory
  const depDir = findDependencyDir(registry, projectDir, depName);
  if (!depDir) {
    console.error(
      `Error: Cannot resolve dependency "${depName}" for module import "${imported.importName}". ` +
        `Run 'yo fetch' to download dependencies.`
    );
    process.exit(1);
  }

  // Evaluate the dependency's build.yo (cached)
  const depRegistry = getOrEvaluateDepRegistry(depDir);
  if (!depRegistry) {
    console.error(
      `Error: Dependency "${depName}" has no build.yo at ${path.join(depDir, "build.yo")}.`
    );
    process.exit(1);
  }

  // Find the requested module
  let depModule: BuildModuleEntry | undefined;
  if (imported.moduleName === "") {
    // Default: sole module
    if (depRegistry.modules.length === 0) {
      console.error(
        `Error: Dependency "${depName}" has no modules defined. ` +
          `Add build.module() to its build.yo.`
      );
      process.exit(1);
    } else if (depRegistry.modules.length === 1) {
      depModule = depRegistry.modules[0]!;
    } else {
      console.error(
        `Error: Dependency "${depName}" has ${depRegistry.modules.length} modules. ` +
          `Specify a module name: dep.module("name").`
      );
      process.exit(1);
    }
  } else {
    depModule = depRegistry.findModule(imported.moduleName);
    if (!depModule) {
      const available =
        depRegistry.modules.map((m) => m.name).join(", ") || "(none)";
      console.error(
        `Error: Module "${imported.moduleName}" not found in dependency "${depName}". ` +
          `Available modules: ${available}`
      );
      process.exit(1);
    }
  }

  // Resolve the module's root file
  imported.resolvedRoot = path.resolve(depDir, depModule.root);

  if (verbose) {
    console.log(
      `  Module import "${imported.importName}": ${depModule.name} → ${imported.resolvedRoot}`
    );
  }

  // Propagate system libraries from the module.
  // For WASM targets, skip host-platform pkg-config/vcpkg resolution but
  // still add -l<name> so the emscripten linker finds them in its sysroot.
  if (depModule.linkedSystemLibraries.length > 0) {
    imported.propagatedSystemLibraries = [...depModule.linkedSystemLibraries];

    if (isTargetWasm(parseTarget(artifact.target))) {
      // WASM: just add -l<name> for each linked system library
      for (const name of depModule.linkedSystemLibraries) {
        if (!artifact.linkLibraries.includes(name)) {
          artifact.linkLibraries.push(name);
        }
      }
    } else {
      // Native: resolve via pkg-config/vcpkg for full paths and flags
      const sysLibs = depModule.linkedSystemLibraries
        .map((name) => depRegistry.findSystemLibrary(name))
        .filter((lib): lib is NonNullable<typeof lib> => lib != null);

      if (sysLibs.length > 0) {
        if (verbose) {
          console.log(
            `  Propagating system libraries from module "${depModule.name}": ${sysLibs.map((l) => l.name).join(", ")}`
          );
        }

        const sysLibFlags = resolveAllSystemLibraries(sysLibs, verbose, {
          preferDebugRuntime: artifact.optimize === "debug",
        });

        artifact.includePaths.push(...sysLibFlags.includePaths);
        artifact.libraryPaths.push(...sysLibFlags.libraryPaths);
        artifact.linkLibraries.push(...sysLibFlags.linkLibraries);
        artifact.defines.push(...sysLibFlags.defines);
        artifact.cFlags.push(...sysLibFlags.cFlags);
        artifact.runtimeFiles ??= [];
        for (const runtimeFile of sysLibFlags.runtimeFiles) {
          if (!artifact.runtimeFiles.includes(runtimeFile)) {
            artifact.runtimeFiles.push(runtimeFile);
          }
        }
      }
    }
  }
}

/**
 * Propagate system libraries from a local module to an artifact.
 */
function propagateSystemLibraries(
  registry: BuildRegistry,
  artifact: BuildArtifact,
  sysLibNames: string[],
  verbose: boolean
): void {
  // For WASM targets, skip host-platform pkg-config/vcpkg resolution but
  // still add -l<name> so the emscripten linker finds them in its sysroot.
  if (isTargetWasm(parseTarget(artifact.target))) {
    for (const name of sysLibNames) {
      if (!artifact.linkLibraries.includes(name)) {
        artifact.linkLibraries.push(name);
      }
    }
    return;
  }

  const sysLibs = sysLibNames
    .map((name) => registry.findSystemLibrary(name))
    .filter((lib): lib is NonNullable<typeof lib> => lib != null);

  if (sysLibs.length === 0) return;

  const sysLibFlags = resolveAllSystemLibraries(sysLibs, verbose, {
    preferDebugRuntime: artifact.optimize === "debug",
  });

  artifact.includePaths.push(...sysLibFlags.includePaths);
  artifact.libraryPaths.push(...sysLibFlags.libraryPaths);
  artifact.linkLibraries.push(...sysLibFlags.linkLibraries);
  artifact.defines.push(...sysLibFlags.defines);
  artifact.cFlags.push(...sysLibFlags.cFlags);
  artifact.runtimeFiles ??= [];
  for (const runtimeFile of sysLibFlags.runtimeFiles) {
    if (!artifact.runtimeFiles.includes(runtimeFile)) {
      artifact.runtimeFiles.push(runtimeFile);
    }
  }
}

/**
 * Get or evaluate a dependency's build.yo registry (with caching).
 */
function getOrEvaluateDepRegistry(depDir: string): BuildRegistry | undefined {
  const cached = evaluatedDepRegistries.get(depDir);
  if (cached) return cached;

  const depBuildFile = path.join(depDir, "build.yo");
  if (!fs.existsSync(depBuildFile)) return undefined;

  const depRegistry = evaluateDependencyBuildFile(depBuildFile);
  evaluatedDepRegistries.set(depDir, depRegistry);
  return depRegistry;
}

/**
 * Compile a dependency artifact (static library, shared library, etc.).
 */
async function compileDependencyArtifact(
  artifact: BuildArtifact,
  outputDir: string,
  depDir: string,
  opts: {
    cCompiler: string;
    targetTriple?: string;
    sysroot?: string;
    verbose?: boolean;
  }
): Promise<void> {
  // Auto-select emcc for WASM targets
  const effectiveTarget = opts.targetTriple ?? artifact.target;
  const parsedTarget = parseTarget(effectiveTarget);
  const cCompiler =
    isTargetWasm(parsedTarget) && opts.cCompiler !== "emcc"
      ? "emcc"
      : opts.cCompiler;

  const sourcePath = artifact.root; // Already absolute
  if (!fs.existsSync(sourcePath)) {
    console.error(`Error: Dependency source file not found: ${sourcePath}`);
    process.exit(1);
  }

  const outputName = getArtifactOutputFileName(
    artifact,
    opts.targetTriple ?? artifact.target
  );
  const outputPath = path.join(outputDir, outputName);

  console.log(
    `Building dependency artifact: ${artifact.name} → ${path.relative(process.cwd(), outputPath)}${artifact.kind === "static_library" ? ".a" : ""}`
  );

  const absolutePath = `file://${fs.realpathSync(sourcePath)}`;

  // Reset global evaluator state for clean compilation
  clearAllGlobalImplState();
  clearEnvContainingPrelude();
  clearAllModuleCounters();
  clearAllCachedTypes();

  const release =
    artifact.optimize !== "debug" && artifact.optimize !== "release-safe";
  const optimize = mapOptimize(artifact.optimize);

  const codeGenerator = new CodeGenerator();
  codeGenerator.compileModule(absolutePath, {
    output: outputPath,
    cCompiler,
    target: "c",
    targetTriple: opts.targetTriple ?? artifact.target,
    sysroot: opts.sysroot,
    extern: artifact.cSources,
    includePaths: artifact.includePaths,
    libraryPaths: artifact.libraryPaths,
    libraries: artifact.linkLibraries,
    defines: artifact.defines,
    release,
    optimize,
    allocator: artifact.allocator as "mimalloc" | "libc",
    sanitize:
      artifact.sanitize !== "none"
        ? (artifact.sanitize as "address" | "leak" | "thread")
        : undefined,
    strip: artifact.strip,
    static: artifact.staticLink,
    shared: artifact.kind === "shared_library",
    staticLibrary: artifact.kind === "static_library",
    cflags: artifact.cFlags.length > 0 ? artifact.cFlags.join(" ") : undefined,
    emccEnvironment: isTargetWasm(parsedTarget) ? "web" : undefined,
  });

  if (
    artifact.kind !== "static_library" &&
    (artifact.runtimeFiles?.length ?? 0) > 0
  ) {
    stageRuntimeFiles(artifact.runtimeFiles ?? [], outputDir, opts.verbose);
  }
}

function mapOptimize(level: string): "0" | "1" | "2" | "3" | undefined {
  switch (level) {
    case "debug":
      return undefined;
    case "release-safe":
      return "2";
    case "release-fast":
      return "3";
    case "release-small":
      return "2"; // Use -O2 for small builds (codegen handles -Os via release flag)
    default:
      return undefined;
  }
}

// ── Run executable ────────────────────────────────────────────────────

async function runExecutable(
  artifact: BuildArtifact,
  args: string[],
  ctx: ExecutionContext
): Promise<void> {
  const { projectDir } = ctx;

  const effectiveTarget = ctx.targetTriple ?? artifact.target;
  const outputDir = getTargetOutputDir(projectDir, effectiveTarget, "bin");
  const exePath = path.join(
    outputDir,
    getArtifactOutputFileName(artifact, ctx.targetTriple ?? artifact.target)
  );

  if (!fs.existsSync(exePath)) {
    console.error(`Error: Compiled executable not found at ${exePath}`);
    process.exit(1);
  }

  // WASM executables — run with node using the .js file
  const parsedTarget = parseTarget(effectiveTarget);
  const isWasm = isTargetWasm(parsedTarget);

  const { spawnSync } = await import("child_process");
  let result;
  if (isWasm) {
    // emcc may output .html (which also generates .js + .wasm) or .js directly.
    // Node always runs the .js file.
    const jsPath = exePath.replace(/\.html$/, ".js");
    result = spawnSync("node", [jsPath, ...args], {
      stdio: "inherit",
      cwd: projectDir,
    });
  } else {
    result = spawnSync(exePath, args, {
      stdio: "inherit",
      cwd: projectDir,
    });
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

// ── Test suite execution ──────────────────────────────────────────────

async function runTestSuite(
  testSuite: BuildTestSuite,
  ctx: ExecutionContext
): Promise<void> {
  const { projectDir, cCompiler } = ctx;

  const { findTestFiles, runTests } = await import("./test-runner");
  const testPath = path.resolve(projectDir, testSuite.root);
  const testFiles = findTestFiles(testPath);

  if (testFiles.length === 0) {
    console.log(`No test files found in ${testSuite.root}`);
    return;
  }

  const summary = await runTests(testFiles, {
    cCompiler,
    verbose: testSuite.verbose || (ctx.verbose ?? false),
    bail: testSuite.bail,
    parallel: testSuite.parallel,
    keepGeneratedFiles: false,
    profile: false,
  });

  if (summary.failed > 0) {
    process.exit(1);
  }
}

// ── Documentation generation ──────────────────────────────────────────

async function runDocGeneration(
  docConfig: BuildDocConfig,
  ctx: ExecutionContext
): Promise<void> {
  const { projectDir } = ctx;

  console.log(`Generating documentation: ${docConfig.name}`);

  const { runDoc } = await import("./doc-command");
  const rootPath = path.resolve(projectDir, docConfig.root);
  const outputPath = path.resolve(projectDir, docConfig.outputDir);

  const format = (docConfig.format || "html") as "html" | "markdown" | "json";

  await runDoc({
    input: rootPath,
    outputDir: outputPath,
    includePrivate: docConfig.includePrivate,
    verbose: ctx.verbose ?? false,
    title: docConfig.title || undefined,
    format,
    version: docConfig.version || undefined,
  });
}
