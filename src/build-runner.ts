/**
 * `yo build` — build system runner.
 *
 * Evaluates `build.yo` at compile time to extract project configuration,
 * then orchestrates compilation for each artifact.
 *
 * This is the initial implementation — it reads `build.yo` as a standard
 * Yo module and extracts exported declarations. The full declarative build
 * API (build.project, build.executable, etc.) will be implemented as
 * evaluator builtins in a later phase. For now, `yo build` delegates to
 * `yo compile` using the information it can extract.
 */

import * as fs from "fs";
import * as path from "path";
import { CodeGenerator } from "./codegen";
import { findAvailableCompiler } from "./compiler-utils";

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
 * Currently this is a simplified implementation that:
 * 1. Verifies build.yo exists
 * 2. Reports available steps if --list-steps
 * 3. For the "run" step, compiles and runs the main source
 * 4. For the "test" step, delegates to the test runner
 *
 * The full implementation will evaluate build.yo at compile time
 * and extract structured build configuration.
 */
export async function runBuild(options: BuildOptions): Promise<void> {
  // Resolve build file relative to the user's original working directory,
  // since the yo-cli wrapper may cd to the repo root.
  const userCwd = process.env.YO_ORIGINAL_CWD ?? process.cwd();
  const buildFile = path.resolve(userCwd, options.buildFile);

  if (!fs.existsSync(buildFile)) {
    console.error(
      `Error: Build file not found: ${buildFile}\n` +
        `Run 'yo init' to create a new project with a build.yo file.`
    );
    process.exit(1);
  }

  // Read build.yo to extract basic configuration
  const buildContent = fs.readFileSync(buildFile, "utf-8");
  const config = parseBuildConfig(buildContent);

  if (options.listSteps) {
    printSteps(config);
    return;
  }

  // Determine which steps to run
  const steps =
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

  for (const stepName of steps) {
    if (options.dryRun) {
      console.log(`[dry-run] Would execute step: ${stepName}`);
      continue;
    }

    await executeStep(stepName, {
      config,
      projectDir,
      cCompiler,
      targetTriple: options.targetTriple,
      verbose: options.verbose,
    });
  }
}

// ── Build configuration extraction ────────────────────────────────────

interface BuildConfig {
  projectName: string;
  version: string;
  mainRoot?: string;
  executableName?: string;
  testRoot?: string;
  steps: StepInfo[];
}

interface StepInfo {
  name: string;
  description: string;
}

/**
 * Parse build.yo to extract basic configuration.
 *
 * This is a lightweight regex-based parser that extracts key values
 * from the build.yo file. The full implementation will use the Yo
 * evaluator to process build.yo at compile time.
 */
