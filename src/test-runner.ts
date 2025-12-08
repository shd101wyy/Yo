import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { YoError } from "./error";
import {
  BuiltinKeywords,
  Expr,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
} from "./expr";
import { ModuleManager } from "./module-manager";
import Parser from "./parser";
import { TokenType } from "./token";

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
 */
export function extractTests(filePath: string): TestDeclaration[] {
  const tests: TestDeclaration[] = [];

  try {
    const inputString = fs.readFileSync(filePath, "utf-8");
    const parser = new Parser({
      modulePath: `file://${filePath}`,
      inputString,
    });
    const program = parser.getProgram();

    for (const expr of program) {
      if (
        exprIsFunctionCall(expr) &&
        exprIsFunctionCallOf(expr, BuiltinKeywords.test)
      ) {
        if (expr.args.length >= 2) {
          const testNameExpr = expr.args[0]!;
          const testBodyExpr = expr.args[1]!;

          // We need to evaluate the test name to get the string value
          // For now, we extract it from the string literal token
          let testName = "unnamed_test";
          if (
            exprIsAtom(testNameExpr) &&
            testNameExpr.token.type === TokenType.String
          ) {
            // String literal - extract the value
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
  tempDir: string,
  cCompiler: string
): TestResult {
  const startTime = Date.now();
  const sanitizedName = test.name.replace(/[^a-zA-Z0-9_]/g, "_");
  const testFilePath = path.join(tempDir, `test_${sanitizedName}.yo`);
  const testOutputPath = path.join(tempDir, `test_${sanitizedName}`);
  const testCPath = testOutputPath + ".c";

  try {
    // Generate test program
    const testProgram = generateTestProgram(test, originalFileContent);
    fs.writeFileSync(testFilePath, testProgram);

    // Compile the test using ModuleManager
    const moduleManager = new ModuleManager();

    try {
      moduleManager.compileModule(`file://${testFilePath}`, {
        emitC: false,
        debugBrc: false,
        debugConcurrency: false,
        debugAsyncAwait: false,
      });
    } catch (compileError) {
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
  } = {}
): TestRunSummary {
  const startTime = Date.now();
  const cCompiler = options.cCompiler ?? "cc";
  const results: TestResult[] = [];

  // Create temporary directory for test artifacts
  const tempDir = path.join(process.cwd(), ".yo-test-tmp");
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  console.log(
    `\n${colors.bold}${colors.cyan}Running Yo Tests${colors.reset}\n`
  );

  let totalTests = 0;
  let passedTests = 0;
  let failedTests = 0;

  for (const filePath of testFiles) {
    const relativePath = path.relative(process.cwd(), filePath);
    console.log(`${colors.dim}${relativePath}${colors.reset}`);

    const originalContent = fs.readFileSync(filePath, "utf-8");
    const tests = extractTests(filePath);

    if (tests.length === 0) {
      console.log(`  ${colors.yellow}(no tests found)${colors.reset}`);
      continue;
    }

    for (const test of tests) {
      totalTests++;
      const result = runSingleTest(test, originalContent, tempDir, cCompiler);
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

  // Clean up temp directory (optional - keep for debugging)
  // fs.rmSync(tempDir, { recursive: true, force: true });

  return {
    totalTests,
    passed: passedTests,
    failed: failedTests,
    results,
    duration: totalDuration,
  };
}
