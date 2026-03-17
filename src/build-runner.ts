/**
 * `yo build` — build system runner.
 *
 * Evaluates `build.yo` using the Yo evaluator at compile time.
 * Build functions (build.project, build.executable, etc.) are backed by
 * evaluator builtins that register artifacts in a global BuildRegistry.
 * After evaluation, the build runner reads the registry and orchestrates
 * compilation for each artifact.
 */

import * as fs from "fs";
import * as path from "path";
import { CodeGenerator } from "./codegen";
import { findAvailableCompiler } from "./compiler-utils";
import { clearEnvContainingPrelude } from "./env";
import {
  type BuildArtifact,
  type BuildRegistry,
  type BuildTestSuite,
  clearBuildRegistry,
  getBuildRegistry,
} from "./evaluator/builtins/build";
import { clearAllGlobalImplState } from "./evaluator/values/impl";
import { fetchAllDependencies, areDependenciesCached } from "./fetch";
import { ModuleManager } from "./module-manager";
import { clearAllModuleCounters } from "./utils";
import { clearAllCachedTypes } from "./types/creators";
import { resolveAllSystemLibraries } from "./pkg-config";

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

  // Auto-fetch git dependencies if not cached
  if (registry.dependencies.length > 0) {
    if (!areDependenciesCached(projectDir, registry.dependencies)) {
      if (options.verbose) {
        console.log("Dependencies not cached — fetching...");
      }
      fetchAllDependencies(projectDir, registry.dependencies, options.verbose);
    } else if (options.verbose) {
      console.log("All dependencies cached.");
    }
  }

  // Resolve system libraries per-artifact via pkg-config
  // Each artifact only gets flags for system libraries explicitly linked to it
  if (registry.systemLibraries.length > 0) {
    for (const artifact of registry.artifacts) {
      if (artifact.linkedSystemLibraries.length === 0) continue;
      const linkedLibs = registry.systemLibraries.filter((lib) =>
        artifact.linkedSystemLibraries.includes(lib.name)
      );
      if (linkedLibs.length === 0) continue;
      const sysLibFlags = resolveAllSystemLibraries(
        linkedLibs,
        options.verbose
      );
      artifact.includePaths.push(...sysLibFlags.includePaths);
      artifact.libraryPaths.push(...sysLibFlags.libraryPaths);
      artifact.linkLibraries.push(...sysLibFlags.linkLibraries);
      artifact.cFlags.push(...sysLibFlags.cFlags);
    }
  }

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
}

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

  // Resolve all dependencies for this step
  const deps = registry.resolveDependencies(step);

  // Compile all artifacts
  for (const artifact of deps.artifacts) {
    await compileArtifact(artifact, ctx);
  }

  // Run tests
  for (const testSuite of deps.tests) {
    await runTestSuite(testSuite, ctx);
  }

  // Run executables (only when an explicit run step is in deps)
  for (const runStep of deps.runs) {
    const artifact = registry.findArtifact(runStep.artifactName);
    if (artifact) {
      await runExecutable(artifact, runStep.args, ctx);
    }
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

  const { projectDir, cCompiler, registry } = ctx;

  // Compile linked library artifacts first
  for (const linkedName of artifact.linkedArtifacts) {
    const linkedArtifact = registry.findArtifact(linkedName);
    if (linkedArtifact) {
      await compileArtifact(linkedArtifact, ctx);

      if (linkedArtifact.kind === "static_library") {
        // For static libraries, pass the .a file directly as an extern source
        const libDir = path.join(projectDir, "yo-out", "lib");
        const libFile = path.join(libDir, `lib${linkedName}.a`);
        if (fs.existsSync(libFile)) {
          artifact.cSources.push(libFile);
        }
      } else {
        // For shared libraries, use -L and -l flags
        const libDir = path.join(projectDir, "yo-out", "lib");
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
  const outputSubdir = isLibKind ? "yo-out/lib" : "yo-out/bin";
  const outputDir = path.join(projectDir, outputSubdir);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // For static libraries, output is lib<name>.a; for others, just the name
  const outputName =
    artifact.kind === "static_library" ? `lib${artifact.name}` : artifact.name;
  const outputPath = path.join(outputDir, outputName);

  const projectName = ctx.registry.project?.name ?? artifact.name;
  const version = ctx.registry.project?.version ?? "0.0.0";
  console.log(
    `Building ${projectName} v${version} → ${path.relative(projectDir, outputPath)}${artifact.kind === "static_library" ? ".a" : ""}`
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
        ? (artifact.sanitize as "address" | "leak")
        : undefined,
    strip: artifact.strip,
    static: artifact.staticLink,
    shared: artifact.kind === "shared_library",
    staticLibrary: artifact.kind === "static_library",
  });
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

  const outputDir = path.join(projectDir, "yo-out", "bin");
  const exePath = path.join(outputDir, artifact.name);

  if (!fs.existsSync(exePath)) {
    console.error(`Error: Compiled executable not found at ${exePath}`);
    process.exit(1);
  }

  const { spawnSync } = await import("child_process");
  const result = spawnSync(exePath, args, {
    stdio: "inherit",
    cwd: projectDir,
  });
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
