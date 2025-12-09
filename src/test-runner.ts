import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { clearEnvContainingPrelude } from "./env";
import { YoError } from "./error";
import { clearAllGlobalImplState } from "./evaluator/index";
import {
  BuiltinKeywords,
  Expr,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
} from "./expr";
import { ModuleManager } from "./module-manager";
import { TokenType } from "./token";
import { clearAllCachedTypes } from "./types";
import { isComptStringValue } from "./value";

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

export interface TestDeclaration {
  name: string;
  bodyExpr: Expr;
  filePath: string;
  lineNumber: number;
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
 */
export function extractTests(filePath: string): TestDeclaration[] {
  const tests: TestDeclaration[] = [];

  try {
    // Clear global state before evaluating
    clearAllGlobalImplState();
    clearEnvContainingPrelude();
    clearAllCachedTypes();

    // Use ModuleManager to evaluate the file and get the evaluated expressions
    const moduleManager = new ModuleManager();
    const modulePath = `file://${filePath}`;

    const { moduleError } = moduleManager.loadModule(modulePath);
    if (moduleError) {
      console.error(
        `${colors.red}Error evaluating ${filePath}: ${moduleError.message}${colors.reset}`
      );
      return tests;
    }

    const moduleData = moduleManager.modules.get(modulePath);
    if (!moduleData) {
      console.error(
        `${colors.red}Error: Module not found after loading: ${filePath}${colors.reset}`
      );
      return tests;
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
          if (testNameExpr.$ && isComptStringValue(testNameExpr.$.value)) {
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
      }
    }
  } catch (error) {
    console.error(
      `${colors.red}Error parsing ${filePath}: ${error}${colors.reset}`
    );
  }

  return tests;
}

/**
 * Generate a standalone Yo program for a single test
 *
 * Strategy: Keep the original module content and append a main function
 * that executes the specific test body. This preserves all module-level
 * definitions (functions, types, etc.) that the test may depend on.
 */
function generateTestProgram(
  test: TestDeclaration,
  originalFileContent: string
): string {
  // The test body is a begin block, so we wrap it in a main function
  const testBodyString = exprToString(test.bodyExpr);

  // Append main function to the original file content
  // The original file already has all imports and definitions
  // If test body completes without panic/assert failure, it returns 0 (success)
  return `${originalFileContent}

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
  originalFileContent: string,
  cCompiler: string
): TestResult {
  const startTime = Date.now();
  const sanitizedName = test.name.replace(/[^a-zA-Z0-9_]/g, "_");
  const uniqueId = `${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

  // Create all temp files in the SAME directory as the original file
  // This preserves relative import paths
  const originalDir = path.dirname(test.filePath);
  const baseName = `.yo_test_${sanitizedName}_${uniqueId}`;
  const testFilePath = path.join(originalDir, `${baseName}.yo`);
  const testOutputPath = path.join(originalDir, baseName);
  const testCPath = path.join(originalDir, `${baseName}.c`);

  // Helper to clean up all temp files
  const cleanup = () => {
    for (const file of [testFilePath, testOutputPath, testCPath]) {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    }
  };

  try {
    // Clear all global state before compiling each test
    // This ensures each test runs in a clean environment
    clearAllGlobalImplState();
    clearEnvContainingPrelude();
    clearAllCachedTypes();

    // Generate test program
    const testProgram = generateTestProgram(test, originalFileContent);
    fs.writeFileSync(testFilePath, testProgram);

    // Compile the test using ModuleManager
    const moduleManager = new ModuleManager();

    try {
      moduleManager.compileModule(`file://${testFilePath}`, {
        emitC: false,
        debugGc: false,
        debugParallelism: false,
        debugAsyncAwait: false,
      });
    } catch (compileError) {
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
    fs.writeFileSync(testCPath, generatedCode);

    // Clean up temp .yo file after generating C code
    if (fs.existsSync(testFilePath)) {
      fs.unlinkSync(testFilePath);
    }

    // Compile C code
    const mimallocStaticPath = path.resolve("vendor/mimalloc/src/static.c");
    const mimallocIncludePath = path.resolve("vendor/mimalloc/include");

    const compileArgs = [
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-O0",
      testCPath,
      "-o",
      testOutputPath,
    ];

    if (fs.existsSync(mimallocStaticPath)) {
      compileArgs.push(mimallocStaticPath);
      compileArgs.push(`-I${mimallocIncludePath}`);
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

    // Run the test executable
    const runResult = spawnSync(testOutputPath, [], {
      stdio: "pipe",
      encoding: "utf-8",
      timeout: 30000, // 30 second timeout
    });

    const passed = runResult.status === 0;

    cleanup();

    return {
      testName: test.name,
      filePath: test.filePath,
      passed,
      errorMessage: passed
        ? undefined
        : `Test failed with exit code ${runResult.status}\n${runResult.stdout}\n${runResult.stderr}`,
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
 * Run all tests in the specified files
 */
export function runTests(
  testFiles: string[],
  options: {
    cCompiler?: string;
    verbose?: boolean;
    testNamePattern?: string;
  } = {}
): TestRunSummary {
  const startTime = Date.now();
  const cCompiler = options.cCompiler ?? "cc";
  const results: TestResult[] = [];

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
    `\n${colors.bold}${colors.cyan}Running Yo Tests${colors.reset}\n`
  );
  if (testNameRegex) {
    console.log(
      `${colors.dim}Filtering tests matching: ${options.testNamePattern}${colors.reset}\n`
    );
  }

  let totalTests = 0;
  let passedTests = 0;
  let failedTests = 0;

  for (const filePath of testFiles) {
    const relativePath = path.relative(process.cwd(), filePath);
    console.log(`${colors.dim}${relativePath}${colors.reset}`);

    const originalContent = fs.readFileSync(filePath, "utf-8");
    let tests = extractTests(filePath);

    if (testNameRegex) {
      tests = tests.filter((test) => testNameRegex.test(test.name));
    }

    if (tests.length === 0) {
      console.log(`  ${colors.yellow}(no tests found)${colors.reset}`);
      continue;
    }

    for (const test of tests) {
      totalTests++;
      const result = runSingleTest(test, originalContent, cCompiler);
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
          // Show a brief error message
          const firstLine = result.errorMessage.split("\n")[0];
          console.log(`    ${colors.red}${firstLine}${colors.reset}`);
        }
      }
    }

    console.log();
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
    `${colors.dim}${totalTests} total (${totalDuration}ms)${colors.reset}`
  );
  console.log();

  return {
    totalTests,
    passed: passedTests,
    failed: failedTests,
    results,
    duration: totalDuration,
  };
}