function parseBuildConfig(content: string): BuildConfig {
  const config: BuildConfig = {
    projectName: "app",
    version: "0.1.0",
    steps: [{ name: "install", description: "Install build artifacts" }],
  };

  // Extract project name
  const nameMatch = content.match(/build\.project\(\s*name:\s*"([^"]+)"/);
  if (nameMatch) {
    config.projectName = nameMatch[1]!;
  }

  // Extract version
  const versionMatch = content.match(
    /build\.project\([^)]*version:\s*"([^"]+)"/
  );
  if (versionMatch) {
    config.version = versionMatch[1]!;
  }

  // Extract executable root
  const exeRootMatch = content.match(
    /build\.executable\([^)]*root:\s*"([^"]+)"/
  );
  if (exeRootMatch) {
    config.mainRoot = exeRootMatch[1]!;
  }

  // Extract executable name
  const exeNameMatch = content.match(/build\.executable\(\s*name:\s*"([^"]+)"/);
  if (exeNameMatch) {
    config.executableName = exeNameMatch[1]!;
  }

  // Extract test root
  const testRootMatch = content.match(/build\.test\([^)]*root:\s*"([^"]+)"/);
  if (testRootMatch) {
    config.testRoot = testRootMatch[1]!;
  }

  // Extract steps from build.step() calls
  const stepRegex = /build\.step\(\s*"([^"]+)"\s*,\s*"([^"]+)"/g;
  let stepMatch;
  while ((stepMatch = stepRegex.exec(content)) !== null) {
    const name = stepMatch[1]!;
    const description = stepMatch[2]!;
    // Don't duplicate the install step
    if (!config.steps.some((s) => s.name === name)) {
      config.steps.push({ name, description });
    }
  }

  return config;
}

function printSteps(config: BuildConfig): void {
  console.log("Available steps:");
  for (const step of config.steps) {
    const isDefault = step.name === "install" ? " (default)" : "";
    console.log(`  ${step.name}${isDefault}\t${step.description}`);
  }
}

// ── Step execution ────────────────────────────────────────────────────

async function executeStep(
  stepName: string,
  ctx: {
    config: BuildConfig;
    projectDir: string;
    cCompiler: string;
    targetTriple?: string;
    verbose?: boolean;
  }
): Promise<void> {
  const { config, projectDir, cCompiler } = ctx;

  switch (stepName) {
    case "install": {
      if (!config.mainRoot) {
        console.error(
          "Error: No executable defined in build.yo. Nothing to install."
        );
        process.exit(1);
      }
      await compileBuildArtifact(ctx);
      break;
    }
    case "run": {
      if (!config.mainRoot) {
        console.error(
          "Error: No executable defined in build.yo. Nothing to run."
        );
        process.exit(1);
      }
      await compileBuildArtifact(ctx);

      // Run the compiled executable
      const outputDir = path.join(projectDir, "yo-out", "bin");
      const exeName = config.executableName ?? config.projectName;
      const exePath = path.join(outputDir, exeName);

      if (!fs.existsSync(exePath)) {
        console.error(`Error: Compiled executable not found at ${exePath}`);
        process.exit(1);
      }

      const { spawnSync } = await import("child_process");
      console.log(`\nRunning ${exePath}...\n`);
      const result = spawnSync(exePath, [], {
        stdio: "inherit",
        cwd: projectDir,
      });
      if (result.status !== 0) {
        process.exit(result.status ?? 1);
      }
      break;
    }
    case "test": {
      if (!config.testRoot) {
        console.error("Error: No test suite defined in build.yo.");
        process.exit(1);
      }

      const { findTestFiles, runTests } = await import("./test-runner");
      const testPath = path.resolve(projectDir, config.testRoot);
      const testFiles = findTestFiles(testPath);

      if (testFiles.length === 0) {
        console.log("No test files found.");
        return;
      }

      const summary = await runTests(testFiles, {
        cCompiler,
        verbose: ctx.verbose ?? false,
        bail: false,
        parallel: 1,
        keepGeneratedFiles: false,
        profile: false,
      });

      if (summary.failed > 0) {
        process.exit(1);
      }
      break;
    }
    default: {
      // Check if the step exists in the config
      const step = config.steps.find((s) => s.name === stepName);
      if (!step) {
        console.error(
          `Error: Unknown step "${stepName}". Use --list-steps to see available steps.`
        );
        process.exit(1);
      }
      console.log(`Step "${stepName}": ${step.description}`);
      // For custom steps that aren't run/test/install, we need the full
      // build.yo evaluator to resolve dependencies. For now, just report.
      console.log(
        "Note: Custom step execution requires the full build.yo evaluator (coming soon)."
      );
      break;
    }
  }
}

async function compileBuildArtifact(ctx: {
  config: BuildConfig;
  projectDir: string;
  cCompiler: string;
  targetTriple?: string;
  verbose?: boolean;
}): Promise<void> {
  const { config, projectDir, cCompiler } = ctx;
  if (!config.mainRoot) return;

  // Resolve source path relative to project directory
  const sourcePath = path.resolve(projectDir, config.mainRoot);
  if (!fs.existsSync(sourcePath)) {
    console.error(`Error: Source file not found: ${sourcePath}`);
    process.exit(1);
  }

  // Create output directory
  const outputDir = path.join(projectDir, "yo-out", "bin");
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const exeName = config.executableName ?? config.projectName;
  const outputPath = path.join(outputDir, exeName);

  console.log(
    `Building ${config.projectName} v${config.version} → ${path.relative(projectDir, outputPath)}`
  );

  const absolutePath = `file://` + fs.realpathSync(sourcePath);

  const codeGenerator = new CodeGenerator();
  codeGenerator.compileModule(absolutePath, {
    output: outputPath,
    cCompiler,
    target: "c",
    targetTriple: ctx.targetTriple,
    extern: [],
    release: true,
    allocator: "mimalloc",
  });
}
