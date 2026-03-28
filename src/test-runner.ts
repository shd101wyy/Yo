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
  spawnCompiler,
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
import {
  type TargetInfo,
  isTargetStandaloneWasi,
  parseTarget,
  setCurrentTarget,
} from "./target";
import { TokenType } from "./token";
import { clearAllCachedTypes } from "./types/creators";
import { setTargetPointerSize } from "./types/utils";
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
  } else if (
    typeof globalThis !== "undefined" &&
    typeof (globalThis as Record<string, unknown>).Bun === "object"
  ) {
    // Bun runtime: use Bun.gc(true) for synchronous full GC
    const bunObj = (globalThis as Record<string, unknown>).Bun as Record<
      string,
      unknown
    >;
    if (typeof bunObj.gc === "function") {
      (bunObj.gc as (sync: boolean) => void)(true);
    }
  }
}

export interface TestDeclaration {
  name: string;
  bodyExpr: Expr;
  usingExpr?: Expr;
  filePath: string;
  lineNumber: number;
}

/**
 * Pre-stringified test data. Converts AST to source strings eagerly
 * so the heavy AST/environment object graph can be released before
 * the test compilation loop starts.
 */
interface StringifiedTestData {
  name: string;
  bodyString: string;
  usingString: string;
  filePath: string;
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
  profileInfo?: string;
}

export interface TestRunSummary {
  totalTests: number;
  passed: number;
  failed: number;
  skipped: number;
  results: TestResult[];
  duration: number;
}

// ---------------------------------------------------------------------------
// WASM test skip lists
// ---------------------------------------------------------------------------
// Tests that cannot run under Emscripten/WASM or standalone WASI due to
// missing platform features.
// See plans/WASM_SUPPORT.md for details.

/**
 * Check if a test file has a skip directive for the given WASM target.
 *
 * Directives:
 *   `// @skip_wasm`              — skip on ALL WASM targets
 *   `// @skip_wasm32-emscripten` — skip when target is wasm32-emscripten
 *   `// @skip_wasm32-wasi`       — skip when target is wasm32-wasi
 *
 * Scans the first 20 lines of the file for the comment annotation.
 * This is intentionally a fast text scan (no tokenization needed).
 */
function hasSkipDirectiveForTarget(
  filePath: string,
  target: TargetInfo
): boolean {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n", 20);
    const directive = isTargetStandaloneWasi(target)
      ? "@skip_wasm32-wasi"
      : "@skip_wasm32-emscripten";
    return lines.some(
      (line) =>
        line.includes(directive) ||
        (line.includes("@skip_wasm") && !line.includes("@skip_wasm32-"))
    );
  } catch {
    return false;
  }
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
          // 3 args: test "name", using(...), { body }
          // 2 args: test "name", { body }
          const hasUsingClause = expr.args.length === 3;
          const testUsingExpr = hasUsingClause ? expr.args[1]! : undefined;
          const testBodyExpr = hasUsingClause ? expr.args[2]! : expr.args[1]!;

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
            usingExpr: testUsingExpr,
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
 * Strategy: Use pre-stringified source code from the original AST.
 * The AST is converted to strings eagerly so the heavy object graph
 * can be released before the test compilation loop.
 */
function generateTestProgram(
  test: StringifiedTestData,
  nonTestContent: string
): string {
  const mainParams = test.usingString;

  // Build the program from non-test expressions plus the main function
  return `${nonTestContent};

// Auto-generated main function for test: ${test.name}
main :: (fn(${mainParams}) -> unit) {
  ${test.bodyString};
};

export main;
`;
}

/**
 * Compile and run a single test
 */
