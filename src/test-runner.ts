import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildAsanRunEnvironment,
  findClangAsanDllPath,
  getCompilerInfo,
  getMacOSLsanSuppressions,
  getSanitizerFlags,
  isLiburingAvailable,
} from "./compiler-utils";
import { clearEnvContainingPrelude } from "./env";
import { YoError } from "./error";
import { clearAllGlobalImplState } from "./evaluator/index";
import {
  BuiltinKeywords,
  type Expr,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
} from "./expr";
import { ModuleManager } from "./module-manager";
import { TokenType } from "./token";
import { clearAllCachedTypes } from "./types/creators";
import { clearAllModuleCounters } from "./utils";
import { isComptimeStringValue } from "./value";

// ANSI color codes for terminal output
const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
};

const TEST_SUMMARY_MARKER = "__YO_TEST_SUMMARY__";

/**
 * Try to force garbage collection if running with --expose-gc flag
 */
function tryForceGC(): void {
  if (typeof global.gc === "function") {
    global.gc();
  }
}

export interface TestDeclaration {
  name: string;
  bodyExpr: Expr;
  filePath: string;
  lineNumber: number;
}

export interface ExtractTestsResult {
  tests: TestDeclaration[];
  nonTestExprs: Expr[];
}

export interface TestResult {
  testName: string;
  filePath: string;
  passed: boolean;
  errorMessage?: string;
  duration: number;
}

export interface TestRunSummary {
  totalTests: number;
  passed: number;
  failed: number;
  results: TestResult[];
  duration: number;
}

/**
 * Find all test files in a directory or get a single file
 */
export function findTestFiles(targetPath: string): string[] {
  const absolutePath = path.resolve(targetPath);

  if (!fs.existsSync(absolutePath)) {
    console.error(
      `${colors.red}Error: Path does not exist: ${absolutePath}${colors.reset}`
    );
    return [];
  }

  const stats = fs.statSync(absolutePath);

  if (stats.isFile()) {
    // Single file - accept both .yo and .test.yo files
    if (absolutePath.endsWith(".yo")) {
      return [absolutePath];
    } else {
      console.error(
        `${colors.red}Error: File is not a .yo file: ${absolutePath}${colors.reset}`
      );
      return [];
    }
  }

  if (stats.isDirectory()) {
    // Find all *.test.yo files recursively
    return findTestFilesRecursive(absolutePath);
  }

  return [];
}

function findTestFilesRecursive(dir: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      // Skip node_modules, vendor, .git, etc.
      if (
        !["node_modules", "vendor", ".git", "vscode-extension"].includes(
          entry.name
        )
      ) {
        results.push(...findTestFilesRecursive(fullPath));
      }
    } else if (entry.isFile() && entry.name.endsWith(".test.yo")) {
      results.push(fullPath);
    }
  }

  return results;
}

/**
 * Extract test declarations from a Yo source file
 * Uses the evaluator to get test names from compile-time evaluated expressions
 * Also returns non-test expressions for use in generating test programs
 */
