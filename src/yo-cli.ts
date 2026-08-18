import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import packageJson from "../package.json";
import { runBuild } from "./build-runner";
import { getGlobalCacheDir } from "./cache";
import { CodeGenerator } from "./codegen";
import { _printFrameIndexStats } from "./env";
import { _printCallProfile } from "./evaluator/calls/helper";
import { _printSynthStats } from "./evaluator/types/synthesizer";
import { findAvailableCompiler } from "./compiler-utils";
import {
  clearBuildRegistry,
  getBuildRegistry,
} from "./evaluator/builtins/build";
import { formatYoFiles } from "./formatter";
import { initProject } from "./init";
import { formatUnsafeReport, generateUnsafeReport } from "./unsafe-report";
import {
  formatPublicSafeReport,
  generatePublicSafeReport,
} from "./public-safe-report";
import { ModuleManager, setStdPathOverride } from "./module-manager";
import {
  hostTarget,
  isTargetStandaloneWasi,
  isTargetWindows,
  parseTarget,
} from "./target";
import {
  DEFAULT_TEST_BATCH_SIZE,
  findTestFiles,
  runTests,
} from "./test-runner";
import { getCurrentYoVersion, readYoVersion } from "./version";
import {
  cachedBinaryPath,
  cleanVersionCache,
  ensureCachedVersion,
  fetchRemoteVersions,
  isVersionCached,
  listCachedVersions,
} from "./version-cache";

const TEST_SUMMARY_MARKER = "__YO_TEST_SUMMARY__";

// Collect .yo files to type-check. Accepts either a single file (must end in
// `.yo`) or a directory (walked recursively; `.test.yo` files are included
// since their bodies are evaluator-typecheckable; noisy infrastructure dirs
// like `node_modules` / `.git` are skipped).
function collectCheckFiles(
  targetPath: string,
  excludePaths: string[] = []
): string[] {
  const absolutePath = path.resolve(targetPath);
  // Resolve excludes to absolute paths; a path is excluded if it equals an
  // exclude or lives under one (so `--exclude tests/internal` skips the whole
  // subtree). Lets a single directory `check` skip known-broken sub-trees
  // instead of falling back to slow per-file checking.
  const excludes = excludePaths.map((e) => path.resolve(e));
  const isExcluded = (p: string): boolean =>
    excludes.some((ex) => p === ex || p.startsWith(ex + path.sep));
  const stats = fs.statSync(absolutePath);
  if (stats.isFile()) {
    if (!absolutePath.endsWith(".yo")) {
      console.error(`check: not a .yo file: ${absolutePath}`);
      process.exit(1);
    }
    return isExcluded(absolutePath) ? [] : [absolutePath];
  }
  if (stats.isDirectory()) {
    const out: string[] = [];
    walkCheckDir(absolutePath, out, isExcluded);
    out.sort();
    return out;
  }
  return [];
}

function walkCheckDir(
  dir: string,
  out: string[],
  isExcluded: (p: string) => boolean = () => false
): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (isExcluded(full)) {
      continue;
    }
    if (entry.isDirectory()) {
      if (
        ![
          "node_modules",
          "vendor",
          ".git",
          "vscode-extension",
          "outdated",
        ].includes(entry.name)
      ) {
        walkCheckDir(full, out, isExcluded);
      }
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".yo") &&
      // Skip dot-prefixed `.yo` files — these are auto-generated, not-yet-
      // cleaned-up test-batch artifacts (`.yo_test_batch_<ts>_<rand>.yo`),
      // not source files, and shouldn't be type-checked.
      !entry.name.startsWith(".")
    ) {
      out.push(full);
    }
  }
}

// ── Version re-dispatch ─────────────────────────────────────────────────
// Before yargs processes any command, check `.yo-version` and re-dispatch
// to the pinned version if it differs from the currently running version.
// Skip re-dispatch for:
//   - `yo version ...` commands (manage versions locally)
//   - `yo lsp` (LSP handles its own std path resolution)
//   - When already dispatched (YO_VERSION_DISPATCHED=1)

const rawArgs = hideBin(process.argv);
const firstArg = rawArgs[0];
const shouldSkipDispatch =
  process.env.YO_VERSION_DISPATCHED === "1" ||
  firstArg === "version" ||
  firstArg === "lsp" ||
  firstArg === "--help" ||
  firstArg === "-h" ||
  firstArg === "--version";

const dispatchCwd = process.env.YO_ORIGINAL_CWD ?? process.cwd();

