import { spawn, spawnSync, type SpawnSyncOptions } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// On Windows, .bat/.cmd scripts require shell:true for spawnSync to find them.
const spawnShellOption: SpawnSyncOptions =
  process.platform === "win32" ? { shell: true } : {};
import {
  buildAsanRunEnvironment,
  findClangAsanDllPath,
  getCompilerInfo,
  getMacOSLsanSuppressions,
  getSanitizerFlags,
  isLiburingAvailable,
} from "./compiler-utils";
import { clearEnvContainingPrelude } from "./env";
import { describeThrown } from "./error";
import { setEvaluatorDeadline } from "./evaluator/exprs/_expr";
import { clearAllGlobalImplState } from "./evaluator/index";
import {
  BuiltinKeywords,
  type Expr,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
} from "./expr";
import { ModuleManager, canonicalizeModulePath } from "./module-manager";
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
export const DEFAULT_TEST_BATCH_SIZE = 100;

function normalizeTestBatchSize(testBatchSize: number | undefined): number {
  if (testBatchSize === undefined) {
    return DEFAULT_TEST_BATCH_SIZE;
  }
  if (!Number.isInteger(testBatchSize) || testBatchSize < 1) {
    throw new Error("--test-batch-size must be a positive integer");
  }
  return testBatchSize;
}

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
 * Check if a test file has a `pragma(Pragma.SkipWasm*)` declaration
 * matching the given WASM target.
 *
 * Pragmas:
 *   `pragma(Pragma.SkipWasm);`              — skip on ALL WASM targets
 *   `pragma(Pragma.SkipWasm32Emscripten);`  — skip wasm32-emscripten
 *   `pragma(Pragma.SkipWasm32Wasi);`        — skip wasm32-wasi
 *
 * Scans the first 50 lines of the file with a regex. We intentionally
 * don't tokenize/evaluate — this runs before the evaluator on every
 * test file, so it must stay cheap. The regex tolerates whitespace
 * and is permissive enough to match the call from anywhere in a top
 * comment-stripped header (after a doc-comment block, etc.). See
 * `pragma(...)` in `src/evaluator/builtins/pragma.ts` for the
 * authoritative semantic recognition.
 */
function hasSkipDirectiveForTarget(
  filePath: string,
  target: TargetInfo
): boolean {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n").slice(0, 50);
    const targetVariant = isTargetStandaloneWasi(target)
      ? "SkipWasm32Wasi"
      : "SkipWasm32Emscripten";
    // Match `pragma(Pragma.X)` allowing arbitrary intra-call whitespace.
    const variantPattern = (variant: string) =>
      new RegExp(`pragma\\s*\\(\\s*Pragma\\s*\\.\\s*${variant}\\s*\\)`);
    const skipAll = variantPattern("SkipWasm");
    const skipTargeted = variantPattern(targetVariant);
    return lines.some((line) => skipTargeted.test(line) || skipAll.test(line));
  } catch {
    return false;
  }
}

/**
 * Find all test files in a directory or get a single file
 */
export function findTestFiles(
  targetPath: string,
  excludePaths: string[] = []
): string[] {
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
    // Find all *.test.yo files recursively.
    // Excludes are resolved to absolute paths; a path is excluded if it equals
    // an exclude or lives under one (so `--exclude tests/internal` skips the
    // whole sub-tree). Same semantics as `collectCheckFiles` in yo-cli.ts, so
    // `test` and `check` behave identically here. Needed because the compiler's
    // own tests pull in ~99k lines via their import closure and peak at ~6.5 GB
    // each, which cannot share a CI job with the fast language tests.
    const excludes = excludePaths.map((e) => path.resolve(e));
    return findTestFilesRecursive(absolutePath, excludes);
  }

  return [];
}