export function extractTests(filePath: string): ExtractTestsResult {
  const tests: TestDeclaration[] = [];
  const nonTestExprs: Expr[] = [];

  // Declare moduleManager outside try block so we can clean it up
  let moduleManager: ModuleManager | null = null;

  try {
    // Clear global state before evaluating
    clearAllGlobalImplState();
    clearEnvContainingPrelude();
    clearAllCachedTypes();
    clearAllModuleCounters();

    // Use ModuleManager to evaluate the file and get the evaluated expressions
    moduleManager = new ModuleManager();
    const modulePath = `file://${filePath}`;

    const { moduleError } = moduleManager.loadModule(modulePath);
    if (moduleError) {
      moduleManager = null;
      throw new Error(`Error evaluating module: ${moduleError}`);
    }

    const moduleData = moduleManager.modules.get(modulePath);
    if (!moduleData) {
      console.error(
        `${colors.red}Error: Module not found after loading: ${filePath}${colors.reset}`
      );
      moduleManager = null;
      return { tests, nonTestExprs };
    }

    // Get the evaluated program expressions
    const program = moduleData.evaluator.getProgram();

    for (const expr of program) {
      if (
        exprIsFunctionCall(expr) &&
        exprIsFunctionCallOf(expr, BuiltinKeywords.test)
      ) {
        if (expr.args.length >= 2) {
          const testNameExpr = expr.args[0]!;
          const testBodyExpr = expr.args[1]!;

          // Get the test name from the evaluated expression
          let testName = "unnamed_test";

          // First try to get the value from the evaluated expression's $ field
          if (testNameExpr.$ && isComptimeStringValue(testNameExpr.$.value)) {
            testName = testNameExpr.$.value.value;
          } else if (
            exprIsAtom(testNameExpr) &&
            testNameExpr.token.type === TokenType.String
          ) {
            // Fallback: String literal - extract the value directly from token
            testName = testNameExpr.token.value;
          }

          tests.push({
            name: testName,
            bodyExpr: testBodyExpr,
            filePath,
            lineNumber: testNameExpr.token.position.row + 1,
          });
        }
      } else {
        // Collect non-test expressions
        nonTestExprs.push(expr);
      }
    }

    // Clean up moduleManager to help GC
    moduleManager = null;
  } catch (error) {
    // Ensure moduleManager is cleaned up on error
    moduleManager = null;
    console.error(
      `${colors.red}Error parsing ${filePath}: ${error}${colors.reset}`
    );
    throw error;
  }

  return { tests, nonTestExprs };
}

/**
 * Generate a standalone Yo program for a single test
 *
 * Strategy: Use the non-test expressions from the AST and convert them
 * back to source using exprToString. This avoids type collection from
 * other tests since we don't include test blocks at all.
 */
function generateTestProgram(
  test: TestDeclaration,
  nonTestExprs: Expr[]
): string {
  // Convert non-test expressions back to source code
  const nonTestContent = nonTestExprs
    .map((expr) => exprToString(expr.$?.originalExpr ?? expr))
    .join(";\n");

  // The test body is a begin block, so we wrap it in a main function
  const testBodyString = exprToString(
    test.bodyExpr.$?.originalExpr ?? test.bodyExpr
  );

  // Build the program from non-test expressions plus the main function
  return `${nonTestContent};

// Auto-generated main function for test: ${test.name}
main :: (fn() -> unit) {
  ${testBodyString};
};

export main;
`;
}

/**
 * Compile and run a single test
 */