function runSingleTest(
  test: StringifiedTestData,
  nonTestContent: string,
  cCompiler: string,
  wasmTarget?: TargetInfo,
  keepGeneratedFiles?: boolean,
  profile?: boolean
): TestResult {
  const startTime = Date.now();
  const sanitizedName = test.name.replace(/[^a-zA-Z0-9_]/g, "_");
  const uniqueId = `${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

  // Create all temp files in the SAME directory as the original file
  // This preserves relative import paths
  const originalDir = path.dirname(test.filePath);
  const baseName = `.yo_test_${sanitizedName}_${uniqueId}`;
  const testFilePath = path.join(originalDir, `${baseName}.yo`);
  const compilerInfo = getCompilerInfo(cCompiler);
  const { isMSVC, isWindows, isEmcc } = compilerInfo;
  const isWasi = wasmTarget ? isTargetStandaloneWasi(wasmTarget) : false;
  // emcc outputs .js (+ .wasm) for emscripten, .wasm for WASI; Windows needs .exe
  const exeExtension = isWasi
    ? ".wasm"
    : isEmcc
      ? ".js"
      : isWindows
        ? ".exe"
        : "";
  const testOutputPath = path.join(originalDir, `${baseName}${exeExtension}`);
  const testCPath = path.join(originalDir, `${baseName}.c`);
  // emcc also generates a .wasm file alongside the .js (not needed for WASI — output IS .wasm)
  const testWasmPath =
    isEmcc && !isWasi ? path.join(originalDir, `${baseName}.wasm`) : undefined;
  // On Windows with MSVC/Clang-cl, .pdb debug files are generated alongside the executable
  const testPdbPath = isWindows
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
    if (testWasmPath) {
      filesToClean.push(testWasmPath);
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

    // Set WASM target when using emcc so the evaluator sees wasm32 arch/platform
    if (wasmTarget) {
      setCurrentTarget(wasmTarget);
      setTargetPointerSize(wasmTarget.pointerSizeBits);
    } else if (isEmcc) {
      const emscriptenTarget = parseTarget("wasm32-emscripten");
      setCurrentTarget(emscriptenTarget);
      setTargetPointerSize(emscriptenTarget.pointerSizeBits);
    }

    // Generate test program
    const testProgram = generateTestProgram(test, nonTestContent);
    fs.writeFileSync(testFilePath, testProgram);

    // Compile the test using ModuleManager with libc allocator (faster compilation)
    const yoCompileStart = Date.now();
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
    const yoCompileEnd = Date.now();

    // Get the generated C code and codegen flags
    const generatedCode = moduleManager.getGeneratedCode();
    const needsIntelAsmSyntax = moduleManager.needsIntelAsmSyntax;
    const usesParallelism = moduleManager.usesParallelism;

    // Explicitly release the moduleManager to help GC
    moduleManager = null;

    fs.writeFileSync(testCPath, generatedCode);

    // Clean up temp .yo file after generating C code (unless keeping files)
    if (!keepGeneratedFiles && fs.existsSync(testFilePath)) {
      fs.unlinkSync(testFilePath);
    }

    // Compile C code with AddressSanitizer for memory leak detection
    // Note: Using libc allocator (no mimalloc) for faster test compilation
    // (compilerInfo, isMSVC, isWindows, isEmcc already set above)

    // Get ASAN flags (skip for emcc — WASM doesn't support ASAN)
    const asanFlags =
      !isMSVC && !isEmcc
        ? getSanitizerFlags({ sanitize: "address", compilerInfo })
        : { flags: [] };
    const useAsan = asanFlags.flags.length > 0;

    const compileArgs = isMSVC
      ? ["/Od", "/W4", testCPath, `/Fe${testOutputPath}`]
      : [
          ...(cCompiler === "zig" ? ["cc"] : []),
          "-std=c11",
          ...(isEmcc ? ["-w"] : ["-Wall", "-Wextra"]),
          isEmcc ? "-O2" : "-O0",
          ...asanFlags.flags,
          testCPath,
          "-o",
          testOutputPath,
        ];

    if (isWindows) {
      if (isMSVC) {
        compileArgs.splice(-1, 0, "ws2_32.lib");
        compileArgs.splice(-1, 0, "bcrypt.lib");
      } else {
        compileArgs.splice(-2, 0, "-lws2_32");
        compileArgs.splice(-2, 0, "-lbcrypt");
      }
    }

    // Add -masm=intel when inline assembly uses Intel syntax (not for emcc)
    if (!isMSVC && !isEmcc && needsIntelAsmSyntax) {
      compileArgs.splice(-2, 0, "-masm=intel");
    }

    // Add liburing on Linux for async I/O (not for emcc)
    if (!isMSVC && !isEmcc && isLiburingAvailable()) {
      compileArgs.splice(-2, 0, "-luring");
    }

    // Emscripten-specific flags
    if (isEmcc) {
      // Allow function pointer casts (WASM call_indirect requires exact
      // signature matches, but the codegen casts void* to fn pointers)
      compileArgs.splice(-2, 0, "-sEMULATE_FUNCTION_POINTER_CASTS=1");

      if (isWasi) {
        // Standalone WASI: produce a .wasm file without JS glue
        compileArgs.splice(-2, 0, "-sSTANDALONE_WASM");
      } else {
        // Emscripten target: use Node.js's real filesystem instead of MEMFS
        compileArgs.splice(-2, 0, "-sNODERAWFS=1");
      }

      // Enable pthreads when the program uses threading (not for standalone WASI)
      if (usesParallelism && !isWasi) {
        compileArgs.splice(
          -2,
          0,
          "-pthread",
          "-sPTHREAD_POOL_SIZE=4",
          "-sEXIT_RUNTIME=1"
        );
      }
    }

    const cCompileStart = Date.now();
    const compileResult = spawnCompiler(cCompiler, compileArgs, {
      stdio: "pipe",
      encoding: "utf-8",
    });
    const cCompileEnd = Date.now();

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

    // Run the test executable
    const runStart = Date.now();
    let runResult;

    if (isWasi) {
      // WASI: run via wasmtime with directory access
      const testDir = path.dirname(test.filePath);
      runResult = spawnSync(
        "wasmtime",
        [
          "--dir",
          testDir,
          "--dir",
          "/tmp",
          "--dir",
          process.cwd(),
          testOutputPath,
        ],
        {
          stdio: "pipe",
          encoding: "utf-8",
          timeout: 60000,
        }
      );
    } else if (isEmcc) {
      // WASM: run via node (emcc produces .js + .wasm)
      runResult = spawnSync("node", [testOutputPath], {
        stdio: "pipe",
        encoding: "utf-8",
        timeout: 60000,
      });
    } else {
      // Native: run with AddressSanitizer leak detection
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

      runResult = spawnSync(testOutputPath, [], {
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
    }

    // Check for memory leaks in the output (skip for emcc — no ASAN)
    const combinedOutput = `${runResult.stdout || ""}${runResult.stderr || ""}`;
    const hasMemoryLeak =
      !isEmcc &&
      (combinedOutput.includes("LeakSanitizer") ||
        combinedOutput.includes("detected memory leaks") ||
        combinedOutput.includes("Direct leak") ||
        combinedOutput.includes("Indirect leak"));

    const passed = runResult.status === 0 && !hasMemoryLeak;
    const runEnd = Date.now();

    let profileInfo: string | undefined;
    if (profile) {
      const heapMB = process.memoryUsage().heapUsed / 1024 / 1024;
      profileInfo = `yo=${yoCompileEnd - yoCompileStart}ms cc=${cCompileEnd - cCompileStart}ms run=${runEnd - runStart}ms heap=${heapMB.toFixed(0)}MB`;
      console.log(`    ${colors.dim}${profileInfo}${colors.reset}`);
    }

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
      profileInfo,
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
 * Information about a test to run (pre-stringified source code)
 */
interface TestToRun {
  test: StringifiedTestData;
  nonTestContent: string;
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
  target,
  verbose,
  bail,
  testNamePattern,
  keepGeneratedFiles,
  profile,
}: {
  filePath: string;
  cCompiler: string;
  target?: string;
  verbose?: boolean;
  bail?: boolean;
  testNamePattern?: string;
  keepGeneratedFiles?: boolean;
  profile?: boolean;
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

    if (target) {
      args.push("--target", target);
    }
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
    if (profile) {
      args.push("--profile");
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
  target,
  concurrency,
  verbose,
  bail,
  testNamePattern,
  keepGeneratedFiles,
  profile,
  startTime,
}: {
  testFiles: string[];
  cCompiler: string;
  target?: string;
  concurrency: number;
  verbose?: boolean;
  bail?: boolean;
  testNamePattern?: string;
  keepGeneratedFiles?: boolean;
  profile?: boolean;
  startTime: number;
}): Promise<TestRunSummary> {
  const allResults: TestResult[] = [];
  let passedTests = 0;
  let failedTests = 0;
  let skippedTestNames = 0;
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
        target,
        verbose,
        bail,
        testNamePattern,
        keepGeneratedFiles,
        profile,
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
        skippedTestNames += result.summary.skipped ?? 0;
      } else {
        skippedTestNames += result.summary.skipped ?? 0;
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
          }
          if (testResult.profileInfo && profile) {
            console.log(
              `    ${colors.dim}${testResult.profileInfo}${colors.reset}`
            );
          }
          if (!testResult.passed) {
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
  if (skippedTestNames > 0) {
    console.log(`${colors.yellow}${skippedTestNames} skipped${colors.reset}`);
  }
  console.log(
    `${colors.dim}${passedTests + failedTests} total (${totalDuration}ms)${colors.reset}`
  );
  console.log();

  return {
    totalTests: passedTests + failedTests,
    passed: passedTests,
    failed: failedTests,
    skipped: skippedTestNames,
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
    profile?: boolean;
    wasmTarget?: TargetInfo;
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

  for (const { test, nonTestContent } of testsToRun) {
    if (bailed) break;

    const result = runSingleTest(
      test,
      nonTestContent,
      cCompiler,
      options.wasmTarget,
      options.keepGeneratedFiles,
      options.profile
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

    // Force GC between tests to prevent heap accumulation.
    // Each test compilation creates millions of objects; without GC
    // the heap can grow to several GB causing extreme GC pressure.
    tryForceGC();
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
    target?: string;
    verbose?: boolean;
    bail?: boolean;
    testNamePattern?: string;
    parallel?: number;
    keepGeneratedFiles?: boolean;
    profile?: boolean;
  } = {}
): Promise<TestRunSummary> {
  const startTime = Date.now();
  const cCompiler = options.cCompiler ?? "cc";
  const isEmcc = cCompiler === "emcc";

  // Resolve the WASM target (if any)
  let wasmTarget: TargetInfo | undefined;
  if (options.target) {
    wasmTarget = parseTarget(options.target);
  } else if (isEmcc) {
    wasmTarget = parseTarget("wasm32-emscripten");
  }
  const isWasmBuild = wasmTarget !== undefined;

  // Filter out files with target-specific skip directives
  let skippedTests = 0;
  let filteredTestFiles = testFiles;
  if (isWasmBuild && wasmTarget) {
    const directive = isTargetStandaloneWasi(wasmTarget)
      ? "@skip_wasm32-wasi"
      : "@skip_wasm32-emscripten";
    filteredTestFiles = [];
    for (const filePath of testFiles) {
      if (hasSkipDirectiveForTarget(filePath, wasmTarget)) {
        skippedTests++;
      } else {
        filteredTestFiles.push(filePath);
      }
    }
    if (skippedTests > 0) {
      console.log(
        `${colors.yellow}Skipping ${skippedTests} test file(s) with ${directive}${colors.reset}\n`
      );
    }
  }

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
        skipped: 0,
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
    const parallelResult = await runTestsInIsolatedProcesses({
      testFiles: filteredTestFiles,
      cCompiler,
      target: options.target,
      concurrency,
      verbose: options.verbose,
      bail: options.bail,
      testNamePattern: options.testNamePattern,
      keepGeneratedFiles: options.keepGeneratedFiles,
      profile: options.profile,
      startTime,
    });
    parallelResult.skipped += skippedTests;
    return parallelResult;
  }

  // Initialize result tracking variables early so they can be used in error handling
  const allResults: TestResult[] = [];
  let passedTests = 0;
  let failedTests = 0;
  let bailed = false;

  // Process files incrementally so users get immediate feedback
  for (const filePath of filteredTestFiles) {
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

    // Pre-stringify AST to source code strings. This allows the heavy
    // AST/environment object graph from extractTests to be GC'd before
    // the test compilation loop starts (each test creates its own large
    // object graph during compilation).
    const nonTestContent = nonTestExprs
      .map((expr) => exprToString(expr.$?.originalExpr ?? expr))
      .join(";\n");

    const testsToRun: TestToRun[] = tests.map((test) => ({
      test: {
        name: test.name,
        bodyString: exprToString(
          test.bodyExpr.$?.originalExpr ?? test.bodyExpr
        ),
        usingString: test.usingExpr
          ? exprToString(test.usingExpr.$?.originalExpr ?? test.usingExpr)
          : "",
        filePath: test.filePath,
      },
      nonTestContent,
    }));

    // Release AST references so GC can collect the evaluation state
    tests = [];
    nonTestExprs = [];
    tryForceGC();

    const result = await runTestsSequentially(testsToRun, cCompiler, {
      verbose: options.verbose,
      bail: options.bail,
      keepGeneratedFiles: options.keepGeneratedFiles,
      profile: options.profile,
      wasmTarget,
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
  if (skippedTests > 0) {
    console.log(`${colors.yellow}${skippedTests} skipped${colors.reset}`);
  }
  console.log(
    `${colors.dim}${passedTests + failedTests} total (${totalDuration}ms)${colors.reset}`
  );
  console.log();

  return {
    totalTests: passedTests + failedTests,
    passed: passedTests,
    failed: failedTests,
    skipped: skippedTests,
    results: allResults,
    duration: totalDuration,
  };
}