if (!shouldSkipDispatch) {
  const pinnedVersion = readYoVersion(dispatchCwd);
  if (pinnedVersion && pinnedVersion !== getCurrentYoVersion()) {
    // Synchronously ensure the version is cached and re-dispatch
    (async () => {
      try {
        const cachedDir = await ensureCachedVersion(pinnedVersion);
        // Cached versions are NATIVE release bundles (bin/yo + std/ +
        // vendor/, self-locating) — spawn the binary directly; no JS
        // runtime involved. See plans/P3_DISTRIBUTION.md item 2.
        const binPath = cachedBinaryPath(cachedDir);

        if (!fs.existsSync(binPath)) {
          console.error(
            `Error: Cached Yo v${pinnedVersion} is missing its compiler binary at ${binPath}`
          );
          process.exit(1);
        }

        // execFileSync throws on non-zero exit; success returns here
        execFileSync(binPath, rawArgs, {
          stdio: "inherit",
          cwd: dispatchCwd,
          env: {
            ...process.env,
            YO_VERSION_DISPATCHED: "1",
            YO_ORIGINAL_CWD: dispatchCwd,
          },
        });
        process.exit(0);
      } catch (err) {
        if (
          err &&
          typeof err === "object" &&
          "status" in err &&
          typeof (err as { status: unknown }).status === "number"
        ) {
          // Child process exited with non-zero status
          process.exit((err as { status: number }).status);
        }
        console.error(
          `Error dispatching to Yo v${pinnedVersion}:`,
          err instanceof Error ? err.message : err
        );
        process.exit(1);
      }
    })();
    // The async IIFE above calls process.exit, so the code below this
    // block will not run for the re-dispatch case. However, for TypeScript
    // control flow, we don't continue to yargs setup below.
    // We use a module-level guard to prevent yargs from running.
  } else {
    // No re-dispatch needed — continue to yargs
    runCli();
  }
} else {
  runCli();
}

