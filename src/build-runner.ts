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
import {
  type BuildArtifact,
  type BuildRegistry,
  type BuildTestSuite,
  clearBuildRegistry,
  getBuildRegistry,
} from "./evaluator/builtins/build";
import { ModuleManager } from "./module-manager";

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

  // Evaluate build.yo — builtins populate the global BuildRegistry
  const registry = evaluateBuildFile(buildFile);

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
      verbose: options.verbose,
    });
  }
}

// ── Build file evaluation ─────────────────────────────────────────────

function evaluateBuildFile(buildFile: string): BuildRegistry {
  // Clear any previous build registry
  clearBuildRegistry();

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

async function compileArtifact(
  artifact: BuildArtifact,
  ctx: ExecutionContext
): Promise<void> {
  const { projectDir, cCompiler } = ctx;

  const sourcePath = path.resolve(projectDir, artifact.root);
  if (!fs.existsSync(sourcePath)) {
    console.error(`Error: Source file not found: ${sourcePath}`);
    process.exit(1);
  }

  // Determine output directory and path
  const outputSubdir =
    artifact.kind === "executable" ? "yo-out/bin" : "yo-out/lib";
  const outputDir = path.join(projectDir, outputSubdir);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const outputPath = path.join(outputDir, artifact.name);

  const projectName = ctx.registry.project?.name ?? artifact.name;
  const version = ctx.registry.project?.version ?? "0.0.0";
  console.log(
    `Building ${projectName} v${version} → ${path.relative(projectDir, outputPath)}`
  );

  const absolutePath = `file://${fs.realpathSync(sourcePath)}`;

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