function runSingleTest(
  test: TestDeclaration,
  nonTestExprs: Expr[],
  cCompiler: string,
  keepGeneratedFiles?: boolean
): TestResult {
  const startTime = Date.now();
  const sanitizedName = test.name.replace(/[^a-zA-Z0-9_]/g, "_");
  const uniqueId = `${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

  // Create all temp files in the SAME directory as the original file
  // This preserves relative import paths
  const originalDir = path.dirname(test.filePath);
  const baseName = `.yo_test_${sanitizedName}_${uniqueId}`;
  const testFilePath = path.join(originalDir, `${baseName}.yo`);
  // On Windows, executables must have .exe extension
  const exeExtension = process.platform === "win32" ? ".exe" : "";
  const testOutputPath = path.join(originalDir, `${baseName}${exeExtension}`);
  const testCPath = path.join(originalDir, `${baseName}.c`);
  // On Windows with MSVC/Clang-cl, .pdb debug files are generated alongside the executable
  const testPdbPath =
    process.platform === "win32"
      ? path.join(originalDir, `${baseName}.pdb`)
      : undefined;

  // Helper to clean up all temp files
  const cleanup = () => {
    if (keepGeneratedFiles) {
      console.log(`  ${colors.dim}Keeping generated files:${colors.reset}`);
      console.log(`    ${colors.dim}.yo file: ${testFilePath}${colors.reset}`);
      console.log(`    ${colors.dim}.c file: ${testCPath}${colors.reset}`);
      return;
    }
    const filesToClean = [testFilePath, testOutputPath, testCPath];
    if (testPdbPath) {
      filesToClean.push(testPdbPath);
    }
    for (const file of filesToClean) {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    }
  };

  // Declare moduleManager outside try block so we can clean it up
  let moduleManager: ModuleManager | null = null;

  try {
    // Clear all global state before compiling each test
    // This ensures each test runs in a clean environment
    clearAllGlobalImplState();
    clearEnvContainingPrelude();
    clearAllCachedTypes();
    clearAllModuleCounters();

    // Generate test program
    const testProgram = generateTestProgram(test, nonTestExprs);
    fs.writeFileSync(testFilePath, testProgram);

    // Compile the test using ModuleManager with libc allocator (faster compilation)
    moduleManager = new ModuleManager();

    try {
      moduleManager.compileModule(`file://${testFilePath}`, {
        emitC: false,
        debugGc: false,
        debugParallelism: false,
        debugAsyncAwait: false,
        allocator: "libc",
      });
    } catch (compileError) {
      // Clean up moduleManager before returning
      moduleManager = null;
      cleanup();
      return {
        testName: test.name,
        filePath: test.filePath,
        passed: false,
        errorMessage: `Compilation error: ${compileError instanceof YoError ? compileError.toString() : compileError instanceof Error ? compileError.message : String(compileError)}`,
        duration: Date.now() - startTime,
      };
    }

    // Get the generated C code
    const generatedCode = moduleManager.getGeneratedCode();

    // Explicitly release the moduleManager to help GC
    moduleManager = null;

    fs.writeFileSync(testCPath, generatedCode);

    // Clean up temp .yo file after generating C code (unless keeping files)
    if (!keepGeneratedFiles && fs.existsSync(testFilePath)) {
      fs.unlinkSync(testFilePath);
    }

    // Compile C code with AddressSanitizer for memory leak detection
    // Note: Using libc allocator (no mimalloc) for faster test compilation
    const compilerInfo = getCompilerInfo(cCompiler);
    const { isMSVC, isWindows } = compilerInfo;

    // Get ASAN flags using shared utility
    // ASAN is enabled if we get non-empty flags back (handles cases like MinGW GCC where ASAN isn't available)
    const asanFlags = !isMSVC
      ? getSanitizerFlags({ sanitize: "address", compilerInfo })
      : { flags: [] };
    const useAsan = asanFlags.flags.length > 0;

    const compileArgs = isMSVC
      ? ["/Od", "/W4", testCPath, `/Fe${testOutputPath}`]
      : [
          ...(cCompiler === "zig" ? ["cc"] : []),
          "-std=c11",
          "-Wall",
          "-Wextra",
          "-O0",
          ...asanFlags.flags,
          testCPath,
          "-o",
          testOutputPath,
        ];

    if (isWindows) {
      if (isMSVC) {
        compileArgs.splice(-1, 0, "ws2_32.lib");
      } else {
        compileArgs.splice(-2, 0, "-lws2_32");
      }
    }

    // Add liburing on Linux for async I/O (uses system-installed liburing)
    if (!isMSVC && isLiburingAvailable()) {
      compileArgs.splice(-2, 0, "-luring");
    }

    const compileResult = spawnSync(cCompiler, compileArgs, {
      stdio: "pipe",
      encoding: "utf-8",
    });

    if (compileResult.status !== 0) {
      cleanup();
      return {
        testName: test.name,
        filePath: test.filePath,
        passed: false,
        errorMessage: `C compilation failed:\n${compileResult.stderr || compileResult.stdout}`,
        duration: Date.now() - startTime,
      };
    }

    // Run the test executable with AddressSanitizer leak detection enabled
    // On macOS, we need to suppress system library leaks
    // On Windows with Clang, we need to find and add the ASAN DLL path to PATH
    const isMacOS = process.platform === "darwin";
    const lsanSuppressions = getMacOSLsanSuppressions();

    // Create a temporary suppression file for macOS
    let suppressionFile: string | undefined;
    if (isMacOS && lsanSuppressions) {
      suppressionFile = `${testOutputPath}.lsan_suppressions.txt`;
      fs.writeFileSync(suppressionFile, lsanSuppressions);
    }

    // On Windows with Clang, find the ASAN DLL directory
    // (GCC uses static linking so doesn't need this)
    const asanDllPath =
      isWindows && useAsan && compilerInfo.isClangOnWindows
        ? findClangAsanDllPath(cCompiler)
        : undefined;

    // Build environment with ASAN settings
    const runEnv = buildAsanRunEnvironment({
      compilerInfo,
      asanDllPath,
      lsanSuppressionFile: suppressionFile,
      detectLeaks: true,
    });

    let runResult = spawnSync(testOutputPath, [], {
      stdio: "pipe",
      encoding: "utf-8",
      timeout: 60000, // 60 second timeout - tests should complete quickly, this catches hangs
      env: runEnv,
    });

    // Check if detect_leaks is not supported (e.g., on GitHub Actions macOS runners)
    const combinedOutputInitial = `${runResult.stdout || ""}${runResult.stderr || ""}`;
    const leakDetectionNotSupported = combinedOutputInitial.includes(
      "detect_leaks is not supported"
    );

    // If leak detection is not supported, rerun without it
    if (leakDetectionNotSupported) {
      const runEnvNoLeaks = buildAsanRunEnvironment({
        compilerInfo,
        asanDllPath,
        lsanSuppressionFile: suppressionFile,
        detectLeaks: false,
      });
      runResult = spawnSync(testOutputPath, [], {
        stdio: "pipe",
        encoding: "utf-8",
        timeout: 60000,
        env: runEnvNoLeaks,
      });
    }

    // Clean up suppression file
    if (suppressionFile && fs.existsSync(suppressionFile)) {
      fs.unlinkSync(suppressionFile);
    }

    // Check for memory leaks in the output (only if leak detection was supported)
    const combinedOutput = `${runResult.stdout || ""}${runResult.stderr || ""}`;
    const hasMemoryLeak =
      !leakDetectionNotSupported &&
      (combinedOutput.includes("LeakSanitizer") ||
        combinedOutput.includes("detected memory leaks") ||
        combinedOutput.includes("Direct leak") ||
        combinedOutput.includes("Indirect leak"));

    const passed = runResult.status === 0 && !hasMemoryLeak;

    cleanup();

    let errorMessage: string | undefined;
    if (!passed) {
      if (hasMemoryLeak) {
        // Extract just the leak summary for a cleaner error message
        const leakMatch = combinedOutput.match(
          /=+\n([\s\S]*?SUMMARY[\s\S]*?)(\n=+|$)/
        );
        const leakInfo = leakMatch ? leakMatch[1] : combinedOutput;
        errorMessage = `Memory leak detected:\n${leakInfo}`;
      } else {
        errorMessage = `Test failed with exit code ${runResult.status}\n${runResult.stdout}\n${runResult.stderr}`;
      }
    }

    return {
      testName: test.name,
      filePath: test.filePath,
      passed,
      errorMessage,
      duration: Date.now() - startTime,
    };
  } catch (error) {
    cleanup();
    return {
      testName: test.name,
      filePath: test.filePath,
      passed: false,
      errorMessage: `Error running test: ${error instanceof Error ? error.message : String(error)}`,
      duration: Date.now() - startTime,
    };
  }
}