function runCli(): void {
  yargs(hideBin(process.argv))
    .scriptName("yo")
    .wrap(null)
    .option("std-path", {
      type: "string",
      describe:
        "Path to the standard-library root (overrides YO_STD and the default search next to the compiler)",
    })
    .middleware((argv) => {
      if (typeof argv.stdPath === "string" && argv.stdPath.length > 0) {
        setStdPathOverride(argv.stdPath);
      }
    })
    .usage(
      `The Yo Programming Language ${packageJson.version}
Usage:

yo compile <file> [options]      Compile a '.yo' file
Examples:
  $ yo compile main.yo -o app
  $ yo compile main.yo -cc clang -o app
  $ yo compile main.yo --target x86_64-linux-gnu -o app
  $ yo compile main.yo -l m -o app
  $ yo compile main.yo -I./include -L./lib -l mylib -o app
  $ yo compile main.yo --release -D NDEBUG -o app
  $ yo compile main.yo -g -o app_debug
  $ yo compile main.yo --release -s --cflags='-march=native' -o app

yo build [steps] [options]       Build project using build.yo
Examples:
  $ yo build                     Build all artifacts (default: install step)
  $ yo build run                 Build and run the application
  $ yo build test                Run the test suite
  $ yo build --list-steps        Show available build steps
  $ yo build --summary           Print build summary tree
  $ yo build -Dstrip=true        Pass build option to build.yo

yo init [dir] [options]          Initialize a new Yo project
Examples:
  $ yo init                      Initialize in current directory
  $ yo init my-project           Initialize in ./my-project

yo fetch [options]               Fetch git dependencies into .yo-cache
Examples:
  $ yo fetch                     Fetch all dependencies from build.yo
  $ yo fetch --verbose           Show detailed fetch progress
  $ yo fetch --update            Re-resolve refs to latest commits

yo install <package>             Install a dependency from GitHub
Examples:
  $ yo install github.com/user/repo          Latest semver tag
  $ yo install github.com/user/repo@v1.0.0   Pinned version
  $ yo install user/repo                     Shorthand for GitHub

yo test [path] [options]         Run tests
Example:
  $ yo test                      Run all *.test.yo files in the workspace
  $ yo test ./tests              Run all *.test.yo files in ./tests directory
  $ yo test ./some-file.yo       Run tests in some-file.yo

yo fmt [paths...] [options]      Format Yo source files
Examples:
  $ yo fmt                       Format all .yo files in the current directory
  $ yo fmt src tests             Format .yo files under src and tests
  $ yo fmt --check               Check formatting without writing files

yo doc [path] [options]          Generate API documentation
Examples:
  $ yo doc                       Document all .yo files in current directory
  $ yo doc ./src                 Document all .yo files in ./src
  $ yo doc ./src/main.yo         Document a single file
  $ yo doc -o docs               Output to ./docs directory
  $ yo doc --title "My Project"  Set doc site title

yo version                       Manage Yo versions
Examples:
  $ yo version                     Show current version and .yo-version
  $ yo version pin                 Pin current version to .yo-version
  $ yo version pin 0.1.12          Pin specific version
  $ yo version install 0.1.12      Pre-download a version
  $ yo version list                List cached versions
  $ yo version clean               Remove all cached versions

yo --help                        Show this help message
yo --version                     Show version number
`
    )
    .command(
      "compile <file>",
      "Compile a '.yo' file",
      (_yargs) => {
        _yargs
          .positional("file", {
            describe: "File to compile",
            type: "string",
            demandOption: true,
          })
          .option("o", {
            alias: "output",
            describe: "Output file",
            type: "string",
            demandOption: false,
            default: "a.out",
          })
          .option("cc", {
            alias: "c-compiler",
            describe:
              "C Compiler to use: 'cc', 'gcc', 'clang', 'zig', 'cl' (MSVC), or 'emcc' (Emscripten/WASM)",
            type: "string",
            demandOption: false,
            choices: ["cc", "gcc", "clang", "zig", "cl", "emcc"],
          })
          .option("t", {
            alias: "target",
            describe:
              "Target triple (e.g. x86_64-linux-gnu, x86_64-linux-musl, wasm32-emscripten). Must match host architecture; WASM targets are always cross-compilable. Defaults to host.",
            type: "string",
            demandOption: false,
          })
          .option("sysroot", {
            describe: "Sysroot directory for cross-compilation.",
            type: "string",
            demandOption: false,
          })
          .option("I", {
            alias: "include-path",
            describe:
              "Add directory to include search path (like gcc -I). Can be specified multiple times.",
            type: "array",
            demandOption: false,
            default: [],
          })
          .option("L", {
            alias: "library-path",
            describe:
              "Add directory to library search path (like gcc -L). Can be specified multiple times.",
            type: "array",
            demandOption: false,
            default: [],
          })
          .option("l", {
            alias: "library",
            describe:
              "Link against library (like gcc -l). Can be specified multiple times. Example: -l m",
            type: "array",
            demandOption: false,
            default: [],
          })
          .option("D", {
            alias: "define",
            describe:
              "Define preprocessor macro (like gcc -D). Can be specified multiple times. Example: -D DEBUG -D VERSION=1",
            type: "array",
            demandOption: false,
            default: [],
          })
          .option("emit-c", {
            describe: "Print C code generated.",
            type: "boolean",
            demandOption: false,
            default: false,
          })
          .option("emit-c-to", {
            describe:
              "Write the generated C to this path instead of <output>.c.",
            type: "string",
            demandOption: false,
          })
          .option("skip-codegen", {
            describe: "Do not compile the code.",
            type: "boolean",
            demandOption: false,
            default: false,
          })
          .option("skip-c-compiler", {
            describe: "Generate C code but skip running the C compiler.",
            type: "boolean",
            demandOption: false,
            default: false,
          })
          .option("debug-gc", {
            describe:
              "Enable debug logging for GC and reference counting operations.",
            type: "boolean",
            demandOption: false,
            default: false,
          })
          .option("debug-parallelism", {
            describe:
              "Enable debug logging for parallel worker thread operations.",
            type: "boolean",
            demandOption: false,
            default: false,
          })
          .option("debug-async-await", {
            describe:
              "Enable debug logging for async/await state machine operations.",
            type: "boolean",
            demandOption: false,
            default: false,
          })
          .option("allocator", {
            describe:
              "Memory allocator to use: 'system' (default; the platform allocator) or 'mimalloc'. 'libc' is a deprecated alias of 'system', scheduled for removal.",
            type: "string",
            demandOption: false,
            default: "system",
            choices: ["mimalloc", "system", "libc"],
          })
          .option("release", {
            describe:
              "Build in release mode with optimizations (-O2, no warnings).",
            type: "boolean",
            demandOption: false,
            default: false,
          })
          .option("optimize", {
            describe:
              "Set optimization level (0, 1, 2, 3). Overrides --release.",
            type: "string",
            demandOption: false,
            choices: ["0", "1", "2", "3"],
          })
          .option("extern", {
            describe:
              "External C files to link with. eg: --extern extern1.c extern2.c",
            type: "array",
            demandOption: false,
            default: [],
          })
          .option("sanitize", {
            describe:
              "Enable a sanitizer. 'address' (full AddressSanitizer), 'leak' (LeakSanitizer only), or 'thread' (ThreadSanitizer for data-race detection in cross-thread code).",
            type: "string",
            demandOption: false,
            choices: ["address", "leak", "thread"],
          })
          .option("g", {
            alias: "debug-symbols",
            describe: "Include debug symbols in the binary (like gcc -g).",
            type: "boolean",
            demandOption: false,
            default: false,
          })
          .option("s", {
            alias: "strip",
            describe:
              "Strip symbols from the binary to reduce size (like gcc -s).",
            type: "boolean",
            demandOption: false,
            default: false,
          })
          .option("static", {
            describe: "Produce a statically linked binary.",
            type: "boolean",
            demandOption: false,
            default: false,
          })
          .option("static-library", {
            describe: "Compile as a static library (.a archive).",
            type: "boolean",
            demandOption: false,
            default: false,
          })
          .option("cflags", {
            describe:
              "Pass arbitrary flags directly to the C compiler. Example: --cflags '-march=native -mtune=native'",
            type: "string",
            demandOption: false,
          });
      },
      (argv) => {
        const file = argv.file as string;
        if (!fs.existsSync(file)) {
          console.log(`File ${file} does not exist`);
          return;
        }

        let cCompiler = argv.cc as string | undefined;
        const targetTripleArg = argv.t as string | undefined;

        // Auto-select emcc for WASM targets
        if (!cCompiler && targetTripleArg?.startsWith("wasm")) {
          cCompiler = "emcc";
        }

        if (!cCompiler) {
          const availableCompiler = findAvailableCompiler();
          if (!availableCompiler) {
            console.error(
              "Error: No C compiler found. Please install a C compiler (cc, gcc, clang, zig, or cl) or specify one using the -cc/--c-compiler flag."
            );
            process.exit(1);
          }
          cCompiler = availableCompiler;
        }

        // When using emcc (Emscripten), auto-set target to wasm32-emscripten if not specified
        const isEmcc = cCompiler === "emcc";
        const targetTriple =
          targetTripleArg ?? (isEmcc ? "wasm32-emscripten" : undefined);

        const absolutePath = `file://` + fs.realpathSync(file);
        const targetInfo = targetTriple
          ? parseTarget(targetTriple)
          : hostTarget();
        const requestedOutput = argv.o as string;
        // Auto-add extension when output has no extension
        let outputPath: string;
        if (isEmcc && path.extname(requestedOutput) === "") {
          outputPath = isTargetStandaloneWasi(targetInfo)
            ? `${requestedOutput}.wasm`
            : `${requestedOutput}.html`;
        } else if (
          isTargetWindows(targetInfo) &&
          path.extname(requestedOutput) === ""
        ) {
          outputPath = `${requestedOutput}.exe`;
        } else {
          outputPath = requestedOutput;
        }

        const codeGenerator = new CodeGenerator();
        codeGenerator.compileModule(absolutePath, {
          output: outputPath,
          cCompiler,
          target: "c",
          targetTriple,
          sysroot: argv.sysroot as string | undefined,
          extern: (argv.extern ?? []) as string[],
          includePaths: (argv.I ?? []) as string[],
          libraryPaths: (argv.L ?? []) as string[],
          libraries: (argv.l ?? []) as string[],
          defines: (argv.D ?? []) as string[],
          emitC: argv.emitC as boolean,
          emitCTo: argv.emitCTo as string | undefined,
          skipCodegen: argv.skipCodegen as boolean,
          skipCCompiler: argv.skipCCompiler as boolean,
          debugGc: argv.debugGc as boolean,
          debugParallelism: argv.debugParallelism as boolean,
          debugAsyncAwait: argv.debugAsyncAwait as boolean,
          release: argv.release as boolean,
          optimize: argv.optimize as "0" | "1" | "2" | "3" | undefined,
          allocator: argv.allocator as "mimalloc" | "system" | "libc",
          sanitize: argv.sanitize as "address" | "leak" | "thread" | undefined,
          debugSymbols: argv.g as boolean,
          strip: argv.s as boolean,
          static: argv.static as boolean,
          staticLibrary: argv.staticLibrary as boolean,
          cflags: argv.cflags as string | undefined,
        });
        _printCallProfile();
        _printFrameIndexStats();
        _printSynthStats();
      }
    )
    .command(
      "check <path>",
      "Type-check (run the evaluator on) a .yo file or every .yo file in a directory — no codegen",
      (_yargs) => {
        _yargs.positional("path", {
          describe: "File or directory to check",
          type: "string",
          demandOption: true,
        });
        _yargs.option("exclude", {
          type: "array",
          describe:
            "Path(s) to exclude when checking a directory (file or sub-directory; repeatable)",
          default: [],
        });
      },
      (argv) => {
        // `check` is `compile` with `--skip-codegen --skip-c-compiler`
        // and no output binary. The TS evaluator runs during module
        // loading, so any coverage gap surfaces as a thrown error
        // before codegen would have started.
        const targetPath = argv.path as string;
        if (!fs.existsSync(targetPath)) {
          console.error(`check: path does not exist: ${targetPath}`);
          process.exit(1);
        }
        const excludePaths = (
          (argv.exclude as unknown[] | undefined) ?? []
        ).map((e) => String(e));
        const files = collectCheckFiles(targetPath, excludePaths);
        if (files.length === 0) {
          console.error(`check: no .yo files found at ${targetPath}`);
          process.exit(1);
        }
        // Reuse a single CodeGenerator across files so the
        // ModuleManager's module cache persists. Without this, every
        // file in a directory reloads the prelude + all transitive
        // imports from scratch — for large trees (e.g. yo-self/, 223
        // files) the cost compounds dramatically.
        //
        // With reuse, a file that was already loaded as a dependency
        // of an earlier file is a cache hit on the second pass; we
        // still re-run the "evaluator OK" report so the user sees
        // each file marked, but no real work happens.
        const codeGenerator = new CodeGenerator();
        let failed = 0;
        for (const file of files) {
          const absolutePath = `file://` + fs.realpathSync(file);
          try {
            codeGenerator.compileModule(absolutePath, {
              output: "/tmp/yo_check_noop",
              cCompiler: "cc",
              target: "c",
              extern: [],
              includePaths: [],
              libraryPaths: [],
              libraries: [],
              defines: [],
              emitC: false,
              skipCodegen: true,
              skipCCompiler: true,
              debugGc: false,
              debugParallelism: false,
              debugAsyncAwait: false,
              release: false,
              allocator: "system",
            });
            console.log(`check: ${file} — evaluator OK`);
          } catch (err) {
            failed += 1;
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`check: ${file} — FAILED\n${msg}`);
          }
        }
        if (files.length > 1) {
          console.log(
            `check: ${files.length - failed}/${files.length} file(s) passed`
          );
        }
        if (failed > 0) {
          process.exit(1);
        }
      }
    )
    .command(
      "unsafe-report [path]",
      "List every unsafe(...) site, asm/extern declaration, and pragma(Pragma.AllowUnsafe);-declaring file. Audit-friendly output for memory-safety review.",
      (_yargs) => {
        _yargs
          .positional("path", {
            describe: "File or directory to scan (default: current directory)",
            type: "string",
            default: ".",
          })
          .option("json", {
            describe:
              "Emit machine-readable JSON instead of the formatted report",
            type: "boolean",
            default: false,
          });
      },
      (argv) => {
        const targetPath = (argv.path as string) ?? ".";
        if (!fs.existsSync(targetPath)) {
          console.error(`unsafe-report: path does not exist: ${targetPath}`);
          process.exit(1);
        }
        const report = generateUnsafeReport(targetPath);
        if (argv.json as boolean) {
          console.log(JSON.stringify(report, null, 2));
        } else {
          console.log(formatUnsafeReport(report));
        }
      }
    )
    .command(
      "public-safe-report [path]",
      "Lint public stdlib signatures for raw-pointer leaks. Reports every top-level public `fn(...)` declaration in the scanned tree whose parameters or return type expose `*(T)` outside an `extern(...)` block. Names ending in `_cstr`, `_ptr`, `_raw`, or `from_raw_parts` / `as_ptr` are treated as raw-pointer-API by contract and skipped. Whole files under `libc/`, `linux/`, `darwin/`, `cuda/` are skipped — those are FFI by construction. Exits 0 even when findings exist; the lint is informational.",
      (_yargs) => {
        _yargs
          .positional("path", {
            describe: "File or directory to scan (default: ./std)",
            type: "string",
            default: "./std",
          })
          .option("json", {
            describe:
              "Emit machine-readable JSON instead of the formatted report",
            type: "boolean",
            default: false,
          });
      },
      (argv) => {
        const targetPath = (argv.path as string) ?? "./std";
        if (!fs.existsSync(targetPath)) {
          console.error(
            `public-safe-report: path does not exist: ${targetPath}`
          );
          process.exit(1);
        }
        const report = generatePublicSafeReport(targetPath);
        if (argv.json as boolean) {
          console.log(JSON.stringify(report, null, 2));
        } else {
          console.log(formatPublicSafeReport(report));
        }
      }
    )
    .command(
      "test [path]",
      "Run tests in .test.yo files",
      (_yargs) => {
        _yargs
          .positional("path", {
            describe:
              "Path to test file or directory (default: current directory)",
            type: "string",
            default: ".",
          })
          .option("cc", {
            alias: "c-compiler",
            describe:
              "C Compiler to use: 'cc', 'gcc', 'clang', 'zig', 'cl' (MSVC), or 'emcc' (Emscripten/WASM)",
            type: "string",
            choices: ["cc", "gcc", "clang", "zig", "cl", "emcc"],
          })
          .option("target", {
            describe:
              "Target triple (e.g., 'wasm-emscripten', 'wasm-wasi', 'x86_64-linux-musl'). Must match host architecture; WASM targets are always cross-compilable.",
            type: "string",
          })
          .option("verbose", {
            alias: "v",
            describe: "Show detailed error messages",
            type: "boolean",
            default: false,
          })
          .option("bail", {
            alias: "b",
            describe: "Stop running tests after the first failure",
            type: "boolean",
            default: false,
          })
          .option("test-name-pattern", {
            describe: "Only run tests with names matching this regex pattern",
            type: "string",
          })
          .option("parallel", {
            alias: "p",
            describe:
              "Number of test files to run in parallel (0 = auto/max CPUs, 1 = sequential)",
            type: "number",
            default: 0,
          })
          .option("keep-generated-files", {
            alias: "k",
            describe:
              "Keep generated .yo and .c test files for debugging (not deleted after test)",
            type: "boolean",
            default: false,
          })
          .option("disable-sanitize", {
            describe:
              "Disable AddressSanitizer for test binaries (workaround for macOS 26 AMFI blocking the Nix-store ASAN dylib). Note: to switch the sanitizer for test binaries (e.g., to ThreadSanitizer), set the YO_TEST_SANITIZE=thread environment variable.",
            type: "boolean",
            default: false,
          })
          .option("json-summary", {
            describe:
              "Internal: print machine-readable summary line for isolated parallel test execution",
            type: "boolean",
            default: false,
          })
          .option("profile", {
            describe:
              "Print per-test timing breakdown (Yo compile, C compile, run) and heap usage",
            type: "boolean",
            default: false,
          })
          .option("test-batch-size", {
            describe:
              "Maximum number of tests to compile into one generated test binary",
            type: "number",
            default: DEFAULT_TEST_BATCH_SIZE,
          })
          .option("exclude", {
            type: "array",
            describe:
              "Path(s) to exclude when running a directory (file or sub-directory; repeatable)",
            default: [],
          });
      },
      async (argv) => {
        const targetPath = argv.path as string;
        // Same semantics as `check --exclude`. Needed so the fast language
        // suite can skip `tests/internal`, whose files each pull in ~99k lines
        // through their import closure and peak at ~6.5 GB — they cannot share a
        // CI job that runs `--parallel 2` under `--max-old-space-size=4096`.
        const excludePaths = (
          (argv.exclude as unknown[] | undefined) ?? []
        ).map((e) => String(e));
        const testFiles = findTestFiles(targetPath, excludePaths);

        if (testFiles.length === 0) {
          console.log("No test files found.");
          process.exit(0);
        }

        const parallel = argv.parallel as number;
        if (parallel < 0) {
          console.error("Error: --parallel value cannot be negative");
          process.exit(1);
        }
        const testBatchSize = argv.testBatchSize as number;
        if (!Number.isInteger(testBatchSize) || testBatchSize < 1) {
          console.error("Error: --test-batch-size must be a positive integer");
          process.exit(1);
        }

        let cCompiler = argv.cc as string | undefined;
        const target = argv.target as string | undefined;

        // Auto-select emcc for WASM targets
        if (
          target &&
          (target.includes("wasm") ||
            target.includes("emscripten") ||
            target.includes("wasi")) &&
          !cCompiler
        ) {
          cCompiler = "emcc";
        }

        if (!cCompiler) {
          const availableCompiler = findAvailableCompiler();
          if (!availableCompiler) {
            console.error(
              "Error: No C compiler found. Please install a C compiler (cc, gcc, clang, zig, or cl) or specify one using the -cc/--c-compiler flag."
            );
            process.exit(1);
          }
          cCompiler = availableCompiler;
        }

        const summary = await runTests(testFiles, {
          cCompiler,
          target,
          verbose: argv.verbose as boolean,
          bail: argv.bail as boolean,
          testNamePattern: argv.testNamePattern as string | undefined,
          parallel,
          keepGeneratedFiles: argv.keepGeneratedFiles as boolean,
          noSanitize: argv.disableSanitize as boolean,
          profile: argv.profile as boolean,
          testBatchSize,
        });

        if (argv.jsonSummary as boolean) {
          console.log(`${TEST_SUMMARY_MARKER}${JSON.stringify(summary)}`);
        }

        process.exit(summary.failed > 0 ? 1 : 0);
      }
    )
    .command(
      "init [dir]",
      "Initialize a new Yo project",
      (_yargs) => {
        _yargs
          .positional("dir", {
            describe: "Directory to initialize (default: current directory)",
            type: "string",
            default: ".",
          })
          .option("name", {
            describe: "Project name (default: directory name)",
            type: "string",
          });
      },
      (argv) => {
        initProject({
          dir: argv.dir as string,
          name: argv.name as string | undefined,
        });
      }
    )
    .command(
      "fetch",
      "Fetch git dependencies into global cache",
      (_yargs) => {
        _yargs
          .option("build-file", {
            describe: "Path to build file",
            type: "string",
            default: "./build.yo",
          })
          .option("verbose", {
            alias: "v",
            describe: "Verbose output",
            type: "boolean",
            default: false,
          })
          .option("update", {
            alias: "u",
            describe:
              "Re-resolve git refs to latest commits and update yo.lock",
            type: "boolean",
            default: false,
          });
      },
      async (argv) => {
        const { runFetch } = await import("./fetch-command");
        await runFetch({
          buildFile: argv.buildFile as string,
          verbose: argv.verbose as boolean,
          update: argv.update as boolean,
        });
      }
    )
    .command(
      "install <package>",
      "Install a dependency from GitHub",
      (_yargs) => {
        _yargs
          .positional("package", {
            describe:
              "Package specifier: github.com/user/repo, user/repo, or URL. " +
              "Append @version to pin (e.g., github.com/user/repo@v1.0.0)",
            type: "string",
            demandOption: true,
          })
          .option("build-file", {
            describe: "Path to build file",
            type: "string",
            default: "./build.yo",
          })
          .option("verbose", {
            alias: "v",
            describe: "Verbose output",
            type: "boolean",
            default: false,
          });
      },
      async (argv) => {
        const { runInstall } = await import("./install-command");
        await runInstall({
          package: argv.package as string,
          buildFile: argv.buildFile as string,
          verbose: argv.verbose as boolean,
        });
      }
    )
    .command(
      "build [steps..]",
      "Build project using build.yo",
      (_yargs) => {
        _yargs
          .positional("steps", {
            describe:
              "Named steps to run (default: install). Common: run, test",
            type: "string",
            array: true,
          })
          .option("cc", {
            alias: "c-compiler",
            describe:
              "C Compiler to use: 'cc', 'gcc', 'clang', 'zig', 'cl' (MSVC), or 'emcc' (Emscripten/WASM)",
            type: "string",
            choices: ["cc", "gcc", "clang", "zig", "cl", "emcc"],
          })
          .option("t", {
            alias: "target",
            describe:
              "Target triple (e.g. x86_64-linux-gnu, x86_64-linux-musl, wasm32-emscripten). Must match host architecture; WASM targets are always cross-compilable.",
            type: "string",
          })
          .option("sysroot", {
            describe: "Sysroot directory for cross-compilation.",
            type: "string",
          })
          .option("build-file", {
            describe: "Path to build file",
            type: "string",
            default: "./build.yo",
          })
          .option("list-steps", {
            describe: "List available build steps",
            type: "boolean",
            default: false,
          })
          .option("dry-run", {
            describe: "Show what would be built without building",
            type: "boolean",
            default: false,
          })
          .option("verbose", {
            alias: "v",
            describe: "Verbose build output",
            type: "boolean",
            default: false,
          })
          .option("summary", {
            describe: "Print build summary tree after completion",
            type: "boolean",
            default: false,
          })
          .parserConfiguration({ "unknown-options-as-args": true });

        // When --help is requested, evaluate build.yo to discover project options
        if (process.argv.includes("--help") || process.argv.includes("-h")) {
          try {
            const userCwd = process.env.YO_ORIGINAL_CWD ?? process.cwd();
            const buildFile = path.resolve(userCwd, "./build.yo");
            if (fs.existsSync(buildFile)) {
              clearBuildRegistry();
              const modulePath = `file://${fs.realpathSync(buildFile)}`;
              const moduleManager = new ModuleManager();
              moduleManager.loadModule(modulePath);
              moduleManager.resetAllState();
              const registry = getBuildRegistry();
              if (registry.declaredOptions.size > 0) {
                let epilog = "Project-Specific Options:";
                for (const [name, opt] of registry.declaredOptions) {
                  epilog += `\n  -D${name}\t${opt.description} [default: ${opt.defaultValue}]`;
                }
                _yargs.epilog(epilog);
              }
            }
          } catch (e) {
            // Silently ignore — build.yo may not exist or may have errors
            if (process.env.YO_DEBUG_HELP) {
              console.error("Debug: build.yo evaluation failed:", e);
            }
          }
        }
      },
      async (argv) => {
        // Parse -Dname=value flags from process.argv (yargs doesn't handle -D natively)
        const defines: Record<string, string> = {};
        for (const arg of process.argv) {
          if (arg.startsWith("-D")) {
            const rest = arg.slice(2);
            const eqIdx = rest.indexOf("=");
            if (eqIdx >= 0) {
              defines[rest.slice(0, eqIdx)] = rest.slice(eqIdx + 1);
            } else {
              defines[rest] = "true";
            }
          }
        }
        await runBuild({
          buildFile: argv.buildFile as string,
          targetTriple: argv.t as string | undefined,
          sysroot: argv.sysroot as string | undefined,
          verbose: argv.verbose as boolean,
          dryRun: argv.dryRun as boolean,
          listSteps: argv.listSteps as boolean,
          steps: argv.steps as string[] | undefined,
          cCompiler: argv.cc as string | undefined,
          defines: Object.keys(defines).length > 0 ? defines : undefined,
          summary: argv.summary as boolean,
        });
      }
    )
    .command(
      "fmt [paths..]",
      "Format Yo source files",
      (_yargs) => {
        _yargs
          .positional("paths", {
            describe:
              "Files or directories to format (default: current directory)",
            type: "string",
            array: true,
          })
          .option("check", {
            describe: "Check formatting without writing changes",
            type: "boolean",
            default: false,
          });
      },
      (argv) => {
        try {
          const paths = (argv.paths as string[] | undefined) ?? [];
          const cwd = process.env.YO_ORIGINAL_CWD ?? process.cwd();
          const result = formatYoFiles(paths, {
            check: argv.check as boolean,
            cwd,
          });

          if ((argv.check as boolean) && result.changed.length > 0) {
            console.error("The following Yo files need formatting:");
            for (const file of result.changed) {
              console.error(path.relative(cwd, file));
            }
            process.exit(1);
          }

          if (!(argv.check as boolean) && result.changed.length > 0) {
            console.log(`Formatted ${result.changed.length} Yo file(s).`);
          }
        } catch (error) {
          console.error(error instanceof Error ? error.message : String(error));
          process.exit(1);
        }
      }
    )
    .command(
      "doc [path]",
      "Generate API documentation",
      (_yargs) => {
        _yargs
          .positional("path", {
            describe:
              "File or directory to document (default: current directory)",
            type: "string",
            default: ".",
          })
          .option("o", {
            alias: "output",
            describe: "Output directory",
            type: "string",
            default: "yo-out/doc",
          })
          .option("title", {
            describe:
              "Doc site title (default: inferred from directory/package)",
            type: "string",
          })
          .option("document-private", {
            describe: "Include non-exported (private) declarations",
            type: "boolean",
            default: false,
          })
          .option("verbose", {
            alias: "v",
            describe: "Verbose output",
            type: "boolean",
            default: false,
          })
          .option("format", {
            alias: "f",
            describe: "Output format",
            type: "string",
            choices: ["html", "markdown", "json"],
            default: "html",
          })
          .option("version", {
            describe: "Release version to display (e.g., v0.1.12)",
            type: "string",
          });
      },
      async (argv) => {
        const { runDoc } = await import("./doc-command");
        await runDoc({
          input: argv.path as string,
          outputDir: argv.o as string,
          includePrivate: argv.documentPrivate as boolean,
          verbose: argv.verbose as boolean,
          title: argv.title as string | undefined,
          format: argv.format as "html" | "markdown" | "json",
          version: argv.version as string | undefined,
        });
      }
    )
    .command(
      "cache <action>",
      "Manage the global dependency cache",
      (_yargs) => {
        _yargs.positional("action", {
          describe: "Cache action",
          choices: ["path", "clean"],
          type: "string",
        });
      },
      (argv) => {
        const action = argv.action as string;
        if (action === "path") {
          console.log(getGlobalCacheDir());
        } else if (action === "clean") {
          const cacheDir = getGlobalCacheDir();
          if (fs.existsSync(cacheDir)) {
            fs.rmSync(cacheDir, { recursive: true, force: true });
            console.log(`Removed cache directory: ${cacheDir}`);
          } else {
            console.log(`Cache directory does not exist: ${cacheDir}`);
          }
        }
      }
    )
    .command(
      "lsp",
      "Start the Yo Language Server (LSP)",
      (_yargs) => {
        _yargs.option("stdio", {
          describe: "Use stdio transport (default)",
          type: "boolean",
          default: true,
        });
      },
      async () => {
        // The LSP server is a separate entry point; for the CLI command,
        // we dynamically import and run it.
        await import("./lsp/server");
      }
    )
    .command(
      "version [action] [value]",
      "Manage Yo versions",
      (_yargs) => {
        _yargs
          .positional("action", {
            describe: "Action to perform: pin, install, list, clean",
            type: "string",
          })
          .positional("value", {
            describe: "Version number (for pin, install, clean)",
            type: "string",
          })
          .option("remote", {
            describe: "Show available releases (for list action)",
            type: "boolean",
            default: false,
          });
      },
      async (argv) => {
        const action = argv.action as string | undefined;
        const value = argv.value as string | undefined;
        const versionCwd = process.env.YO_ORIGINAL_CWD ?? process.cwd();

        if (!action) {
          // `yo version` — show current version and .yo-version info
          const currentVersion = getCurrentYoVersion();
          console.log(`Yo ${currentVersion}`);

          const pinnedVersion = readYoVersion(versionCwd);
          if (pinnedVersion) {
            const match = pinnedVersion === currentVersion;
            console.log(
              `.yo-version: ${pinnedVersion}${match ? " (matches current)" : ` (current: ${currentVersion})`}`
            );
          } else {
            console.log("No .yo-version file found in project.");
          }
          return;
        }

        switch (action) {
          case "pin": {
            const versionToPin = value ?? getCurrentYoVersion();
            // Validate if a specific version was given
            if (value) {
              const remoteVersions = await fetchRemoteVersions();
              if (!remoteVersions.includes(versionToPin)) {
                console.error(
                  `Error: Yo version ${versionToPin} is not available.\n` +
                    `Available versions: ${remoteVersions.slice(-10).join(", ")}${remoteVersions.length > 10 ? " ..." : ""}\n`
                );
                process.exit(1);
              }
            }
            fs.writeFileSync(
              path.join(versionCwd, ".yo-version"),
              versionToPin + "\n"
            );
            console.log(`Pinned Yo version to ${versionToPin} in .yo-version`);
            break;
          }
          case "install": {
            if (!value) {
              console.error(
                "Error: Specify a version to install.\nUsage: yo version install <version>"
              );
              process.exit(1);
            }
            if (isVersionCached(value)) {
              console.log(`Yo v${value} is already cached.`);
            } else {
              await ensureCachedVersion(value);
            }
            break;
          }
          case "list": {
            if (argv.remote) {
              const remoteVersions = await fetchRemoteVersions();
              console.log("Available releases:");
              for (const v of remoteVersions) {
                const current = v === getCurrentYoVersion() ? " (current)" : "";
                const cached = isVersionCached(v) ? " (cached)" : "";
                console.log(`  ${v}${current}${cached}`);
              }
            } else {
              const cached = listCachedVersions();
              if (cached.length === 0) {
                console.log(
                  "No cached versions. Use `yo version install <version>` to cache a version."
                );
              } else {
                console.log("Cached versions:");
                for (const v of cached) {
                  const current =
                    v === getCurrentYoVersion() ? " (current)" : "";
                  console.log(`  ${v}${current}`);
                }
              }
            }
            break;
          }
          case "clean": {
            if (value) {
              if (!isVersionCached(value)) {
                console.log(`Yo v${value} is not cached.`);
              } else {
                cleanVersionCache(value);
                console.log(`Removed cached Yo v${value}.`);
              }
            } else {
              const cached = listCachedVersions();
              if (cached.length === 0) {
                console.log("No cached versions to remove.");
              } else {
                cleanVersionCache();
                console.log(`Removed ${cached.length} cached version(s).`);
              }
            }
            break;
          }
          default:
            console.error(
              `Unknown action: ${action}\nAvailable actions: pin, install, list, clean`
            );
            process.exit(1);
        }
      }
    )
    .command(
      "skills <action>",
      "Manage Yo AI agent skill files for use with AI coding agents",
      (_yargs) => {
        _yargs
          .positional("action", {
            describe: "Action to perform",
            choices: ["install"],
            type: "string",
          })
          .epilog(
            [
              "Actions:",
              "  install   Copy bundled skill files into the current project",
              "",
              "The install action copies Yo skill files into all agent config directories",
              "found in the current project (.github, .agents, .claude, .opencode,",
              ".openai, .cursor). If none exist, .agents/skills/ is created.",
              "",
              "Examples:",
              "  yo skills install       Install skills in the current project",
            ].join("\n")
          );
      },
      async (argv) => {
        const action = argv.action as string;
        if (action === "install") {
          const { runSkillsInstall } = await import("./skills-command");
          await runSkillsInstall({
            cwd: process.env.YO_ORIGINAL_CWD ?? process.cwd(),
          });
        }
      }
    )
    .demandCommand(
      1,
      "You need to specify a command (e.g., 'compile', 'build', 'init')"
    )
    .strict()
    .help()
    .version(false)
    .option("version", {
      describe: "Show version number",
      type: "boolean",
      global: false,
    })
    .middleware((argv) => {
      if (argv.version === true && !argv._?.length) {
        console.log(`yo ${packageJson.version}`);
        process.exit(0);
      }
    }, true).argv;
} // end runCli