function findTestFilesRecursive(
  dir: string,
  excludes: string[] = []
): string[] {
  const results: string[] = [];
  const isExcluded = (p: string): boolean =>
    excludes.some((ex) => p === ex || p.startsWith(ex + path.sep));
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (isExcluded(fullPath)) {
      continue;
    }

    if (entry.isDirectory()) {
      // Skip node_modules, vendor, .git, etc.
      if (
        !["node_modules", "vendor", ".git", "vscode-extension"].includes(
          entry.name
        )
      ) {
        results.push(...findTestFilesRecursive(fullPath, excludes));
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
export function extractTests(
  filePath: string,
  sharedManager?: ModuleManager
): ExtractTestsResult {
  const tests: TestDeclaration[] = [];
  const nonTestExprs: Expr[] = [];

  // Declare moduleManager outside try block so we can clean it up
  let moduleManager: ModuleManager | null = null;
  // Canonical, so the modules.get() below agrees with the canonical key
  // loadModule stores under.
  const modulePath = canonicalizeModulePath(`file://${filePath}`);
  // With a run-scoped shared manager, the test module (and anything only it
  // pulled in) must be scrubbed from the shared universe after extraction —
  // its impls on shared types and its pragma privileges must not leak into
  // the next file. Shared dependency modules stay cached; that reuse is the
  // whole point (plans/SHARED_MODULE_CACHE_TESTS.md).
  const scrubSharedModule = () => {
    if (sharedManager) {
      sharedManager.deleteModule(modulePath);
    }
  };

  try {
    if (sharedManager) {
      moduleManager = sharedManager;
    } else {
      // Clear global state before evaluating
      clearAllGlobalImplState();
      clearEnvContainingPrelude();
      clearAllCachedTypes();
      clearAllModuleCounters();

      // Use ModuleManager to evaluate the file and get the evaluated expressions
      moduleManager = new ModuleManager();
    }

    // Test extraction also evaluates the module in-process — arm the same
    // cooperative deadline as the sequential compile so a hung module
    // evaluation fails the file instead of hanging the runner
    // (issues/fixed/test-runner-no-compile-timeout.md).
    setEvaluatorDeadline(Date.now() + 600_000);
    let moduleError: Error | undefined;
    try {
      ({ moduleError } = moduleManager.loadModule(modulePath));
    } finally {
      setEvaluatorDeadline(undefined);
    }
    if (moduleError) {
      moduleManager = null;
      scrubSharedModule();
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
          // test "name", { body }
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
    scrubSharedModule();
  } catch (error) {
    // Ensure moduleManager is cleaned up on error
    moduleManager = null;
    scrubSharedModule();
    console.error(
      `${colors.red}Error parsing ${filePath}: ${error}${colors.reset}`
    );
    throw error;
  }

  return { tests, nonTestExprs };
}

/**
 * Generate a batched Yo program containing all test functions,
 * dispatched by the YO_TEST_INDEX environment variable.
 * This allows compiling all tests in a file into a single binary,
 * then running the binary multiple times (once per test).
 */
function generateBatchedTestProgram(
  tests: StringifiedTestData[],
  nonTestContent: string
): string {
  const lines: string[] = [];

  // Non-test content (imports, helpers, etc.)
  if (nonTestContent.trim().length > 0) {
    lines.push(nonTestContent + ";");
  }
  lines.push("");

  // Import env module for env var dispatch (unique name to avoid conflicts)
  lines.push('__yo_batch_env :: import("std/env");');
  lines.push("");

  // Inline all test bodies into main's cond branches.
  // We can't use separate functions because tests with algebraic effects
  // (unwind/given) need to be in the same codegen scope as main.
  //
  // main takes no parameters. We expose `io` as a local binding to
  // `__yo_builtin_io` (the Io instance defined in `std/prelude.yo`) so
  // test bodies that use `io.async`/`io.await`/`io.spawn`/`io.state`
  // keep compiling unchanged.
  //
  // We tried declaring `io : Io` directly so the body could reference
  // the parameter — this works in isolation but regresses 3 Thread /
  // Worker async tests where the closure captures `io`. Pre-fix, those
  // tests use `__yo_builtin_io` via the comptime alias path which the
  // capture-struct codegen handles differently than a runtime parameter.
  // Keep the alias form until the capture-of-runtime-io path is fixed.
  //
  // Tests that throw exceptions construct their own `Exception` value
  // locally (e.g. `tests/error.test.yo`); we don't inject one here.
  lines.push(`main :: (fn() -> unit)({`);
  lines.push("  io :: __yo_builtin_io;");
  lines.push("  match(__yo_batch_env.env.get(`YO_TEST_INDEX`),");
  lines.push("    .Some(__yo_test_idx) => cond(");
  for (let i = 0; i < tests.length; i++) {
    const test = tests[i]!;
    lines.push(
      "      (__yo_test_idx == `" + i + "`) => { " + test.bodyString + "; },"
    );
  }
  lines.push("      true => ()");
  lines.push("    ),");
  lines.push("    .None => ()");
  lines.push("  );");
  lines.push("});");
  lines.push("");
  lines.push("export(main);");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Batched test compilation — compile all tests in a file into one binary
// ---------------------------------------------------------------------------

interface BatchCompileResult {
  binaryPath: string;
  cleanup: () => void;
  yoCompileMs?: number;
  cCompileMs?: number;
}

/**
 * Compile all tests in a file into a single binary.
 * The binary reads YO_TEST_INDEX env var to dispatch to a test function.
 * Caller MUST call cleanup() on the returned result when done.
 */
function compileBatchedBinary(
  tests: StringifiedTestData[],
  nonTestContent: string,
  filePath: string,
  cCompiler: string,
  wasmTarget?: TargetInfo,
  keepGeneratedFiles?: boolean,
  noSanitize?: boolean,
  sharedManager?: ModuleManager
): BatchCompileResult {
  const program = generateBatchedTestProgram(tests, nonTestContent);
  const originalDir = path.dirname(filePath);
  const uniqueId = `${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  const baseName = `.yo_test_batch_${uniqueId}`;
  const testFilePath = path.join(originalDir, `${baseName}.yo`);

  const compilerInfo = getCompilerInfo(cCompiler);
  const { isMSVC, isWindows, isEmcc } = compilerInfo;
  const isWasi = wasmTarget ? isTargetStandaloneWasi(wasmTarget) : false;
  const exeExtension = isWasi
    ? ".wasm"
    : isEmcc
      ? ".js"
      : isWindows
        ? ".exe"
        : "";
  const testOutputPath = path.join(originalDir, `${baseName}${exeExtension}`);
  const testCPath = path.join(originalDir, `${baseName}.c`);
  const testWasmPath =
    isEmcc && !isWasi ? path.join(originalDir, `${baseName}.wasm`) : undefined;
  const testPdbPath = isWindows
    ? path.join(originalDir, `${baseName}.pdb`)
    : undefined;

  const cleanup = () => {
    if (keepGeneratedFiles) {
      console.log(`  ${colors.dim}Keeping generated files:${colors.reset}`);
      console.log(`    ${colors.dim}.yo file: ${testFilePath}${colors.reset}`);
      console.log(`    ${colors.dim}.c file: ${testCPath}${colors.reset}`);
      return;
    }
    const filesToClean = [testFilePath, testOutputPath, testCPath];
    if (testPdbPath) filesToClean.push(testPdbPath);
    if (testWasmPath) filesToClean.push(testWasmPath);
    for (const file of filesToClean) {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    }
  };

  // Wall-clock budget for one in-process Yo→C compile in sequential mode
  // (mirrors the 600 s C-compile spawnSync timeout below).
  const SEQUENTIAL_COMPILE_TIMEOUT_MS = 600_000;

  let moduleManager: ModuleManager | null = null;
  // The batch module (its impls, pragma privileges, dependency edges) must
  // not outlive this compile in a run-scoped shared universe — but the
  // shared dependency modules it cache-hit must (that reuse is the point,
  // plans/SHARED_MODULE_CACHE_TESTS.md).
  const scrubSharedBatchModule = () => {
    if (sharedManager) {
      sharedManager.deleteModule(`file://${testFilePath}`);
    }
  };
  try {
    fs.writeFileSync(testFilePath, program);

    if (sharedManager) {
      moduleManager = sharedManager;
    } else {
      clearAllGlobalImplState();
      clearEnvContainingPrelude();
      clearAllCachedTypes();
      clearAllModuleCounters();

      if (wasmTarget) {
        setCurrentTarget(wasmTarget);
        setTargetPointerSize(wasmTarget.pointerSizeBits);
      } else if (isEmcc) {
        const emscriptenTarget = parseTarget("wasm32-emscripten");
        setCurrentTarget(emscriptenTarget);
        setTargetPointerSize(emscriptenTarget.pointerSizeBits);
      }

      moduleManager = new ModuleManager();
    }

    const yoCompileStart = Date.now();
    try {
      // Sequential mode compiles in-process; arm the evaluator's cooperative
      // deadline so a hung Yo→C compile fails this file instead of hanging
      // the runner forever (issues/fixed/test-runner-no-compile-timeout.md).
      setEvaluatorDeadline(Date.now() + SEQUENTIAL_COMPILE_TIMEOUT_MS);
      moduleManager.compileModule(`file://${testFilePath}`, {
        emitC: false,
        debugGc: false,
        debugParallelism: false,
        debugAsyncAwait: false,
        allocator: "libc",
      });
    } catch (compileError) {
      moduleManager = null;
      scrubSharedBatchModule();
      cleanup();
      throw new Error(`Yo compilation error: ${describeThrown(compileError)}`);
    } finally {
      setEvaluatorDeadline(undefined);
    }
    const yoCompileMs = Date.now() - yoCompileStart;

    let generatedCode = moduleManager.getGeneratedCode();
    const needsIntelAsmSyntax = moduleManager.needsIntelAsmSyntax;
    const usesParallelism = moduleManager.usesParallelism;
    moduleManager = null;
    scrubSharedBatchModule();

    // On Linux, prepend a setrlimit call to increase the stack limit from the
    // default 8 MB to 64 MB.  The ELF PT_GNU_STACK linker flag (-Wl,-z,stack-size=)
    // is ignored by the kernel when RLIMIT_STACK (ulimit -s) is lower — the soft
    // limit always takes precedence.  We call setrlimit in a constructor so it runs
    // before main(), before any ASAN instrumentation touches the stack.
    // See issues/linux-test-stack-overflow.md for the full root cause analysis.
    if (process.platform === "linux") {
      generatedCode =
        `#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include <sys/resource.h>
__attribute__((constructor)) static void _yo_increase_stack_limit(void) {
  struct rlimit rl = { .rlim_cur = 64UL * 1024 * 1024, .rlim_max = RLIM_INFINITY };
  setrlimit(RLIMIT_STACK, &rl);
}
` + generatedCode;
    }

    fs.writeFileSync(testCPath, generatedCode);

    if (!keepGeneratedFiles && fs.existsSync(testFilePath)) {
      fs.unlinkSync(testFilePath);
    }

    // Build C compile args. Default sanitizer is "address"; set
    // YO_TEST_SANITIZE=thread to run test binaries under ThreadSanitizer
    // (e.g. in a Linux/Clang CI matrix that validates sync primitives).
    const sanitizerChoice =
      (process.env.YO_TEST_SANITIZE as
        | "address"
        | "leak"
        | "thread"
        | undefined) ?? "address";
    const asanFlags =
      !isMSVC && !isEmcc && !noSanitize
        ? getSanitizerFlags({ sanitize: sanitizerChoice, compilerInfo })
        : { flags: [] };

    const compileArgs = isMSVC
      ? [
          "/Od",
          "/W4",
          "/wd4100",
          "/wd4101",
          "/wd4189",
          "/wd4505",
          testCPath,
          `/Fe${testOutputPath}`,
        ]
      : [
          ...(cCompiler === "zig" ? ["cc"] : []),
          "-std=c11",
          "-fno-strict-aliasing",
          // Define signed-integer overflow as two's-complement wrap.
          // See plans/MEMORY_SAFETY.md Limitation #6 and the matching
          // codegen/index.ts setting for the rationale.
          "-fwrapv",
          // Increase bracket nesting limit (default 256 is too low for large
          // batch test binaries that include the full yo-self evaluator).
          // Not supported by MSVC, so guard on !isMSVC is applied below.
          ...(!isMSVC ? ["-fbracket-depth=1024"] : []),
          ...(isEmcc
            ? ["-w"]
            : [
                "-Wall",
                "-Wextra",
                "-Wno-unused-variable",
                "-Wno-unused-parameter",
                "-Wno-unused-function",
                "-Wno-unused-but-set-variable",
                "-Wno-unused-label",
                "-Wno-unused-value",
                "-Wno-parentheses-equality",
              ]),
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
        // Increase the stack reserve to 16 MB.  The Windows default (1 MB) is
        // too small when ASAN is enabled: ASAN disables stack frame reuse and
        // adds redzones around every local variable, inflating each frame by
        // roughly 2× compared to macOS ARM64.  Large functions in the yo-self
        // bootstrapping tests (e.g. compile_module_to_c, evaluate) have
        // hundreds of locals, and their recursive call chains exceed 8 MB on
        // x86_64 Windows.  16 MB provides sufficient headroom for all tests.
        compileArgs.splice(-2, 0, "-Wl,/STACK:16777216");
      }
    }

    if (!isWindows && !isEmcc && process.platform === "darwin") {
      // Increase the stack reserve to 256 MB on macOS.  The default 8 MB is
      // insufficient for large yo-self tests: the `evaluate` function in
      // yo-self/evaluator/eval.yo has ~2482 local variables that consume
      // ~1.5 MB of stack space per frame (at -O0, no stack-frame reuse).
      // Tests that run recursive programs through the proto-evaluator (e.g.
      // countdown(10), fibonacci(10)) require dozens of simultaneous evaluate()
      // frames.  256 MB (≈170 frames) covers all test inputs in the suite.
      // macOS linker flag: -Wl,-stack_size,<hex-bytes> (0x10000000 = 256 MB).
      compileArgs.splice(-2, 0, "-Wl,-stack_size,0x10000000");
    }

    if (!isMSVC && !isEmcc && needsIntelAsmSyntax) {
      compileArgs.splice(-2, 0, "-masm=intel");
    }

    if (!isMSVC && !isEmcc && isLiburingAvailable()) {
      compileArgs.splice(-2, 0, "-luring");
    }

    if (isEmcc) {
      compileArgs.splice(-2, 0, "-sEMULATE_FUNCTION_POINTER_CASTS=1");
      compileArgs.splice(-2, 0, "-fno-exceptions");
      if (isWasi) {
        compileArgs.splice(-2, 0, "-sSTANDALONE_WASM");
        // Increase stack and initial memory for WASI builds.  The yo-self
        // evaluator's `evaluate()` function has 693+ local variables, which
        // inflates each call frame significantly.  Emscripten's default stack
        // size (64KB) and initial memory (16MB) are insufficient for batch
        // test binaries that include the full evaluator.  16MB stack + 128MB
        // initial memory provides enough headroom for all tests.
        compileArgs.splice(-2, 0, "-sSTACK_SIZE=16777216");
        compileArgs.splice(-2, 0, "-sINITIAL_MEMORY=134217728");
      } else {
        compileArgs.splice(-2, 0, "-sNODERAWFS=1");
      }
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
    const compileResult = spawnSync(cCompiler, compileArgs, {
      stdio: "pipe",
      encoding: "utf-8",
      timeout: 600_000,
      ...spawnShellOption,
    });
    const cCompileMs = Date.now() - cCompileStart;

    if (
      compileResult.error &&
      (compileResult.error as NodeJS.ErrnoException).code === "ETIMEDOUT"
    ) {
      cleanup();
      throw new Error(
        `C compilation timed out after 600s (compiler: ${cCompiler}). ` +
          `This usually indicates a stuck linker or extremely large input. ` +
          `See issues/fixed/test-runner-no-compile-timeout.md.`
      );
    }
    if (compileResult.status !== 0) {
      cleanup();
      throw new Error(
        `C compilation failed:\n${compileResult.stderr || compileResult.stdout}`
      );
    }

    return {
      binaryPath: testOutputPath,
      cleanup,
      yoCompileMs,
      cCompileMs,
    };
  } catch (error) {
    moduleManager = null;
    if (
      error instanceof Error &&
      (error.message.startsWith("Yo compilation error:") ||
        error.message.startsWith("C compilation failed:"))
    ) {
      throw error;
    }
    cleanup();
    throw new Error(`Compilation error: ${describeThrown(error)}`);
  }
}

/**
 * Run a single test from a pre-compiled batched binary.
 * Sets YO_TEST_INDEX env var to select which test to execute.
 */
function runTestFromBatchedBinary(
  testIndex: number,
  test: StringifiedTestData,
  binaryPath: string,
  cCompiler: string,
  wasmTarget?: TargetInfo,
  profile?: boolean,
  noSanitize?: boolean
): TestResult {
  const startTime = Date.now();
  const compilerInfo = getCompilerInfo(cCompiler);
  const { isMSVC, isWindows, isEmcc } = compilerInfo;
  const isWasi = wasmTarget ? isTargetStandaloneWasi(wasmTarget) : false;
  const useAsan = !isMSVC && !isEmcc && !noSanitize;

  try {
    let runResult;

    if (isWasi) {
      const testDir = path.dirname(test.filePath);
      runResult = spawnSync(
        "wasmtime",
        [
          "-W",
          "max-wasm-stack=16777216",
          "--dir",
          testDir,
          "--dir",
          "/tmp",
          "--dir",
          process.cwd(),
          "--env",
          `YO_TEST_INDEX=${testIndex}`,
          binaryPath,
        ],
        {
          stdio: "pipe",
          encoding: "utf-8",
          timeout: 60000,
        }
      );
    } else if (isEmcc) {
      runResult = spawnSync("node", [binaryPath], {
        stdio: "pipe",
        encoding: "utf-8",
        timeout: 60000,
        env: { ...process.env, YO_TEST_INDEX: String(testIndex) },
      });
    } else {
      // Native: run with AddressSanitizer leak detection
      const isMacOS = process.platform === "darwin";
      const lsanSuppressions = getMacOSLsanSuppressions();

      let suppressionFile: string | undefined;
      if (isMacOS && lsanSuppressions) {
        suppressionFile = `${binaryPath}.lsan_supp_${testIndex}.txt`;
        fs.writeFileSync(suppressionFile, lsanSuppressions);
      }

      const asanDllPath =
        isWindows && useAsan && compilerInfo.isClangOnWindows
          ? findClangAsanDllPath(cCompiler)
          : undefined;

      const baseRunEnv = buildAsanRunEnvironment({
        compilerInfo,
        asanDllPath,
        lsanSuppressionFile: suppressionFile,
        detectLeaks: true,
      });
      const runEnv = { ...baseRunEnv, YO_TEST_INDEX: String(testIndex) };

      runResult = spawnSync(binaryPath, [], {
        stdio: "pipe",
        encoding: "utf-8",
        timeout: 60000,
        env: runEnv,
      });

      const combinedOutputInitial = `${runResult.stdout || ""}${runResult.stderr || ""}`;
      const leakDetectionNotSupported = combinedOutputInitial.includes(
        "detect_leaks is not supported"
      );

      if (leakDetectionNotSupported) {
        const runEnvNoLeaks = {
          ...buildAsanRunEnvironment({
            compilerInfo,
            asanDllPath,
            lsanSuppressionFile: suppressionFile,
            detectLeaks: false,
          }),
          YO_TEST_INDEX: String(testIndex),
        };
        runResult = spawnSync(binaryPath, [], {
          stdio: "pipe",
          encoding: "utf-8",
          timeout: 60000,
          env: runEnvNoLeaks,
        });
      }

      if (suppressionFile && fs.existsSync(suppressionFile)) {
        fs.unlinkSync(suppressionFile);
      }
    }

    const combinedOutput = `${runResult.stdout || ""}${runResult.stderr || ""}`;
    const hasMemoryLeak =
      !isEmcc &&
      (combinedOutput.includes("LeakSanitizer") ||
        combinedOutput.includes("detected memory leaks") ||
        combinedOutput.includes("Direct leak") ||
        combinedOutput.includes("Indirect leak"));

    const passed = runResult.status === 0 && !hasMemoryLeak;
    const duration = Date.now() - startTime;

    let profileInfo: string | undefined;
    if (profile) {
      profileInfo = `run=${duration}ms`;
      console.log(`    ${colors.dim}${profileInfo}${colors.reset}`);
    }

    let errorMessage: string | undefined;
    if (!passed) {
      if (hasMemoryLeak) {
        const leakMatch = combinedOutput.match(
          /=+\n([\s\S]*?SUMMARY[\s\S]*?)(\n=+|$)/
        );
        const leakInfo = leakMatch ? leakMatch[1] : combinedOutput;
        errorMessage = `Memory leak detected:\n${leakInfo}`;
      } else {
        errorMessage = `Test failed with exit code ${runResult.status} signal=${runResult.signal}\n${runResult.stdout}\n${runResult.stderr}`;
      }
    }

    return {
      testName: test.name,
      filePath: test.filePath,
      passed,
      errorMessage,
      duration,
      profileInfo,
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
  noSanitize,
  testBatchSize,
}: {
  filePath: string;
  cCompiler: string;
  target?: string;
  verbose?: boolean;
  bail?: boolean;
  testNamePattern?: string;
  keepGeneratedFiles?: boolean;
  profile?: boolean;
  noSanitize?: boolean;
  testBatchSize: number;
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
    if (noSanitize) {
      args.push("--disable-sanitize");
    }
    if (profile) {
      args.push("--profile");
    }
    args.push("--test-batch-size", String(testBatchSize));

    const child = spawn(bunExecutable, args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: process.cwd(),
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const PER_FILE_TIMEOUT_MS = 1_800_000;
    const watchdog = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore — child may have already exited
      }
    }, PER_FILE_TIMEOUT_MS);

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      clearTimeout(watchdog);
      resolve({
        filePath,
        errorMessage: `Failed to spawn isolated test process: ${error.message}`,
      });
    });

    child.on("close", (code) => {
      clearTimeout(watchdog);
      if (timedOut) {
        resolve({
          filePath,
          errorMessage:
            `Isolated test process timed out after ${PER_FILE_TIMEOUT_MS / 1000}s. ` +
            `This usually means the Yo or C compilation phase is stuck. ` +
            `See issues/fixed/test-runner-no-compile-timeout.md.`,
        });
        return;
      }
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
  noSanitize,
  testBatchSize,
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
  noSanitize?: boolean;
  testBatchSize: number;
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
        noSanitize,
        testBatchSize,
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
 * Uses batch compilation: all tests are compiled into one binary,
 * then the binary is run once per test with YO_TEST_INDEX selecting
 * which test to execute. Falls back to per-test compilation on failure.
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
    noSanitize?: boolean;
    testBatchSize: number;
    sharedManager?: ModuleManager;
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

  if (testsToRun.length === 0) {
    return { results, passedTests, failedTests, bailed };
  }

  // Helper to display a test result and update counters
  const reportResult = (test: StringifiedTestData, result: TestResult) => {
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
  };

  // Worklist of batches still to compile. Initially seeded with one
  // batch per `testBatchSize` slice of testsToRun. If a batch fails
  // to compile AND has more than one test, we don't report all of its
  // tests as failed (which conflates a single bad test with all the
  // others sharing its batch); instead we push the batch back onto the
  // worklist as two halves and retry. This bottoms out at single-test
  // batches, where compile failure is genuinely that one test's fault.
  //
  // Bisection has a `depth` to cap how many times a failing batch can
  // be split before we give up and report its tests as failed. For
  // test files where ALL tests share the same compile error (e.g. all
  // 30 imm_threading tests trip the same closure-body-emission bug),
  // unbounded bisection wastes compile time without ever finding a
  // mixed batch. Cap depth so the worst-case cost for an all-failing
  // N-test batch is bounded — once depth is exhausted, fall through
  // to the per-test "report failed" path with the original error
  // message. The cap is chosen as `ceil(log2(testBatchSize)) + 1` so
  // a full bisect of a maximally-sized initial batch can still reach
  // single-test resolution; that bound only matters as a guard
  // against pathological re-compile storms.
  type WorklistEntry = { tests: TestToRun[]; bisectDepth: number };
  const MAX_BISECT_DEPTH = Math.max(
    4,
    Math.ceil(Math.log2(Math.max(2, options.testBatchSize))) + 1
  );
  const remainingBatches: WorklistEntry[] = [];
  for (
    let batchStart = 0;
    batchStart < testsToRun.length;
    batchStart += options.testBatchSize
  ) {
    remainingBatches.push({
      tests: testsToRun.slice(batchStart, batchStart + options.testBatchSize),
      bisectDepth: 0,
    });
  }

  while (remainingBatches.length > 0) {
    if (bailed) break;
    const entry = remainingBatches.shift()!;
    const batchTests = entry.tests;
    const firstTest = batchTests[0]!;

    let batchResult: BatchCompileResult;
    try {
      batchResult = compileBatchedBinary(
        batchTests.map((t) => t.test),
        firstTest.nonTestContent,
        firstTest.test.filePath,
        cCompiler,
        options.wasmTarget,
        options.keepGeneratedFiles,
        options.noSanitize,
        options.sharedManager
      );
    } catch (compileError) {
      // If this batch has more than one test AND we haven't blown the
      // bisect-depth budget, the compile error might be caused by a
      // single bad test poisoning the whole batch. Split it in half
      // and retry. The depth cap prevents pathological re-compile
      // storms when every test shares the same fatal error.
      if (batchTests.length > 1 && entry.bisectDepth < MAX_BISECT_DEPTH) {
        const mid = Math.ceil(batchTests.length / 2);
        // Unshift in order so the first half runs next, then the second.
        remainingBatches.unshift(
          {
            tests: batchTests.slice(0, mid),
            bisectDepth: entry.bisectDepth + 1,
          },
          { tests: batchTests.slice(mid), bisectDepth: entry.bisectDepth + 1 }
        );
        continue;
      }
      const errorMsg =
        compileError instanceof Error
          ? compileError.message
          : String(compileError);
      for (const { test } of batchTests) {
        reportResult(test, {
          testName: test.name,
          filePath: test.filePath,
          passed: false,
          errorMessage: errorMsg,
          duration: 0,
        });
        if (bailed) break;
      }
      continue;
    }

    try {
      if (options.profile && batchResult.yoCompileMs != null) {
        console.log(
          `  ${colors.dim}batch: yo=${batchResult.yoCompileMs}ms cc=${batchResult.cCompileMs}ms (${batchTests.length} tests)${colors.reset}`
        );
      }

      for (let i = 0; i < batchTests.length; i++) {
        if (bailed) break;
        const test = batchTests[i]!.test;
        const result = runTestFromBatchedBinary(
          i,
          test,
          batchResult.binaryPath,
          cCompiler,
          options.wasmTarget,
          options.profile,
          options.noSanitize
        );
        reportResult(test, result);
      }
    } finally {
      batchResult.cleanup();
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
    target?: string;
    verbose?: boolean;
    bail?: boolean;
    testNamePattern?: string;
    parallel?: number;
    keepGeneratedFiles?: boolean;
    profile?: boolean;
    noSanitize?: boolean;
    testBatchSize?: number;
  } = {}
): Promise<TestRunSummary> {
  const startTime = Date.now();
  const cCompiler = options.cCompiler ?? "cc";
  const isEmcc = cCompiler === "emcc";
  const testBatchSize = normalizeTestBatchSize(options.testBatchSize);

  // Resolve the WASM target (if any)
  let wasmTarget: TargetInfo | undefined;
  if (options.target) {
    wasmTarget = parseTarget(options.target);
  } else if (isEmcc) {
    wasmTarget = parseTarget("wasm32-emscripten");
  }
  const isWasmBuild = wasmTarget !== undefined;

  // Filter out files with target-specific skip pragmas
  let skippedTests = 0;
  let filteredTestFiles = testFiles;
  if (isWasmBuild && wasmTarget) {
    const pragmaVariant = isTargetStandaloneWasi(wasmTarget)
      ? "pragma(Pragma.SkipWasm32Wasi)"
      : "pragma(Pragma.SkipWasm32Emscripten)";
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
        `${colors.yellow}Skipping ${skippedTests} test file(s) with ${pragmaVariant}${colors.reset}\n`
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
      noSanitize: options.noSanitize,
      testBatchSize,
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

  // Run-scoped shared evaluator universe for the host-target sequential
  // path: extraction and every batch compile reuse one ModuleManager, so
  // the shared dependency closure (for tests/internal, the whole ~99k-line
  // compiler) evaluates ONCE per run instead of twice per file. Per-file
  // state is scrubbed after each use (see extractTests /
  // compileBatchedBinary). WASM/emcc runs switch the compilation target,
  // which invalidates evaluated state — they keep the per-compile fresh
  // universe. See plans/SHARED_MODULE_CACHE_TESTS.md.
  // YO_TEST_NO_SHARED_UNIVERSE=1 opts out (per-compile fresh universes, the
  // pre-2026-08-15 behavior) for memory-constrained machines and for
  // A/B measurement.
  //
  // An RSS-threshold "bound" was tried here and REMOVED as measured-harmful:
  // when it fired it reclaimed nothing — instrumented resets logged
  // rssAfter == rssBefore every time (3026->3026 MB, 5402->5402 MB) while RSS
  // kept climbing — because V8 does not return its heap high-water mark to the
  // OS and `tryForceGC()` is inert unless node runs with `--expose-gc` (CI
  // passes it; the ./yo-cli wrapper does not). So the first trip made every
  // later file reset too, paying full first-touch evaluation per file for zero
  // memory saved: the tier ran 2 min SLOWER at an identical 13.8 GB peak.
  // See plans/SHARED_MODULE_CACHE_TESTS.md.
  const useSharedUniverse =
    !isWasmBuild && !isEmcc && process.env.YO_TEST_NO_SHARED_UNIVERSE !== "1";
  const sharedManager = useSharedUniverse ? new ModuleManager() : undefined;

  // Process files incrementally so users get immediate feedback
  for (const filePath of filteredTestFiles) {
    if (bailed) break;

    const relativePath = path.relative(process.cwd(), filePath);
    console.log(`${colors.dim}${relativePath}${colors.reset}`);

    let tests: TestDeclaration[];
    let nonTestExprs: Expr[];
    try {
      const result = extractTests(filePath, sharedManager);
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
      noSanitize: options.noSanitize,
      testBatchSize,
      sharedManager,
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

    if (process.env.YO_TEST_DEBUG_SHARED) {
      const rssMb = (process.memoryUsage().rss / (1024 * 1024)).toFixed(0);
      console.log(
        `${colors.dim}[shared] shared=${useSharedUniverse} rss=${rssMb}MB after ${relativePath}${colors.reset}`
      );
    }
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