/**
 * Information about a test to run (including pre-extracted content)
 */
interface TestToRun {
  test: TestDeclaration;
  nonTestExprs: Expr[];
}

interface IsolatedFileRunResult {
  filePath: string;
  summary?: TestRunSummary;
  errorMessage?: string;
}

function parseTestSummaryFromOutput(
  output: string
): TestRunSummary | undefined {
  const markerIndex = output.lastIndexOf(TEST_SUMMARY_MARKER);
  if (markerIndex < 0) {
    return undefined;
  }

  const jsonPart = output
    .slice(markerIndex + TEST_SUMMARY_MARKER.length)
    .trim();
  const jsonLine = jsonPart.split(/\r?\n/)[0];
  if (!jsonLine) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(jsonLine) as TestRunSummary;
    if (
      typeof parsed.totalTests === "number" &&
      typeof parsed.passed === "number" &&
      typeof parsed.failed === "number" &&
      Array.isArray(parsed.results) &&
      typeof parsed.duration === "number"
    ) {
      return parsed;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function runSingleFileInIsolatedProcess({
  filePath,
  cCompiler,
  verbose,
  bail,
  testNamePattern,
  keepGeneratedFiles,
}: {
  filePath: string;
  cCompiler: string;
  verbose?: boolean;
  bail?: boolean;
  testNamePattern?: string;
  keepGeneratedFiles?: boolean;
}): Promise<IsolatedFileRunResult> {
  return await new Promise((resolve) => {
    const bunExecutable = process.env.BUN || "bun";
    const cliEntryPath = path.join(process.cwd(), "src/yo-cli.ts");
    const args = [
      "run",
      cliEntryPath,
      "test",
      filePath,
      "--parallel",
      "1",
      "--json-summary",
      "--cc",
      cCompiler,
    ];

    if (verbose) {
      args.push("--verbose");
    }
    if (bail) {
      args.push("--bail");
    }
    if (testNamePattern) {
      args.push("--test-name-pattern", testNamePattern);
    }
    if (keepGeneratedFiles) {
      args.push("--keep-generated-files");
    }

    const child = spawn(bunExecutable, args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: process.cwd(),
      env: process.env,
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      resolve({
        filePath,
        errorMessage: `Failed to spawn isolated test process: ${error.message}`,
      });
    });

    child.on("close", (code) => {
      const summary = parseTestSummaryFromOutput(stdout);
      if (summary) {
        resolve({ filePath, summary });
        return;
      }

      const outputTail = `${stdout}\n${stderr}`
        .trim()
        .split(/\r?\n/)
        .slice(-12);
      const outputHint =
        outputTail.length > 0 ? `\n${outputTail.join("\n")}` : "";
      resolve({
        filePath,
        errorMessage: `Isolated test process failed to produce summary (exit code ${code ?? "unknown"}).${outputHint}`,
      });
    });
  });
}

async function runTestsInIsolatedProcesses({
  testFiles,
  cCompiler,
  concurrency,
  verbose,
  bail,
  testNamePattern,
  keepGeneratedFiles,
  startTime,
}: {
  testFiles: string[];
  cCompiler: string;
  concurrency: number;
  verbose?: boolean;
  bail?: boolean;
  testNamePattern?: string;
  keepGeneratedFiles?: boolean;
  startTime: number;
}): Promise<TestRunSummary> {
  const allResults: TestResult[] = [];
  let passedTests = 0;
  let failedTests = 0;
  let nextFileIndex = 0;
  let bailed = false;

  const workerCount = Math.min(concurrency, testFiles.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextFileIndex < testFiles.length && !bailed) {
      const fileIndex = nextFileIndex;
      nextFileIndex += 1;

      const filePath = testFiles[fileIndex]!;
      const result = await runSingleFileInIsolatedProcess({
        filePath,
        cCompiler,
        verbose,
        bail,
        testNamePattern,
        keepGeneratedFiles,
      });

      const relativePath = path.relative(process.cwd(), filePath);
      console.log(`${colors.dim}${relativePath}${colors.reset}`);

      if (!result.summary) {
        const errorMessage =
          result.errorMessage ?? "Unknown isolated test process error";
        console.log(
          `  ${colors.red}✗${colors.reset} Isolated test runner failed`
        );
        console.log(`    ${colors.red}${errorMessage}${colors.reset}`);
        console.log();

        allResults.push({
          testName: "Isolated test runner",
          filePath,
          passed: false,
          errorMessage,
          duration: 0,
        });
        failedTests += 1;
      } else if (result.summary.results.length === 0) {
        console.log(`  ${colors.yellow}(no tests found)${colors.reset}`);
        console.log();
      } else {
        for (const testResult of result.summary.results) {
          allResults.push(testResult);
          if (testResult.passed) {
            passedTests += 1;
            console.log(
              `  ${colors.green}✓${colors.reset} ${testResult.testName} ${colors.dim}(${testResult.duration}ms)${colors.reset}`
            );
          } else {
            failedTests += 1;
            console.log(
              `  ${colors.red}✗${colors.reset} ${testResult.testName} ${colors.dim}(${testResult.duration}ms)${colors.reset}`
            );

            if (testResult.errorMessage && verbose) {
              const indentedError = testResult.errorMessage
                .split("\n")
                .map((l) => `    ${l}`)
                .join("\n");
              console.log(`${colors.red}${indentedError}${colors.reset}`);
            } else if (testResult.errorMessage) {
              const firstLine = testResult.errorMessage.split("\n")[0];
              console.log(`    ${colors.red}${firstLine}${colors.reset}`);
            }
          }
        }
        console.log();
      }

      if (
        bail &&
        ((result.summary && result.summary.failed > 0) || !result.summary)
      ) {
        bailed = true;
      }
    }
  });

  await Promise.all(workers);

  if (bailed) {
    console.log(
      `\n${colors.yellow}Bailing out early due to test failure (--bail)${colors.reset}\n`
    );
  }

  const totalDuration = Date.now() - startTime;

  console.log(`${colors.bold}Test Summary${colors.reset}`);
  console.log(`─────────────────────────────────`);
  if (passedTests > 0) {
    console.log(`${colors.green}${passedTests} passed${colors.reset}`);
  }
  if (failedTests > 0) {
    console.log(`${colors.red}${failedTests} failed${colors.reset}`);
  }
  console.log(
    `${colors.dim}${passedTests + failedTests} total (${totalDuration}ms)${colors.reset}`
  );
  console.log();

  return {
    totalTests: passedTests + failedTests,
    passed: passedTests,
    failed: failedTests,
    results: allResults,
    duration: totalDuration,
  };
}

/**
 * Run tests sequentially within a single file.
 *
 * Parallel execution is handled at file level via isolated child processes.
 */
async function runTestsSequentially(
  testsToRun: TestToRun[],
  cCompiler: string,
  options: {
    verbose?: boolean;
    bail?: boolean;
    keepGeneratedFiles?: boolean;
  }
): Promise<{
  results: TestResult[];
  passedTests: number;
  failedTests: number;
  bailed: boolean;
}> {
  const results: TestResult[] = [];
  let passedTests = 0;
  let failedTests = 0;
  let bailed = false;

  for (const { test, nonTestExprs } of testsToRun) {
    if (bailed) break;

    const result = runSingleTest(
      test,
      nonTestExprs,
      cCompiler,
      options.keepGeneratedFiles
    );
    results.push(result);

    if (result.passed) {
      passedTests++;
      console.log(
        `  ${colors.green}✓${colors.reset} ${test.name} ${colors.dim}(${result.duration}ms)${colors.reset}`
      );
    } else {
      failedTests++;
      console.log(
        `  ${colors.red}✗${colors.reset} ${test.name} ${colors.dim}(${result.duration}ms)${colors.reset}`
      );
      if (result.errorMessage && options.verbose) {
        const indentedError = result.errorMessage
          .split("\n")
          .map((l) => `    ${l}`)
          .join("\n");
        console.log(`${colors.red}${indentedError}${colors.reset}`);
      } else if (result.errorMessage) {
        const firstLine = result.errorMessage.split("\n")[0];
        console.log(`    ${colors.red}${firstLine}${colors.reset}`);
      }

      if (options.bail) {
        bailed = true;
      }
    }
  }

  return { results, passedTests, failedTests, bailed };
}

/**
 * Run all tests in the specified files
 */
export async function runTests(
  testFiles: string[],
  options: {
    cCompiler?: string;
    verbose?: boolean;
    bail?: boolean;
    testNamePattern?: string;
    parallel?: number;
    keepGeneratedFiles?: boolean;
  } = {}
): Promise<TestRunSummary> {
  const startTime = Date.now();
  const cCompiler = options.cCompiler ?? "cc";

  // Determine concurrency level
  const maxCpus = os.cpus().length;
  let concurrency: number;
  if (options.parallel === undefined || options.parallel === 0) {
    // Auto: use all available CPUs
    concurrency = maxCpus;
  } else if (options.parallel === 1) {
    // Sequential
    concurrency = 1;
  } else {
    // User specified, cap at max CPUs
    concurrency = Math.min(options.parallel, maxCpus);
  }

  let testNameRegex: RegExp | undefined;
  if (options.testNamePattern) {
    try {
      testNameRegex = new RegExp(options.testNamePattern);
    } catch (e) {
      console.error(
        `${colors.red}Error: Invalid regex pattern: ${options.testNamePattern}${colors.reset}`
      );
      return {
        totalTests: 0,
        passed: 0,
        failed: 0,
        results: [],
        duration: 0,
      };
    }
  }

  console.log(
    `\n${colors.bold}${colors.cyan}Running Yo Tests${colors.reset}${concurrency > 1 ? ` ${colors.dim}(${concurrency} workers)${colors.reset}` : ""}\n`
  );
  if (testNameRegex) {
    console.log(
      `${colors.dim}Filtering tests matching: ${options.testNamePattern}${colors.reset}\n`
    );
  }

  // For parallel mode, run each test file in an isolated child process.
  // This avoids interference from global mutable state in the compiler/evaluator.
  if (concurrency > 1) {
    return await runTestsInIsolatedProcesses({
      testFiles,
      cCompiler,
      concurrency,
      verbose: options.verbose,
      bail: options.bail,
      testNamePattern: options.testNamePattern,
      keepGeneratedFiles: options.keepGeneratedFiles,
      startTime,
    });
  }

  // Initialize result tracking variables early so they can be used in error handling
  const allResults: TestResult[] = [];
  let passedTests = 0;
  let failedTests = 0;
  let bailed = false;

  // Process files incrementally so users get immediate feedback
  for (const filePath of testFiles) {
    if (bailed) break;

    const relativePath = path.relative(process.cwd(), filePath);
    console.log(`${colors.dim}${relativePath}${colors.reset}`);

    let tests: TestDeclaration[];
    let nonTestExprs: Expr[];
    try {
      const result = extractTests(filePath);
      tests = result.tests;
      nonTestExprs = result.nonTestExprs;
    } catch (error) {
      // Module evaluation failed - treat as a single failed test for this file
      console.log(`  ${colors.red}✗${colors.reset} Module evaluation failed`);
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.log(`    ${colors.red}${errorMessage}${colors.reset}`);
      console.log();

      allResults.push({
        testName: "Module evaluation",
        filePath,
        passed: false,
        errorMessage,
        duration: 0,
      });
      failedTests++;
      continue;
    }

    if (testNameRegex) {
      tests = tests.filter((test) => testNameRegex.test(test.name));
    }

    if (tests.length === 0) {
      console.log(`  ${colors.yellow}(no tests found)${colors.reset}`);
      console.log();
      // Try to force garbage collection between files to prevent memory accumulation
      tryForceGC();
      continue;
    }

    const testsToRun = tests.map((test) => ({
      test,
      nonTestExprs,
    }));

    const result = await runTestsSequentially(testsToRun, cCompiler, {
      verbose: options.verbose,
      bail: options.bail,
      keepGeneratedFiles: options.keepGeneratedFiles,
    });

    allResults.push(...result.results);
    passedTests += result.passedTests;
    failedTests += result.failedTests;
    bailed = result.bailed;

    if (bailed) {
      console.log(
        `\n${colors.yellow}Bailing out early due to test failure (--bail)${colors.reset}\n`
      );
    }

    console.log();

    // Try to force garbage collection between files to prevent memory accumulation
    tryForceGC();
  }

  const totalDuration = Date.now() - startTime;

  // Print summary
  console.log(`${colors.bold}Test Summary${colors.reset}`);
  console.log(`─────────────────────────────────`);
  if (passedTests > 0) {
    console.log(`${colors.green}${passedTests} passed${colors.reset}`);
  }
  if (failedTests > 0) {
    console.log(`${colors.red}${failedTests} failed${colors.reset}`);
  }
  console.log(
    `${colors.dim}${passedTests + failedTests} total (${totalDuration}ms)${colors.reset}`
  );
  console.log();

  return {
    totalTests: passedTests + failedTests,
    passed: passedTests,
    failed: failedTests,
    results: allResults,
    duration: totalDuration,
  };
}
